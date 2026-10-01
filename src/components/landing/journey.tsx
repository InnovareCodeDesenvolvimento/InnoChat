import { buildDemoScript } from "./demo-script";
import { JourneyStory } from "./journey-story";
import { SectionHeading } from "./section-heading";

/**
 * "Da primeira mensagem à cliente na porta": a jornada completa contada pela rolagem (celular fixo
 * no centro, conteúdo muda por passo). Fica logo depois de "Como funciona": ali a pessoa acabou de
 * ver como CONFIGURAR; aqui vê o que acontece DEPOIS de ligado. Fundo escuro para alternar com as
 * seções claras vizinhas. `overflow-clip` (e não `hidden`) porque `hidden` transforma a seção em
 * contêiner de rolagem e quebraria o `position: sticky` do celular.
 */
export function Journey() {
  const messages = buildDemoScript();
  return (
    <section
      id="jornada"
      aria-labelledby="jornada-titulo"
      className="auth-brand-bg relative isolate overflow-clip py-20 sm:py-28"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading
          id="jornada-titulo"
          tone="dark"
          title="Da primeira mensagem à cliente na porta"
          description="Veja o que acontece depois que o InnoChat é ligado ao WhatsApp da empresa. Os dados são fictícios; os textos são os mesmos que o bot usa de verdade."
        />
        <JourneyStory messages={messages} company="Studio Bella" />
      </div>
    </section>
  );
}
