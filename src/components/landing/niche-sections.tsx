import Link from "next/link";
import { CalendarX, Clock, MessageCircle, Users, type LucideIcon } from "lucide-react";
import { SectionHeading } from "./section-heading";
import { allNiches, type Niche, type NicheSlug } from "./niches";

const PAIN_ICONS: LucideIcon[] = [MessageCircle, CalendarX, Users];

/** Três situações do dia a dia do tipo de negócio, contadas na voz de quem vive isso. */
export function NichePains({ niche }: { niche: Niche }) {
  return (
    <section aria-labelledby="dores-titulo" className="bg-bg py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading id="dores-titulo" eyebrow={`Para ${niche.forWhom}`} title={niche.painsTitle} description={niche.painsIntro} />
        <ul className="mt-14 grid gap-5 lg:grid-cols-3">
          {niche.pains.map((pain, index) => {
            const Icon = PAIN_ICONS[index] ?? MessageCircle;
            return (
              <li key={pain.title} className="flex flex-col rounded-hero border border-border bg-surface p-6 shadow-card sm:p-7">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Icon className="h-6 w-6" aria-hidden="true" />
                </span>
                <h3 className="mt-5 font-display text-lg font-bold text-text">{pain.title}</h3>
                <p className="mt-2 text-base leading-relaxed text-text-secondary">{pain.text}</p>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/** Serviços de exemplo do tipo de negócio, com a duração e o preço que o bot mostra ao cliente. */
export function NicheServices({ niche }: { niche: Niche }) {
  return (
    <section aria-labelledby="servicos-titulo" className="bg-surface py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading id="servicos-titulo" title={niche.servicesTitle} description={niche.servicesIntro} />
        <ul data-testid="niche-services" className="mt-14 grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
          {niche.services.map((service) => (
            <li
              key={service.name}
              className="flex items-center justify-between gap-4 rounded-hero border border-border bg-bg px-5 py-4 shadow-card"
            >
              <div className="min-w-0">
                <p className="font-display text-base font-bold text-text">{service.name}</p>
                <p className="mt-0.5 flex items-center gap-1.5 text-sm text-text-secondary">
                  <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {service.detail}
                </p>
              </div>
              <p className="shrink-0 font-display text-base font-extrabold text-primary">{service.price}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** Atalhos para as outras páginas por tipo de negócio (a atual não aparece). */
export function NicheLinks({ current }: { current?: NicheSlug }) {
  const others = allNiches().filter((n) => n.slug !== current);
  return (
    <section aria-labelledby="outros-nichos-titulo" className="bg-bg py-16 sm:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          id="outros-nichos-titulo"
          title="Tem outro tipo de negócio?"
          description="O InnoChat serve para quem vive de horário marcado. Veja como fica no seu caso."
        />
        <ul className="mt-8 flex flex-wrap justify-center gap-3">
          {others.map((niche) => (
            <li key={niche.slug}>
              <Link
                href={`/${niche.slug}`}
                className="inline-flex min-h-11 items-center rounded-full border border-border bg-surface px-5 text-sm font-semibold text-text shadow-card transition-[border-color,box-shadow] hover:border-primary/40 hover:shadow-card-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              >
                {niche.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
