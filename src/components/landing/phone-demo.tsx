"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCheck, ChevronLeft, Phone, RotateCcw, Video } from "lucide-react";
import { cn } from "@/components/lib/cn";
import {
  ChatDoodle,
  ChatInputBar,
  HomeIndicator,
  initialsOf,
  PhoneFrame,
  StatusBarTime,
} from "@/components/whatsapp/phone-mockup";
import { WhatsappText } from "./whatsapp-text";
import type { DemoMessage } from "./demo-script";

/**
 * Celular com a conversa do bot. Client Component só por causa do tempo (as mensagens entram uma
 * a uma). O HTML do servidor já traz TODAS as mensagens; quem tem `prefers-reduced-motion` (ou
 * não tem JS) vê a conversa completa e parada. Para os demais o CSS (`.demo[data-mode]`) esconde
 * o que ainda não "chegou" e o efeito abaixo conduz o relógio: começa quando o celular entra na
 * tela (IntersectionObserver), mostra "digitando..." no cabeçalho antes de cada resposta do bot e, no fim,
 * oferece "Rever".
 */
type Mode = "idle" | "playing" | "done";

/** Aparelho maior que o do painel (260x520): o texto do bot é longo e precisa ficar legível. */
const PHONE_WIDTH = 300;
const PHONE_HEIGHT = 560;

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
        aria-label={`Exemplo de conversa de WhatsApp com o bot da ${company}`}
        className="demo mx-auto w-fit"
      >
        <PhoneFrame width={PHONE_WIDTH} height={PHONE_HEIGHT}>
          <div className="flex h-full flex-col bg-[var(--wa-bg)]">
            <div className="bg-[var(--wa-header)]">
              <StatusBarTime />
              <div className="flex items-center gap-1.5 px-2 pb-2 pt-1 text-white">
                <ChevronLeft aria-hidden="true" className="h-5 w-5 shrink-0" />
                <span
                  aria-hidden="true"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#DFE5E7] text-[12px] font-bold text-[#54656F]"
                >
                  {initialsOf(company)}
                </span>
                <div className="min-w-0 flex-1 leading-tight">
                  <p className="truncate text-[14px] font-semibold">{company}</p>
                  <p aria-hidden="true" data-testid="phone-demo-status" className="truncate text-[11px] text-white">
                    {typing ? "digitando..." : "online"}
                  </p>
                </div>
                <Video aria-hidden="true" className="h-4 w-4 shrink-0" />
                <Phone aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
              </div>
            </div>

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
                  <div
                    aria-hidden="true"
                    className="mx-auto rounded-md bg-white/90 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--wa-ink-2)] shadow-[0_1px_0.5px_rgb(11_20_26/0.1)]"
                  >
                    Hoje
                  </div>
                  {messages.map((message, index) => {
                    const out = message.from === "client";
                    const startsRun = index === 0 || messages[index - 1].from !== message.from || Boolean(message.note);
                    return (
                      <div
                        key={message.id}
                        data-shown={index < shown || mode !== "playing" ? "true" : "false"}
                        className={cn("demo-msg flex flex-col", out ? "items-end" : "items-start", startsRun ? "mt-1" : "")}
                      >
                        {message.note ? (
                          <p className="mb-1.5 self-center rounded-md bg-[#FFF5C4] px-2.5 py-1 text-center text-[11px] font-medium leading-snug text-[#54656F] shadow-[0_1px_0.5px_rgb(11_20_26/0.1)]">
                            {message.note}
                          </p>
                        ) : null}
                        <div
                          className={cn(
                            "relative max-w-[86%] rounded-lg px-2 py-1.5 text-[13px] leading-snug text-[var(--wa-ink)] shadow-[0_1px_0.5px_rgb(11_20_26/0.13)]",
                            out ? "bg-[var(--wa-out)]" : "bg-[var(--wa-in)]",
                            startsRun ? (out ? "rounded-tr-none" : "rounded-tl-none") : "",
                          )}
                        >
                          {startsRun ? (
                            <span
                              aria-hidden="true"
                              className={cn(
                                "absolute top-0 h-3 w-2",
                                out
                                  ? "-right-[7px] bg-[var(--wa-out)] [clip-path:polygon(0_0,100%_0,0_100%)]"
                                  : "-left-[7px] bg-[var(--wa-in)] [clip-path:polygon(0_0,100%_0,100%_100%)]",
                              )}
                            />
                          ) : null}
                          <WhatsappText text={message.text} />
                          <span
                            className={cn(
                              "float-right ml-2 mt-1.5 inline-flex items-center gap-0.5 text-[10px] leading-none",
                              out ? "text-[#54656F]" : "text-[var(--wa-ink-2)]",
                            )}
                          >
                            {message.time}
                            {out ? <CheckCheck className="h-3.5 w-3.5 text-[var(--wa-tick)]" strokeWidth={2.4} aria-hidden="true" /> : null}
                          </span>
                          <span aria-hidden="true" className="block clear-both" />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div aria-hidden="true">
              <ChatInputBar />
            </div>
            <HomeIndicator />
          </div>
        </PhoneFrame>
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
