import type { CSSProperties, ReactNode } from "react";
import { ChevronLeft, Phone, Plus, Mic, Smile, WifiOff, CheckCheck } from "lucide-react";
import { cn } from "@/components/lib/cn";

/**
 * Celular estilizado (CSS puro, sem imagem) usado no card de cada número da tela WhatsApp.
 * Tamanho fixo de 260x520 (proporção de aparelho real); no mobile o CHAMADOR reduz com
 * `PhoneScale` (escala 0.85 dentro de uma caixa já reduzida — nada de reflow interno).
 *
 * Cores: o verde/bege do WhatsApp são tokens LOCAIS deste componente (`--wa-*`), valem só
 * DENTRO da tela do aparelho. Moldura e sombra são neutras/derivadas do tema da empresa.
 */
export const WA_TOKENS = {
  "--wa-header": "#008069",
  "--wa-bg": "#EFEAE2",
  "--wa-doodle": "#D6CDBE",
  "--wa-in": "#FFFFFF",
  "--wa-out": "#D9FDD3",
  "--wa-ink": "#111B21",
  "--wa-ink-2": "#667781",
  "--wa-tick": "#53BDEB",
  "--wa-off": "#0B141A",
} as CSSProperties;

export const PHONE_W = 260;
export const PHONE_H = 520;

/** Caixa que reserva o espaço já reduzido no mobile (0.85) e no tamanho cheio a partir de `sm`. */
export function PhoneScale({
  children,
  compact = false,
  className,
}: {
  children: ReactNode;
  /** Versão menor (0.7 em qualquer tela) para o celular fantasma do "Adicionar número". */
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative",
        compact ? "h-[364px] w-[182px]" : "h-[442px] w-[221px] sm:h-[520px] sm:w-[260px]",
        className,
      )}
    >
      <div
        className={cn(
          "absolute left-0 top-0 origin-top-left",
          compact ? "scale-[0.7]" : "scale-[0.85] sm:scale-100",
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function PhoneFrame({
  children,
  ghost = false,
  className,
  width = PHONE_W,
  height = PHONE_H,
}: {
  children: ReactNode;
  /** Tamanho do aparelho em px (padrão 260x520, o do painel). A landing usa um maior. */
  width?: number;
  height?: number;
  /** Celular "fantasma" pontilhado do card "Adicionar número". */
  ghost?: boolean;
  className?: string;
}) {
  return (
    <div
      style={{ ...WA_TOKENS, width, height }}
      className={cn(
        "relative rounded-[42px] p-2",
        ghost
          ? "border-2 border-dashed border-border bg-transparent"
          : "bg-[#14171c] shadow-[0_18px_40px_-14px_rgb(0_0_0/0.45),inset_0_0_0_1.5px_rgb(255_255_255/0.14)]",
        className,
      )}
    >
      {ghost ? null : (
        <>
          {/* Botões laterais (volume e power) */}
          <span aria-hidden="true" className="absolute -left-[3px] top-24 h-8 w-[3px] rounded-l bg-[#14171c]" />
          <span aria-hidden="true" className="absolute -left-[3px] top-36 h-12 w-[3px] rounded-l bg-[#14171c]" />
          <span aria-hidden="true" className="absolute -right-[3px] top-32 h-16 w-[3px] rounded-r bg-[#14171c]" />
        </>
      )}
      <div className={cn("relative h-full w-full overflow-hidden rounded-[34px]", ghost ? "" : "bg-[var(--wa-off)]")}>
        {children}
        {ghost ? null : (
          <>
            {/* Ilha dinâmica + brilho sutil de vidro */}
            <span
              aria-hidden="true"
              className="absolute left-1/2 top-2 z-20 h-[18px] w-[64px] -translate-x-1/2 rounded-full bg-black"
            />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 z-20 bg-[linear-gradient(115deg,rgb(255_255_255/0.10)_0%,transparent_38%)]"
            />
          </>
        )}
      </div>
    </div>
  );
}

/** Doodle do fundo de conversa: ícones minúsculos repetidos num `<pattern>` SVG inline. */
export function ChatDoodle() {
  return (
    <svg aria-hidden="true" className="absolute inset-0 h-full w-full" focusable="false">
      <defs>
        <pattern id="wa-doodle" width="44" height="44" patternUnits="userSpaceOnUse">
          <g fill="none" stroke="var(--wa-doodle)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="9" cy="9" r="3.5" />
            <path d="M28 6l4 4m0-4l-4 4" />
            <path d="M7 30q3-5 6 0t6 0" />
            <rect x="29" y="27" width="8" height="6" rx="2" />
            <path d="M22 20l.01 0" />
          </g>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#wa-doodle)" />
    </svg>
  );
}

export function StatusBarTime() {
  return (
    <div aria-hidden="true" className="flex h-[28px] items-center justify-between px-6 pt-1 text-[11px] font-semibold text-white">
      <span>9:41</span>
      <span className="flex items-center gap-1 opacity-90">
        <span className="h-[7px] w-[11px] rounded-[2px] bg-white/90" />
        <span className="h-[7px] w-[14px] rounded-[2px] border border-white/90" />
      </span>
    </div>
  );
}

export function HomeIndicator({ dark = false }: { dark?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute bottom-1.5 left-1/2 z-10 h-1 w-[84px] -translate-x-1/2 rounded-full",
        dark ? "bg-white/40" : "bg-black/70",
      )}
    />
  );
}

export function initialsOf(label: string): string {
  const words = label.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]![0]!;
  const second = words.length > 1 ? words[words.length - 1]![0]! : (words[0]![1] ?? "");
  return (first + second).toUpperCase();
}

function Bubble({
  side,
  delay,
  children,
  time = "9:41",
}: {
  side: "in" | "out";
  delay: number;
  children: ReactNode;
  time?: string;
}) {
  return (
    <div
      className={cn("wa-bubble-in flex", side === "out" ? "justify-end" : "justify-start")}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div
        className={cn(
          "max-w-[82%] rounded-lg px-2 py-1.5 text-[11.5px] leading-snug text-[var(--wa-ink)] shadow-[0_1px_0.5px_rgb(11_20_26/0.13)]",
          side === "out" ? "rounded-tr-none bg-[var(--wa-out)]" : "rounded-tl-none bg-[var(--wa-in)]",
        )}
      >
        {children}
        <span className="ml-2 inline-flex translate-y-[3px] items-center gap-0.5 text-[9px] text-[var(--wa-ink-2)]">
          {time}
          {side === "out" ? <CheckCheck className="h-3 w-3 text-[var(--wa-tick)]" strokeWidth={2.4} /> : null}
        </span>
      </div>
    </div>
  );
}

/** Barra de digitação do WhatsApp (emoji, campo, +, microfone). Decorativa: quem usa decide o `aria-hidden`. */
export function ChatInputBar() {
  return (
    <div className="flex items-center gap-1.5 px-2 pb-5 pt-1.5">
      <div className="flex h-8 flex-1 items-center gap-1.5 rounded-full bg-white px-2.5 text-[11px] text-[var(--wa-ink-2)] shadow-[0_1px_0.5px_rgb(11_20_26/0.13)]">
        <Smile className="h-4 w-4 shrink-0" />
        <span className="flex-1 truncate">Mensagem</span>
        <Plus className="h-4 w-4 shrink-0" />
      </div>
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--wa-header)] text-white">
        <Mic className="h-4 w-4" />
      </span>
    </div>
  );
}

/**
 * Tela "conectado": cabeçalho de conversa + balões de EXEMPLO do bot. Toda a tela é decorativa
 * (`aria-hidden`); quem usa deve fornecer o texto alternativo (`PhoneAltText`). O nome do contato
 * vem de `data-name` + `::after` de propósito: não duplica o rótulo como nó de texto na página
 * (o rótulo real fica só no painel ao lado), o que também evita leitor de tela ler duas vezes.
 */
export type WelcomePreview = { greeting: string; menu: string };

export function ChatScreen({
  label,
  phoneDisplay,
  preview = null,
}: {
  label: string;
  phoneDisplay: string | null;
  /** Textos REAIS da empresa (saudação e menu já renderizados pelo servidor). Sem isso, cai no exemplo genérico. */
  preview?: WelcomePreview | null;
}) {
  return (
    <div aria-hidden="true" className="flex h-full flex-col bg-[var(--wa-bg)]">
      <div className="bg-[var(--wa-header)]">
        <StatusBarTime />
        <div className="flex items-center gap-1.5 px-2 pb-2 pt-1 text-white">
          <ChevronLeft className="h-5 w-5 shrink-0" />
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#DFE5E7] text-[11px] font-bold text-[#54656F]">
            {initialsOf(label)}
          </span>
          <div className="min-w-0 flex-1 leading-tight">
            <span
              data-name={label}
              className="block truncate text-[13px] font-semibold after:content-[attr(data-name)]"
            />
            <span className="block truncate text-[10px] text-white/85">
              {phoneDisplay ? `${phoneDisplay} · online` : "online"}
            </span>
          </div>
          <Phone className="h-3.5 w-3.5 shrink-0" />
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden">
        <ChatDoodle />
        <div className="relative flex flex-col gap-1.5 px-2.5 py-2.5">
          <div className="mx-auto rounded-md bg-white/85 px-2 py-0.5 text-[9.5px] font-medium uppercase tracking-wide text-[var(--wa-ink-2)] shadow-[0_1px_0.5px_rgb(11_20_26/0.1)]">
            Exemplo ilustrativo
          </div>
          <Bubble side="in" delay={60}>
            Oi
          </Bubble>
          {preview ? (
            <>
              <Bubble side="out" delay={200}>
                <span className="block whitespace-pre-line break-words">{preview.greeting}</span>
              </Bubble>
              <Bubble side="out" delay={340}>
                <span className="block whitespace-pre-line break-words">{preview.menu}</span>
              </Bubble>
            </>
          ) : (
            <>
              <Bubble side="out" delay={200}>
                <span className="block">Olá! Eu sou o assistente virtual. Como posso ajudar?</span>
                <span className="mt-1 block text-[var(--wa-ink-2)]">
                  1 · Agendar horário
                  <br />
                  2 · Ver serviços e preços
                  <br />
                  3 · Falar com a equipe
                </span>
              </Bubble>
              <Bubble side="in" delay={340}>
                1
              </Bubble>
              <Bubble side="out" delay={480}>
                Ótimo! Para qual dia você quer o horário?
              </Bubble>
            </>
          )}
        </div>
      </div>

      <ChatInputBar />
      <HomeIndicator />
    </div>
  );
}

/** Tela "aguardando QR" no estilo WhatsApp Web. O QR é informativo (não é `aria-hidden`). */
export function QrScreen({
  label,
  qrDataUrl,
  message,
  action,
}: {
  label: string;
  qrDataUrl: string | null;
  message: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col bg-[var(--wa-in)] text-[var(--wa-ink)]">
      <div className="bg-[var(--wa-header)]">
        <StatusBarTime />
        <p className="px-4 pb-3 pt-1 text-[13px] font-semibold text-white">Conectar ao WhatsApp</p>
      </div>
      <div className="flex flex-1 flex-col items-center px-4 pt-4 text-center">
        <div className="relative flex h-[176px] w-[176px] items-center justify-center overflow-hidden rounded-xl border border-[#E1E5E8] bg-white p-2">
          {qrDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- imagem base64 gerada em runtime pela Evolution
            <img
              src={qrDataUrl}
              alt={`QR code do número ${label}. Abra o WhatsApp no celular, vá em Aparelhos conectados e escaneie.`}
              width={160}
              height={160}
              className="h-full w-full [image-rendering:pixelated]"
            />
          ) : (
            <div role="status" aria-label="Gerando o QR code" className="skeleton-shimmer h-full w-full rounded-lg" />
          )}
          {qrDataUrl ? (
            <span
              aria-hidden="true"
              className="wa-scan-line pointer-events-none absolute left-2 right-2 top-2 h-0.5 rounded-full bg-[var(--wa-header)] opacity-70"
            />
          ) : null}
        </div>
        <p role="status" className="mt-3 text-[12px] font-medium leading-snug">
          {message}
        </p>
        <ol className="mt-2 space-y-0.5 text-left text-[11px] leading-snug text-[var(--wa-ink-2)]">
          <li>1. Abra o WhatsApp no celular</li>
          <li>2. Toque em Aparelhos conectados</li>
          <li>3. Aponte a câmera para este código</li>
        </ol>
        {action ? <div className="mt-auto pb-6">{action}</div> : null}
      </div>
      <HomeIndicator />
    </div>
  );
}

/** Tela apagada com o aviso "sem conexão" e a ação de reconectar (só para quem pode). */
export function OffScreen({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="relative flex h-full flex-col items-center justify-center bg-[radial-gradient(120%_70%_at_30%_0%,#1a2730_0%,var(--wa-off)_60%)] px-5 text-center text-white">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white/10">
        <WifiOff className="h-7 w-7 text-white/80" aria-hidden="true" />
      </span>
      <p className="mt-4 text-[14px] font-semibold">Número desconectado</p>
      <p className="mt-1 text-[12px] leading-snug text-white/75">{message}</p>
      {action ? <div className="mt-5">{action}</div> : null}
      <HomeIndicator dark />
    </div>
  );
}

/** Tela "fantasma" do card Adicionar número: só o "+" centralizado, sem texto dentro do aparelho. */
export function GhostScreen() {
  return (
    <div aria-hidden="true" className="flex h-full items-center justify-center text-text-secondary">
      <span className="flex h-16 w-16 items-center justify-center rounded-full border-2 border-dashed border-border bg-surface">
        <Plus className="h-7 w-7" />
      </span>
    </div>
  );
}
