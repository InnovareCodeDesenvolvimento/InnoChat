"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "@/components/lib/cn";
import {
  AgendaCard,
  AgendaRowView,
  Margin,
  Notif,
  WaBubble,
  WaChat,
} from "./day-story-pieces";
import { cap, DEFAULT_NICHE_ID, firstName, NICHES, nicheById, type Niche } from "./day-story-data";

/**
 * "Você conhece esse dia": um dia de trabalho contado em primeira pessoa, com horários reais, em
 * duas versões (Sem / Com InnoChat) e em seis tipos de negócio (conteúdo em `day-story-data.ts`).
 *
 * Sem JS o HTML traz as DUAS versões de cada cena, uma sob a outra (o `<noscript>` abaixo desliga
 * a troca). Com JS, as duas ocupam o mesmo espaço (grid) e o CSS alterna a visível por
 * `data-mode`; a inativa fica `visibility:hidden`, então o leitor de tela só lê a ativa. Todo o
 * movimento (entrada por rolagem, notificações que caem, ✓ que se desenha) está no globals.css
 * dentro de `prefers-reduced-motion: no-preference`; sem ele o estado final aparece parado.
 */

type Mode = "sem" | "com";

type PaneContent = { text: string; visual: ReactNode; note?: string };
type SceneData = { time: string; flip: boolean; sem: PaneContent; com: PaneContent };

const SEM_ROW = { tone: "bad", label: "não veio" } as const;
const OK_ROW = (label: string) => ({ tone: "ok", label }) as const;

/** As 5 cenas do dia, montadas com os campos do negócio escolhido. */
function buildScenes(n: Niche): SceneData[] {
  const [a0, a1, a2] = n.agenda;
  const lateFirst = firstName(n.late.name);
  const nightFirst = firstName(n.night.name);
  const lunchFirst = firstName(n.lunch.name);

  return [
    {
      time: "08:40",
      flip: false,
      sem: {
        text: `${n.opening} e o celular já tem seis mensagens. “${n.messages[0]}” “${n.messages[1]}” Ainda nem acendi as luzes.`,
        visual: (
          <div className="space-y-2">
            <Notif name={a0.name} text={n.messages[0]} time="08:31" i={0} fall={{ x: -18, r: -7 }} className="-rotate-1" />
            <Notif name={a1.name} text={n.messages[1]} time="08:34" i={1} fall={{ x: 14, r: 6 }} className="ml-4 rotate-1" />
            <Notif name={a2.name} text={n.messages[2]} time="08:38" i={2} fall={{ x: -8, r: -4 }} className="-ml-1 -rotate-[0.5deg]" />
            <p className="ds-fall pl-2 text-sm font-semibold text-text-secondary" style={{ "--i": 3 } as CSSProperties}>
              + 3 mensagens não lidas
            </p>
          </div>
        ),
      },
      com: {
        text: `${n.opening} e as seis mensagens já foram respondidas. Quem queria horário hoje já está na agenda.`,
        visual: (
          <AgendaCard title="Hoje">
            {n.agenda.map((r, idx) => (
              <AgendaRowView key={r.time} {...r} status={OK_ROW("agendado")} i={idx} />
            ))}
          </AgendaCard>
        ),
      },
    },
    {
      time: "10:15",
      flip: true,
      sem: {
        text: `Estou ${n.busy} e o celular vibra ${n.surface}. ${cap(n.inFront)} percebe. Eu vejo que percebeu.`,
        note: "e não tem como disfarçar",
        visual: (
          <div className="space-y-2">
            <Notif name={n.buzz.name} text={n.buzz.ask} time="10:15" i={0} buzz fall={{ x: 10, r: 5 }} />
            <Notif name={n.buzz.name} text="Oi? Alguém aí?" time="10:19" i={1} fall={{ x: -12, r: -6 }} className="ml-3" />
          </div>
        ),
      },
      com: {
        text: `Sigo ${n.busy}. Quem chama no WhatsApp é atendido pelo bot, e eu não preciso largar o que estou fazendo.`,
        visual: (
          <WaChat contact={n.buzz.name}>
            <WaBubble side="in" time="10:15" i={0}>{n.buzz.ask}</WaBubble>
            <WaBubble side="out" time="10:15" ticks="read" i={1}>
              {"Tenho 10h e 14h. Qual prefere?\n1 · 10h\n2 · 14h"}
            </WaBubble>
            <WaBubble side="in" time="10:16" i={2}>1</WaBubble>
            <WaBubble side="out" time="10:16" ticks="read" i={3}>{"Pronto, sábado às 10h. Agendado!"}</WaBubble>
          </WaChat>
        ),
      },
    },
    {
      time: "12:30",
      flip: false,
      sem: {
        text: "Meu almoço esfria. Paro para responder “Pode ser às 15h?” e ainda confiro a agenda de cabeça para não marcar em cima de ninguém.",
        note: "o almoço esfriou",
        visual: (
          <WaChat contact={n.lunch.name}>
            <WaBubble side="in" time="12:30" i={0}>Pode ser às 15h?</WaBubble>
            <WaBubble side="out" time="12:34" ticks="sent" i={1}>Só um minuto, estou almoçando</WaBubble>
          </WaChat>
        ),
      },
      com: {
        text: "Almoço inteiro. O bot só oferece o que está livre na agenda, então ninguém marca em cima de ninguém.",
        visual: (
          <WaChat contact={n.lunch.name}>
            <WaBubble side="in" time="12:30" i={0}>Pode ser às 15h?</WaBubble>
            <WaBubble side="out" time="12:30" ticks="read" i={1}>
              {`Às 15h está livre para ${n.lunch.service}, ${lunchFirst}. Confirmo?\n1 · Confirmar\n2 · Outro horário`}
            </WaBubble>
            <WaBubble side="in" time="12:31" i={2}>1</WaBubble>
            <WaBubble side="out" time="12:31" ticks="read" i={3}>Agendado! Hoje, 15h.</WaBubble>
          </WaChat>
        ),
      },
    },
    {
      time: "16:00",
      flip: true,
      sem: {
        text: `${n.noShow} não veio. Não avisou, não respondeu. ${n.emptyPhrase}, e a hora já era.`,
        note: "essa hora ninguém devolve",
        visual: (
          <AgendaCard title="Hoje, 16:00">
            <AgendaRowView time="16:00" name={n.late.name} service={cap(n.late.service)} status={SEM_ROW} />
            <p className="rounded-xl border-2 border-dashed border-border px-3 py-3 text-center text-sm text-text-secondary">
              {n.emptyPhrase}
            </p>
          </AgendaCard>
        ),
      },
      com: {
        text: `Ontem às 16h o bot lembrou ${lateFirst} do horário e a resposta veio. Se precisasse remarcar, ainda daria tempo de oferecer essa hora a outra pessoa.`,
        note: "lembrete enviado ontem, 16h",
        visual: (
          <div className="space-y-2">
            <WaChat contact={lateFirst}>
              <WaBubble side="out" time="ontem 16:00" ticks="read" i={0}>
                {`Oi, ${lateFirst}! Lembrete: amanhã às 16h, ${n.late.service}.\n1 · Confirmo\n2 · Remarcar\n3 · Cancelar`}
              </WaBubble>
              <WaBubble side="in" time="ontem 16:12" i={1}>1</WaBubble>
            </WaChat>
            <AgendaCard title="Hoje">
              <AgendaRowView time="16:00" name={n.late.name} service={cap(n.late.service)} status={OK_ROW("confirmado")} i={2} />
            </AgendaCard>
          </div>
        ),
      },
    },
    {
      time: "23:47",
      flip: false,
      sem: {
        text: `${nightFirst} pergunta se tem horário amanhã. Eu já estou dormindo e ninguém responde. De manhã, já marcou em outro lugar.`,
        note: "ninguém viu",
        visual: (
          <div className="space-y-2">
            <WaChat contact={n.night.name}>
              <WaBubble side="in" time="23:47" i={0}>Tem horário amanhã?</WaBubble>
            </WaChat>
            <p className="rounded-xl border border-dashed border-border px-3 py-2 text-sm italic text-text-secondary">
              08:02 · {nightFirst} marcou em outro lugar
            </p>
          </div>
        ),
      },
      com: {
        text: `${nightFirst} pergunta, e o bot responde na hora. Quando eu acordo, o horário já está na agenda.`,
        note: "dormi tranquilo",
        visual: (
          <WaChat contact={n.night.name}>
            <WaBubble side="in" time="23:47" i={0}>Tem horário amanhã?</WaBubble>
            <WaBubble side="out" time="23:47" ticks="read" i={1}>
              {"Tem sim! Amanhã tenho 10h e 15h.\n1 · 10h\n2 · 15h"}
            </WaBubble>
            <WaBubble side="in" time="23:48" i={2}>2</WaBubble>
            <WaBubble side="out" time="23:48" ticks="read" i={3}>Agendado! Amanhã, 15h.</WaBubble>
          </WaChat>
        ),
      },
    },
  ];
}

/** Horário em destaque: números grandes e tabulares, com os dois-pontos na cor de destaque. */
function BigTime({ time }: { time: string }) {
  const [h, m] = time.split(":");
  return (
    <p className="font-display text-5xl font-extrabold leading-none tracking-tight text-text tabular-nums sm:text-6xl">
      <time dateTime={time}>
        {h}
        <span className="text-primary">:</span>
        {m}
      </time>
    </p>
  );
}

function Pane({
  tag,
  content,
  flip,
  className,
}: {
  tag: string;
  content: PaneContent;
  flip: boolean;
  className: string;
}) {
  return (
    <div className={cn("ds-pane min-w-0", className)}>
      <p className="ds-tag mb-1 text-xs font-bold uppercase tracking-wider text-text-secondary">{tag}</p>
      <div
        className={cn(
          "grid items-start gap-5 xl:gap-10",
          flip ? "xl:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]" : "xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]",
        )}
      >
        <div className={cn("space-y-3", flip && "xl:order-2")}>
          <p className="max-w-prose text-lg leading-relaxed text-text">{content.text}</p>
          {content.note ? <Margin>{content.note}</Margin> : null}
        </div>
        <div aria-hidden="true" className={cn("w-full max-w-sm", flip && "xl:order-1")}>
          {content.visual}
        </div>
      </div>
    </div>
  );
}

function Scene({ scene, last, nicheId }: { scene: SceneData; last: boolean; nicheId: string }) {
  return (
    <li data-reveal className="ds-scene relative pl-9 sm:pl-12">
      {last ? null : <span aria-hidden="true" className="ds-seg absolute -bottom-3 left-[9px] top-8 w-0.5" />}
      <span aria-hidden="true" className="ds-dot absolute left-0 top-3 h-5 w-5 rounded-full border-4 border-bg" />
      <div className={cn("ds-body grid gap-x-8 gap-y-4 lg:grid-cols-[11.5rem_minmax(0,1fr)]", last ? "pb-0" : "pb-14 lg:pb-20")}>
        <BigTime time={scene.time} />
        {/* `key` do nicho: a troca de negócio remonta o par de painéis e replica a entrada suave. */}
        <div key={nicheId} className="ds-stack ds-swap min-w-0">
          <Pane tag="Sem InnoChat" content={scene.sem} flip={scene.flip} className="ds-before" />
          <Pane tag="Com InnoChat" content={scene.com} flip={scene.flip} className="ds-after" />
        </div>
      </div>
    </li>
  );
}

export function DayStory() {
  const [mode, setMode] = useState<Mode>("sem");
  const [nicheId, setNicheId] = useState(DEFAULT_NICHE_ID);
  const rootRef = useRef<HTMLDivElement>(null);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  const niche = nicheById(nicheId);
  const scenes = buildScenes(niche);
  const com = mode === "com";

  // Entrada por rolagem: marca `is-in` direto no DOM (sem re-render). `ds-js` só liga o estado
  // "escondido" depois de hidratar, então sem JS tudo aparece.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const targets = Array.from(root.querySelectorAll<HTMLElement>("[data-reveal]"));
    if (typeof IntersectionObserver === "undefined") {
      targets.forEach((t) => t.classList.add("is-in"));
      return;
    }
    root.classList.add("ds-js");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    targets.forEach((t) => io.observe(t));
    return () => io.disconnect();
  }, []);

  function onRadioKey(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = NICHES.length - 1;
    let next = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = index === last ? 0 : index + 1;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = index === 0 ? last : index - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next < 0) return;
    e.preventDefault();
    setNicheId(NICHES[next]!.id);
    radios.current[next]?.focus();
  }

  return (
    <div ref={rootRef} data-mode={mode} className="ds-root">
      <noscript>
        <style>{`.ds-stack{display:block!important}.ds-pane{visibility:visible!important;opacity:1!important;margin-bottom:1.25rem}.ds-tag{display:block!important}.ds-ctl{display:none!important}`}</style>
      </noscript>

      <div data-reveal className="ds-head grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:items-end lg:gap-14">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-primary">Um dia comum</p>
          <h2
            id="dor-titulo"
            className="mt-3 text-balance font-display text-4xl font-extrabold leading-[1.05] tracking-tight text-text sm:text-5xl lg:text-6xl"
          >
            Você conhece{" "}
            <span className="relative inline-block whitespace-nowrap">
              esse dia
              <svg
                viewBox="0 0 300 14"
                preserveAspectRatio="none"
                aria-hidden="true"
                focusable="false"
                className="ds-underline pointer-events-none absolute -bottom-2 left-0 h-3 w-full text-accent"
              >
                <path
                  d="M2 9C40 3 78 12 120 7S210 4 252 8 290 7 298 5"
                  pathLength={1}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={4}
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            </span>
            .
          </h2>
        </div>
        <p className="max-w-md text-base leading-relaxed text-text-secondary sm:text-lg">
          Quem vive de horário marcado acaba virando a recepcionista do próprio WhatsApp. Escolha o seu tipo de negócio,
          vire a chave e veja o mesmo dia de dois jeitos.
        </p>
      </div>

      <div className="ds-ctl mt-10 flex flex-wrap items-center gap-x-4 gap-y-3">
        <span id="ds-niche-label" className="text-sm font-semibold text-text-secondary">
          Seu negócio:
        </span>
        <div role="radiogroup" aria-labelledby="ds-niche-label" className="flex flex-wrap gap-2">
          {NICHES.map((n, idx) => {
            const on = n.id === nicheId;
            return (
              <button
                key={n.id}
                ref={(el) => {
                  radios.current[idx] = el;
                }}
                type="button"
                role="radio"
                aria-checked={on}
                tabIndex={on ? 0 : -1}
                onClick={() => setNicheId(n.id)}
                onKeyDown={(e) => onRadioKey(e, idx)}
                className={cn(
                  "inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                  on
                    ? "border-primary bg-primary text-white"
                    : "border-border bg-surface text-text hover:border-primary/50",
                )}
              >
                {n.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Interruptor: sempre à vista enquanto a pessoa percorre o dia. */}
      <div className="ds-ctl sticky top-[4.5rem] z-30 mt-6 flex flex-wrap items-center gap-x-5 gap-y-2 py-2">
        <button
          type="button"
          role="switch"
          aria-checked={com}
          aria-label="Mostrar o dia com o InnoChat"
          data-testid="ds-switch"
          onClick={() => setMode(com ? "sem" : "com")}
          className="group inline-flex min-h-14 items-center gap-3 rounded-full border border-border bg-surface px-5 shadow-card-hover transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
        >
          <span aria-hidden="true" className={cn("text-sm font-bold transition-colors", com ? "text-text-secondary" : "text-text")}>
            Sem InnoChat
          </span>
          <span
            aria-hidden="true"
            className="relative inline-block h-9 w-[4.25rem] shrink-0 rounded-full bg-danger transition-colors duration-300 group-aria-checked:bg-primary"
          >
            <span className="absolute left-1 top-1 flex h-7 w-7 items-center justify-center rounded-full bg-white text-primary shadow-[0_2px_4px_rgb(0_0_0/0.3)] transition-transform duration-300 ease-out group-aria-checked:translate-x-[2rem]">
              <Check className="h-4 w-4 opacity-0 transition-opacity group-aria-checked:opacity-100" strokeWidth={3} />
            </span>
          </span>
          <span aria-hidden="true" className={cn("text-sm font-bold transition-colors", com ? "text-text" : "text-text-secondary")}>
            Com InnoChat
          </span>
        </button>
        <p aria-hidden="true" className="hidden rounded-full bg-surface/90 px-3 py-1 text-sm font-semibold text-text-secondary shadow-card sm:block">
          {com ? "Dia leve: a agenda se enche sozinha." : "Dia pesado: o WhatsApp manda no seu horário."}
        </p>
        <p role="status" aria-live="polite" className="sr-only">
          {`${niche.label}: mostrando o dia ${com ? "com" : "sem"} o InnoChat.`}
        </p>
      </div>

      <ol className="ds-line mt-8 sm:mt-10">
        {scenes.map((scene, idx) => (
          <Scene key={scene.time} scene={scene} last={idx === scenes.length - 1} nicheId={niche.id} />
        ))}
      </ol>

      <div data-reveal className="ds-head mt-16 grid gap-8 lg:mt-24 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:items-end lg:gap-14">
        <p className="text-balance font-display text-3xl font-extrabold leading-tight tracking-tight text-text sm:text-4xl">
          O dia é inventado. A rotina, provavelmente, não.
        </p>
        <div className="space-y-2 border-l-2 border-primary/30 pl-5 text-sm leading-relaxed text-text-secondary sm:text-base">
          <p>
            Nomes e mensagens são fictícios e servem de exemplo. O que o InnoChat faz aqui é real: o bot agenda, remarca
            e cancela 24 horas por dia, o lembrete sai antes do horário, na antecedência que você escolher, e, quando
            alguém pede uma pessoa, a sua equipe responde pelo painel.
          </p>
          <p>Vale para salão, clínica, consultório, pet shop, odontologia, fisioterapia e qualquer negócio de horário marcado.</p>
        </div>
      </div>
    </div>
  );
}
