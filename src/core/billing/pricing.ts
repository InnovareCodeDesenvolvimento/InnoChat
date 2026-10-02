/**
 * Preço da fatura: ciclo (mensal/anual) e cupom. Tudo puro (sem banco, sem relógio implícito), para o
 * mesmo cálculo valer no cadastro, na tela de Assinatura, no `billing/tick` e nos testes.
 *
 * Regras:
 * - `Invoice.amountCents` é sempre o LÍQUIDO (o que o Pix cobra). Bruto = líquido + `discountCents`.
 * - Cupom PERCENT: `value` de 1 a 100, sobre o bruto do ciclo. AMOUNT: `value` em centavos, por fatura coberta.
 * - O desconto nunca deixa o líquido abaixo de `MIN_CHARGE_CENTS` (o Mercado Pago não gera Pix de valor
 *   ínfimo/zero). Cupom de 100% ou AMOUNT maior que a fatura cai no mínimo, nunca em zero ou negativo.
 */

export type BillingCycle = "MONTHLY" | "ANNUAL";
export const BILLING_CYCLES: readonly BillingCycle[] = ["MONTHLY", "ANNUAL"];

export type CouponKind = "PERCENT" | "AMOUNT";
export type CouponDuration = "ONCE" | "N_CYCLES" | "FOREVER";
export type CouponCycleRule = "ANY" | "MONTHLY" | "ANNUAL";

/** Menor cobrança Pix que mandamos ao Mercado Pago (R$ 1,00): abaixo disso o desconto é limitado. */
export const MIN_CHARGE_CENTS = 100;

export const COUPON_CODE_PATTERN = /^[A-Z0-9_-]{3,32}$/;

/** `"  verao10 "` -> `"VERAO10"`. Não valida; use `isValidCouponCode` depois. */
export function normalizeCouponCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function isValidCouponCode(code: string): boolean {
  return COUPON_CODE_PATTERN.test(code);
}

/** Meses que o ciclo cobre. */
export function cycleMonths(cycle: BillingCycle): number {
  return cycle === "ANNUAL" ? 12 : 1;
}

export function cycleLabel(cycle: BillingCycle): string {
  return cycle === "ANNUAL" ? "anual" : "mensal";
}

export type PlanPrices = { priceCents: number; annualPriceCents: number | null };

/** O plano oferece cobrança anual (preço anual definido e positivo). */
export function planOffersAnnual(plan: PlanPrices): boolean {
  return plan.annualPriceCents !== null && plan.annualPriceCents > 0;
}

/**
 * Ciclo realmente cobrável: pedir ANUAL num plano sem preço anual (o admin pode tirar o preço depois)
 * cai em MONTHLY em vez de cobrar errado.
 */
export function effectiveCycle(plan: PlanPrices, requested: BillingCycle): BillingCycle {
  return requested === "ANNUAL" && planOffersAnnual(plan) ? "ANNUAL" : "MONTHLY";
}

/** Bruto (preço de tabela) de um ciclo. */
export function grossCentsFor(plan: PlanPrices, cycle: BillingCycle): number {
  return cycle === "ANNUAL" && planOffersAnnual(plan) ? (plan.annualPriceCents as number) : plan.priceCents;
}

/** Quanto o anual economiza em relação a 12 mensalidades (0 se não há anual ou se não compensa). */
export function annualSavingsCents(plan: PlanPrices): number {
  if (!planOffersAnnual(plan)) return 0;
  return Math.max(0, plan.priceCents * 12 - (plan.annualPriceCents as number));
}

/** Economia em meses de mensalidade, arredondada para baixo ("2 meses grátis"). 0 se menos de 1 mês. */
export function annualFreeMonths(plan: PlanPrices): number {
  if (plan.priceCents <= 0) return 0;
  return Math.floor(annualSavingsCents(plan) / plan.priceCents);
}

/** Equivalente mensal do anual (MRR de um plano anual), em centavos, arredondado. */
export function annualMonthlyEquivalentCents(annualPriceCents: number): number {
  return Math.round(annualPriceCents / 12);
}

/** Contribuição da assinatura para o MRR: o mensal, ou o anual dividido por 12. */
export function mrrContributionCents(plan: PlanPrices, cycle: BillingCycle): number {
  return cycle === "ANNUAL" && planOffersAnnual(plan) ? annualMonthlyEquivalentCents(plan.annualPriceCents as number) : plan.priceCents;
}

export type CouponTerms = {
  kind: CouponKind;
  value: number;
};

export type InvoicePricing = {
  cycle: BillingCycle;
  grossCents: number;
  discountCents: number;
  netCents: number;
};

/** Desconto bruto que o cupom daria (antes do piso do mínimo). */
function rawDiscount(grossCents: number, coupon: CouponTerms): number {
  if (coupon.kind === "PERCENT") return Math.floor((grossCents * Math.min(Math.max(coupon.value, 0), 100)) / 100);
  return Math.max(coupon.value, 0);
}

/**
 * Preço de uma fatura: bruto do ciclo menos o cupom (se houver), respeitando o piso. `grossCents` abaixo ou
 * igual ao piso não recebe desconto (já é o mínimo).
 */
export function priceInvoice(plan: PlanPrices, requestedCycle: BillingCycle, coupon: CouponTerms | null): InvoicePricing {
  const cycle = effectiveCycle(plan, requestedCycle);
  const grossCents = grossCentsFor(plan, cycle);
  if (!coupon) return { cycle, grossCents, discountCents: 0, netCents: grossCents };
  const maxDiscount = Math.max(0, grossCents - MIN_CHARGE_CENTS);
  const discountCents = Math.min(rawDiscount(grossCents, coupon), maxDiscount);
  return { cycle, grossCents, discountCents, netCents: grossCents - discountCents };
}

/** `couponCyclesRemaining` inicial ao adotar o cupom: ONCE = 1, N_CYCLES = N, FOREVER = nulo (sem fim). */
export function initialCouponCycles(duration: CouponDuration, durationCycles: number | null): number | null {
  if (duration === "ONCE") return 1;
  if (duration === "N_CYCLES") return durationCycles ?? 1;
  return null;
}

export type CouponEligibilityInput = {
  active: boolean;
  validFrom: Date | null;
  validUntil: Date | null;
  maxRedemptions: number | null;
  redemptionsCount: number;
  appliesToCycle: CouponCycleRule;
  /** Planos válidos; lista vazia = todos. */
  planIds: readonly string[];
};

export type CouponIneligibleReason =
  | "INACTIVE"
  | "NOT_STARTED"
  | "EXPIRED"
  | "EXHAUSTED"
  | "WRONG_PLAN"
  | "WRONG_CYCLE";

/** Por que o cupom NÃO vale agora para este plano e ciclo (`null` = vale). Só leitura: o resgate de verdade é atômico no banco. */
export function couponIneligibleReason(
  coupon: CouponEligibilityInput,
  ctx: { planId: string; cycle: BillingCycle; now: Date },
): CouponIneligibleReason | null {
  if (!coupon.active) return "INACTIVE";
  if (coupon.validFrom && ctx.now < coupon.validFrom) return "NOT_STARTED";
  if (coupon.validUntil && ctx.now > coupon.validUntil) return "EXPIRED";
  if (coupon.maxRedemptions !== null && coupon.redemptionsCount >= coupon.maxRedemptions) return "EXHAUSTED";
  if (coupon.planIds.length > 0 && !coupon.planIds.includes(ctx.planId)) return "WRONG_PLAN";
  if (coupon.appliesToCycle !== "ANY" && coupon.appliesToCycle !== ctx.cycle) return "WRONG_CYCLE";
  return null;
}
