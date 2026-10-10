import type { Prisma } from "@/lib/db/types";
import { getPrisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { lockSubscriptionRow } from "@/lib/db/billing-row-locks";
import { asBillingCycle, validateCpfCnpj } from "@/core/billing";
import type { MercadoPagoGateway } from "./mercadopago";
import { consumeCouponCycleInTx, loadInvoiceCharge } from "./coupons";
import { recordBillingEvent } from "./dunning/events";
import { suppressInvoiceCreatedNotice } from "./dunning/outbox";
import { cancelPixPayments, findBillingRecipientEmail, generateInvoiceDescription, tryAttachPix, voidOpenInvoices, type VoidedPix } from "./service";

/**
 * Reprecificação da fatura do teste (cadastro enxuto, F2).
 *
 * A fatura que cobre o fim do teste nasce no cadastro (`isTrialConversion`), com o ciclo e o cupom daquele instante. Agora
 * que ciclo e cupom saíram do cadastro, quem escolhe anual ou aplica um cupom DURANTE o teste esperaria a fatura mensal e
 * cheia. Aqui a fatura aberta do teste acompanha a escolha: é ANULADA (VOID) e uma nova nasce com o preço de agora.
 *
 * Por que anular e recriar, e não editar no lugar: se o Pix antigo (mensal) for pago numa corrida, `applyInvoicePayment` de uma
 * fatura VOID só marca `paidWhileVoidAt` (o admin decide o estorno). Editar a mesma linha faria um Pix mensal baixar uma
 * fatura anual e dar 12 meses pelo preço de 1.
 *
 * Roda DENTRO da transação do chamador, com a linha da assinatura já travada (`lockSubscriptionRow`): troca de ciclo,
 * cupom e plano não reprecificam ao mesmo tempo. O efeito de rede (cancelar o Pix velho, gerar o novo) é `afterTrialReprice`,
 * DEPOIS do commit.
 */

export type RepriceOutcome =
  | { repriced: false; reason: "NOT_TRIAL" | "NO_OPEN_TRIAL_INVOICE" | "UNCHANGED" | "PAID_CONCURRENTLY" }
  | { repriced: true; oldInvoiceId: string; newInvoiceId: string; voidedPix: VoidedPix[] };

/**
 * Dentro da transação do chamador (assinatura já travada). A fatura nova usa o plano e o ciclo que valem para a PRÓXIMA
 * cobrança: o plano do downgrade agendado, se houver, e o ciclo atual da assinatura.
 */
export async function repriceTrialInvoiceInTx(tx: Prisma.TransactionClient, tenantId: string, now: Date = new Date()): Promise<RepriceOutcome> {
  const subscription = await tx.subscription.findUnique({ where: { tenantId }, include: { plan: true, pendingPlan: true } });
  // Só teste que nunca pagou: depois do primeiro pagamento a fatura da frente é a do tick, e vale a regra "a partir da próxima".
  if (!subscription || subscription.status !== "TRIALING" || subscription.firstPaidAt !== null) return { repriced: false, reason: "NOT_TRIAL" };

  const old = await tx.invoice.findFirst({
    where: { subscriptionId: subscription.id, isTrialConversion: true, status: "OPEN" },
    orderBy: { periodStart: "desc" },
  });
  if (!old) return { repriced: false, reason: "NO_OPEN_TRIAL_INVOICE" };

  const billedPlan = subscription.pendingPlan ?? subscription.plan;

  // Cupom que entrou na fatura antiga: o resgate aponta para ela (`CouponRedemption.invoiceId`). O cupom pode já ter saído da
  // assinatura (acabou o último ciclo e `couponId` foi limpo), por isso a fonte é o resgate, não `subscription.couponId`.
  const spent = old.discountCents > 0 ? await tx.couponRedemption.findFirst({ where: { tenantId, invoiceId: old.id } }) : null;
  let couponIdForNew = subscription.couponId;
  let restore: { couponId: string; cyclesRemaining: number | null } | null = null;
  if (spent) {
    if (subscription.couponId === null) {
      // O ciclo gasto era o último: o cupom foi desligado. Devolve 1 ciclo e religa.
      restore = { couponId: spent.couponId, cyclesRemaining: 1 };
      couponIdForNew = spent.couponId;
    } else if (subscription.couponId === spent.couponId) {
      // Mesmo cupom ainda em uso: devolve o ciclo (nulo = para sempre, nada a devolver).
      restore = { couponId: spent.couponId, cyclesRemaining: subscription.couponCyclesRemaining === null ? null : subscription.couponCyclesRemaining + 1 };
    }
    // Outro cupom ocupa o lugar: o da fatura antiga não volta (só há um cupom por assinatura); o atual vale para a nova.
  }

  const charge = await loadInvoiceCharge({ couponId: couponIdForNew, billingCycle: subscription.billingCycle }, billedPlan);
  const sameAsOld =
    charge.netCents === old.amountCents &&
    charge.discountCents === old.discountCents &&
    charge.cycle === asBillingCycle(old.cycle) &&
    (charge.discountCents > 0 ? charge.couponCode : null) === (old.couponCode ?? null);
  // Nada mudou para a fatura (ex.: trocar para o ciclo que já é o dela): não mexe, nem cancela o Pix que já existe.
  if (sameAsOld) return { repriced: false, reason: "UNCHANGED" };

  // Anula primeiro, de forma condicional: se um pagamento baixou a fatura no meio do caminho, `count` é 0 e nada mais é tocado.
  const voided = await voidOpenInvoices(tx, { id: old.id });
  if (voided.count === 0) return { repriced: false, reason: "PAID_CONCURRENTLY" };

  if (spent && restore) {
    await tx.couponRedemption.updateMany({ where: { id: spent.id, invoiceId: old.id }, data: { invoiceId: null, discountCents: 0 } });
    await tx.subscription.update({ where: { id: subscription.id }, data: { couponId: restore.couponId, couponCyclesRemaining: restore.cyclesRemaining } });
  } else if (spent) {
    // Sem como devolver (outro cupom ocupa o lugar): o resgate fica preso à fatura anulada, sem reaproveitar o ciclo.
    logger.info("billing.trial_reprice.coupon_not_restored", { tenantId });
  }

  // Mesmo `periodStart` não pode repetir (chave única por assinatura): usa o instante da troca, sempre depois do anterior.
  const periodStart = new Date(Math.max(now.getTime(), old.periodStart.getTime() + 1));
  const created = await tx.invoice.create({
    data: {
      subscriptionId: subscription.id,
      amountCents: charge.netCents,
      discountCents: charge.discountCents,
      couponCode: charge.discountCents > 0 ? charge.couponCode : null,
      cycle: charge.cycle,
      periodStart,
      periodEnd: old.periodEnd,
      dueAt: old.dueAt,
      status: "OPEN",
      isTrialConversion: true,
    },
  });
  if (charge.couponId && charge.discountCents > 0) {
    await consumeCouponCycleInTx(tx, { subscriptionId: subscription.id, tenantId, couponId: charge.couponId, invoiceId: created.id, discountCents: charge.discountCents });
  }

  // "Sua fatura chegou" não se repete a cada troca de ciclo: se a fatura antiga já foi avisada por e-mail, a nova nasce com o
  // aviso tratado. Se ninguém foi avisado ainda (sem CPF/CNPJ), o aviso da nova segue pendente e sai com o Pix quando o documento entrar.
  const alreadyNotified = await tx.billingNotice.findFirst({
    where: { invoiceId: old.id, step: "INVOICE_CREATED", channel: "EMAIL", status: "SENT" },
    select: { id: true },
  });
  if (alreadyNotified) {
    await suppressInvoiceCreatedNotice(tx, { tenantId, subscriptionId: subscription.id, invoiceId: created.id, expiresAt: old.dueAt });
  }

  return { repriced: true, oldInvoiceId: old.id, newInvoiceId: created.id, voidedPix: voided.pix };
}

/**
 * Depois do commit: cancela o Pix da fatura anulada (para ninguém pagar o valor velho) e gera o da nova, se a empresa tem
 * CPF/CNPJ. Nada daqui desfaz a troca: falha de rede só vira log e a tela de Assinatura oferece "Gerar Pix".
 */
export async function afterTrialReprice(outcome: RepriceOutcome, tenantId: string, gateway?: MercadoPagoGateway): Promise<void> {
  if (!outcome.repriced) return;
  try {
    await cancelVoidedPixWithRetry(outcome.voidedPix, gateway);
    const tenant = await getPrisma().tenant.findUnique({ where: { id: tenantId }, select: { name: true, document: true } });
    const hasDocument = Boolean(tenant?.document && validateCpfCnpj(tenant.document).valid);
    const payerEmail = await findBillingRecipientEmail(tenantId);
    const invoice = await getPrisma().invoice.findUnique({ where: { id: outcome.newInvoiceId }, select: { cycle: true, subscriptionId: true, amountCents: true, discountCents: true } });
    if (tenant && hasDocument && payerEmail && invoice) {
      await tryAttachPix(outcome.newInvoiceId, payerEmail, generateInvoiceDescription(tenant.name, asBillingCycle(invoice.cycle)), gateway);
    }
    if (invoice) {
      await recordBillingEvent({
        tenantId,
        subscriptionId: invoice.subscriptionId,
        invoiceId: outcome.newInvoiceId,
        type: "INVOICE_CREATED",
        actorType: "OWNER",
        metadata: { trial: true, repriced: true, replacedInvoiceId: outcome.oldInvoiceId, amountCents: invoice.amountCents, cycle: invoice.cycle, discountCents: invoice.discountCents, hasDocument },
      });
    }
  } catch (error) {
    logger.warn("billing.trial_reprice.after_failed", { tenantId, errorName: error instanceof Error ? error.name : "unknown" });
  }
}

const PIX_CANCEL_PROVIDER = "pix-cancel";
/** O Pix do MP vale 3 dias: depois disso não há mais o que cancelar e a tentativa pendente é encerrada. */
const PIX_CANCEL_RETRY_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Cancela no MP o Pix das faturas anuladas e, se algum cancelamento falhar, deixa a pendência registrada em `ProviderEvent`
 * (`provider = "pix-cancel"`, `processedAt` nulo) para o tick tentar de novo (`retryPendingPixCancellations`). Sem migration.
 * Se o Pix velho for pago antes, `applyInvoicePayment` de fatura anulada só marca `paidWhileVoidAt` e o admin decide o estorno.
 */
async function cancelVoidedPixWithRetry(pix: VoidedPix[], gateway?: MercadoPagoGateway): Promise<void> {
  if (pix.length === 0) return;
  const prisma = getPrisma();
  await prisma.providerEvent
    .createMany({
      data: pix.map((p) => ({ provider: PIX_CANCEL_PROVIDER, providerEventId: p.mpPaymentId, payload: { invoiceId: p.invoiceId, mpEnvironment: p.mpEnvironment } })),
      skipDuplicates: true,
    })
    .catch((error) => logger.warn("billing.pix_cancel.enqueue_failed", { errorName: error instanceof Error ? error.name : "unknown" }));
  for (const item of pix) {
    const { cancelled } = await cancelPixPayments([item], gateway);
    if (cancelled === 1) {
      await prisma.providerEvent
        .updateMany({ where: { provider: PIX_CANCEL_PROVIDER, providerEventId: item.mpPaymentId, processedAt: null }, data: { processedAt: new Date() } })
        .catch(() => undefined);
    }
  }
}

/** Tick: repete o cancelamento dos Pix de faturas anuladas que falharam antes (até 3 dias; depois o Pix já expirou). */
export async function retryPendingPixCancellations(now: Date, gateway?: MercadoPagoGateway): Promise<{ retried: number; cancelled: number }> {
  const prisma = getPrisma();
  const pending = await prisma.providerEvent.findMany({
    where: { provider: PIX_CANCEL_PROVIDER, processedAt: null },
    orderBy: { createdAt: "asc" },
    take: 50,
  });
  let cancelled = 0;
  for (const event of pending) {
    if (now.getTime() - event.createdAt.getTime() > PIX_CANCEL_RETRY_WINDOW_MS) {
      await prisma.providerEvent.updateMany({ where: { id: event.id, processedAt: null }, data: { processedAt: now } });
      continue;
    }
    const payload = event.payload as { invoiceId?: string; mpEnvironment?: VoidedPix["mpEnvironment"] } | null;
    const result = await cancelPixPayments([{ invoiceId: payload?.invoiceId ?? "", mpPaymentId: event.providerEventId, mpEnvironment: payload?.mpEnvironment ?? null }], gateway);
    if (result.cancelled === 1) {
      cancelled += 1;
      await prisma.providerEvent.updateMany({ where: { id: event.id, processedAt: null }, data: { processedAt: now } });
    }
  }
  return { retried: pending.length, cancelled };
}

/** Versão autônoma (cria a própria transação e trava a assinatura). Usada onde não há outra mudança junto, e nos testes. */
export async function repriceTrialInvoice(tenantId: string, options: { now?: Date; gateway?: MercadoPagoGateway } = {}): Promise<RepriceOutcome> {
  const outcome = await getPrisma().$transaction(async (tx) => {
    await lockSubscriptionRow(tx, tenantId);
    return repriceTrialInvoiceInTx(tx, tenantId, options.now ?? new Date());
  });
  await afterTrialReprice(outcome, tenantId, options.gateway);
  return outcome;
}
