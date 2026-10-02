import { annualFreeMonths, annualSavingsCents, type BillingCycle, type CouponCycleRule, type CouponDuration, type CouponKind } from "./pricing";

/**
 * Textos curtos dos cupons, usados pelo Admin, pelo cadastro e pela tela Assinatura. Puros, sem travessão
 * (docs/guia-de-voz.md).
 */

function brl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/** "2 meses grátis" quando a economia fecha meses inteiros; senão "economize R$ X no ano"; `null` se o anual não economiza. */
export function annualSavingsLabel(plan: { priceCents: number; annualPriceCents: number | null }): string | null {
  const savings = annualSavingsCents(plan);
  if (savings <= 0) return null;
  const months = annualFreeMonths(plan);
  if (months >= 1 && months * plan.priceCents === savings) return months === 1 ? "1 mês grátis" : `${months} meses grátis`;
  return `economize ${brl(savings)} no ano`;
}

/** "20%" ou "R$ 50,00". */
export function couponDiscountLabel(kind: CouponKind, value: number): string {
  return kind === "PERCENT" ? `${value}%` : brl(value);
}

/** "na primeira cobrança", "nas 3 primeiras cobranças" ou "em todas as cobranças". */
export function couponDurationLabel(duration: CouponDuration, durationCycles: number | null): string {
  if (duration === "ONCE") return "na primeira cobrança";
  if (duration === "N_CYCLES") {
    const n = durationCycles ?? 1;
    return n === 1 ? "na primeira cobrança" : `nas ${n} primeiras cobranças`;
  }
  return "em todas as cobranças";
}

/** Onde o cupom vale quanto ao ciclo. */
export function couponCycleRuleLabel(rule: CouponCycleRule): string {
  if (rule === "MONTHLY") return "só no plano mensal";
  if (rule === "ANNUAL") return "só no plano anual";
  return "mensal ou anual";
}

/** "20% de desconto na primeira cobrança". */
export function couponSummary(kind: CouponKind, value: number, duration: CouponDuration, durationCycles: number | null): string {
  return `${couponDiscountLabel(kind, value)} de desconto ${couponDurationLabel(duration, durationCycles)}`;
}

/** Quantas cobranças com desconto ainda restam; `null` = sem fim. Texto para a tela Assinatura. */
export function couponRemainingLabel(cyclesRemaining: number | null, cycle: BillingCycle): string {
  if (cyclesRemaining === null) return "em todas as próximas cobranças";
  const unit = cycle === "ANNUAL" ? (cyclesRemaining === 1 ? "cobrança anual" : "cobranças anuais") : cyclesRemaining === 1 ? "cobrança" : "cobranças";
  return cyclesRemaining === 1 ? `em mais 1 ${unit}` : `em mais ${cyclesRemaining} ${unit}`;
}
