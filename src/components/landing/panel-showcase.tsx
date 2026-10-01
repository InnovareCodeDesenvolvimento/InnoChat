import Image from "next/image";
import { PanelTilt } from "./panel-tilt";
import { SectionHeading } from "./section-heading";

/**
 * Vitrine do painel com prints reais (docs/design/screens/premium → public/landing, recortados
 * sem menu lateral nem dados do ambiente de desenvolvimento). Moldura de navegador feita em CSS.
 * Imagens abaixo da dobra: carregam sob demanda (padrão do next/image, sem `priority`);
 * `unoptimized` porque já são .webp do tamanho exato, como a arte da marca em `auth-shell`.
 */
function BrowserFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-hero bg-surface shadow-2xl ring-1 ring-white/20">
      <div
        className="flex items-center gap-2 border-b border-border bg-bg px-4 py-3"
        aria-hidden="true"
      >
        <span className="h-3 w-3 rounded-full bg-danger/70" />
        <span className="h-3 w-3 rounded-full bg-warning/70" />
        <span className="h-3 w-3 rounded-full bg-success/70" />
        <span className="ml-3 hidden flex-1 rounded-full bg-surface px-4 py-1 text-xs text-text-secondary ring-1 ring-border sm:block">
          innochat.innovarecode.com.br
        </span>
      </div>
      {children}
    </div>
  );
}

export function PanelShowcase() {
  return (
    <section
      aria-labelledby="painel-titulo"
      className="auth-brand-bg landing-dark py-20 sm:py-28"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          id="painel-titulo"
          tone="dark"
          eyebrow="O painel"
          title="Sua equipe no controle, sem complicação"
          description="Agenda, indicadores e a tela de Atendimento, onde a equipe responde quem pediu um humano, no estilo do WhatsApp Web."
        />

        <div className="mx-auto mt-14 max-w-5xl">
          <PanelTilt testId="painel-3d" tiltX={14} tiltY={-8}>
            <BrowserFrame>
              <Image
                src="/landing/painel-atendimento.webp"
                alt="Tela Atendimento do InnoChat: fila de clientes aguardando e uma conversa aberta, com o histórico do bot e o campo para a equipe responder."
                width={1184}
                height={736}
                unoptimized
                sizes="(min-width: 1024px) 64rem, 100vw"
                className="h-auto w-full"
              />
            </BrowserFrame>
          </PanelTilt>
        </div>

        <div className="mx-auto mt-8 grid max-w-5xl items-center gap-8 lg:grid-cols-[1.25fr_1fr] lg:gap-10">
          <figure>
            <PanelTilt tiltX={12} tiltY={9}>
              <BrowserFrame>
                <Image
                  src="/landing/painel-inicio.webp"
                  alt="Tela Início do InnoChat com os indicadores do dia: agendamentos de hoje, próximos 7 dias, taxa de faltas e percentual agendado pelo bot."
                  width={1184}
                  height={736}
                  unoptimized
                  sizes="(min-width: 1024px) 38rem, 100vw"
                  className="h-auto w-full"
                />
              </BrowserFrame>
            </PanelTilt>
            <figcaption className="mt-3 text-center text-sm text-sidebar-text">
              Indicadores: taxa de faltas e quanto foi agendado pelo bot
            </figcaption>
          </figure>

          <div className="flex flex-col items-center gap-6 text-center sm:flex-row sm:text-left lg:flex-col lg:text-center xl:flex-row xl:text-left">
            <PanelTilt className="shrink-0" tiltX={10} tiltY={-14}>
              <Image
                src="/landing/painel-mobile.webp"
                alt="Tela Atendimento no celular, com a conversa de um cliente que pediu para falar com um atendente."
                width={480}
                height={911}
                unoptimized
                sizes="12rem"
                className="h-auto w-44 shrink-0 rounded-hero shadow-2xl ring-1 ring-white/20"
              />
            </PanelTilt>
            <div>
              <h3 className="font-display text-xl font-bold text-sidebar-active-text">
                Funciona também no celular
              </h3>
              <p className="mt-3 text-base leading-relaxed text-sidebar-text">
                O painel se adapta a qualquer tela. Quem está no balcão ou na
                rua olha a agenda, responde um cliente e vê quem pediu
                atendimento.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
