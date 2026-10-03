"use client";

import { useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { BILLING_CYCLES, CYCLE_INFO, TRIAL_DAYS, type BillingCycle, type CycleOptionData } from "@/core/billing";
import { cn } from "@/components/lib/cn";
import { CycleSelector } from "@/components/billing/cycle-selector";
import type { LandingPlan } from "@/modules/billing/landing-plans";
import { Button } from "@/components/ui/button";

const INCLUDED = [
  "Bot de agendamento 24 horas pelo WhatsApp",
  "Lembretes automáticos antes do horário",
  "Atendimento humano pelo painel",
  "Aviso ao cliente quando a equipe altera a agenda",
  "Indicadores, papéis para a equipe e textos editáveis",
];

/** Plano em destaque: o do meio quando há 3 ou mais (nunca um valor fixo do código). */
function featuredIndex(count: number): number {
  return count >= 3 ? Math.floor(count / 2) : -1;
}

/**
 * Opções do seletor da vitrine: todo ciclo que ao menos um plano oferece. O selo de economia mostra a MAIOR
 * economia entre os planos (a conta de cada plano aparece no próprio cartão).
 */
function selectorOptions(plans: LandingPlan[]): CycleOptionData[] {
  const out: CycleOptionData[] = [];
  for (const cycle of BILLING_CYCLES) {
    const offered = plans.flatMap((p) => p.cycles.filter((c) => c.cycle === cycle));
    if (offered.length === 0) continue;
    const bestPercent = Math.max(...offered.map((c) => c.percent));
    out.push({
      cycle,
      months: CYCLE_INFO[cycle].months,
      label: CYCLE_INFO[cycle].label,
      every: CYCLE_INFO[cycle].every,
      periodCents: 0,
      perMonthCents: 0,
      savingsCents: bestPercent > 0 ? 1 : 0,
      percent: bestPercent,
      savingsLabel: null,
    });
  }
  return out;
}

/**
 * Cartões de plano da vitrine, com um seletor "Pagar a cada 1, 3, 6 ou 12 meses" (só aparece se algum plano oferece
 * mais que o mensal). Começa no mensal, e cada cartão mostra "a partir de R$ X por mês pagando a cada N meses"
 * para a opção mais vantajosa do plano. Valores vêm do banco (`getLandingPlans`), nada escrito aqui.
 */
export function PricingCards({ plans }: { plans: LandingPlan[] }) {
  const options = selectorOptions(plans);
  const [cycle, setCycle] = useState<BillingCycle>("MONTHLY");
  const featured = featuredIndex(plans.length);
  const showSelector = options.length > 1;
  const top = options.reduce<CycleOptionData | null>((best, o) => (o.cycle !== "MONTHLY" && (best === null || o.percent > best.percent) ? o : best), null);

  return (
    <>
      {showSelector ? (
        <div className="mx-auto mt-10 max-w-xl" data-testid="planos-ciclos">
          <CycleSelector options={options} value={cycle} onChange={setCycle} name="planos-ciclo" legend="Pagar a cada" primary="name" testId="ciclo-seletor" showDetail={false} />
          {top && top.percent > 0 ? (
            <p className="mt-2 text-center text-sm text-text-secondary">
              Pagando a cada {top.every}, você economiza até <strong className="font-semibold text-success">{top.percent}%</strong>.
            </p>
          ) : null}
        </div>
      ) : null}

      <ul
        data-testid="planos-lista"
        className={cn(
          "mx-auto mt-14 grid max-w-md gap-6 lg:items-stretch",
          plans.length === 2 && "lg:max-w-4xl lg:grid-cols-2",
          plans.length >= 3 && "lg:max-w-none lg:grid-cols-3",
        )}
      >
        {plans.map((plan, index) => {
          const isFeatured = index === featured;
          const chosen = plan.cycles.find((c) => c.cycle === cycle);
          const shown = chosen ?? plan.cycles[0];
          const onlyMonthly = !chosen && cycle !== "MONTHLY";
          return (
            <li
              key={plan.id}
              data-testid="plano-card"
              className={cn(
                "relative flex flex-col rounded-hero border bg-surface p-6 sm:p-8",
                isFeatured ? "border-primary shadow-card-hover ring-2 ring-primary/20 lg:-my-4 lg:py-12" : "border-border shadow-card",
              )}
            >
              {isFeatured ? (
                <span className="absolute -top-3.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-primary px-4 py-1 text-xs font-bold uppercase tracking-wider text-white shadow-lg shadow-primary/30">
                  Recomendado
                </span>
              ) : null}
              <h3 className="font-display text-xl font-bold text-text">{plan.name}</h3>
              <p className="mt-5 flex flex-wrap items-baseline gap-x-1.5">
                <span data-testid="plano-preco-mes" className="font-display text-4xl font-extrabold tracking-tight text-text sm:text-5xl">
                  {shown ? shown.perMonthLabel : plan.priceLabel}
                </span>
                <span className="text-base font-medium text-text-secondary">/mês</span>
              </p>
              {shown && shown.cycle !== "MONTHLY" ? (
                <p data-testid="plano-periodo" className="mt-2 text-sm text-text-secondary">
                  <span className="font-semibold text-text">{shown.periodLabel}</span> a cada {shown.every}, de uma vez
                  {shown.savingsLabel ? <span className="font-semibold text-success"> ({shown.savingsLabel})</span> : null}
                </p>
              ) : plan.best ? (
                <p data-testid="plano-a-partir-de" className="mt-2 text-sm text-text-secondary">
                  a partir de <span className="font-semibold text-text">{plan.best.perMonthLabel}</span> por mês pagando a cada {plan.best.every}
                  {plan.best.savingsLabel ? <span className="font-semibold text-success"> ({plan.best.savingsLabel})</span> : null}
                </p>
              ) : null}
              {onlyMonthly ? <p className="mt-1 text-xs text-text-secondary">Este plano só tem cobrança mensal.</p> : null}
              <ul className="mb-8 mt-6 space-y-3 border-t border-border pt-6">
                {[plan.professionalsLabel, plan.whatsappLabel].map((line) => (
                  <li key={line} className="flex items-start gap-2.5 text-base font-semibold text-text">
                    <Check className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                    {line}
                  </li>
                ))}
                {INCLUDED.map((line) => (
                  <li key={line} className="flex items-start gap-2.5 text-sm leading-snug text-text-secondary">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                    {line}
                  </li>
                ))}
              </ul>
              <Button asChild size="lg" variant={isFeatured ? "primary" : "outline"} className={cn("mt-auto w-full", isFeatured && "shadow-lg shadow-primary/30")}>
                <Link href="/cadastro">
                  Testar {TRIAL_DAYS} dias grátis
                  <span className="sr-only"> no plano {plan.name}</span>
                </Link>
              </Button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
