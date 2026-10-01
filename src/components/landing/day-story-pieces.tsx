import type { CSSProperties, ReactNode } from "react";
import { CheckCheck, MessageCircle } from "lucide-react";
import { cn } from "@/components/lib/cn";
import { initialsOf, WA_TOKENS } from "@/components/whatsapp/phone-mockup";

/**
 * Mini-elementos de interface usados nas cenas do dia (notificação de celular, conversa de
 * WhatsApp, cartão de agenda). Tudo decorativo: quem usa envolve em `aria-hidden`, porque o texto
 * da cena já conta a mesma coisa. As classes `ds-*` (fall/pop/check/buzz) vivem no globals.css.
 */

/** Variável CSS de ordem (`--i`) usada nos atrasos escalonados das animações. */
function order(i: number, extra?: Record<string, string | number>): CSSProperties {
  return { "--i": i, ...extra } as CSSProperties;
}

/** "✓" desenhado: o traço se desenha quando o modo vira "Com InnoChat". */
export function InkCheck({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={cn("ds-check h-4 w-4", className)}>
      <path
        d="M2.5 8.6 6.4 12.4 13.5 3.8"
        pathLength={1}
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Notificação no estilo de celular (iOS/Android): ícone do app, remetente, hora e prévia. */
export function Notif({
  name,
  text,
  time,
  i = 0,
  className,
  fall,
  buzz,
}: {
  name: string;
  text: string;
  time: string;
  i?: number;
  className?: string;
  /** Deslocamento/rotação com que cai quando o modo vira (variação para não cair em bloco). */
  fall?: { x: number; r: number };
  buzz?: boolean;
}) {
  return (
    <div
      className={cn("ds-fall", buzz && "ds-buzz", className)}
      style={order(i, fall ? { "--fx": `${fall.x}px`, "--fr": `${fall.r}deg` } : undefined)}
    >
      <div className="flex gap-3 rounded-[1.25rem] border border-border bg-surface p-3 shadow-card">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-[#25D366] text-white">
          <MessageCircle className="h-[18px] w-[18px]" strokeWidth={2.4} />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <div className="flex items-baseline justify-between gap-2">
            <p className="truncate text-sm font-semibold text-text">{name}</p>
            <p className="shrink-0 text-xs tabular-nums text-text-secondary">{time}</p>
          </div>
          <p className="mt-0.5 text-sm text-text-secondary">{text}</p>
        </div>
      </div>
    </div>
  );
}

type BubbleProps = {
  side: "in" | "out";
  time: string;
  /** Tiques: enviado/entregue (cinza) ou lido (azul). Só no balão de saída. */
  ticks?: "sent" | "read";
  i?: number;
  children: ReactNode;
};

/** Balão de WhatsApp. "in" = chega para a pessoa (branco), "out" = quem lê a conversa enviou (verde). */
function Bubble({ side, time, ticks, i = 0, children }: BubbleProps) {
  return (
    <div className={cn("ds-pop flex", side === "out" ? "justify-end" : "justify-start")} style={order(i)}>
      <div
        className={cn(
          "max-w-[85%] rounded-lg px-2.5 py-1.5 text-[13px] leading-snug text-[var(--wa-ink)] shadow-[0_1px_0.5px_rgb(11_20_26/0.13)]",
          side === "out" ? "rounded-tr-none bg-[var(--wa-out)]" : "rounded-tl-none bg-[var(--wa-in)]",
        )}
      >
        <span className="block whitespace-pre-line break-words">{children}</span>
        <span className="mt-0.5 flex items-center justify-end gap-0.5 text-[10px] tabular-nums text-[var(--wa-ink-2)]">
          {time}
          {side === "out" && ticks ? (
            <CheckCheck
              className={cn("h-3.5 w-3.5", ticks === "read" ? "text-[var(--wa-tick)]" : "text-[var(--wa-ink-2)]")}
              strokeWidth={2.4}
            />
          ) : null}
        </span>
      </div>
    </div>
  );
}

export const WaBubble = Bubble;

/** Janela de conversa de WhatsApp (cabeçalho com o contato + fundo bege). `bot` mostra o selo "assistente". */
export function WaChat({ contact, children, className }: { contact: string; children: ReactNode; className?: string }) {
  return (
    <div style={WA_TOKENS} className={cn("overflow-hidden rounded-2xl border border-border shadow-card", className)}>
      <div className="flex items-center gap-2 bg-[var(--wa-header)] px-3 py-2 text-white">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#DFE5E7] text-[10px] font-bold text-[#54656F]">
          {initialsOf(contact)}
        </span>
        <p className="truncate text-sm font-semibold">{contact}</p>
      </div>
      <div className="space-y-1.5 bg-[var(--wa-bg)] p-3">{children}</div>
    </div>
  );
}

/** Cartão de agenda: linhas de horário com situação. */
export function AgendaCard({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-2xl border border-border bg-surface p-3 shadow-card", className)}>
      <p className="px-1 pb-2 text-xs font-bold uppercase tracking-wider text-text-secondary">{title}</p>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

export function AgendaRowView({
  time,
  name,
  service,
  status,
  i = 0,
}: {
  time: string;
  name: string;
  service: string;
  status: { tone: "ok" | "bad"; label: string };
  i?: number;
}) {
  const ok = status.tone === "ok";
  return (
    <div className="ds-pop flex items-center gap-3 rounded-xl bg-bg px-3 py-2" style={order(i)}>
      <span className="w-12 shrink-0 font-display text-base font-bold tabular-nums text-text">{time}</span>
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-sm font-semibold text-text">{name}</p>
        <p className="truncate text-xs text-text-secondary">{service}</p>
      </div>
      <span
        className={cn(
          "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold",
          ok ? "bg-success-bg text-success" : "bg-danger-bg text-danger",
        )}
      >
        {ok ? <InkCheck className="h-3.5 w-3.5" /> : null}
        {status.label}
      </span>
    </div>
  );
}

/** Anotação "à mão" na margem (itálico do título + seta curva). Sem JS, sem imagem. */
export function Margin({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("flex items-end gap-1.5 font-display text-lg italic text-primary", className)}>
      <svg viewBox="0 0 40 28" aria-hidden="true" focusable="false" className="h-6 w-9 shrink-0 -rotate-6">
        <path
          d="M36 4C26 3 14 6 8 20M8 20l-1-9M8 20l9-3"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="-rotate-1">{children}</span>
    </p>
  );
}
