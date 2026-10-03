import type { PlanPrices } from "@/core/billing";

/** Preços do plano que o cadastro assume (o padrão de cadastro), lidos do banco pela página. */
export type SignupPricing = PlanPrices & { planName: string };

/** Monta os preços do cadastro a partir da linha do plano; plano sem mensalidade (> 0) não tem escolha de ciclo. */
export function signupPricingOf(plan: (PlanPrices & { name: string }) | null): SignupPricing | null {
  if (!plan || plan.priceCents <= 0) return null;
  return {
    planName: plan.name,
    priceCents: plan.priceCents,
    quarterlyPriceCents: plan.quarterlyPriceCents,
    semiannualPriceCents: plan.semiannualPriceCents,
    annualPriceCents: plan.annualPriceCents,
  };
}
