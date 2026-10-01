import Image from "next/image";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { TRIAL_DAYS } from "@/core/billing";
import { Button } from "@/components/ui/button";

/** CTA final em fundo escuro, com o Inno (a arte da marca foi feita para fundo escuro). */
export function FinalCta() {
  return (
    <section aria-labelledby="cta-final-titulo" className="auth-brand-bg landing-dark py-20 sm:py-28">
      <div className="mx-auto grid max-w-7xl items-center gap-10 px-4 sm:px-6 lg:grid-cols-[1.2fr_0.8fr] lg:px-8">
        <div className="text-center lg:text-left">
          <h2
            id="cta-final-titulo"
            className="font-display text-3xl font-extrabold leading-tight tracking-tight text-sidebar-active-text sm:text-4xl lg:text-5xl"
          >
            Deixe o WhatsApp trabalhando e volte a cuidar do seu cliente
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-sidebar-text lg:mx-0">
            Crie a conta, conecte o número e deixe o bot marcar os próximos horários. São {TRIAL_DAYS} dias grátis, sem
            cartão de crédito.
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
              <Link href="/login">Entrar</Link>
            </Button>
          </div>
        </div>

        <div className="flex justify-center">
          <Image
            src="/marca/inno-banner.webp"
            alt="Inno, o robô mascote do InnoChat, de fone de ouvido, com a mão estendida, ao lado do logotipo InnoChat"
            width={720}
            height={436}
            unoptimized
            sizes="(min-width: 1024px) 28rem, 22rem"
            className="h-auto w-full max-w-[22rem] select-none lg:max-w-md"
          />
        </div>
      </div>
    </section>
  );
}
