import { listActivePlans } from "./service";
import { formatCentsBRL } from "./format";

/**
 * Planos para a vitrine pública (landing). Vêm SEMPRE do banco (`Plan`, editável em Admin →
 * Planos) — nenhum valor escrito no código. Só os planos `active` aparecem.
 *
 * Cache em memória de 60 s: a landing é renderizada a cada requisição (`force-dynamic`, porque o
 * build de produção roda sem banco) e não deve bater no banco a cada visita. Se o banco falhar,
 * devolve `null` (a seção mostra o convite sem preços) e tenta de novo em 10 s — a página nunca
 * quebra por causa disso.
 */
export type LandingPlan = {
  id: string;
  name: string;
  priceCents: number;
  priceLabel: string;
  professionalsLabel: string;
  whatsappLabel: string;
};

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
