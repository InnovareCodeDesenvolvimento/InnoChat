import { addDays, addMonths } from "date-fns";
import { getPrisma } from "@/lib/db/prisma";
import { withAdvisoryLock } from "@/lib/db/advisory-lock";
import { logger } from "@/lib/logger";
import { loadEmailContext, invoiceDueReminderEmail } from "@/lib/email";
import { effectiveStatus, GRACE_DAYS, validateCpfCnpj } from "@/core/billing";
import {
  billingUrlFor,
  pixEnvironmentFor,
  createInvoiceForPeriodTracked,
  findBillingRecipientEmail,
  generateInvoiceDescription,
  sendBillingMail,
  sendInvoiceGeneratedEmail,
  sendSubscriptionSuspendedEmail,
  cancelPixPayments,
  voidOpenInvoices,
} from "./service";
import { formatCentsBRL, formatDateBR } from "./format";
import { getMercadoPagoGateway, type MercadoPagoGateway } from "./mercadopago";
import { reconcileInvoicePayment } from "./reconcile";
import { deliverAutoCancelEmail, persistCanceledTransition } from "./cancellation";
import { claimOnceEmail, listPendingOnceEmails, markOnceEmailSent, ONCE_EMAIL_GIVE_UP_DAYS, ONCE_EMAIL_PROVIDER, onceEmailId } from "./email-outbox";
import { disconnectAllWhatsappInstances } from "@/modules/whatsapp/service";
import { recordBillingTickRun } from "@/modules/platform/health-service";
import { runReminderTick } from "@/modules/reminders/tick";

/**
 * `POST /api/internal/v1/billing/tick` (docs/contratos.md — Fase 7). Roda periodicamente
 * (n8n/cron, fora deste código) e faz, nesta ordem:
 *
 * 1. Gera a próxima fatura 5 dias antes de vencer (§7.1), para assinaturas que já passaram do
 *    trial (`ACTIVE`/`PAST_DUE` — a fatura do trial já foi criada no cadastro, ver
 *    `src/modules/signup/service.ts`; incluir `TRIALING` aqui geraria uma segunda fatura quase
 *    junto da primeira, já que o trial dura só `TRIAL_DAYS` (3) dias — menos que a janela de 5 dias).
 * 2. Regenera o Pix de faturas `OPEN` com Pix expirado (ou nunca gerado, se o Mercado Pago
 *    estava fora do ar na criação).
 * 3. Envia lembrete de vencimento (1 dia antes e, no dia, até 24h DEPOIS do vencimento — §7.1),
 *    uma vez por fatura (`dueReminderEmailSentAt`/`dueTodayEmailSentAt`).
 * 4. Recalcula `effectiveStatus` de toda assinatura não-`CANCELED` e persiste se mudou; ao
 *    entrar em `SUSPENDED`, dispara o e-mail de suspensão (uma vez por suspensão —
 *    `suspendedEmailSentAt`, resetado quando sai de `SUSPENDED`).
 *
 * E-MAIL QUE NÃO SAIU NÃO VIRA "ENVIADO" (R1-R3 de docs/regua-de-cobranca.md): toda marca
 * `*SentAt` só é gravada quando `sendMail` devolve `sent: true` (`sendBillingMail`). Falha de SMTP,
 * SMTP sem configuração ou erro = sem marca, a próxima rodada tenta de novo, `summary.emailsFailed`
 * conta e o sino do Admin avisa (`BILLING_EMAIL_FAILING`, derivado do resultado do tick).
 *
 * Um tick por vez: `runBillingTick` pega `pg_try_advisory_xact_lock` (R8); sem a trava, sai sem
 * fazer nada.
 *
 * Idempotente por desenho, não só "na prática": rodar 2x seguidas não duplica fatura (unique
 * `(subscriptionId, periodStart)`), não duplica e-mail (marcas `*SentAt`) e não desconta 2 meses
 * de ninguém (o pagamento, não o tick, avança `currentPeriodEnd` — `applyInvoicePayment`).
 */

const INVOICE_LEAD_DAYS = 5;

export type BillingTickSummary = {
  invoicesCreated: number;
  pixRegenerated: number;
  remindersSent: number;
  statusChanges: number;
  suspensionEmailsSent: number;
  /** Faturas de teste não convertido anuladas (`VOID`) por a conta ter sido cancelada. */
  invoicesVoided: number;
  /** Faturas `OPEN` com Pix conciliadas ativamente contra o Mercado Pago e baixadas (webhook perdido/atrasado). */
  invoicesReconciledPaid: number;
  /** Lembretes de véspera enviados por WhatsApp aos clientes finais (`src/modules/reminders/tick.ts`). */
  remindersToClientsSent: number;
  /** E-mails de cobrança que NÃO saíram nesta rodada (SMTP fora/sem configuração). Reenviados na próxima. */
  emailsFailed: number;
  /** `true` quando outro tick já estava rodando e este saiu sem fazer nada (nenhum contador vale). */
  skippedByLock?: true;
};

export const BILLING_TICK_LOCK_NAME = "innochat:billing-tick";

function emptySummary(): BillingTickSummary {
  return {
    invoicesCreated: 0,
    pixRegenerated: 0,
    remindersSent: 0,
    statusChanges: 0,
    suspensionEmailsSent: 0,
    invoicesVoided: 0,
    invoicesReconciledPaid: 0,
    remindersToClientsSent: 0,
    emailsFailed: 0,
  };
}

export async function runBillingTick(now: Date = new Date(), gateway?: MercadoPagoGateway): Promise<BillingTickSummary> {
  // Trava de transação (solta sozinha em commit/rollback/queda de conexão: nunca fica presa por erro).
  const outcome = await withAdvisoryLock(BILLING_TICK_LOCK_NAME, () => runBillingTickLocked(now, gateway));
  if (outcome.acquired) return outcome.value;
  logger.info("billing.tick.skipped_locked", {});
  return { ...emptySummary(), skippedByLock: true };
}

async function runBillingTickLocked(now: Date, gateway?: MercadoPagoGateway): Promise<BillingTickSummary> {
  const prisma = getPrisma();
  const summary = emptySummary();

  // Resolve o gateway do MP uma vez só (evita reler PlatformSettings a cada fatura/Pix). Se não
  // estiver configurado ainda, cada tentativa individual loga e segue (nunca derruba o tick
  // inteiro — docs/arquitetura.md, "nunca crash").
  let resolvedGateway = gateway;
  if (!resolvedGateway) {
    try {
      resolvedGateway = await getMercadoPagoGateway({ forNewCharge: true });
    } catch {
      resolvedGateway = undefined; // segue sem Pix — faturas nascem OPEN sem QR, regeráveis depois
    }
  }

  // 0. Concilia PRIMEIRO: fatura já paga não pode receber lembrete/suspensão/Pix novo.
  await reconcileOpenInvoices(prisma, now, gateway, summary);
  await voidAbandonedReactivations(prisma, now, gateway, summary);
  // Reenvia ANTES de gerar: o que nasce nesta rodada já teve a sua tentativa (sem 2 envios por rodada).
  await retryPendingOnceEmails(prisma, now, summary);
  await generateUpcomingInvoices(prisma, now, resolvedGateway, summary);
  await regenerateExpiredPix(prisma, now, resolvedGateway, summary);
  await sendDueReminders(prisma, now, summary);
  await reconcileStatuses(prisma, now, summary, gateway);

  // Registra a execução de COBRANÇA já aqui: o lembrete aos clientes tem ritmo lento de propósito
  // (até ~45 s) e o "quando rodou" de Admin > Saúde não pode atrasar por causa dele. A cobrança
  // acima está concluída; o resumo é regravado com os lembretes ao final.
  const recordRun = () =>
    recordBillingTickRun(summary, now).catch((error) => {
      // Nunca falha o tick em si; o próximo tick tenta de novo e o log final tem o resultado real.
      logger.warn("billing.tick.record_run_failed", { errorMessage: error instanceof Error ? error.message : String(error) });
    });
  await recordRun();

  // Lembrete de véspera aos clientes finais: falha isolada — nunca derruba a cobrança acima.
  try {
    const reminders = await runReminderTick(now);
    summary.remindersToClientsSent = reminders.remindersToClientsSent;
  } catch (error) {
    logger.error("billing.tick.reminders_failed", { errorMessage: error instanceof Error ? error.message : String(error) });
  }

  logger.info("billing.tick.completed", { ...summary });
  if (summary.remindersToClientsSent > 0) await recordRun();

  return summary;
}

/** Teto por rodada — o tick roda de hora em hora; o restante entra na rodada seguinte (mais antigas consultadas primeiro). */
const RECONCILE_BATCH_LIMIT = 50;

async function reconcileOpenInvoices(prisma: ReturnType<typeof getPrisma>, now: Date, gateway: MercadoPagoGateway | undefined, summary: BillingTickSummary) {
  const candidates = await prisma.invoice.findMany({
    where: { status: "OPEN", mpPaymentId: { not: null } },
    orderBy: [{ mpLastCheckedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take: RECONCILE_BATCH_LIMIT,
    select: { id: true },
  });
  for (const { id } of candidates) {
    try {
      const outcome = await reconcileInvoicePayment(id, { source: "tick", minIntervalMs: 0, now, gateway });
      if (outcome.status === "paid") summary.invoicesReconciledPaid += 1;
    } catch (error) {
      // Nunca derruba o tick por uma fatura — só loga e segue.
      logger.warn("billing.tick.reconcile_failed", { invoiceId: id, errorMessage: error instanceof Error ? error.message : String(error) });
    }
  }
}

/**
 * Dias após o vencimento (`dueAt`) da fatura de REATIVAÇÃO em que ela é considerada abandonada e
 * anulada. A reativação nasce com vencimento em 3 dias; depois dele o dono ainda tem este prazo
 * para pagar o Pix pendente.
 */
export const REACTIVATION_ABANDON_DAYS = 7;

/**
 * Fatura `OPEN` de assinatura `CANCELED` = fatura de reativação (os efeitos do cancelamento já
 * anularam as demais). Abandonada há mais de `REACTIVATION_ABANDON_DAYS` depois do vencimento:
 * anula e cancela o Pix no MP (mesmo caminho do cancelamento), para não ficar cobrança pendurada
 * nem Pix pagável sem baixa. Roda ANTES de regenerar Pix/enviar lembretes.
 */
async function voidAbandonedReactivations(
  prisma: ReturnType<typeof getPrisma>,
  now: Date,
  gateway: MercadoPagoGateway | undefined,
  summary: BillingTickSummary,
) {
  const cutoff = addDays(now, -REACTIVATION_ABANDON_DAYS);
  const abandoned = await prisma.subscription.findMany({
    where: { status: "CANCELED", invoices: { some: { status: "OPEN", dueAt: { lt: cutoff } } } },
    select: { id: true },
    take: 100,
  });
  for (const { id } of abandoned) {
    try {
      const voided = await voidOpenInvoices(prisma, { subscriptionId: id, dueAt: { lt: cutoff } });
      await cancelPixPayments(voided.pix, gateway);
      summary.invoicesVoided += voided.count;
    } catch (error) {
      logger.warn("billing.tick.abandoned_reactivation_failed", { subscriptionId: id, errorMessage: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function generateUpcomingInvoices(
  prisma: ReturnType<typeof getPrisma>,
  now: Date,
  gateway: MercadoPagoGateway | undefined,
  summary: BillingTickSummary,
) {
  const leadWindow = addDays(now, INVOICE_LEAD_DAYS);
  const subscriptions = await prisma.subscription.findMany({
    where: {
      status: { in: ["ACTIVE", "PAST_DUE"] },
      currentPeriodEnd: { lte: leadWindow },
      // Cancelamento agendado pelo dono: nenhuma fatura nova (Termos §9).
      cancelAtPeriodEnd: false,
      // Teste ainda não convertido: a fatura do trial É a cobrança. Sem esta guarda, o PAST_DUE
      // pós-trial geraria uma 2ª fatura (mês seguinte) que voltaria a contar como "vencida".
      invoices: { none: { isTrialConversion: true, status: "OPEN" } },
    },
    include: { plan: true, pendingPlan: true, tenant: true },
  });

  for (const subscription of subscriptions) {
    const payerEmail = await findBillingRecipientEmail(subscription.tenantId);
    if (!payerEmail) {
      logger.warn("billing.tick.invoice.no_owner_email", { tenantId: subscription.tenantId });
      continue;
    }

    const periodStart = subscription.currentPeriodEnd;
    const periodEnd = addMonths(periodStart, 1);

    // Downgrade agendado (`changePlan`, docs/arquitetura.md §7.2): o ciclo que está sendo
    // faturado AGORA (5 dias antes de começar) é o "próximo ciclo" em que ele entra em vigor —
    // a fatura já sai no preço do plano novo, e a assinatura já aponta para ele a partir daqui.
    const billingPlan = subscription.pendingPlan ?? subscription.plan;
    if (subscription.pendingPlanId) {
      await prisma.subscription.update({ where: { id: subscription.id }, data: { planId: subscription.pendingPlanId, pendingPlanId: null } });
    }

    const { invoice, created } = await createInvoiceForPeriodTracked({
      subscriptionId: subscription.id,
      amountCents: billingPlan.priceCents,
      periodStart,
      periodEnd,
      dueAt: periodEnd,
      payerEmail,
      description: generateInvoiceDescription(subscription.tenant.name),
      gateway,
    });

    if (created) {
      summary.invoicesCreated += 1;
      // `created` só é `true` uma vez, então a marca de envio único é a linha de `email-outbox`:
      // criada aqui, confirmada ao sair, e reenviada pela rodada seguinte se o SMTP falhar (sem
      // migration; a F1 troca isto pelo outbox `BillingNotice`).
      if (await claimOnceEmail("invoice_generated", invoice.id)) {
        if (await deliverInvoiceGeneratedEmail(invoice.id)) await markOnceEmailSent("invoice_generated", invoice.id, now);
        else summary.emailsFailed += 1;
      }
    }
  }
}

/** Monta e envia o e-mail "fatura gerada" com o estado ATUAL da fatura. `true` = saiu (ou não há mais o que enviar). */
async function deliverInvoiceGeneratedEmail(invoiceId: string): Promise<boolean> {
  const invoice = await getPrisma().invoice.findUnique({
    where: { id: invoiceId },
    include: { subscription: { include: { tenant: true } } },
  });
  // Paga/anulada entre a geração e o reenvio: cobrar agora seria o pior erro da régua.
  if (!invoice || invoice.status !== "OPEN") return true;
  const toEmail = await findBillingRecipientEmail(invoice.subscription.tenantId);
  if (!toEmail) return true;
  return sendInvoiceGeneratedEmail({
    toEmail,
    tenantName: invoice.subscription.tenant.name,
    tenantSlug: invoice.subscription.tenant.slug,
    amountCents: invoice.amountCents,
    dueAt: invoice.dueAt,
    pixCopyPaste: invoice.pixCopyPaste,
    timezone: invoice.subscription.tenant.timezone,
  });
}

/**
 * Reenvia os e-mails de envio único que falharam (fatura gerada, cancelamento automático). Passado
 * `ONCE_EMAIL_GIVE_UP_DAYS` sem sucesso o aviso perdeu o sentido: encerra a marca sem reenviar.
 */
async function retryPendingOnceEmails(prisma: ReturnType<typeof getPrisma>, now: Date, summary: BillingTickSummary) {
  const giveUpBefore = addDays(now, -ONCE_EMAIL_GIVE_UP_DAYS);
  const kinds = [
    { kind: "invoice_generated" as const, deliver: (key: string) => deliverInvoiceGeneratedEmail(key) },
    // chave do cancelamento = "<subscriptionId>:<canceledAt ms>"
    { kind: "auto_cancel" as const, deliver: (key: string) => deliverAutoCancelEmail(key.slice(0, key.lastIndexOf(":"))) },
  ];
  for (const { kind, deliver } of kinds) {
    for (const pending of await listPendingOnceEmails(kind)) {
      try {
        if (pending.createdAt < giveUpBefore) {
          await prisma.providerEvent.updateMany({
            where: { provider: ONCE_EMAIL_PROVIDER, providerEventId: onceEmailId(kind, pending.key), processedAt: null },
            data: { processedAt: now },
          });
          logger.warn("billing.tick.once_email_gave_up", { kind });
          continue;
        }
        if (await deliver(pending.key)) await markOnceEmailSent(kind, pending.key, now);
        else summary.emailsFailed += 1;
      } catch (error) {
        logger.warn("billing.tick.once_email_retry_failed", { kind, errorMessage: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}

async function regenerateExpiredPix(
  prisma: ReturnType<typeof getPrisma>,
  now: Date,
  gateway: MercadoPagoGateway | undefined,
  summary: BillingTickSummary,
) {
  if (!gateway) return; // sem gateway configurado, não há como gerar Pix — próximo tick tenta de novo

  const expired = await prisma.invoice.findMany({
    where: { status: "OPEN", OR: [{ pixExpiresAt: { lt: now } }, { pixExpiresAt: null }] },
    include: { subscription: { include: { tenant: true } } },
  });

  for (const invoice of expired) {
    const payerEmail = await findBillingRecipientEmail(invoice.subscription.tenantId);
    if (!payerEmail) continue;

    // O MP exige `payer.identification` para Pix (ver `mercadopago.ts#createPixPayment`) —
    // `Tenant.document` ainda `null` (nenhuma tela pública coleta isso, PENDÊNCIAS no handoff)
    // vira `createPixPayment` lançando `missing_payer_document`, capturado abaixo como qualquer
    // outra falha: o tick nunca derruba por isso, só loga e tenta de novo na próxima rodada.
    const tenantDocument = invoice.subscription.tenant.document ? validateCpfCnpj(invoice.subscription.tenant.document) : { valid: false as const };

    try {
      const pix = await gateway.createPixPayment({
        externalReference: invoice.id,
        amountCents: invoice.amountCents,
        description: generateInvoiceDescription(invoice.subscription.tenant.name),
        payerEmail,
        payerName: invoice.subscription.tenant.name,
        payerDocument: tenantDocument.valid ? tenantDocument.digits : null,
        idempotencyKey: `${invoice.id}:${now.getTime()}`, // Pix anterior expirou — precisa de cobrança nova no MP
        expiresInDays: 3,
      });
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          mpPaymentId: pix.paymentId,
          pixQrCode: pix.qrCode,
          pixCopyPaste: pix.copyPaste,
          pixExpiresAt: pix.expiresAt,
          mpEnvironment: await pixEnvironmentFor(gateway),
        },
      });
      summary.pixRegenerated += 1;
    } catch (error) {
      logger.warn("billing.tick.pix_regenerate_failed", {
        invoiceId: invoice.id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function sendDueReminders(prisma: ReturnType<typeof getPrisma>, now: Date, summary: BillingTickSummary) {
  const oneDayOut = addDays(now, 1);

  const dueTomorrow = await prisma.invoice.findMany({
    where: { status: "OPEN", dueReminderEmailSentAt: null, dueAt: { lte: oneDayOut, gt: now } },
    include: { subscription: { include: { tenant: true } } },
  });
  for (const invoice of dueTomorrow.filter(isBillableReminder)) {
    await notifyDue(invoice, false, prisma, summary, "dueReminderEmailSentAt");
  }

  const dueToday = await prisma.invoice.findMany({
    // "Vence hoje" só até 24h DEPOIS do vencimento (R6): fora dessa janela o texto seria mentira.
    where: { status: "OPEN", dueTodayEmailSentAt: null, dueAt: { lte: now, gt: addDays(now, -1) } },
    include: { subscription: { include: { tenant: true } } },
  });
  for (const invoice of dueToday.filter(isBillableReminder)) {
    await notifyDue(invoice, true, prisma, summary, "dueTodayEmailSentAt");
  }
}

/**
 * Assinatura `CANCELED` só recebe e-mail de cobrança por uma REATIVAÇÃO ativa: fatura criada
 * depois do cancelamento (`createdAt >= canceledAt`). Fatura anterior que sobrou aberta nunca gera
 * lembrete (o tick a anula; o dono cancelou e não deve ser cobrado).
 */
function isBillableReminder(invoice: { createdAt: Date; subscription: { status: string; canceledAt: Date | null } }): boolean {
  if (invoice.subscription.status !== "CANCELED") return true;
  const canceledAt = invoice.subscription.canceledAt;
  return canceledAt !== null && invoice.createdAt >= canceledAt;
}

type InvoiceWithTenant = {
  id: string;
  amountCents: number;
  dueAt: Date;
  subscription: { tenantId: string; tenant: { name: string; slug: string; timezone: string } };
};

async function notifyDue(
  invoice: InvoiceWithTenant,
  dueToday: boolean,
  prisma: ReturnType<typeof getPrisma>,
  summary: BillingTickSummary,
  field: "dueReminderEmailSentAt" | "dueTodayEmailSentAt",
) {
  const payerEmail = await findBillingRecipientEmail(invoice.subscription.tenantId);
  if (!payerEmail) return;

  const { subject, html, text } = invoiceDueReminderEmail({
    tenantName: invoice.subscription.tenant.name,
    amountReais: formatCentsBRL(invoice.amountCents),
    dueDateBr: formatDateBR(invoice.dueAt, invoice.subscription.tenant.timezone),
    billingUrl: await billingUrlFor(invoice.subscription.tenant.slug),
    dueToday,
    ctx: await loadEmailContext(),
  });
  // Só marca como enviado se SAIU. Falha/SMTP sem configuração: sem marca, a próxima rodada repete.
  const sent = await sendBillingMail({ to: payerEmail, subject, html, text }, "billing.tick.due_reminder_not_sent");
  if (!sent) {
    summary.emailsFailed += 1;
    return;
  }

  await prisma.invoice.update({ where: { id: invoice.id }, data: { [field]: new Date() } });
  summary.remindersSent += 1;
}

async function reconcileStatuses(prisma: ReturnType<typeof getPrisma>, now: Date, summary: BillingTickSummary, gateway?: MercadoPagoGateway) {
  const subscriptions = await prisma.subscription.findMany({
    where: { status: { not: "CANCELED" } },
    include: { tenant: true },
  });

  for (const subscription of subscriptions) {
    const next = effectiveStatus(subscription, now);
    if (next === subscription.status) continue;

    if (next === "CANCELED") {
      // Claim condicional (status/agendamento/fim do período como lidos): se o dono desfez o
      // cancelamento ou um pagamento entrou entre a leitura e aqui, não cancela. Efeitos do
      // cancelamento (qualquer origem: agendado ou 60 dias em SUSPENDED) rodam dentro; falha deles
      // é isolada e a varredura abaixo repete a desconexão. A data de cancelamento é o fim do
      // período pago quando agendado (dela partem os 90 dias de retenção, ver `canceledAt` em
      // `maintenance/tick.ts`).
      const result = await persistCanceledTransition(subscription, now, { gateway });
      if (!result.claimed) continue;
      summary.statusChanges += 1;
      summary.invoicesVoided += result.invoicesVoided;
      continue;
    }

    const claimed = await prisma.subscription.updateMany({
      where: {
        id: subscription.id,
        status: subscription.status,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        currentPeriodEnd: subscription.currentPeriodEnd,
      },
      data: {
        status: next,
        // Sai de SUSPENDED (pagou/reativou) → zera a marca, para avisar de novo numa suspensão futura.
        suspendedEmailSentAt: next === "SUSPENDED" ? subscription.suspendedEmailSentAt : null,
      },
    });
    if (claimed.count === 0) continue; // mudou no meio do caminho (pagamento/desfazer): próxima rodada reavalia
    summary.statusChanges += 1;
  }

  await sendPendingSuspensionEmails(prisma, now, summary);

  // Teste não convertido cancelado (por aqui, pelo dono da empresa ou pelo admin): a fatura do
  // trial vira VOID e sai de qualquer conta de inadimplência (decisão do dono, 2026-09-29).
  // É uma varredura (não parte da transição) para se auto-curar: se o tick cair entre gravar
  // `CANCELED` e anular, a próxima rodada anula. Idempotente e segura em corrida: só toca fatura
  // ainda `OPEN` (um pagamento concorrente que a marcou `PAID` não é sobrescrito).
  const voided = await voidOpenInvoices(prisma, { isTrialConversion: true, subscription: { status: "CANCELED", firstPaidAt: null } });
  await cancelPixPayments(voided.pix, gateway);
  summary.invoicesVoided += voided.count;

  // Auto-cura da desconexão: número ainda ligado numa assinatura já CANCELED = a desconexão
  // falhou/foi interrompida na transição. Limitado por rodada. (Fatura aberta NÃO entra aqui: numa
  // assinatura CANCELED ela pode ser a de reativação pedida pelo dono.)
  const lingering = await prisma.subscription.findMany({
    where: { status: "CANCELED", tenant: { whatsappInstances: { some: { deletedAt: null, status: { not: "DISCONNECTED" } } } } },
    select: { tenantId: true },
    take: 50,
  });
  for (const { tenantId } of lingering) {
    try {
      await disconnectAllWhatsappInstances(tenantId);
    } catch (error) {
      logger.warn("billing.tick.cancel_effects_failed", { tenantId, errorMessage: error instanceof Error ? error.message : String(error) });
    }
  }
}

/** Suspensões mais antigas que isto sem e-mail não recebem mais (o aviso ficou tardio demais). */
const SUSPENSION_EMAIL_MAX_AGE_DAYS = 7;

/**
 * E-mail de suspensão (R3): para toda assinatura `SUSPENDED` com `suspendedEmailSentAt` nulo. A marca
 * só é gravada quando o e-mail SAIU; se o SMTP falhou, a assinatura continua aqui e a próxima rodada
 * tenta de novo (antes o e-mail só era tentado na transição, então falhar era perder para sempre).
 */
async function sendPendingSuspensionEmails(prisma: ReturnType<typeof getPrisma>, now: Date, summary: BillingTickSummary) {
  const suspended = await prisma.subscription.findMany({
    where: { status: "SUSPENDED", suspendedEmailSentAt: null },
    include: { tenant: true },
  });
  for (const subscription of suspended) {
    const suspendedSince = addDays(subscription.currentPeriodEnd, GRACE_DAYS);
    if (suspendedSince < addDays(now, -SUSPENSION_EMAIL_MAX_AGE_DAYS)) continue;

    const payerEmail = await findBillingRecipientEmail(subscription.tenantId);
    if (!payerEmail) continue;
    const sent = await sendSubscriptionSuspendedEmail({
      toEmail: payerEmail,
      tenantName: subscription.tenant.name,
      tenantSlug: subscription.tenant.slug,
      trialNotConverted: subscription.firstPaidAt === null,
    });
    if (!sent) {
      summary.emailsFailed += 1;
      continue;
    }
    // Condicional: se a conta saiu de SUSPENDED (pagou) no meio, não deixa marca para a próxima suspensão.
    await prisma.subscription.updateMany({ where: { id: subscription.id, status: "SUSPENDED" }, data: { suspendedEmailSentAt: now } });
    summary.suspensionEmailsSent += 1;
  }
}
