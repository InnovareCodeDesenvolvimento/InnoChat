import { getPrisma } from "@/lib/db/prisma";
import { lockPlanRow, lockSubscriptionRow } from "@/lib/db/billing-row-locks";
import { DomainError } from "@/lib/errors";
import { couponAcceptsCycle, cycleLabel, planOffersCycle, type BillingCycle } from "@/core/billing";
import { recordBillingEvent } from "./dunning/events";
import type { MercadoPagoGateway } from "./mercadopago";
import { afterTrialReprice, repriceTrialInvoiceInTx, type RepriceOutcome } from "./trial-reprice";

/**
 * Troca do ciclo de cobrança pelo OWNER (mensal, trimestral, semestral ou anual). Sem pro-rata (decisão do dono): a mudança só vale na
 * PRÓXIMA fatura a ser gerada. A fatura que já está em aberto continua como foi emitida e o período já pago
 * não é recalculado nem devolvido.
 *
 * Exceção (cadastro enxuto): no TESTE que ainda não pagou, a fatura aberta do fim do teste é ANULADA e recriada no ciclo novo
 * (`trial-reprice.ts`), porque ciclo e cupom saíram do cadastro e a primeira cobrança precisa refletir a escolha.
 */
export type ChangeBillingCycleResult = {
  billingCycle: BillingCycle;
  /** `true` se já havia fatura em aberto: ela segue no ciclo antigo, a troca vale na seguinte. Sempre `false` quando a fatura do teste foi recriada. */
  openInvoiceKeepsOldCycle: boolean;
  /** `true` se a fatura aberta do TESTE foi anulada e recriada no ciclo novo (o Pix antigo foi cancelado). */
  trialInvoiceRepriced: boolean;
  /** `true` se o cupom em uso não vale no ciclo novo: ele fica guardado (sem gastar ciclos) até voltar ao ciclo dele. */
  couponPaused: boolean;
};

export async function changeBillingCycle(tenantId: string, cycle: BillingCycle, gateway?: MercadoPagoGateway): Promise<ChangeBillingCycleResult> {
  const prisma = getPrisma();
  // Assinatura e plano cobrado travados na mesma transação: o Admin pode estar tirando o preço deste ciclo agora
  // (`updatePlan`, que trava a linha do plano), e uma troca de plano da empresa trava a mesma assinatura.
  const outcome = await prisma.$transaction(async (tx) => {
    await lockSubscriptionRow(tx, tenantId);
    const first = await tx.subscription.findUnique({ where: { tenantId }, select: { planId: true, pendingPlanId: true } });
    if (!first) throw new DomainError("NOT_FOUND", "Assinatura não encontrada para esta empresa.");
    // O plano que vale na PRÓXIMA fatura (o do downgrade agendado, se houver) é o que precisa oferecer o ciclo.
    await lockPlanRow(tx, first.pendingPlanId ?? first.planId);
    const subscription = await tx.subscription.findUnique({ where: { tenantId }, include: { plan: true, coupon: true } });
    if (!subscription) throw new DomainError("NOT_FOUND", "Assinatura não encontrada para esta empresa.");
    if (subscription.status === "CANCELED") throw new DomainError("INVALID_STATE", "Reative a assinatura antes de trocar a cobrança.");
    const billedPlan = subscription.pendingPlanId ? await tx.plan.findUnique({ where: { id: subscription.pendingPlanId } }) : subscription.plan;
    if (!billedPlan) throw new DomainError("NOT_FOUND", "Plano não encontrado.");
    if (!planOffersCycle(billedPlan, cycle)) {
      throw new DomainError(
        "CYCLE_NOT_AVAILABLE",
        subscription.pendingPlanId ? `O plano ${billedPlan.name}, que vale a partir da próxima renovação, não tem cobrança ${cycleLabel(cycle)}.` : `O plano atual não tem cobrança ${cycleLabel(cycle)}.`,
      );
    }
    const openInvoices = await tx.invoice.count({ where: { subscriptionId: subscription.id, status: "OPEN" } });
    const changed = subscription.billingCycle !== cycle;
    if (changed) await tx.subscription.update({ where: { id: subscription.id }, data: { billingCycle: cycle } });
    // Teste que nunca pagou: a fatura aberta acompanha o ciclo novo (mesma transação, assinatura travada).
    const reprice: RepriceOutcome | null = changed ? await repriceTrialInvoiceInTx(tx, tenantId) : null;
    return { subscription, openInvoices, changed, reprice };
  });

  const { subscription, openInvoices, changed, reprice } = outcome;
  if (reprice) await afterTrialReprice(reprice, tenantId, gateway);
  const trialInvoiceRepriced = reprice?.repriced === true;
  if (changed) {
    await recordBillingEvent({
      tenantId,
      subscriptionId: subscription.id,
      type: "PLAN_CHANGED",
      actorType: "OWNER",
      metadata: { billingCycle: cycle, previousCycle: subscription.billingCycle, appliedImmediately: false },
    });
  }
  const couponPaused = Boolean(subscription.coupon && !couponAcceptsCycle(subscription.coupon.appliesToCycles, cycle));
  return { billingCycle: cycle, openInvoiceKeepsOldCycle: openInvoices > 0 && !trialInvoiceRepriced, trialInvoiceRepriced, couponPaused };
}
