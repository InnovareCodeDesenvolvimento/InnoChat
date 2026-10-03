import Link from "next/link";
import { TRIAL_DAYS } from "@/core/billing";
import type { LandingPlan } from "@/modules/billing/landing-plans";
import { Button } from "@/components/ui/button";
import { SectionHeading } from "./section-heading";
import { PricingCards } from "./pricing-cards";

/**
 * Planos e preços vêm do banco (`getLandingPlans`). `plans === null` (banco indisponível) ou
 * lista vazia: a seção continua inteira, sem valores, e o CTA do teste grátis segue funcionando.
 */
export function Pricing({ plans }: { plans: LandingPlan[] | null }) {
  const hasPlans = plans !== null && plans.length > 0;

  return (
    <section id="planos" aria-labelledby="planos-titulo" className="relative scroll-mt-20 overflow-hidden bg-bg py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          id="planos-titulo"
          title="Comece grátis e escolha o plano depois"
          description={`Teste por ${TRIAL_DAYS} dias sem cartão de crédito. Todos os planos têm todos os recursos; o que muda é o tamanho da equipe e a quantidade de números de WhatsApp.`}
        />

        {hasPlans ? (
          <PricingCards plans={plans} />
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
          Pagamento por Pix, a cada 1, 3, 6 ou 12 meses. Você pode trocar de plano e de período depois, pelo próprio painel.
        </p>
      </div>
    </section>
  );
}
