import { listActivePlans } from "./service";
import { formatCentsBRL } from "./format";
import { bestCycle, CYCLE_INFO, cycleSavings, cycleSavingsLabel, offeredCycles, type BillingCycle } from "@/core/billing";

/**
 * Planos para a vitrine pública (landing). Vêm SEMPRE do banco (`Plan`, editável em Admin →
 * Planos) — nenhum valor escrito no código. Só os planos `active` aparecem.
 *
 * Cache em memória de 60 s: a landing é renderizada a cada requisição (`force-dynamic`, porque o
 * build de produção roda sem banco) e não deve bater no banco a cada visita. Se o banco falhar,
 * devolve `null` (a seção mostra o convite sem preços) e tenta de novo em 10 s — a página nunca
 * quebra por causa disso.
 */
export type LandingCycle = {
  cycle: BillingCycle;
  /** "Mensal", "Trimestral"... */
  label: string;
  months: number;
  /** "1 mês", "3 meses", "6 meses", "12 meses". */
  every: string;
  /** Valor cobrado de uma vez no período. */
  periodLabel: string;
  /** Equivalente por mês. */
  perMonthLabel: string;
  /** "2 meses grátis" ou "5% de desconto"; `null` no mensal ou sem economia. */
  savingsLabel: string | null;
  /** Economia em % (0 se nenhuma). */
  percent: number;
};

export type LandingPlan = {
  id: string;
  name: string;
  priceCents: number;
  priceLabel: string;
  /** Ciclos que o plano oferece, do mensal ao anual. O mensal vem sempre. */
  cycles: LandingCycle[];
  /** Ciclo com o menor valor por mês ("a partir de R$ 49,17/mês pagando a cada 12 meses"), ou `null` se nenhum economiza. */
  best: { cycle: BillingCycle; every: string; perMonthLabel: string; savingsLabel: string | null } | null;
  professionalsLabel: string;
  whatsappLabel: string;
};

function prices(plan: { priceCents: number; quarterlyPriceCents?: number | null; semiannualPriceCents?: number | null; annualPriceCents?: number | null }) {
  return {
    priceCents: plan.priceCents,
    quarterlyPriceCents: plan.quarterlyPriceCents ?? null,
    semiannualPriceCents: plan.semiannualPriceCents ?? null,
    annualPriceCents: plan.annualPriceCents ?? null,
  };
}

function bestOf(plan: Parameters<typeof prices>[0]): LandingPlan["best"] {
  const best = bestCycle(prices(plan));
  if (!best) return null;
  return {
    cycle: best.cycle,
    every: CYCLE_INFO[best.cycle].every,
    perMonthLabel: formatCentsBRL(best.savings.perMonthCents as number),
    savingsLabel: cycleSavingsLabel(prices(plan), best.cycle),
  };
}

const OK_TTL_MS = 60_000;
const FAIL_TTL_MS = 10_000;

let cache: { at: number; ttl: number; plans: LandingPlan[] | null } | null = null;

function professionalsLabel(max: number | null): string {
  if (max === null) return "Profissionais ilimitados";
  return max === 1 ? "1 profissional" : `Até ${max} profissionais`;
}

function whatsappLabel(max: number): string {
  return max === 1 ? "1 número de WhatsApp" : `${max} números de WhatsApp`;
}

export async function getLandingPlans(now: number = Date.now()): Promise<LandingPlan[] | null> {
  if (cache && now - cache.at < cache.ttl) return cache.plans;
  try {
    const rows = await listActivePlans();
    const plans = rows.map((plan) => ({
      id: plan.id,
      name: plan.name,
      priceCents: plan.priceCents,
      priceLabel: formatCentsBRL(plan.priceCents),
      cycles: offeredCycles(prices(plan)).map((cycle) => {
        const s = cycleSavings(prices(plan), cycle);
        return {
          cycle,
          label: CYCLE_INFO[cycle].label,
          months: CYCLE_INFO[cycle].months,
          every: CYCLE_INFO[cycle].every,
          periodLabel: formatCentsBRL(s.periodCents as number),
          perMonthLabel: formatCentsBRL(s.perMonthCents as number),
          savingsLabel: cycleSavingsLabel(prices(plan), cycle),
          percent: s.percent,
        };
      }),
      best: bestOf(plan),
      professionalsLabel: professionalsLabel(plan.maxProfessionals),
      whatsappLabel: whatsappLabel(plan.maxWhatsappNumbers),
    }));
    cache = { at: now, ttl: OK_TTL_MS, plans };
    return plans;
  } catch {
    cache = { at: now, ttl: FAIL_TTL_MS, plans: null };
    return null;
  }
}

/** Só para testes. */
export function resetLandingPlansCache(): void {
  cache = null;
}
