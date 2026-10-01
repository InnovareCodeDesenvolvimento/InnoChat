import { addDays, addMonths } from "date-fns";
import { getPrisma } from "@/lib/db/prisma";
import { isUniqueViolation } from "@/lib/db/prisma-errors";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { sendMail, loadEmailContext, subscriptionCancelEmail } from "@/lib/email";
import { getPublicBaseUrl } from "@/lib/public-url";
import {
  accessEndsAt,
  CANCEL_AFTER_SUSPENDED_DAYS,
  CANCEL_AFTER_SUSPENDED_TRIAL_DAYS,
  CANCELED_RETENTION_DAYS,
  effectiveStatus,
} from "@/core/billing";
import { disconnectAllWhatsappInstances } from "@/modules/whatsapp/service";
import type { EvolutionClient } from "@/modules/whatsapp/evolution-client";
import { formatDateBR } from "./format";
import {
  cancelPixPayments,
  findBillingRecipientEmail,
  generateInvoiceDescription,
  sendBillingMail,
  createInvoiceForPeriodTracked,
  tryAttachPix,
  voidOpenInvoices,
} from "./service";
import type { MercadoPagoGateway } from "./mercadopago";
import { claimOnceEmail, markOnceEmailSent } from "./email-outbox";

/**
 * Cancelamento da assinatura pelo OWNER (Termos §9). Regras (decisão registrada em
 * docs/contratos.md, "Cancelamento pelo painel"):
 *
 * - `ACTIVE` (paga) e `TRIALING` (teste): AGENDA para o fim do período pago / do teste
 *   (`cancelAtPeriodEnd`). Até lá tudo funciona; faturas em aberto são anuladas (VOID) e o tick
 *   não gera outra. Pode ser desfeito até a data. Na data, `effectiveStatus` já devolve
 *   `CANCELED` e o tick persiste e executa os efeitos (`applyCancellationEffects`).
 * - `PAST_DUE`/`SUSPENDED`: não há período pago a respeitar — cancela IMEDIATAMENTE.
 * - Idempotente: pedir de novo (clique duplo, aba duplicada) devolve o estado atual com
 *   `alreadyRequested: true`, sem regravar motivo/data nem reenviar e-mail.
 */

export const CANCEL_REASON_MAX_LENGTH = 500;

/**
 * Normaliza o motivo digitado pelo dono ANTES de gravar: tira caracteres de controle (inclui
 * CR/LF/TAB), marcas bidirecionais/invisíveis (que poderiam inverter ou esconder texto no sino do
 * admin e nos e-mails) e colapsa espaços. Corta em `CANCEL_REASON_MAX_LENGTH` SEM partir um par
 * substituto (emoji). Vazio vira `null`.
 */
export function normalizeCancelReason(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = Array.from(raw.normalize("NFC"))
    .filter((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp <= 0x08 || cp === 0x0b || cp === 0x0c || (cp >= 0x0e && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f)) return false; // controle (TAB/LF/CR viram espaço abaixo)
      if (cp === 0x00ad || cp === 0x061c || cp === 0x180e) return false; // hífen suave, ALM, separador mongol
      if (cp >= 0x200b && cp <= 0x200f) return false; // largura zero + LRM/RLM
      if (cp >= 0x202a && cp <= 0x202e) return false; // embeddings/overrides bidi
      if (cp >= 0x2060 && cp <= 0x206f) return false; // word joiner, isolates bidi, etc.
      if (cp === 0xfeff) return false; // BOM
      return true;
    })
    .join("")
    .replace(/[\t\n\r\u2028\u2029]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
  if (!cleaned) return null;
  // Array.from separa por code point: o corte nunca cai no meio de um par substituto.
  return Array.from(cleaned).slice(0, CANCEL_REASON_MAX_LENGTH).join("").trim() || null;
}

export type CancelResult = {
  mode: "SCHEDULED" | "IMMEDIATE";
  /** Quando o acesso termina (ISO). Em `IMMEDIATE`, é o instante do cancelamento. */
  endsAt: string;
  alreadyRequested: boolean;
};

export type CancellationEffectsDeps = { evolution?: EvolutionClient; gateway?: MercadoPagoGateway };

/**
 * Efeitos de a assinatura estar `CANCELED`: anula TODA fatura em aberto (nenhuma cobrança depois
 * do cancelamento) e desconecta os números de WhatsApp. Idempotente — o tick também chama isto
 * para auto-curar quando cai entre gravar `CANCELED` e executar os efeitos.
 */
export async function applyCancellationEffects(subscriptionId: string, tenantId: string, deps: CancellationEffectsDeps = {}) {
  const voided = await voidOpenInvoices(getPrisma(), { subscriptionId });
  // Pix pendente no MP deixa de poder ser pago (falha só é logada; ver `cancelPixPayments`).
  await cancelPixPayments(voided.pix, deps.gateway);
  const disconnected = await disconnectAllWhatsappInstances(tenantId, deps);
  return { invoicesVoided: voided.count, instancesDisconnected: disconnected };
}

type CancelableSubscription = {
  id: string;
  tenantId: string;
  status: "TRIALING" | "ACTIVE" | "PAST_DUE" | "SUSPENDED" | "CANCELED";
  cancelAtPeriodEnd: boolean;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date;
  firstPaidAt: Date | null;
};

/**
 * Persiste a transição para `CANCELED` de uma assinatura cujo status EFETIVO já é `CANCELED` mas o
 * persistido ainda não (agendamento vencido / 60 dias em SUSPENDED, tick ainda não rodou) e executa
 * os efeitos. Usada pelo tick e por `startReactivation` (a fatura de reativação só nasce depois
 * disto, então os efeitos nunca anulam a fatura nova).
 *
 * É um CLAIM condicional (status, `cancelAtPeriodEnd` e fim do período iguais ao que foi lido):
 * se o dono desfez o cancelamento, ou um pagamento moveu o período, entre a leitura e aqui, não
 * grava nada (`claimed: false`). Falha dos efeitos é só logada — a varredura do tick refaz.
 */
export async function persistCanceledTransition(
  subscription: CancelableSubscription,
  now: Date,
  deps: CancellationEffectsDeps = {},
): Promise<{ claimed: boolean; invoicesVoided: number }> {
  const claim = await getPrisma().subscription.updateMany({
    where: {
      id: subscription.id,
      status: subscription.status,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      currentPeriodEnd: subscription.currentPeriodEnd,
    },
    data: {
      status: "CANCELED",
      suspendedEmailSentAt: null,
      // Cancelamento agendado: a data é o fim do período pago (não o instante em que o tick rodou) —
      // é dela que partem os 90 dias de retenção. Demais origens (60 dias em SUSPENDED): agora.
      canceledAt: subscription.cancelAtPeriodEnd ? accessEndsAt(subscription) : now,
    },
  });
  if (claim.count === 0) return { claimed: false, invoicesVoided: 0 };

  // Cancelamento AUTOMÁTICO (sem pedido do dono): ele não sabe que perdeu a conta. O agendado já
  // avisou no pedido (`requestCancellation`), então não repete aqui.
  if (!subscription.cancelAtPeriodEnd) await announceAutoCancel(subscription.id);

  try {
    const effects = await applyCancellationEffects(subscription.id, subscription.tenantId, deps);
    return { claimed: true, invoicesVoided: effects.invoicesVoided };
  } catch (error) {
    logger.warn("billing.cancel.effects_failed", { tenantId: subscription.tenantId, errorMessage: error instanceof Error ? error.message : String(error) });
    return { claimed: true, invoicesVoided: 0 };
  }
}

/**
 * E-mail do cancelamento automático (R4 da régua). Envio ÚNICO: `claimOnceEmail` cria a marca
 * (chave = assinatura + instante do cancelamento) e só quem a cria envia; se o envio falha, a marca
 * fica pendente e o tick reenvia (`retryPendingAutoCancelEmails`). Nunca desfaz o cancelamento.
 */
async function announceAutoCancel(subscriptionId: string): Promise<void> {
  try {
    const subscription = await getPrisma().subscription.findUnique({ where: { id: subscriptionId }, select: { canceledAt: true } });
    if (!subscription?.canceledAt) return;
    const key = autoCancelKey(subscriptionId, subscription.canceledAt);
    if (!(await claimOnceEmail("auto_cancel", key))) return;
    if (await deliverAutoCancelEmail(subscriptionId)) await markOnceEmailSent("auto_cancel", key);
  } catch (error) {
    logger.error("billing.cancel.auto_email_failed", { subscriptionId, errorMessage: error instanceof Error ? error.message : String(error) });
  }
}

export function autoCancelKey(subscriptionId: string, canceledAt: Date): string {
  return `${subscriptionId}:${canceledAt.getTime()}`;
}

/** Monta e envia o e-mail de conta encerrada. `true` = saiu (ou não há mais o que enviar). */
export async function deliverAutoCancelEmail(subscriptionId: string): Promise<boolean> {
  const subscription = await getPrisma().subscription.findUnique({
    where: { id: subscriptionId },
    select: { status: true, canceledAt: true, firstPaidAt: true, tenantId: true, tenant: { select: { name: true, slug: true, timezone: true } } },
  });
  // Reativou entre o cancelamento e o reenvio: o aviso perdeu o sentido.
  if (!subscription || subscription.status !== "CANCELED" || !subscription.canceledAt) return true;

  const to = await findBillingRecipientEmail(subscription.tenantId);
  if (!to) {
    logger.warn("billing.cancel.auto_email_no_recipient", { tenantId: subscription.tenantId });
    return true; // sem destinatário não adianta insistir
  }
  const base = await getPublicBaseUrl();
  const trialNotConverted = subscription.firstPaidAt === null;
  const { subject, html, text } = subscriptionCancelEmail({
    tenantName: subscription.tenant.name,
    immediate: true,
    endsAtBr: formatDateBR(subscription.canceledAt, subscription.tenant.timezone),
    retentionDays: CANCELED_RETENTION_DAYS,
    clientsUrl: `${base}/${subscription.tenant.slug}/clientes`,
    billingUrl: `${base}/${subscription.tenant.slug}/assinatura`,
    automatic: {
      unpaidDays: trialNotConverted ? CANCEL_AFTER_SUSPENDED_TRIAL_DAYS : CANCEL_AFTER_SUSPENDED_DAYS,
      trialNotConverted,
      retentionUntilBr: formatDateBR(addDays(subscription.canceledAt, CANCELED_RETENTION_DAYS), subscription.tenant.timezone),
    },
    ctx: await loadEmailContext(),
  });
  return sendBillingMail({ to, subject, html, text }, "billing.cancel.auto_email_not_sent");
}

async function sendCancelEmail(tenantId: string, params: { immediate: boolean; endsAt: Date }) {
  try {
    const [tenant, to] = await Promise.all([
      getPrisma().tenant.findUnique({ where: { id: tenantId }, select: { name: true, slug: true, timezone: true } }),
      findBillingRecipientEmail(tenantId),
    ]);
    if (!tenant || !to) return;
    const base = await getPublicBaseUrl();
    const { subject, html, text } = subscriptionCancelEmail({
      tenantName: tenant.name,
      immediate: params.immediate,
      endsAtBr: formatDateBR(params.endsAt, tenant.timezone),
      retentionDays: CANCELED_RETENTION_DAYS,
      clientsUrl: `${base}/${tenant.slug}/clientes`,
      billingUrl: `${base}/${tenant.slug}/assinatura`,
      ctx: await loadEmailContext(),
    });
    await sendMail({ to, subject, html, text });
  } catch (error) {
    // E-mail nunca desfaz o cancelamento.
    logger.error("billing.cancel.email_failed", { tenantId, errorMessage: error instanceof Error ? error.message : String(error) });
  }
}

export async function requestCancellation(
  tenantId: string,
  input: { reason?: string | null },
  options: { now?: Date } & CancellationEffectsDeps = {},
): Promise<CancelResult> {
  const prisma = getPrisma();
  const now = options.now ?? new Date();
  const reason = normalizeCancelReason(input.reason);

  const subscription = await prisma.subscription.findUnique({ where: { tenantId } });
  if (!subscription) throw new DomainError("NOT_FOUND", "Assinatura não encontrada para esta empresa.");

  // Já cancelada (pelo tick ou por um clique anterior): estado atual, nada a refazer.
  if (subscription.status === "CANCELED") {
    return { mode: "IMMEDIATE", endsAt: (subscription.canceledAt ?? now).toISOString(), alreadyRequested: true };
  }

  const status = effectiveStatus(subscription, now);
  const scheduled = (alreadyRequested: boolean): CancelResult => ({
    mode: "SCHEDULED",
    endsAt: accessEndsAt(subscription).toISOString(),
    alreadyRequested,
  });

  if (status === "CANCELED") return scheduled(true); // agendada e a data já passou (tick ainda não persistiu)

  if (status === "TRIALING" || status === "ACTIVE") {
    if (subscription.cancelAtPeriodEnd) return scheduled(true);

    const won = await prisma.$transaction(async (tx) => {
      const claimed = await tx.subscription.updateMany({
        where: { id: subscription.id, cancelAtPeriodEnd: false, status: { not: "CANCELED" } },
        data: { cancelAtPeriodEnd: true, cancelRequestedAt: now, cancelReason: reason, pendingPlanId: null },
      });
      if (claimed.count === 0) return null;
      // Nenhuma cobrança futura: a fatura do próximo ciclo (ou a do teste) é anulada. Se o dono
      // desfizer, `undoCancellation` reabre exatamente as anuladas por este pedido.
      return voidOpenInvoices(tx, { subscriptionId: subscription.id });
    });
    if (!won) return scheduled(true);
    // Fora da transação: o Pix pendente no MP deixa de poder ser pago.
    await cancelPixPayments(won.pix, options.gateway);

    logger.info("billing.cancel.scheduled", { tenantId, wasTrial: status === "TRIALING" });
    await sendCancelEmail(tenantId, { immediate: false, endsAt: accessEndsAt(subscription) });
    return scheduled(false);
  }

  // PAST_DUE / SUSPENDED: imediato.
  const claimed = await prisma.subscription.updateMany({
    where: { id: subscription.id, status: { not: "CANCELED" } },
    data: {
      status: "CANCELED",
      canceledAt: now,
      cancelAtPeriodEnd: false,
      cancelRequestedAt: now,
      cancelReason: reason,
      pendingPlanId: null,
    },
  });
  if (claimed.count === 0) return { mode: "IMMEDIATE", endsAt: now.toISOString(), alreadyRequested: true };

  await applyCancellationEffects(subscription.id, tenantId, options);
  logger.info("billing.cancel.immediate", { tenantId, from: status });
  await sendCancelEmail(tenantId, { immediate: true, endsAt: now });
  return { mode: "IMMEDIATE", endsAt: now.toISOString(), alreadyRequested: false };
}

/** Desfaz o cancelamento agendado (só até a data). Idempotente: sem cancelamento agendado → `{ undone: false }`. */
export async function undoCancellation(tenantId: string, options: { now?: Date } = {}): Promise<{ undone: boolean }> {
  const prisma = getPrisma();
  const now = options.now ?? new Date();
  const subscription = await prisma.subscription.findUnique({ where: { tenantId } });
  if (!subscription) throw new DomainError("NOT_FOUND", "Assinatura não encontrada para esta empresa.");

  if (subscription.status === "CANCELED" || (subscription.cancelAtPeriodEnd && effectiveStatus(subscription, now) === "CANCELED")) {
    throw new DomainError("INVALID_STATE", "O cancelamento já está em vigor. Para voltar, reative a assinatura.");
  }
  if (!subscription.cancelAtPeriodEnd) return { undone: false };

  const requestedAt = subscription.cancelRequestedAt;
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.subscription.updateMany({
      where: { id: subscription.id, cancelAtPeriodEnd: true, status: { not: "CANCELED" } },
      data: { cancelAtPeriodEnd: false, cancelRequestedAt: null, cancelReason: null },
    });
    if (claimed.count === 0) return { undone: false };
    // Reabre só o que ESTE cancelamento anulou (anuladas a partir do pedido). O tick então volta
    // a regenerar o Pix/lembrete normalmente; sem isto o `@@unique(periodStart)` impediria a
    // fatura do próximo ciclo de nascer.
    if (requestedAt) {
      await tx.invoice.updateMany({
        where: { subscriptionId: subscription.id, status: "VOID", updatedAt: { gte: requestedAt } },
        // O Pix antigo foi cancelado no MP ao anular: limpa para o tick/tela gerarem um novo (com
        // chave de idempotência nova) em vez de exibir um QR morto.
        data: { status: "OPEN", mpPaymentId: null, pixQrCode: null, pixCopyPaste: null, pixExpiresAt: null, mpEnvironment: null, mpLastCheckedAt: null },
      });
    }
    return { undone: true };
  });
}

/**
 * Reativação pelo OWNER de uma assinatura `CANCELED`: cria (ou reaproveita) a fatura do plano
 * atual, vencendo em 3 dias, com Pix. Ao pagar, `applyInvoicePayment` volta para `ACTIVE` com o
 * ciclo contado a partir do pagamento. Idempotente: já existindo fatura em aberto, devolve a mesma.
 * Os números de WhatsApp precisam ser reconectados (leitura de QR) depois.
 */
export async function startReactivation(
  tenantId: string,
  options: { now?: Date } & CancellationEffectsDeps = {},
): Promise<{ invoiceId: string }> {
  const prisma = getPrisma();
  const now = options.now ?? new Date();
  const subscription = await prisma.subscription.findUnique({ where: { tenantId }, include: { plan: true, tenant: { select: { name: true } } } });
  if (!subscription) throw new DomainError("NOT_FOUND", "Assinatura não encontrada para esta empresa.");
  // Status EFETIVO: agendamento vencido / 60 dias de suspensão contam como cancelada mesmo antes do
  // tick persistir `CANCELED`.
  if (effectiveStatus(subscription, now) !== "CANCELED") throw new DomainError("INVALID_STATE", "A assinatura não está cancelada.");
  if (subscription.plan.priceCents <= 0) {
    throw new DomainError("INVALID_STATE", "O plano desta empresa ainda não tem preço definido. Contate o suporte para reativar.");
  }

  // Persiste `CANCELED` e roda os efeitos (anular faturas, desconectar números) ANTES de a fatura
  // de reativação nascer: senão o tick, ao persistir depois, anularia a fatura nova e o estado
  // ficaria incoerente. Concorrente que já persistiu: o claim devolve `claimed: false` e segue.
  if (subscription.status !== "CANCELED") {
    await persistCanceledTransition(subscription, now, options);
  }

  const open = await prisma.invoice.findFirst({ where: { subscriptionId: subscription.id, status: "OPEN" }, orderBy: { periodStart: "desc" } });
  if (open) return { invoiceId: open.id };

  const payerEmail = await findBillingRecipientEmail(tenantId);
  if (!payerEmail) throw new DomainError("NOT_FOUND", "Nenhum e-mail de cobrança encontrado para esta empresa. Contate o suporte.");

  // periodStart = início do dia (UTC): dois cliques/abas no mesmo dia colidem no
  // `@@unique(subscriptionId, periodStart)` e caem na mesma fatura.
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const description = generateInvoiceDescription(subscription.tenant.name);
  const params = {
    subscriptionId: subscription.id,
    amountCents: subscription.plan.priceCents,
    periodStart,
    periodEnd: addMonths(periodStart, 1),
    dueAt: addDays(now, 3),
    payerEmail,
    description,
    gateway: options.gateway,
  };

  let invoice;
  try {
    ({ invoice } = await createInvoiceForPeriodTracked(params));
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    invoice = await prisma.invoice.findUniqueOrThrow({
      where: { subscriptionId_periodStart: { subscriptionId: subscription.id, periodStart } },
    });
  }

  if (invoice.status === "VOID") {
    // Mesma data de uma fatura anulada antes (cancelou e reativou no mesmo dia): reabre. O
    // `updateMany` VOID→OPEN é o CLAIM: só quem o ganha (`count === 1`) gera o Pix — duas
    // reativações concorrentes não geram dois pagamentos no MP. O Pix antigo (cancelado ao anular)
    // é descartado e o novo usa chave de idempotência própria.
    const reopened = await prisma.invoice.updateMany({
      where: { id: invoice.id, status: "VOID" },
      data: {
        status: "OPEN",
        dueAt: params.dueAt,
        mpPaymentId: null,
        pixQrCode: null,
        pixCopyPaste: null,
        pixExpiresAt: null,
        mpEnvironment: null,
        mpLastCheckedAt: null,
        dueReminderEmailSentAt: null,
        dueTodayEmailSentAt: null,
        paidWhileVoidAt: null,
      },
    });
    if (reopened.count === 1) {
      await tryAttachPix(invoice.id, payerEmail, description, options.gateway, { idempotencyKey: `${invoice.id}:reopen:${now.getTime()}` });
    }
  } else if (invoice.status === "PAID") {
    throw new DomainError("INVALID_STATE", "A fatura de reativação de hoje já foi paga. Atualize a página.");
  }
  logger.info("billing.reactivation.invoice_ready", { tenantId, invoiceId: invoice.id });
  return { invoiceId: invoice.id };
}
