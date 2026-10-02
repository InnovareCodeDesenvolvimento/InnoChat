import Link from "next/link";
import { Check } from "lucide-react";
import { TRIAL_DAYS } from "@/core/billing";
import { cn } from "@/components/lib/cn";
import type { LandingPlan } from "@/modules/billing/landing-plans";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "./section-heading";

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
 * Planos e preços vêm do banco (`getLandingPlans`). `plans === null` (banco indisponível) ou
 * lista vazia: a seção continua inteira, sem valores, e o CTA do teste grátis segue funcionando.
 */
export function Pricing({ plans }: { plans: LandingPlan[] | null }) {
  const hasPlans = plans !== null && plans.length > 0;
  const featured = hasPlans ? featuredIndex(plans.length) : -1;

  return (
    <section id="planos" aria-labelledby="planos-titulo" className="relative scroll-mt-20 overflow-hidden bg-bg py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          id="planos-titulo"
          title="Comece grátis e escolha o plano depois"
          description={`Teste por ${TRIAL_DAYS} dias sem cartão de crédito. Todos os planos têm todos os recursos; o que muda é o tamanho da equipe e a quantidade de números de WhatsApp.`}
        />

        {hasPlans ? (
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
              return (
                <li
                  key={plan.id}
                  data-testid="plano-card"
                  className={cn(
                    "relative flex flex-col rounded-hero border bg-surface p-6 sm:p-8",
                    isFeatured
                      ? "border-primary shadow-card-hover ring-2 ring-primary/20 lg:-my-4 lg:py-12"
                      : "border-border shadow-card",
                  )}
                >
                  {isFeatured ? (
                    <span className="absolute -top-3.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-primary px-4 py-1 text-xs font-bold uppercase tracking-wider text-white shadow-lg shadow-primary/30">
                      Recomendado
                    </span>
                  ) : null}
                  <h3 className="font-display text-xl font-bold text-text">{plan.name}</h3>
                  <p className="mt-5 flex items-baseline gap-1.5">
                    <span className="font-display text-4xl font-extrabold tracking-tight text-text sm:text-5xl">
                      {plan.priceLabel}
                    </span>
                    <span className="text-base font-medium text-text-secondary">/mês</span>
                  </p>
                  {plan.annualLabel ? (
                    <p data-testid="plano-anual" className="mt-2 text-sm text-text-secondary">
                      ou <span className="font-semibold text-text">{plan.annualLabel}</span> por ano
                      {plan.annualSavingsLabel ? <span className="font-semibold text-success"> ({plan.annualSavingsLabel})</span> : null}
                    </p>
                  ) : null}
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
                  <Button
                    asChild
                    size="lg"
                    variant={isFeatured ? "primary" : "outline"}
                    className={cn("mt-auto w-full", isFeatured && "shadow-lg shadow-primary/30")}
                  >
                    <Link href="/cadastro">
                      Testar {TRIAL_DAYS} dias grátis
                      <span className="sr-only"> no plano {plan.name}</span>
                    </Link>
                  </Button>
                </li>
              );
            })}
          </ul>
        ) : (
          <div
            data-testid="planos-sem-preco"
            className="mx-auto mt-14 max-w-2xl rounded-hero border border-border bg-surface p-8 text-center shadow-card sm:p-10"
          >
            <h3 className="font-display text-xl font-bold text-text">Valores disponíveis ao criar a conta</h3>
            <p className="mt-3 text-base leading-relaxed text-text-secondary">
              Comece o teste de {TRIAL_DAYS} dias, sem cartão de crédito, e veja os planos e valores dentro do painel, na
              tela de Assinatura.
            </p>
            <Button asChild size="lg" className="mt-6">
              <Link href="/cadastro">Começar teste grátis</Link>
            </Button>
          </div>
        )}

        <p className="mx-auto mt-10 max-w-2xl text-center text-sm leading-relaxed text-text-secondary">
          Pagamento por Pix, mensal ou anual. Você pode trocar de plano depois, pelo próprio painel.
        </p>
      </div>
    </section>
  );
}
