import { CheckCheck, ChevronLeft, Phone, Video } from "lucide-react";
import { cn } from "@/components/lib/cn";
import { initialsOf, StatusBarTime } from "@/components/whatsapp/phone-mockup";
import { WhatsappText } from "./whatsapp-text";
import type { DemoMessage } from "./demo-script";

/**
 * Peças de tela de WhatsApp compartilhadas entre a demo do hero (`phone-demo.tsx`) e a jornada
 * (`journey-phone.tsx`): cabeçalho da conversa e balão de mensagem. Presentacionais, sem estado.
 */
export function DemoChatHeader({ company, typing, statusTestId }: { company: string; typing: boolean; statusTestId?: string }) {
  return (
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
          <p aria-hidden="true" data-testid={statusTestId} className="truncate text-[11px] text-white">
            {typing ? "digitando..." : "online"}
          </p>
        </div>
        <Video aria-hidden="true" className="h-4 w-4 shrink-0" />
        <Phone aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
      </div>
    </div>
  );
}

/** Chip "Hoje" do topo da conversa. */
export function DemoDayChip() {
  return (
    <div
      aria-hidden="true"
      className="mx-auto rounded-md bg-white/90 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--wa-ink-2)] shadow-[0_1px_0.5px_rgb(11_20_26/0.1)]"
    >
      Hoje
    </div>
  );
}

/**
 * Um balão. `startsRun` = primeira mensagem de uma sequência do mesmo remetente (ganha o "rabinho").
 * `shown` e a classe `demo-msg` são os ganchos do CSS da demo do hero; a jornada passa `className`
 * e `style` próprios para a entrada animada.
 */
export function DemoBubble({
  message,
  startsRun,
  shown = true,
  className,
  style,
  testId,
}: {
  message: DemoMessage;
  startsRun: boolean;
  shown?: boolean;
  className?: string;
  style?: React.CSSProperties;
  testId?: string;
}) {
  const out = message.from === "client";
  return (
    <div
      data-shown={shown ? "true" : "false"}
      data-testid={testId}
      style={style}
      className={cn("demo-msg flex flex-col", out ? "items-end" : "items-start", startsRun ? "mt-1" : "", className)}
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
}

export function startsRunAt(messages: DemoMessage[], index: number): boolean {
  return index === 0 || messages[index - 1].from !== messages[index].from || Boolean(messages[index].note);
}
