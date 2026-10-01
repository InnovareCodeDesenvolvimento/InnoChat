"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCheck, RotateCcw } from "lucide-react";
import { cn } from "@/components/lib/cn";
import { WhatsappText } from "./whatsapp-text";
import type { DemoMessage } from "./demo-script";

/**
 * Celular com a conversa do bot. Client Component só por causa do tempo (as mensagens entram uma
 * a uma). O HTML do servidor já traz TODAS as mensagens; quem tem `prefers-reduced-motion` (ou
 * não tem JS) vê a conversa completa e parada. Para os demais o CSS (`.demo[data-mode]`) esconde
 * o que ainda não "chegou" e o efeito abaixo conduz o relógio: começa quando o celular entra na
 * tela (IntersectionObserver), mostra "digitando" antes de cada resposta do bot e, no fim,
 * oferece "Rever".
 */
type Mode = "idle" | "playing" | "done";

const TYPING_MS = 1000;
const CLIENT_GAP_MS = 750;

function readingPause(text: string): number {
  return Math.min(3200, 650 + text.length * 7);
}

export function PhoneDemo({ messages, company }: { messages: DemoMessage[]; company: string }) {
  const [mode, setMode] = useState<Mode>("idle");
  const [shown, setShown] = useState(0);
  const [typing, setTyping] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
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

  return (
    <div className="mx-auto w-full max-w-[19rem]">
      <div
        ref={rootRef}
        data-mode={mode}
        data-testid="phone-demo"
        role="group"
        aria-label={`Exemplo de conversa de WhatsApp com o bot da ${company}`}
        className="demo relative flex h-[34rem] flex-col overflow-hidden rounded-[2.5rem] bg-sidebar p-2.5 shadow-2xl ring-1 ring-white/20"
      >
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[2rem] bg-bg">
          <div className="flex items-center gap-3 bg-success px-4 py-3 text-white">
            <span
              aria-hidden="true"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/25 font-display text-sm font-extrabold"
            >
              SB
            </span>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold leading-tight">{company}</p>
              <p className="text-xs leading-tight text-white">atendimento automático</p>
            </div>
          </div>

          <div className="demo-chat flex min-h-0 flex-1 flex-col justify-end gap-2 overflow-hidden px-3 pb-3 pt-6">
            {messages.map((message, index) => (
              <div
                key={message.id}
                data-shown={index < shown || mode !== "playing" ? "true" : "false"}
                className={cn("demo-msg flex flex-col", message.from === "client" ? "items-end" : "items-start")}
              >
                {message.note ? (
                  <p className="mb-1 self-center rounded-full bg-surface px-3 py-1 text-center text-[11px] font-medium leading-snug text-text-secondary ring-1 ring-border">
                    {message.note}
                  </p>
                ) : null}
                <div
                  className={cn(
                    "max-w-[88%] rounded-2xl px-3 py-2 text-[13px] leading-snug text-text shadow-sm",
                    message.from === "client" ? "rounded-br-md bg-success-bg" : "rounded-bl-md bg-surface",
                  )}
                >
                  <WhatsappText text={message.text} />
                  <span className="mt-1 flex items-center justify-end gap-1 text-[10px] leading-none text-text-secondary">
                    {message.time}
                    {message.from === "client" ? <CheckCheck className="h-3 w-3 text-primary" aria-hidden="true" /> : null}
                  </span>
                </div>
              </div>
            ))}
            {typing ? (
              <div className="demo-typing flex items-start" aria-hidden="true">
                <span className="flex items-center gap-1 rounded-2xl rounded-bl-md bg-surface px-3.5 py-3 shadow-sm">
                  <span className="demo-dot h-1.5 w-1.5 rounded-full bg-text-secondary" />
                  <span className="demo-dot h-1.5 w-1.5 rounded-full bg-text-secondary [animation-delay:150ms]" />
                  <span className="demo-dot h-1.5 w-1.5 rounded-full bg-text-secondary [animation-delay:300ms]" />
                </span>
              </div>
            ) : null}
          </div>

          <div aria-hidden="true" className="flex items-center gap-2 border-t border-border bg-surface px-3 py-2.5">
            <span className="flex-1 rounded-full bg-bg px-3 py-2 text-xs text-text-secondary">Mensagem</span>
          </div>
        </div>
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
