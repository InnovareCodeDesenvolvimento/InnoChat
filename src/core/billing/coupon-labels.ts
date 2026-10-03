import { BILLING_CYCLES, CYCLE_INFO, cycleMonths, cycleSavings, normalizeCouponCycles, type BillingCycle, type CouponDuration, type CouponKind, type PlanPrices } from "./pricing";

/**
 * Textos curtos dos cupons e dos ciclos, usados pelo Admin, pelo cadastro e pela tela Assinatura. Puros, sem
 * travessão (docs/guia-de-voz.md).
 */

function brl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/**
 * Economia de um ciclo contra a mensalidade: "2 meses grátis" quando fecha meses inteiros, senão "5% de
 * desconto". `null` se o plano não oferece o ciclo, é o mensal ou não economiza.
 */
export function cycleSavingsLabel(plan: PlanPrices, cycle: BillingCycle): string | null {
  if (cycle === "MONTHLY") return null;
  const savings = cycleSavings(plan, cycle);
  if (savings.savingsCents <= 0) return null;
  if (savings.freeMonthsExact) return savings.freeMonths === 1 ? "1 mês grátis" : `${savings.freeMonths} meses grátis`;
  return savings.percent >= 1 ? `${savings.percent}% de desconto` : `economize ${brl(savings.savingsCents)}`;
}

/** "20%" ou "R$ 50,00". */
export function couponDiscountLabel(kind: CouponKind, value: number): string {
  return kind === "PERCENT" ? `${value}%` : brl(value);
}

/** "na primeira fatura", "nas 3 primeiras faturas" ou "em todas as faturas". A duração conta FATURAS, não meses. */
export function couponDurationLabel(duration: CouponDuration, durationCycles: number | null): string {
  if (duration === "ONCE") return "na primeira fatura";
  if (duration === "N_CYCLES") {
    const n = durationCycles ?? 1;
    return n === 1 ? "na primeira fatura" : `nas ${n} primeiras faturas`;
  }
  return "em todas as faturas";
}

/** Onde o cupom vale quanto ao ciclo: "todos os ciclos", "só no trimestral" ou "trimestral e semestral". */
export function couponCyclesLabel(appliesToCycles: readonly string[]): string {
  const cycles = normalizeCouponCycles(appliesToCycles);
  if (cycles.length === 0) return "todos os ciclos";
  const words = cycles.map((c) => CYCLE_INFO[c].word);
  if (words.length === 1) return `só no ${words[0]}`;
  return `${words.slice(0, -1).join(", ")} e ${words[words.length - 1]}`;
}

/**
 * Aviso de que a duração do cupom conta FATURAS: "3 faturas, cerca de 9 meses no trimestral". Com mais de um
 * ciclo possível, mostra o menor e o maior período.
 */
export function couponDurationHint(durationCycles: number, appliesToCycles: readonly string[]): string {
  const cycles = normalizeCouponCycles(appliesToCycles);
  const list: readonly BillingCycle[] = cycles.length === 0 ? BILLING_CYCLES : cycles;
  const invoices = durationCycles === 1 ? "1 fatura" : `${durationCycles} faturas`;
  if (list.length === 1) {
    const months = durationCycles * cycleMonths(list[0]);
    return `${invoices}, cerca de ${months === 1 ? "1 mês" : `${months} meses`} no ${CYCLE_INFO[list[0]].word}`;
  }
  const shortest = list.reduce((x, y) => (cycleMonths(y) < cycleMonths(x) ? y : x));
  const longest = list.reduce((x, y) => (cycleMonths(y) > cycleMonths(x) ? y : x));
  const monthsLabel = (n: number) => (n === 1 ? "1 mês" : `${n} meses`);
  return `${invoices}: de ${monthsLabel(durationCycles * cycleMonths(shortest))} no ${CYCLE_INFO[shortest].word} a ${monthsLabel(durationCycles * cycleMonths(longest))} no ${CYCLE_INFO[longest].word}`;
}

/** "20% de desconto na primeira fatura". */
export function couponSummary(kind: CouponKind, value: number, duration: CouponDuration, durationCycles: number | null): string {
  return `${couponDiscountLabel(kind, value)} de desconto ${couponDurationLabel(duration, durationCycles)}`;
}

/** Quantas faturas com desconto ainda restam; `null` = sem fim. Texto para a tela Assinatura. */
export function couponRemainingLabel(cyclesRemaining: number | null): string {
  if (cyclesRemaining === null) return "em todas as próximas faturas";
  return cyclesRemaining === 1 ? "em mais 1 fatura" : `em mais ${cyclesRemaining} faturas`;
}

/** Complemento do valor de uma fatura: "" no mensal, " do plano trimestral (3 meses)" nos demais. */
export function invoiceCoverageSuffix(cycle: BillingCycle): string {
  return cycle === "MONTHLY" ? "" : ` do plano ${CYCLE_INFO[cycle].word} (${CYCLE_INFO[cycle].every})`;
}
