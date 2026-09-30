"use client";

import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/components/lib/cn";
import { STAGGER_DELAY_S } from "@/components/lib/motion";
import { HelpButton } from "@/components/help/help-button";
import type { HelpKey } from "@/components/help/help-content";
import { AnimatedCounter } from "./animated-counter";

export type StatCardTone = "primary" | "success" | "warning" | "danger";

const TONE_CLASSES: Record<StatCardTone, string> = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  danger: "bg-danger-bg text-danger",
};

export type StatCardProps = {
  /**
   * Elemento JÁ RENDERIZADO (ex.: `<CalendarClock aria-hidden="true" />`), nunca o COMPONENTE
   * (`LucideIcon`) — este é um Client Component (`motion.div`/`AnimatedCounter`) e quem o chama
   * é sempre um Server Component (`inicio/page.tsx`). Passar a função do ícone como prop quebra
   * o build ("Only plain objects can be passed to Client Components from Server Components"),
   * a mesma armadilha já registrada na memória para `nav-items.ts`/`sidebar-nav.tsx` — aqui ela
   * se repetiu porque o ícone SÓ atravessa a fronteira quando é o componente em si, não quando
   * já é um elemento. O tamanho vem do wrapper (`[&>svg]:h-*`), não de uma prop `className` no
   * ícone — o mesmo elemento é usado duas vezes (selo + decorativo gigante) em tamanhos diferentes.
   */
  icon: React.ReactNode;
  label: string;
  value: number;
  /**
   * Sufixo estático depois do número animado (ex.: `"%"`) — de propósito NÃO é uma função
   * `format(n) => string`: função também não atravessa a fronteira Server→Client (mesmo motivo
   * do `icon`, ver comentário acima — "Functions cannot be passed directly to Client
   * Components"). Cobre o único caso real desta tela (percentual); se aparecer uma formatação
   * mais rica no futuro, ela entra como outro tipo de dado serializável, nunca como função.
   */
  suffix?: string;
  /** Pílula de contexto abaixo do número (ex.: "+12% vs. semana passada"). */
  context?: string;
  tone?: StatCardTone;
  /** Índice na grade — usado só para escalonar a entrada (§7), não muda nada visualmente depois. */
  index?: number;
  /** Único cartão "hero" da tela usa raio maior (`rounded-hero-lg`) — os demais usam `rounded-hero`
   * (docs/design/premium-spec.md §6, os dois multiplicadores testados antes de fixar). */
  size?: "default" | "hero";
  /** Chave do texto de ajuda: "i" no canto superior direito do cartão. */
  help?: HelpKey;
  className?: string;
};

/**
 * `StatCard` fundido (docs/design/premium-spec.md §8): círculo tingido (não quadrado neutro —
 * esconder a categoria da métrica pela cor piora a escaneabilidade), ícone gigante decorativo a
 * 7% de opacidade no canto, pílula de contexto, hover com borda ganhando cor + sombra tingida +
 * `scale-110` no selo, entrada escalonada por índice.
 */
export function StatCard({
  icon,
  label,
  value,
  suffix,
  context,
  tone = "primary",
  index = 0,
  size = "default",
  help,
  className,
}: StatCardProps) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      initial={reduceMotion ? undefined : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, delay: index * STAGGER_DELAY_S, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        "group relative overflow-hidden border border-border bg-surface p-5 shadow-card",
        "transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-card-hover motion-reduce:transition-none motion-reduce:hover:translate-y-0",
        size === "hero" ? "rounded-hero-lg" : "rounded-hero",
        className,
      )}
    >
      <div
        className="pointer-events-none absolute -right-3 -top-3 text-text opacity-[0.07] [&>svg]:h-24 [&>svg]:w-24"
        aria-hidden="true"
      >
        {icon}
      </div>
      {help ? <HelpButton helpKey={help} placement="corner" /> : null}
      <div
        className={cn(
          "mb-4 flex h-11 w-11 items-center justify-center rounded-full transition-transform duration-200 group-hover:scale-110 motion-reduce:transition-none motion-reduce:group-hover:scale-100 [&>svg]:h-5 [&>svg]:w-5",
          TONE_CLASSES[tone],
        )}
      >
        {icon}
      </div>
      <p className="text-sm font-medium text-text-secondary">{label}</p>
      <p className="mt-1 font-display text-4xl font-black tabular-nums text-text">
        <AnimatedCounter value={value} />
        {suffix}
      </p>
      {context ? (
        <span className="mt-3 inline-flex items-center rounded-full border border-border bg-bg px-2.5 py-1 text-xs font-medium text-text-secondary">
          {context}
        </span>
      ) : null}
    </motion.div>
  );
}
