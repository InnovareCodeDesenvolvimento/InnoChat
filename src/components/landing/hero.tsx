import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { TRIAL_DAYS } from "@/core/billing";
import { Button } from "@/components/ui/button";
import { buildDemoScript } from "./demo-script";
import { HeroStage } from "./hero-stage";

const POINTS = ["Agenda, remarca e cancela", "Lembra o cliente antes do horário", "Passa para a sua equipe quando precisa"];

/**
 * Hero: headline de benefício, dois CTAs, microcopy do teste e a demonstração do celular. O
 * h1 é o elemento do LCP (texto, sem imagem pesada). O roteiro do celular é montado aqui, no
 * servidor, com os textos reais do bot v2.
 */
export function Hero() {
  const messages = buildDemoScript();

  return (
    <section aria-labelledby="hero-title" className="auth-brand-bg landing-dark pb-16 pt-28 sm:pb-24 sm:pt-32">
      <div className="mx-auto grid max-w-7xl items-center gap-12 px-4 sm:px-6 lg:grid-cols-[1.08fr_0.92fr] lg:gap-8 lg:px-8">
        <div className="text-center lg:text-left">
          <p className="inline-flex items-center gap-2 rounded-full bg-white/10 py-1.5 pl-1.5 pr-4 text-sm font-medium text-sidebar-active-text ring-1 ring-white/20 backdrop-blur-md">
            <Image
              src="/mascote/inno-avatar.webp"
              alt=""
              width={28}
              height={28}
              unoptimized
              className="h-7 w-7 rounded-full bg-white/10"
            />
            Teste grátis por {TRIAL_DAYS} dias
          </p>

          <h1
            id="hero-title"
            className="mt-6 text-balance font-display text-4xl font-extrabold leading-[1.08] tracking-tight text-sidebar-active-text sm:text-5xl xl:text-6xl"
          >
            Seu WhatsApp{" "}
            <span className="bg-gradient-to-r from-accent to-sidebar-active-text bg-clip-text text-transparent">
              agenda sozinho
            </span>
            , 24 horas por dia
          </h1>

          <p className="mx-auto mt-6 max-w-xl text-lg leading-relaxed text-sidebar-text lg:mx-0">
            Pare de largar o cliente para responder WhatsApp. O InnoChat atende, marca, remarca e cancela horários pelo
            WhatsApp da sua empresa e ainda lembra cada cliente antes do atendimento.
          </p>

          <div className="mt-8 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center lg:justify-start">
            <Button
              asChild
              size="lg"
              className="h-14 px-8 text-base shadow-xl shadow-primary/40 focus-visible:outline-sidebar-active-text"
            >
              <Link href="/cadastro">
                Começar teste grátis
                <ArrowRight className="h-5 w-5" aria-hidden="true" />
              </Link>
            </Button>
            <Button
              asChild
              size="lg"
              variant="outline"
              className="h-14 border-white/30 bg-white/5 px-8 text-base text-sidebar-active-text hover:bg-white/15 focus-visible:outline-sidebar-active-text"
            >
              <Link href="/login">Já tenho conta</Link>
            </Button>
          </div>

          <p className="mt-4 text-sm font-medium text-sidebar-text">
            {TRIAL_DAYS} dias grátis <span aria-hidden="true">·</span>
            <span className="sr-only">,</span> sem cartão de crédito
          </p>

          <ul className="mt-8 flex flex-col items-center gap-2.5 lg:items-start">
            {POINTS.map((point) => (
              <li key={point} className="flex items-center gap-2.5 text-sm text-sidebar-active-text">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-success text-white">
                  <Check className="h-3 w-3" aria-hidden="true" />
                </span>
                {point}
              </li>
            ))}
          </ul>
        </div>

        <HeroStage messages={messages} company="Studio Bella" />
      </div>
    </section>
  );
}
