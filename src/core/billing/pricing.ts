/**
 * Preço da fatura: ciclo (mensal, trimestral, semestral, anual) e cupom. Tudo puro (sem banco, sem relógio
 * implícito), para o mesmo cálculo valer no cadastro, na tela de Assinatura, no `billing/tick` e nos testes.
 *
 * Regras:
 * - O preço de cada ciclo é o valor cobrado DE UMA VEZ no período (não por mês). O mensal é `priceCents`
 *   (sempre existe); os demais são opcionais e nulo = ciclo NÃO oferecido pelo plano.
 * - `Invoice.amountCents` é sempre o LÍQUIDO (o que o Pix cobra). Bruto = líquido + `discountCents`.
 * - Cupom PERCENT: `value` de 1 a 100, sobre o bruto do ciclo. AMOUNT: `value` em centavos, por fatura coberta.
 * - O desconto nunca deixa o líquido abaixo de `MIN_CHARGE_CENTS` (o Mercado Pago não gera Pix de valor
 *   ínfimo/zero). Cupom de 100% ou AMOUNT maior que a fatura cai no mínimo, nunca em zero ou negativo.
 * - Cupom `durationCycles` conta FATURAS, não meses (3 faturas num plano trimestral = 9 meses).
 */

export const BILLING_CYCLES = ["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL"] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export type CycleInfo = {
  months: number;
  /** "Mensal", "Trimestral"... (título de botão e coluna). */
  label: string;
  /** "mensal", "trimestral"... (no meio da frase: "plano trimestral"). */
  word: string;
  /** "1 mês", "3 meses"... ("a cada 3 meses"). */
  every: string;
};

/** Fonte única dos ciclos: meses, rótulo e "a cada N meses". Nada mais no código deve decidir isso por `if`. */
export const CYCLE_INFO: Record<BillingCycle, CycleInfo> = {
  MONTHLY: { months: 1, label: "Mensal", word: "mensal", every: "1 mês" },
  QUARTERLY: { months: 3, label: "Trimestral", word: "trimestral", every: "3 meses" },
  SEMIANNUAL: { months: 6, label: "Semestral", word: "semestral", every: "6 meses" },
  ANNUAL: { months: 12, label: "Anual", word: "anual", every: "12 meses" },
};

/** Coluna de `Plan` que guarda o preço do ciclo. */
export const CYCLE_PRICE_FIELD = {
  MONTHLY: "priceCents",
  QUARTERLY: "quarterlyPriceCents",
  SEMIANNUAL: "semiannualPriceCents",
  ANNUAL: "annualPriceCents",
} as const satisfies Record<BillingCycle, string>;

/** Seleção de preços para `select` do Prisma: usar em toda leitura de plano que precise cobrar. */
export const PLAN_PRICES_SELECT = { priceCents: true, quarterlyPriceCents: true, semiannualPriceCents: true, annualPriceCents: true } as const;

export type CouponKind = "PERCENT" | "AMOUNT";
export type CouponDuration = "ONCE" | "N_CYCLES" | "FOREVER";

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

/** Valor vindo de fora (banco, formulário) que é um dos 4 ciclos; qualquer outra coisa vira `null`. */
export function parseBillingCycle(value: unknown): BillingCycle | null {
  return typeof value === "string" && (BILLING_CYCLES as readonly string[]).includes(value) ? (value as BillingCycle) : null;
}

/** Como `parseBillingCycle`, mas o desconhecido vira MONTHLY (lido de coluna que o banco já restringe). */
export function asBillingCycle(value: unknown): BillingCycle {
  return parseBillingCycle(value) ?? "MONTHLY";
}

/** Meses que o ciclo cobre. */
export function cycleMonths(cycle: BillingCycle): number {
  return CYCLE_INFO[cycle].months;
}

/** "mensal", "trimestral", "semestral" ou "anual" (minúsculo, para o meio da frase). */
export function cycleLabel(cycle: BillingCycle): string {
  return CYCLE_INFO[cycle].word;
}

/** "Mensal", "Trimestral", "Semestral" ou "Anual". */
export function cycleTitle(cycle: BillingCycle): string {
  return CYCLE_INFO[cycle].label;
}

/** "a cada 3 meses" / "a cada 1 mês". */
export function cycleEveryLabel(cycle: BillingCycle): string {
  return `a cada ${CYCLE_INFO[cycle].every}`;
}

export type PlanPrices = {
  priceCents: number;
  quarterlyPriceCents: number | null;
  semiannualPriceCents: number | null;
  annualPriceCents: number | null;
};

/** Preço do ciclo no plano; `null` = não oferecido (o mensal sempre existe). */
export function priceFor(plan: PlanPrices, cycle: BillingCycle): number | null {
  if (cycle === "MONTHLY") return plan.priceCents;
  const value = plan[CYCLE_PRICE_FIELD[cycle]];
  return value !== null && value > 0 ? value : null;
}

/** O plano oferece o ciclo (mensal sempre; os outros só com preço positivo). */
export function planOffersCycle(plan: PlanPrices, cycle: BillingCycle): boolean {
  return priceFor(plan, cycle) !== null;
}

/** Ciclos oferecidos pelo plano, do menor para o maior. O mensal vem sempre primeiro. */
export function offeredCycles(plan: PlanPrices): BillingCycle[] {
  return BILLING_CYCLES.filter((cycle) => planOffersCycle(plan, cycle));
}

/**
 * Ciclo realmente cobrável: pedir um ciclo que o plano não oferece (o admin pode tirar o preço depois, ou a
 * empresa trocou de plano) cai em MONTHLY em vez de cobrar errado.
 */
export function effectiveCycle(plan: PlanPrices, requested: BillingCycle): BillingCycle {
  return planOffersCycle(plan, requested) ? requested : "MONTHLY";
}

/** Bruto (preço de tabela) de um ciclo. Ciclo não oferecido cai no mensal, como `effectiveCycle`. */
export function grossCentsFor(plan: PlanPrices, cycle: BillingCycle): number {
  return priceFor(plan, cycle) ?? plan.priceCents;
}

/** Equivalente por mês de um preço de período, em centavos, arredondado. */
export function monthlyEquivalentCents(periodPriceCents: number, cycle: BillingCycle): number {
  return Math.round(periodPriceCents / cycleMonths(cycle));
}

/** Contribuição da assinatura para o MRR: o preço do ciclo dividido pelos meses dele. */
export function mrrContributionCents(plan: PlanPrices, cycle: BillingCycle): number {
  const effective = effectiveCycle(plan, cycle);
  return monthlyEquivalentCents(grossCentsFor(plan, effective), effective);
}

export type CycleSavings = {
  /** Quanto o ciclo economiza em relação a pagar o mensal pelos mesmos meses (0 se não oferece ou não compensa). */
  savingsCents: number;
  /** Mesma economia em %, inteiro arredondado (0 a 100). */
  percent: number;
  /** Mensalidades inteiras que a economia equivale ("2 meses grátis"); 0 se menos de 1. */
  freeMonths: number;
  /** `true` quando a economia fecha meses inteiros exatos. */
  freeMonthsExact: boolean;
  /** Preço do período e o equivalente por mês (`null` se o plano não oferece o ciclo). */
  periodCents: number | null;
  perMonthCents: number | null;
};

/** Economia de um ciclo contra a mensalidade (tudo derivado de `priceCents * meses`; nada é gravado). */
export function cycleSavings(plan: PlanPrices, cycle: BillingCycle): CycleSavings {
  const periodCents = priceFor(plan, cycle);
  if (periodCents === null) return { savingsCents: 0, percent: 0, freeMonths: 0, freeMonthsExact: false, periodCents: null, perMonthCents: null };
  const full = plan.priceCents * cycleMonths(cycle);
  const savingsCents = Math.max(0, full - periodCents);
  const percent = full > 0 ? Math.round((savingsCents / full) * 100) : 0;
  const freeMonths = plan.priceCents > 0 ? Math.floor(savingsCents / plan.priceCents) : 0;
  return {
    savingsCents,
    percent,
    freeMonths,
    freeMonthsExact: freeMonths >= 1 && freeMonths * plan.priceCents === savingsCents,
    periodCents,
    perMonthCents: monthlyEquivalentCents(periodCents, cycle),
  };
}

/** Maior economia (em %) entre os ciclos oferecidos; `null` se nenhum economiza. Para a landing. */
export function bestCycle(plan: PlanPrices): { cycle: BillingCycle; savings: CycleSavings } | null {
  let best: { cycle: BillingCycle; savings: CycleSavings } | null = null;
  for (const cycle of offeredCycles(plan)) {
    if (cycle === "MONTHLY") continue;
    const savings = cycleSavings(plan, cycle);
    if (savings.savingsCents > 0 && (best === null || savings.perMonthCents! < best.savings.perMonthCents!)) best = { cycle, savings };
  }
  return best;
}

export type SuggestedPrice = {
  cycle: Exclude<BillingCycle, "MONTHLY">;
  /** Preço cheio do período (mensal x meses). */
  fullCents: number;
  /** Valor exato da regra, antes de arredondar. */
  rawCents: number;
  /** Valor sugerido, em reais inteiros (o admin pode editar). */
  roundedCents: number;
  /** Regra aplicada, em texto ("5% de desconto", "2 meses grátis"). */
  rule: string;
};

/** Abaixo desta fração de (mensal x meses) o preço do período pede confirmação explícita do admin (quase sempre é erro de digitação). */
export const LOW_CYCLE_PRICE_RATIO = 0.5;

/** `true` quando o preço do período é menos da metade das mensalidades do período. Sem mensal definido não há base: `false`. */
export function isLowCyclePrice(monthlyCents: number, cycle: BillingCycle, periodCents: number): boolean {
  if (!(monthlyCents > 0)) return false;
  return periodCents < monthlyCents * cycleMonths(cycle) * LOW_CYCLE_PRICE_RATIO;
}

/**
 * Sugestão de preços: trimestral com 5% de desconto, semestral com 10% e anual com 2 meses grátis, arredondados
 * para reais inteiros. Nunca passa de mensal x meses nem cai abaixo do mínimo. Mensal inválido devolve `[]`.
 */
export function suggestCyclePrices(monthlyCents: number): SuggestedPrice[] {
  if (!Number.isFinite(monthlyCents) || monthlyCents < MIN_CHARGE_CENTS) return [];
  const make = (cycle: SuggestedPrice["cycle"], rawCents: number, rule: string): SuggestedPrice => {
    const fullCents = monthlyCents * cycleMonths(cycle);
    const rounded = Math.round(rawCents / 100) * 100;
    const roundedCents = Math.min(fullCents, Math.max(MIN_CHARGE_CENTS, rounded));
    return { cycle, fullCents, rawCents: Math.round(rawCents), roundedCents, rule };
  };
  return [
    make("QUARTERLY", monthlyCents * 3 * 0.95, "5% de desconto"),
    make("SEMIANNUAL", monthlyCents * 6 * 0.9, "10% de desconto"),
    make("ANNUAL", monthlyCents * 10, "2 meses grátis"),
  ];
}

/** Lista de ciclos de cupom normalizada: só os 4 válidos, sem repetir, na ordem; os 4 marcados viram `[]` (todos). */
export function normalizeCouponCycles(cycles: readonly string[]): BillingCycle[] {
  const set = new Set(cycles);
  const picked = BILLING_CYCLES.filter((cycle) => set.has(cycle));
  return picked.length === BILLING_CYCLES.length ? [] : picked;
}

/** O cupom vale no ciclo? Lista vazia = todos. */
export function couponAcceptsCycle(appliesToCycles: readonly string[], cycle: BillingCycle): boolean {
  return appliesToCycles.length === 0 || appliesToCycles.includes(cycle);
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

/** `couponCyclesRemaining` inicial ao adotar o cupom: ONCE = 1, N_CYCLES = N, FOREVER = nulo (sem fim). Conta FATURAS. */
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
  /** Ciclos válidos; lista vazia = todos. */
  appliesToCycles: readonly string[];
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
  if (!couponAcceptsCycle(coupon.appliesToCycles, ctx.cycle)) return "WRONG_CYCLE";
  return null;
}
