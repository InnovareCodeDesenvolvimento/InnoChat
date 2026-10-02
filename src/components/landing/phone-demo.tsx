"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";
import { ChatDoodle, ChatInputBar, HomeIndicator, PhoneFrame } from "@/components/whatsapp/phone-mockup";
import { DemoBubble, DemoChatHeader, DemoDayChip, startsRunAt } from "./demo-parts";
import type { DemoMessage } from "./demo-script";

/**
 * Celular com a conversa do bot. Client Component só por causa do tempo (as mensagens entram uma
 * a uma). O HTML do servidor já traz TODAS as mensagens; quem tem `prefers-reduced-motion` (ou
 * não tem JS) vê a conversa completa e parada. Para os demais o CSS (`.demo[data-mode]`) esconde
 * o que ainda não "chegou" e o efeito abaixo conduz o relógio: começa quando o celular entra na
 * tela (IntersectionObserver), mostra "digitando..." no cabeçalho antes de cada resposta do bot e, no fim,
 * oferece "Rever".
 */
export type DemoMode = "idle" | "playing" | "done";
type Mode = DemoMode;

/** Aparelho maior que o do painel (260x520): o texto do bot é longo e precisa ficar legível. */
const PHONE_WIDTH = 300;
const PHONE_HEIGHT = 560;

// Ritmo de conversa real, mas curto: a confirmação precisa aparecer antes de a pessoa rolar a página.
const TYPING_MS = 700;
const CLIENT_GAP_MS = 500;

function readingPause(text: string): number {
  return Math.min(2200, 450 + text.length * 5);
}

export function PhoneDemo({
  messages,
  company,
  companion,
}: {
  messages: DemoMessage[];
  company: string;
  /** Conteúdo ao lado do aparelho (o Inno), que reage ao estado da demo. Posicionado pelo chamador. */
  companion?: (state: { mode: DemoMode; typing: boolean }) => ReactNode;
}) {
  const [mode, setMode] = useState<Mode>("idle");
  const [shown, setShown] = useState(0);
  const [typing, setTyping] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timers = useRef<number[]>([]);
  const started = useRef(false);

  const clearTimers = useCallback(() => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
  }, []);

  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);

  const play = useCallback(() => {
    clearTimers();
    setShown(0);
    setTyping(false);
    setMode("playing");

    const step = (index: number) => {
      if (index >= messages.length) {
        setTyping(false);
        setMode("done");
        return;
      }
      const message = messages[index];
      const reveal = () => {
        setTyping(false);
        setShown(index + 1);
        later(() => step(index + 1), readingPause(message.text));
      };
      if (message.from === "bot") {
        setTyping(true);
        later(reveal, TYPING_MS);
      } else {
        later(reveal, CLIENT_GAP_MS);
      }
    };
    later(() => step(0), 500);
  }, [clearTimers, later, messages]);

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof IntersectionObserver === "undefined") {
      const id = window.setTimeout(() => play(), 0);
      return () => window.clearTimeout(id);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (started.current) return;
        if (entries.some((entry) => entry.isIntersecting)) {
          started.current = true;
          observer.disconnect();
          play();
        }
      },
      { threshold: 0.35 },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
      clearTimers();
    };
  }, [clearTimers, play]);

  // A conversa "desce" como no app: a cada mensagem nova o chat rola até o fim (só o contêiner
  // interno, nunca a página).
  useEffect(() => {
    if (mode !== "playing") return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [mode, shown, typing]);

  return (
    <div className="mx-auto w-full max-w-[19rem]">
      <div
        ref={rootRef}
        data-mode={mode}
        data-testid="phone-demo"
        role="group"
        aria-label={`Exemplo de conversa de WhatsApp com o bot da empresa ${company}`}
        className="demo relative mx-auto w-fit"
      >
        <PhoneFrame width={PHONE_WIDTH} height={PHONE_HEIGHT}>
          <div className="flex h-full flex-col bg-[var(--wa-bg)]">
            <DemoChatHeader company={company} typing={typing} statusTestId="phone-demo-status" />

            <div className="relative min-h-0 flex-1">
              <ChatDoodle />
              <div
                ref={scrollRef}
                tabIndex={0}
                role="region"
                aria-label="Mensagens da conversa de exemplo"
                className="relative flex h-full flex-col overflow-y-auto px-2.5 py-2.5 [scrollbar-width:none] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--wa-header)] [&::-webkit-scrollbar]:hidden"
              >
                <div className="mt-auto flex flex-col gap-1.5">
                  <DemoDayChip />
                  {messages.map((message, index) => (
                    <DemoBubble
                      key={message.id}
                      message={message}
                      startsRun={startsRunAt(messages, index)}
                      shown={index < shown || mode !== "playing"}
                    />
                  ))}
                </div>
              </div>
            </div>

            <div aria-hidden="true">
              <ChatInputBar />
            </div>
            <HomeIndicator />
          </div>
        </PhoneFrame>
        {companion ? companion({ mode, typing }) : null}
      </div>

      <div className="mt-3 flex min-h-11 items-center justify-center gap-3">
        <p className="text-center text-xs text-sidebar-text">Exemplo com dados fictícios, com os textos reais do bot.</p>
        {mode === "done" ? (
          <button
            type="button"
            onClick={play}
            className="demo-replay inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-card px-2 text-xs font-semibold text-sidebar-active-text underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sidebar-active-text"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            Rever
          </button>
        ) : null}
      </div>
    </div>
  );
}
