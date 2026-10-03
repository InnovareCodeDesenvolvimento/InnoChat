import { CYCLE_INFO, cycleSavings, offeredCycles, type BillingCycle, type PlanPrices } from "./pricing";
import { cycleSavingsLabel } from "./coupon-labels";

/**
 * Dados prontos para desenhar o seletor "Pagar a cada 1, 3, 6 ou 12 meses" (cadastro, tela Assinatura e
 * landing). Puro: o componente só formata. Só entram os ciclos que o plano oferece; o mensal vem sempre.
 */
export type CycleOptionData = {
  cycle: BillingCycle;
  months: number;
  /** "Mensal", "Trimestral"... */
  label: string;
  /** "1 mês", "3 meses"... */
  every: string;
  /** Valor cobrado de uma vez. */
  periodCents: number;
  /** Equivalente por mês, arredondado. */
  perMonthCents: number;
  /** Economia contra pagar o mensal pelo mesmo período (0 no mensal). */
  savingsCents: number;
  percent: number;
  /** "2 meses grátis" / "5% de desconto" / `null`. */
  savingsLabel: string | null;
};

export function buildCycleOptions(plan: PlanPrices): CycleOptionData[] {
  return offeredCycles(plan).map((cycle) => {
    const s = cycleSavings(plan, cycle);
    return {
      cycle,
      months: CYCLE_INFO[cycle].months,
      label: CYCLE_INFO[cycle].label,
      every: CYCLE_INFO[cycle].every,
      periodCents: s.periodCents as number,
      perMonthCents: s.perMonthCents as number,
      savingsCents: s.savingsCents,
      percent: s.percent,
      savingsLabel: cycleSavingsLabel(plan, cycle),
    };
  });
}
