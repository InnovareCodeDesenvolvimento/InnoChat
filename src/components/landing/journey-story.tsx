"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "@/components/lib/cn";
import type { DemoMessage } from "./demo-script";
import { JourneyCard } from "./journey-cards";
import { JOURNEY_STEPS, messageCountForStep } from "./journey-data";
import { JourneyPhone } from "./journey-phone";

/**
 * Rolagem contando uma história. Dois modos sobre os MESMOS dados:
 *
 * - Palco fixo ("sticky scrollytelling"): telas largas e altas, sem `prefers-reduced-motion`. Uma
 *   trilha alta (5 passos x 80svh) com o celular `position: sticky` no centro; o texto do passo fica à
 *   esquerda e o cartão ilustrativo à direita. O passo ativo vem de um IntersectionObserver que
 *   observa 5 blocos invisíveis (um por passo) cruzando uma faixa no meio da janela: nada de conta
 *   de rolagem, então não "pula" nem "prende".
 * - Sequência vertical: celular e tablet, movimento reduzido e o HTML do servidor (sem JS). Cada
 *   passo é um cartão com texto, celular e ilustração, todos legíveis em ordem.
 *
 * O servidor sempre entrega a sequência (`getServerSnapshot = false`); o palco fixo só entra
 * depois da hidratação, bem abaixo da dobra.
 */
const STICKY_QUERY = "(min-width: 1024px) and (min-height: 620px) and (prefers-reduced-motion: no-preference)";

function subscribeSticky(onChange: () => void) {
  const media = window.matchMedia(STICKY_QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}
const getStickySnapshot = () => window.matchMedia(STICKY_QUERY).matches;
const getStickyServerSnapshot = () => false;

const TOTAL = JOURNEY_STEPS.length;

function StepBadge({ index }: { index: number }) {
  return (
    <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-accent">
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-xs font-extrabold tracking-normal text-sidebar">
        {index + 1}
      </span>
      Passo {index + 1} de {TOTAL}
    </p>
  );
}

function StepText({ index, headingLevel = 3 }: { index: number; headingLevel?: 3 }) {
  const step = JOURNEY_STEPS[index];
  const Heading = `h${headingLevel}` as "h3";
  return (
    <>
      <StepBadge index={index} />
      <Heading className="mt-3 font-display text-2xl font-extrabold leading-tight tracking-tight text-sidebar-active-text sm:text-3xl">
        {step.title}
      </Heading>
      <p className="mt-3 text-base leading-relaxed text-sidebar-text">{step.text}</p>
    </>
  );
}

function Sequence({ messages, company }: { messages: DemoMessage[]; company: string }) {
  return (
    <ol data-testid="journey-sequence" className="mt-14 space-y-16 md:space-y-20">
      {JOURNEY_STEPS.map((step, index) => (
        <li
          key={step.id}
          data-testid="journey-step"
          className="mx-auto grid max-w-3xl items-center gap-8 md:grid-cols-[minmax(0,1fr)_auto] md:gap-12"
        >
          <div className="min-w-0">
            <StepText index={index} />
            <div aria-hidden="true" className="mt-6 max-w-sm">
              <JourneyCard id={step.id} />
            </div>
          </div>
          <div className="justify-self-center [--jr-s:0.9] md:[--jr-s:1]">
            <JourneyPhone
              messages={messages}
              count={messageCountForStep(messages, index)}
              company={company}
              animated={false}
              label={`Conversa de exemplo no passo ${index + 1}: ${step.title}`}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}

function Sticky({ messages, company }: { messages: DemoMessage[]; company: string }) {
  const [step, setStep] = useState(0);
  const sentinels = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    const nodes = sentinels.current.filter((n): n is HTMLDivElement => n !== null);
    if (nodes.length === 0 || typeof IntersectionObserver === "undefined") return;
    // Faixa fina no meio da janela: o passo é o bloco que a atravessa.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setStep(Number((entry.target as HTMLElement).dataset.index));
        }
      },
      { rootMargin: "-45% 0px -45% 0px", threshold: 0 },
    );
    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, []);

  const jump = useCallback((index: number) => {
    sentinels.current[index]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, []);

  const current = JOURNEY_STEPS[step];

  return (
    <div data-testid="journey-track" className="jr-track relative mt-12">
      <div
        data-testid="journey-stage"
        data-step={step + 1}
        className="jr-stage sticky top-16 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-10 xl:gap-16"
      >
        <div className="grid min-w-0 justify-self-end">
          {JOURNEY_STEPS.map((s, index) => (
            <div
              key={s.id}
              data-testid="journey-slot"
              data-active={index === step ? "true" : "false"}
              className="jr-slot col-start-1 row-start-1 max-w-sm"
            >
              <StepText index={index} />
            </div>
          ))}
        </div>

        <div className="flex flex-col items-center">
          <JourneyPhone
            messages={messages}
            count={messageCountForStep(messages, step)}
            company={company}
            animated
            label={`Conversa de exemplo no passo ${step + 1}: ${current.title}`}
          />
          <nav aria-label="Passos da jornada" className="mt-3">
            <ol className="flex items-center">
              {JOURNEY_STEPS.map((s, index) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => jump(index)}
                    aria-label={`Passo ${index + 1} de ${TOTAL}: ${s.title}`}
                    aria-current={index === step ? "step" : undefined}
                    className="group flex h-11 w-11 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-sidebar-active-text"
                  >
                    <span
                      className={cn(
                        "block h-2.5 rounded-full transition-all duration-300",
                        index === step ? "w-7 bg-sidebar-active-text" : "w-2.5 bg-white/45 group-hover:bg-white/70",
                      )}
                    />
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        </div>

        <div aria-hidden="true" className="grid min-w-0 justify-self-start">
          {JOURNEY_STEPS.map((s, index) => (
            <div
              key={s.id}
              data-active={index === step ? "true" : "false"}
              className="jr-slot jr-slot-card col-start-1 row-start-1 w-full max-w-xs"
            >
              <JourneyCard id={s.id} />
            </div>
          ))}
        </div>
      </div>

      <p role="status" className="sr-only">
        Passo {step + 1} de {TOTAL}: {current.title}
      </p>

      <div aria-hidden="true" className="jr-sentinels">
        {JOURNEY_STEPS.map((s, index) => (
          <div
            key={s.id}
            ref={(node) => {
              sentinels.current[index] = node;
            }}
            data-index={index}
            data-testid="journey-sentinel"
            className="jr-sentinel"
          />
        ))}
      </div>
    </div>
  );
}

export function JourneyStory({ messages, company }: { messages: DemoMessage[]; company: string }) {
  const sticky = useSyncExternalStore(subscribeSticky, getStickySnapshot, getStickyServerSnapshot);
  return sticky ? <Sticky messages={messages} company={company} /> : <Sequence messages={messages} company={company} />;
}
