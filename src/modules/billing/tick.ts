import { addDays, addMonths } from "date-fns";
import type { Prisma } from "@prisma/client";
import { getPrisma } from "@/lib/db/prisma";
import { withAdvisoryLock } from "@/lib/db/advisory-lock";
import { describeDbError, isTransactionTimeout } from "@/lib/db/prisma-errors";
import { logger } from "@/lib/logger";
import { asBillingCycle, cycleMonths, effectiveStatus, validateCpfCnpj } from "@/core/billing";
import { loadInvoiceCharge } from "./coupons";
import {
  pixEnvironmentFor,
  createInvoiceForPeriodTracked,
  findBillingRecipientEmail,
  generateInvoiceDescription,
  cancelPixPayments,
  voidOpenInvoices,
} from "./service";
import { getMercadoPagoGateway, type MercadoPagoGateway } from "./mercadopago";
import { reconcileInvoicePayment } from "./reconcile";
import { persistCanceledTransition } from "./cancellation";
import { runDunning } from "./dunning/run";
import type { DispatchDeps } from "./dunning/dispatcher";
import { recordBillingEvent } from "./dunning/events";
import { disconnectAllWhatsappInstances } from "@/modules/whatsapp/service";
import { recordBillingTickRun } from "@/modules/platform/health-service";
import { runReminderTick } from "@/modules/reminders/tick";
import { runWaitlistTick } from "@/modules/waitlist/respond";

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
 * 3. Recalcula `effectiveStatus` de toda assinatura não-`CANCELED` e persiste se mudou (cada transição grava
 *    um `BillingEvent`).
 * 4. Roda a RÉGUA DE COBRANÇA (`./dunning`, docs/regua-de-cobranca.md): o planejador puro decide as etapas devidas
 *    (fatura gerada, D-3/D-1/D, carência D+1 a D+3, suspensão, S+3 a S+45, C-7/C-1, cancelamento, teste), grava no
 *    outbox `BillingNotice` com `ON CONFLICT DO NOTHING` e o despachante envia por e-mail e WhatsApp (claim
 *    `FOR UPDATE SKIP LOCKED`, reconferência antes de enviar, espera crescente em falha, janela de horário). Substitui
 *    as marcas `*SentAt` e o outbox transitório em `ProviderEvent`, que deixaram de ser escritos.
 *
 * AVISO QUE NÃO SAIU NÃO VIRA "ENVIADO" (R1-R3): o outbox só marca `SENT` quando o SMTP/WhatsApp confirma. Falha =
 * `FAILED` com nova tentativa; `summary.emailsFailed` conta e o sino do Admin avisa (`BILLING_EMAIL_FAILING`).
 *
 * Um tick por vez: `runBillingTick` pega `pg_try_advisory_xact_lock` (R8); sem a trava, sai sem
 * fazer nada (`skippedByLock: true`, HTTP 200).
 *
 * A trava dura no máximo 15 min (timeout da transação que a segura). Para o trabalho NUNCA passar
 * disso (o Prisma faria rollback e soltaria a trava com o tick ainda rodando, deixando um 2º tick
 * entrar e duplicar e-mail): SMTP tem timeouts curtos (`mailer.ts`), os laços de envio têm teto por
 * rodada e o tick tem um orçamento de `TICK_BUDGET_MS` (10 min) — estourado, ele para de forma limpa
 * (`deadlineReached: true`) e deixa o resto para a próxima rodada. Se mesmo assim a transação
 * estourar (P2028), vira log claro + `lockTimedOut: true`, não 500.
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
  /** E-mails de cobrança que NÃO saíram nesta rodada (SMTP fora/sem configuração). Reenviados com espera crescente. */
  emailsFailed: number;
  /** Régua: avisos gravados no outbox nesta rodada, enviados, pulados (com motivo), com falha e adiados (janela/canal). */
  noticesEnqueued: number;
  noticesSent: number;
  noticesSkipped: number;
  noticesFailed: number;
  noticesDeferred: number;
  /** `true` quando outro tick já estava rodando e este saiu sem fazer nada (nenhum contador vale). */
  skippedByLock?: true;
  /** `true` quando o orçamento de tempo estourou: o tick parou limpo e o resto fica para a próxima rodada. */
  deadlineReached?: true;
  /** `true` quando a transação da trava estourou o timeout (rede de segurança; nenhum contador vale). */
  lockTimedOut?: true;
};

/** Orçamento de tempo do tick, bem abaixo do teto de 15 min da trava (`advisory-lock.ts`). */
export const TICK_BUDGET_MS = 10 * 60 * 1000;

export type BillingTickOptions = {
  /** Só para teste: orçamento em ms (padrão `TICK_BUDGET_MS`). */
  budgetMs?: number;
  /** Só para teste: sender de WhatsApp, espera entre envios etc. (a produção usa o sender da plataforma). */
  dispatch?: DispatchDeps;
};

/** Relógio de parede (não o `now` lógico do tick) que diz se o orçamento acabou. */
type TickBudget = { isOver: () => boolean };

function startBudget(budgetMs: number, summary: BillingTickSummary): TickBudget {
  const startedAt = Date.now();
  return {
    isOver: () => {
      if (Date.now() - startedAt < budgetMs) return false;
      if (!summary.deadlineReached) {
        summary.deadlineReached = true;
        logger.warn("billing.tick.deadline_reached", { budgetMs });
      }
      return true;
    },
  };
}

/** Teto de itens por rodada nos laços que enviam e-mail (o tick roda de hora em hora; o resto entra na próxima). */
const EMAIL_BATCH_LIMIT = 200;

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
    noticesEnqueued: 0,
    noticesSent: 0,
    noticesSkipped: 0,
    noticesFailed: 0,
    noticesDeferred: 0,
  };
}

export async function runBillingTick(
  now: Date = new Date(),
  gateway?: MercadoPagoGateway,
  options: BillingTickOptions = {},
): Promise<BillingTickSummary> {
  // Trava de transação (solta sozinha em commit/rollback/queda de conexão: nunca fica presa por erro).
  let outcome;
  try {
    outcome = await withAdvisoryLock(BILLING_TICK_LOCK_NAME, () => runBillingTickLocked(now, gateway, options.budgetMs ?? TICK_BUDGET_MS, options.dispatch));
  } catch (error) {
    if (!isTransactionTimeout(error)) throw error;
    // Rede de segurança: o orçamento deveria ter parado o tick antes. A transação fez rollback e a
    // trava foi solta; o que já foi enviado tem marca gravada, então a próxima rodada não repete.
    logger.error("billing.tick.lock_timeout", { hint: "tick passou do teto da trava; veja billing.tick.deadline_reached" });
    return { ...emptySummary(), lockTimedOut: true };
  }
  if (outcome.acquired) return outcome.value;
  logger.info("billing.tick.skipped_locked", {});
  return { ...emptySummary(), skippedByLock: true };
}

async function runBillingTickLocked(now: Date, gateway: MercadoPagoGateway | undefined, budgetMs: number, dispatchDeps?: DispatchDeps): Promise<BillingTickSummary> {
  const prisma = getPrisma();
  const summary = emptySummary();
  const budget = startBudget(budgetMs, summary);

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
  await reconcileOpenInvoices(prisma, now, gateway, summary, budget);
  await voidAbandonedReactivations(prisma, now, gateway, summary, budget);
  await generateUpcomingInvoices(prisma, now, resolvedGateway, summary, budget);
  await regenerateExpiredPix(prisma, now, resolvedGateway, summary, budget);
  await reconcileStatuses(prisma, now, summary, budget, gateway);
  // A régua roda DEPOIS das transições de status e da geração de fatura: planeja sobre o estado já persistido.
  await runDunningRound(now, summary, budget, resolvedGateway, dispatchDeps);

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
    // Sem orçamento sobrando, o lembrete aos clientes (lento de propósito) fica para a próxima rodada.
    if (!budget.isOver()) {
      const reminders = await runReminderTick(now);
      summary.remindersToClientsSent = reminders.remindersToClientsSent;
    }
  } catch (error) {
    logger.error("billing.tick.reminders_failed", { errorMessage: error instanceof Error ? error.message : String(error) });
  }

  // Lista de espera: reserva do tick próprio (a cada 5 min, se o cron chamar); aqui vence ofertas e dá baixa em dias passados.
  try {
    await runWaitlistTick(now);
  } catch (error) {
    logger.error("billing.tick.waitlist_failed", { errorMessage: error instanceof Error ? error.message : String(error) });
  }

  logger.info("billing.tick.completed", { ...summary });
  if (summary.remindersToClientsSent > 0) await recordRun();

  return summary;
}

/** Teto por rodada — o tick roda de hora em hora; o restante entra na rodada seguinte (mais antigas consultadas primeiro). */
const RECONCILE_BATCH_LIMIT = 50;

async function reconcileOpenInvoices(
  prisma: ReturnType<typeof getPrisma>,
  now: Date,
  gateway: MercadoPagoGateway | undefined,
  summary: BillingTickSummary,
  budget: TickBudget,
) {
  const candidates = await prisma.invoice.findMany({
    where: { status: "OPEN", mpPaymentId: { not: null } },
    orderBy: [{ mpLastCheckedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take: RECONCILE_BATCH_LIMIT,
    select: { id: true },
  });
  for (const { id } of candidates) {
    if (budget.isOver()) break;
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
  budget: TickBudget,
) {
  const cutoff = addDays(now, -REACTIVATION_ABANDON_DAYS);
  const abandoned = await prisma.subscription.findMany({
    where: { status: "CANCELED", invoices: { some: { status: "OPEN", dueAt: { lt: cutoff } } } },
    select: { id: true },
    take: 100,
  });
  for (const { id } of abandoned) {
    if (budget.isOver()) break;
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
  budget: TickBudget,
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
    orderBy: { currentPeriodEnd: "asc" },
    take: EMAIL_BATCH_LIMIT,
  });

  for (const subscription of subscriptions) {
    if (budget.isOver()) break;
    // Isolado por assinatura: uma falha (consulta, Mercado Pago, e-mail) nunca aborta as demais nem as etapas seguintes.
    try {
      await generateInvoiceForSubscription(prisma, subscription, gateway, summary);
    } catch (error) {
      logger.warn("billing.tick.invoice_generation_failed", { subscriptionId: subscription.id, ...describeDbError(error) });
    }
  }
}

type SubscriptionForInvoice = Prisma.SubscriptionGetPayload<{ include: { plan: true; pendingPlan: true; tenant: true } }>;

/**
 * Gera a fatura do próximo período de UMA assinatura (corpo do laço de `generateUpcomingInvoices`).
 * Exportada só para teste: permite exercitar a cadeia fatura -> baixa -> próxima fatura com relógio
 * adiantado sem rodar o tick global (que varre todas as empresas do banco e grava estados datados no futuro).
 */
export async function generateInvoiceForSubscriptionId(
  subscriptionId: string,
  gateway: MercadoPagoGateway | undefined,
  summary: BillingTickSummary = emptySummary(),
): Promise<BillingTickSummary> {
  const prisma = getPrisma();
  const subscription = await prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId }, include: { plan: true, pendingPlan: true, tenant: true } });
  await generateInvoiceForSubscription(prisma, subscription, gateway, summary);
  return summary;
}

async function generateInvoiceForSubscription(
  prisma: ReturnType<typeof getPrisma>,
  subscription: SubscriptionForInvoice,
  gateway: MercadoPagoGateway | undefined,
  summary: BillingTickSummary,
) {
  const payerEmail = await findBillingRecipientEmail(subscription.tenantId);
  if (!payerEmail) {
    logger.warn("billing.tick.invoice.no_owner_email", { tenantId: subscription.tenantId });
    return;
  }

  const periodStart = subscription.currentPeriodEnd;

  // Downgrade agendado (`changePlan`, docs/arquitetura.md §7.2): o ciclo que está sendo
  // faturado AGORA (5 dias antes de começar) é o "próximo ciclo" em que ele entra em vigor —
  // a fatura já sai no preço do plano novo, e a assinatura já aponta para ele a partir daqui.
  const billingPlan = subscription.pendingPlan ?? subscription.plan;
  if (subscription.pendingPlanId) {
    await prisma.subscription.update({ where: { id: subscription.id }, data: { planId: subscription.pendingPlanId, pendingPlanId: null } });
  }

  // Ciclo (mensal, trimestral, semestral ou anual) e cupom da assinatura: o valor e o período da fatura saem daqui.
  const charge = await loadInvoiceCharge(subscription, billingPlan);
  const periodEnd = addMonths(periodStart, cycleMonths(charge.cycle));

  const { invoice, created } = await createInvoiceForPeriodTracked({
    subscriptionId: subscription.id,
    amountCents: charge.netCents,
    charge,
    periodStart,
    periodEnd,
    // Vence quando o período ATUAL acaba (= `periodStart`), que é quando o status efetivo muda. O vencimento
    // era gravado no fim do período NOVO (um mês depois), e a régua de lembretes e o banner mentiam a data.
    dueAt: periodStart,
    payerEmail,
    description: generateInvoiceDescription(subscription.tenant.name, charge.cycle),
    gateway,
  });

  if (created) {
    summary.invoicesCreated += 1;
    await recordBillingEvent({
      tenantId: subscription.tenantId,
      subscriptionId: subscription.id,
      invoiceId: invoice.id,
      type: "INVOICE_CREATED",
      metadata: { amountCents: invoice.amountCents, cycle: invoice.cycle, discountCents: invoice.discountCents },
    });
    // O aviso "fatura gerada" não é enviado aqui: o planejador da régua o enfileira nesta mesma rodada
    // (etapa INVOICE_CREATED) e o despachante reenvia se o SMTP falhar.
  }
}

async function regenerateExpiredPix(
  prisma: ReturnType<typeof getPrisma>,
  now: Date,
  gateway: MercadoPagoGateway | undefined,
  summary: BillingTickSummary,
  budget: TickBudget,
) {
  if (!gateway) return; // sem gateway configurado, não há como gerar Pix — próximo tick tenta de novo

  const expired = await prisma.invoice.findMany({
    where: { status: "OPEN", OR: [{ pixExpiresAt: { lt: now } }, { pixExpiresAt: null }] },
    include: { subscription: { include: { tenant: true } } },
  });

  for (const invoice of expired) {
    if (budget.isOver()) break;
    let payerEmail: string | null;
    try {
      payerEmail = await findBillingRecipientEmail(invoice.subscription.tenantId);
    } catch (error) {
      logger.warn("billing.tick.pix_regenerate_failed", { invoiceId: invoice.id, ...describeDbError(error) });
      continue;
    }
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
        description: generateInvoiceDescription(invoice.subscription.tenant.name, asBillingCycle(invoice.cycle)),
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

/**
 * Rodada da régua: planeja, grava no outbox e despacha. Falha isolada: nunca derruba o resto do tick (a próxima
 * rodada replaneja; a unicidade `(cycleKey, step, channel)` impede qualquer duplicado).
 */
async function runDunningRound(
  now: Date,
  summary: BillingTickSummary,
  budget: TickBudget,
  gateway: MercadoPagoGateway | undefined,
  deps?: DispatchDeps,
) {
  try {
    const run = await runDunning(now, { budget, deps: { ...deps, gateway: deps?.gateway ?? gateway } });
    const d = run.dispatch;
    summary.noticesEnqueued = run.enqueued;
    summary.noticesSent = d.sent;
    summary.noticesSkipped = d.skipped;
    summary.noticesFailed = d.failed;
    summary.noticesDeferred = d.deferred;
    summary.emailsFailed += d.emailsFailed;
    summary.suspensionEmailsSent = d.emailSentSteps.filter((step) => step === "SUSPENDED").length;
    summary.remindersSent = d.emailSentSteps.filter((step) => step !== "SUSPENDED" && step !== "INVOICE_CREATED" && step !== "PAYMENT_CONFIRMED" && step !== "AUTO_CANCELED").length;
  } catch (error) {
    logger.error("billing.tick.dunning_failed", { ...describeDbError(error) });
  }
}

async function reconcileStatuses(
  prisma: ReturnType<typeof getPrisma>,
  now: Date,
  summary: BillingTickSummary,
  budget: TickBudget,
  gateway?: MercadoPagoGateway,
) {
  const subscriptions = await prisma.subscription.findMany({
    where: { status: { not: "CANCELED" } },
    include: { tenant: true },
  });

  for (const subscription of subscriptions) {
    if (budget.isOver()) break; // o resto das transições entra na próxima rodada
    const next = effectiveStatus({ ...subscription, timezone: subscription.tenant.timezone }, now);
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
      // `suspendedEmailSentAt` deixou de ser escrito: o aviso de suspensão é uma linha do outbox da régua.
      data: { status: next },
    });
    if (claimed.count === 0) continue; // mudou no meio do caminho (pagamento/desfazer): próxima rodada reavalia
    summary.statusChanges += 1;
    await recordBillingEvent({
      tenantId: subscription.tenantId,
      subscriptionId: subscription.id,
      type: "STATUS_CHANGED",
      fromStatus: subscription.status,
      toStatus: next,
      metadata: { source: "tick" },
    });
  }

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
    if (budget.isOver()) break;
    try {
      await disconnectAllWhatsappInstances(tenantId);
    } catch (error) {
      logger.warn("billing.tick.cancel_effects_failed", { tenantId, errorMessage: error instanceof Error ? error.message : String(error) });
    }
  }
}

