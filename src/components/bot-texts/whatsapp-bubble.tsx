import { CheckCheck } from "lucide-react";
import { cn } from "@/components/lib/cn";
import { WA_TOKENS } from "@/components/whatsapp/phone-mockup";
import { parseWhatsAppText, type WaSpan } from "./whatsapp-format";

function Span({ span }: { span: WaSpan }) {
  if (!span.bold && !span.italic && !span.strike && !span.mono) return <>{span.text}</>;
  return (
    <span
      className={cn(
        span.bold && "font-bold",
        span.italic && "italic",
        span.strike && "line-through",
        span.mono && "rounded-sm bg-black/5 font-mono text-[0.92em]",
      )}
    >
      {span.text}
    </span>
  );
}

/**
 * Prévia no formato do WhatsApp: fundo bege do chat, balão verde de saída (mesmos tokens `--wa-*`
 * do mockup do celular — valem só aqui dentro), com negrito/itálico/tachado, keycaps e quebras de
 * linha. Decorativo para leitor de tela: quem usa deve rotular o contêiner.
 */
export function WhatsAppBubble({ text, name, className }: { text: string; name: string; className?: string }) {
  const lines = parseWhatsAppText(text);
  return (
    <div style={WA_TOKENS} className={cn("overflow-hidden rounded-hero border border-border shadow-card", className)}>
      <div className="flex items-center gap-2.5 bg-[var(--wa-header)] px-3 py-2.5 text-white">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#DFE5E7] text-[11px] font-bold text-[#54656F]">
          {name.slice(0, 2).toUpperCase()}
        </span>
        <div className="min-w-0 leading-tight">
          <p className="truncate text-sm font-semibold">{name}</p>
          <p className="text-[11px] text-white/85">online</p>
        </div>
      </div>
      <div className="flex min-h-40 justify-end bg-[var(--wa-bg)] p-3">
        <div
          data-testid="wa-bubble"
          className="relative min-w-0 max-w-[92%] rounded-lg rounded-tr-none bg-[var(--wa-out)] px-2.5 py-1.5 text-[14px] leading-snug text-[var(--wa-ink)] shadow-[0_1px_0.5px_rgb(11_20_26/0.13)]"
        >
          {text ? (
            <p className="break-words">
              {lines.map((spans, i) => (
                <span key={i} className="block min-h-[1.3em]">
                  {spans.map((span, j) => (
                    <Span key={j} span={span} />
                  ))}
                </span>
              ))}
            </p>
          ) : (
            <p className="text-[var(--wa-ink-2)]">Escreva o texto para ver a prévia.</p>
          )}
          <span className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-[var(--wa-ink-2)]">
            14:32
            <CheckCheck className="h-3.5 w-3.5 text-[var(--wa-tick)]" strokeWidth={2.4} aria-hidden="true" />
          </span>
        </div>
      </div>
    </div>
  );
}
