"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { X } from "lucide-react";
import { cn } from "@/components/lib/cn";

/**
 * Botão flutuante "Tirar dúvidas": leva ao WhatsApp comercial (atendido pelo próprio Inno) quem
 * quer conversar antes de se cadastrar. Só existe na landing pública e só quando há número
 * cadastrado (a página não renderiza o componente com `null`).
 *
 * - Convite ("Ficou com dúvida? Fala comigo!") aparece uma vez, ~8 s depois de carregar; o "fechou"
 *   vale só para a sessão (sessionStorage), como o dono pediu.
 * - Nunca cobre CTA: a cada rolagem/redimensionamento (e num intervalo curto, para o "Rever" que
 *   surge sozinho) o conjunto botão+convite é comparado com os CTAs de cadastro, o "Rever" da demo
 *   e o rodapé; se encostar em algum, recolhe (invisível, fora do foco e do leitor de tela).
 * - O selo verde é um SVG próprio (balão de conversa), não o logotipo oficial do WhatsApp.
 */
const INVITE_DELAY_MS = 8_000;
const INVITE_LIFETIME_MS = 16_000;
const STORAGE_KEY = "innochat:convite-duvidas";
const MESSAGE = "Olá! Vim pelo site e quero tirar uma dúvida sobre o InnoChat.";
/** Elementos que o botão nunca pode cobrir. */
const AVOID_SELECTOR = 'main a[href^="/cadastro"], .demo-replay, footer';
const AVOID_PADDING = 12;

export function buildSalesWhatsappHref(e164: string): string {
  return `https://wa.me/${e164}?text=${encodeURIComponent(MESSAGE)}`;
}

function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed() {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* sessionStorage indisponível (modo privado): o convite só não é lembrado. */
  }
}

/** Selo de balão de conversa (desenho próprio). */
function ChatBadge({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" className={className}>
      <path
        d="M12 3.2c-4.9 0-8.8 3.5-8.8 7.8 0 2.1.9 4 2.5 5.4-.1 1.2-.6 2.3-1.4 3.2 0 0 2.5.2 4.3-1.2.9.3 2.4.6 3.4.6 4.9 0 8.8-3.5 8.8-7.8S16.9 3.2 12 3.2Z"
        fill="currentColor"
      />
      <circle cx="8.4" cy="11" r="1.15" fill="#128C4A" />
      <circle cx="12" cy="11" r="1.15" fill="#128C4A" />
      <circle cx="15.6" cy="11" r="1.15" fill="#128C4A" />
    </svg>
  );
}

export function SalesWhatsappButton({ e164, display }: { e164: string; display: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [avoiding, setAvoiding] = useState(false);

  // Convite: uma vez, depois de uns 8 s; some sozinho depois de um tempo e nunca volta na sessão.
  useEffect(() => {
    if (readDismissed()) return;
    let hideTimer: number | undefined;
    const showTimer = window.setTimeout(() => {
      setInviteOpen(true);
      hideTimer = window.setTimeout(() => {
        setInviteOpen(false);
        writeDismissed();
      }, INVITE_LIFETIME_MS);
    }, INVITE_DELAY_MS);
    return () => {
      window.clearTimeout(showTimer);
      if (hideTimer) window.clearTimeout(hideTimer);
    };
  }, []);

  // Colisão com CTAs / "Rever" / rodapé.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      const mine = box.getBoundingClientRect();
      const hit = Array.from(document.querySelectorAll(AVOID_SELECTOR)).some((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        return (
          r.left < mine.right + AVOID_PADDING &&
          r.right > mine.left - AVOID_PADDING &&
          r.top < mine.bottom + AVOID_PADDING &&
          r.bottom > mine.top - AVOID_PADDING
        );
      });
      setAvoiding((prev) => (prev === hit ? prev : hit));
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(check);
    };
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const interval = window.setInterval(() => {
      if (!document.hidden) schedule();
    }, 700);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.clearInterval(interval);
    };
  }, [inviteOpen]);

  function closeInvite() {
    setInviteOpen(false);
    writeDismissed();
  }

  return (
    <div
      ref={boxRef}
      data-testid="duvidas-box"
      data-avoiding={avoiding ? "true" : "false"}
      className={cn(
        "fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-30 flex flex-col items-end gap-3 transition-[opacity,transform,visibility] duration-200 motion-reduce:transition-none sm:right-6",
        avoiding && "invisible translate-y-2 opacity-0",
      )}
    >
      <div role="status" className="contents">
        {inviteOpen ? (
          <div
            data-testid="duvidas-convite"
            className="duvidas-convite relative flex max-w-[17rem] items-center gap-1 rounded-hero bg-surface py-1 pl-4 pr-1 text-sm font-semibold leading-snug text-text shadow-2xl ring-1 ring-border"
          >
            <span>Ficou com dúvida? Fala comigo!</span>
            <button
              type="button"
              onClick={closeInvite}
              aria-label="Fechar convite"
              className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-bg hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
            <span
              aria-hidden="true"
              className="absolute -bottom-1 right-8 h-2.5 w-2.5 rotate-45 bg-surface ring-1 ring-border [clip-path:polygon(100%_0,100%_100%,0_100%)]"
            />
          </div>
        ) : null}
      </div>

      <a
        href={buildSalesWhatsappHref(e164)}
        target="_blank"
        rel="noopener"
        data-testid="duvidas-botao"
        aria-label="Tirar dúvidas pelo WhatsApp com o Inno (abre em nova aba)"
        title={`WhatsApp ${display}`}
        onClick={() => {
          setInviteOpen(false);
          writeDismissed();
        }}
        className="group flex h-14 items-center rounded-full bg-surface p-1 text-text shadow-2xl ring-1 ring-border transition-[transform,box-shadow] hover:-translate-y-0.5 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary"
      >
        <span className="relative h-12 w-12 shrink-0">
          <Image
            src="/mascote/inno-avatar.webp"
            alt=""
            width={96}
            height={96}
            unoptimized
            className="h-12 w-12 rounded-full bg-sidebar object-cover"
          />
          <span className="absolute -bottom-0.5 -right-0.5 flex h-[22px] w-[22px] items-center justify-center rounded-full bg-[#128C4A] text-white ring-2 ring-surface">
            <ChatBadge className="h-3.5 w-3.5" />
          </span>
        </span>
        <span className="hidden whitespace-nowrap pl-3 pr-4 text-sm font-bold sm:inline">Tirar dúvidas</span>
      </a>
    </div>
  );
}
