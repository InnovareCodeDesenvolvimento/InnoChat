import { addDays, addMonths } from "date-fns";
import { getPrisma } from "@/lib/db/prisma";
import { isUniqueViolation } from "@/lib/db/prisma-errors";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { sendMail, loadEmailContext, subscriptionCancelEmail } from "@/lib/email";
import { getPublicBaseUrl } from "@/lib/public-url";
import { accessEndsAt, CANCELED_RETENTION_DAYS, effectiveStatus } from "@/core/billing";
import { disconnectAllWhatsappInstances } from "@/modules/whatsapp/service";
import type { EvolutionClient } from "@/modules/whatsapp/evolution-client";
import { formatDateBR } from "./format";
import { findBillingRecipientEmail, generateInvoiceDescription, createInvoiceForPeriodTracked, tryAttachPix } from "./service";
import type { MercadoPagoGateway } from "./mercadopago";

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

export type CancelResult = {
  mode: "SCHEDULED" | "IMMEDIATE";
  /** Quando o acesso termina (ISO). Em `IMMEDIATE`, é o instante do cancelamento. */
  endsAt: string;
  alreadyRequested: boolean;
};

export type CancellationEffectsDeps = { evolution?: EvolutionClient };

/**
 * Efeitos de a assinatura estar `CANCELED`: anula TODA fatura em aberto (nenhuma cobrança depois
 * do cancelamento) e desconecta os números de WhatsApp. Idempotente — o tick também chama isto
 * para auto-curar quando cai entre gravar `CANCELED` e executar os efeitos.
 */
export async function applyCancellationEffects(subscriptionId: string, tenantId: string, deps: CancellationEffectsDeps = {}) {
  const voided = await getPrisma().invoice.updateMany({ where: { subscriptionId, status: "OPEN" }, data: { status: "VOID" } });
  const disconnected = await disconnectAllWhatsappInstances(tenantId, deps);
  return { invoicesVoided: voided.count, instancesDisconnected: disconnected };
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
  const reason = input.reason?.trim() ? input.reason.trim().slice(0, CANCEL_REASON_MAX_LENGTH) : null;

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
      if (claimed.count === 0) return false;
      // Nenhuma cobrança futura: a fatura do próximo ciclo (ou a do teste) é anulada. Se o dono
      // desfizer, `undoCancellation` reabre exatamente as anuladas por este pedido.
      await tx.invoice.updateMany({ where: { subscriptionId: subscription.id, status: "OPEN" }, data: { status: "VOID" } });
      return true;
    });
    if (!won) return scheduled(true);

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
        data: { status: "OPEN" },
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
  options: { now?: Date; gateway?: MercadoPagoGateway } = {},
): Promise<{ invoiceId: string }> {
  const prisma = getPrisma();
  const now = options.now ?? new Date();
  const subscription = await prisma.subscription.findUnique({ where: { tenantId }, include: { plan: true, tenant: { select: { name: true } } } });
  if (!subscription) throw new DomainError("NOT_FOUND", "Assinatura não encontrada para esta empresa.");
  if (subscription.status !== "CANCELED") throw new DomainError("INVALID_STATE", "A assinatura não está cancelada.");
  if (subscription.plan.priceCents <= 0) {
    throw new DomainError("INVALID_STATE", "O plano desta empresa ainda não tem preço definido. Contate o suporte para reativar.");
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
    // Mesma data de uma fatura anulada antes (cancelou e reativou no mesmo dia): reabre.
    await prisma.invoice.updateMany({ where: { id: invoice.id, status: "VOID" }, data: { status: "OPEN", dueAt: params.dueAt } });
    await tryAttachPix(invoice.id, payerEmail, description, options.gateway);
  } else if (invoice.status === "PAID") {
    throw new DomainError("INVALID_STATE", "A fatura de reativação de hoje já foi paga. Atualize a página.");
  }
  logger.info("billing.reactivation.invoice_ready", { tenantId, invoiceId: invoice.id });
  return { invoiceId: invoice.id };
}
