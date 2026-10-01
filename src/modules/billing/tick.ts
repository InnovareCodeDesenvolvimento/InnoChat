import { addDays, addMonths } from "date-fns";
import { getPrisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { sendMail, loadEmailContext, invoiceDueReminderEmail } from "@/lib/email";
import { accessEndsAt, effectiveStatus, validateCpfCnpj } from "@/core/billing";
import {
  billingUrlFor,
  pixEnvironmentFor,
  createInvoiceForPeriodTracked,
  findBillingRecipientEmail,
  generateInvoiceDescription,
  sendInvoiceGeneratedEmail,
  sendSubscriptionSuspendedEmail,
} from "./service";
import { formatCentsBRL, formatDateBR } from "./format";
import { getMercadoPagoGateway, type MercadoPagoGateway } from "./mercadopago";
import { reconcileInvoicePayment } from "./reconcile";
import { applyCancellationEffects } from "./cancellation";
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
 * 3. Envia lembrete de vencimento (1 dia antes e no dia — §7.1), uma vez por fatura
 *    (`dueReminderEmailSentAt`/`dueTodayEmailSentAt`).
 * 4. Recalcula `effectiveStatus` de toda assinatura não-`CANCELED` e persiste se mudou; ao
 *    entrar em `SUSPENDED`, dispara o e-mail de suspensão (uma vez por suspensão —
 *    `suspendedEmailSentAt`, resetado quando sai de `SUSPENDED`).
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
};

export async function runBillingTick(now: Date = new Date(), gateway?: MercadoPagoGateway): Promise<BillingTickSummary> {
  const prisma = getPrisma();
  const summary: BillingTickSummary = {
    invoicesCreated: 0,
    pixRegenerated: 0,
    remindersSent: 0,
    statusChanges: 0,
    suspensionEmailsSent: 0,
    invoicesVoided: 0,
    invoicesReconciledPaid: 0,
    remindersToClientsSent: 0,
  };

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
  await generateUpcomingInvoices(prisma, now, resolvedGateway, summary);
  await regenerateExpiredPix(prisma, now, resolvedGateway, summary);
  await sendDueReminders(prisma, now, summary);
  await reconcileStatuses(prisma, now, summary);

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
      await sendInvoiceGeneratedEmail({
        toEmail: payerEmail,
        tenantName: subscription.tenant.name,
        tenantSlug: subscription.tenant.slug,
        amountCents: invoice.amountCents,
        dueAt: invoice.dueAt,
        pixCopyPaste: invoice.pixCopyPaste,
        timezone: subscription.tenant.timezone,
      });
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
  for (const invoice of dueTomorrow) {
    await notifyDue(invoice, false, prisma, summary, "dueReminderEmailSentAt");
  }

  const dueToday = await prisma.invoice.findMany({
    where: { status: "OPEN", dueTodayEmailSentAt: null, dueAt: { lte: now } },
    include: { subscription: { include: { tenant: true } } },
  });
  for (const invoice of dueToday) {
    await notifyDue(invoice, true, prisma, summary, "dueTodayEmailSentAt");
  }
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
  await sendMail({ to: payerEmail, subject, html, text }).catch((error) => {
    logger.error("billing.tick.due_reminder_failed", { errorMessage: error instanceof Error ? error.message : String(error) });
  });

  await prisma.invoice.update({ where: { id: invoice.id }, data: { [field]: new Date() } });
  summary.remindersSent += 1;
}

async function reconcileStatuses(prisma: ReturnType<typeof getPrisma>, now: Date, summary: BillingTickSummary) {
  const subscriptions = await prisma.subscription.findMany({
    where: { status: { not: "CANCELED" } },
    include: { tenant: true },
  });

  for (const subscription of subscriptions) {
    const next = effectiveStatus(subscription, now);
    if (next === subscription.status) continue;

    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        status: next,
        // Sai de SUSPENDED (pagou/reativou) → zera a marca, para avisar de novo numa suspensão futura.
        suspendedEmailSentAt: next === "SUSPENDED" ? subscription.suspendedEmailSentAt : null,
        // Correção 2026-09-28 (achado do endpoint de manutenção/LGPD, `maintenance/tick.ts`):
        // `canceledAt` nunca era persistido quando o STATUS EFETIVO virava `CANCELED` por aqui
        // (só era zerado na reativação, em `admin-service.ts`) — sem isto, a anonimização de
        // 90 dias após `CANCELED` (docs/arquitetura.md §11/§12) nunca teria uma data de
        // referência para contar a partir de nenhuma empresa cancelada automaticamente (60
        // dias em `SUSPENDED`, ver `effectiveStatus`). Marca só na transição PARA `CANCELED`.
        // Cancelamento agendado pelo dono: a data de cancelamento é o fim do período pago (não o
        // instante em que o tick rodou) — é dela que partem os 90 dias de retenção.
        ...(next === "CANCELED" ? { canceledAt: subscription.cancelAtPeriodEnd ? accessEndsAt(subscription) : now } : {}),
      },
    });
    summary.statusChanges += 1;

    // Efeitos do cancelamento (qualquer origem: agendado pelo dono ou 60 dias em SUSPENDED):
    // anula faturas em aberto e desconecta os números. Falha isolada — a varredura abaixo repete.
    if (next === "CANCELED") {
      try {
        const effects = await applyCancellationEffects(subscription.id, subscription.tenantId);
        summary.invoicesVoided += effects.invoicesVoided;
      } catch (error) {
        logger.warn("billing.tick.cancel_effects_failed", { tenantId: subscription.tenantId, errorMessage: error instanceof Error ? error.message : String(error) });
      }
    }

    if (next === "SUSPENDED" && !subscription.suspendedEmailSentAt) {
      const payerEmail = await findBillingRecipientEmail(subscription.tenantId);
      if (payerEmail) {
        await sendSubscriptionSuspendedEmail({
          toEmail: payerEmail,
          tenantName: subscription.tenant.name,
          tenantSlug: subscription.tenant.slug,
          trialNotConverted: subscription.firstPaidAt === null,
        });
        await prisma.subscription.update({ where: { id: subscription.id }, data: { suspendedEmailSentAt: now } });
        summary.suspensionEmailsSent += 1;
      }
    }
  }

  // Teste não convertido cancelado (por aqui, pelo dono da empresa ou pelo admin): a fatura do
  // trial vira VOID e sai de qualquer conta de inadimplência (decisão do dono, 2026-09-29).
  // É uma varredura (não parte da transição) para se auto-curar: se o tick cair entre gravar
  // `CANCELED` e anular, a próxima rodada anula. Idempotente e segura em corrida: só toca fatura
  // ainda `OPEN` (um pagamento concorrente que a marcou `PAID` não é sobrescrito).
  const voided = await prisma.invoice.updateMany({
    where: { status: "OPEN", isTrialConversion: true, subscription: { status: "CANCELED", firstPaidAt: null } },
    data: { status: "VOID" },
  });
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
