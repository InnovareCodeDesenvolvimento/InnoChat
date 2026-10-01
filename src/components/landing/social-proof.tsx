import { Quote } from "lucide-react";
import { SectionHeading } from "./section-heading";

/**
 * PROVA SOCIAL: estrutura pronta e DESLIGADA de propósito.
 *
 * A landing não pode exibir depoimento, logo de cliente, número de empresas ou avaliação que não
 * existam. Para ligar, basta preencher `TESTIMONIALS` com depoimentos REAIS e autorizados pelas
 * pessoas (nome, cargo/negócio, texto) e a seção passa a aparecer sozinha, entre os segmentos e
 * os planos (ver `page.tsx`). Enquanto o array estiver vazio, o componente não renderiza nada.
 */
export type Testimonial = {
  /** Texto exatamente como a pessoa autorizou. */
  quote: string;
  name: string;
  /** Ex.: "Dona do Studio X, salão de beleza". */
  role: string;
};

export const TESTIMONIALS: Testimonial[] = [];

export function SocialProof({ items = TESTIMONIALS }: { items?: Testimonial[] }) {
  if (items.length === 0) return null;

  return (
    <section aria-labelledby="prova-titulo" className="bg-bg py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading id="prova-titulo" eyebrow="Quem usa" title="O que dizem os clientes do InnoChat" />
        <ul className="mt-14 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <li key={`${item.name}-${item.role}`} className="rounded-hero border border-border bg-surface p-6 shadow-card sm:p-8">
              <Quote className="h-6 w-6 text-primary" aria-hidden="true" />
              <blockquote className="mt-4 text-base leading-relaxed text-text">{item.quote}</blockquote>
              <p className="mt-5 font-display text-sm font-bold text-text">{item.name}</p>
              <p className="text-sm text-text-secondary">{item.role}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
