import { getPrisma } from "@/lib/db/prisma";
import { DomainError } from "@/lib/errors";
import { planOffersAnnual, type BillingCycle } from "@/core/billing";
import { recordBillingEvent } from "./dunning/events";

/**
 * Troca do ciclo de cobrança pelo OWNER (mensal <-> anual). Sem pro-rata (decisão do dono): a mudança só vale na
 * PRÓXIMA fatura a ser gerada. A fatura que já está em aberto continua como foi emitida e o período já pago
 * não é recalculado nem devolvido.
 */
export type ChangeBillingCycleResult = {
  billingCycle: BillingCycle;
  /** `true` se já havia fatura em aberto: ela segue no ciclo antigo, a troca vale na seguinte. */
  openInvoiceKeepsOldCycle: boolean;
  /** `true` se o cupom em uso não vale no ciclo novo: ele fica guardado (sem gastar ciclos) até voltar ao ciclo dele. */
  couponPaused: boolean;
};

export async function changeBillingCycle(tenantId: string, cycle: BillingCycle): Promise<ChangeBillingCycleResult> {
  const prisma = getPrisma();
  const subscription = await prisma.subscription.findUnique({ where: { tenantId }, include: { plan: true, coupon: true } });
  if (!subscription) throw new DomainError("NOT_FOUND", "Assinatura não encontrada para esta empresa.");
  if (subscription.status === "CANCELED") throw new DomainError("INVALID_STATE", "Reative a assinatura antes de trocar a cobrança.");
  if (cycle === "ANNUAL" && !planOffersAnnual(subscription.plan)) {
    throw new DomainError("ANNUAL_NOT_AVAILABLE", "O plano atual não tem cobrança anual.");
  }

  const openInvoices = await prisma.invoice.count({ where: { subscriptionId: subscription.id, status: "OPEN" } });
  if (subscription.billingCycle !== cycle) {
    await prisma.subscription.update({ where: { id: subscription.id }, data: { billingCycle: cycle } });
    await recordBillingEvent({
      tenantId,
      subscriptionId: subscription.id,
      type: "PLAN_CHANGED",
      actorType: "OWNER",
      metadata: { billingCycle: cycle, previousCycle: subscription.billingCycle, appliedImmediately: false },
    });
  }
  const couponPaused = Boolean(subscription.coupon && subscription.coupon.appliesToCycle !== "ANY" && subscription.coupon.appliesToCycle !== cycle);
  return { billingCycle: cycle, openInvoiceKeepsOldCycle: openInvoices > 0, couponPaused };
}
