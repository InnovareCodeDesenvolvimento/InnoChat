"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/components/lib/cn";

/**
 * Abas de NAVEGAÇÃO: cada aba é uma rota própria, então o padrão certo é uma lista de links com
 * `aria-current="page"` (não `role=tablist`, que prometeria painéis na mesma página). Setas
 * esquerda/direita, Home e End movem o foco entre as abas (Enter ativa, como em qualquer link).
 * A barra rola na horizontal quando não cabe (celular) e mantém a aba ativa à vista.
 */

export type TabNavItem = {
  id: string;
  href: string;
  label: string;
  icon?: LucideIcon;
  active: boolean;
  /** Algo desta aba pede atenção: ponto discreto + aviso para leitor de tela. */
  attention?: boolean;
};

export function TabNav({
  items,
  ariaLabel,
  onItemClick,
  className,
}: {
  items: ReadonlyArray<TabNavItem>;
  ariaLabel: string;
  /** Chance de interceptar a navegação (ex.: avisar de alterações não salvas). */
  onItemClick?: (e: React.MouseEvent<HTMLAnchorElement>, item: TabNavItem) => void;
  className?: string;
}) {
  const refs = useRef<Record<string, HTMLAnchorElement | null>>({});
  const activeId = items.find((i) => i.active)?.id;

  useEffect(() => {
    const el = activeId ? refs.current[activeId] : null;
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const count = items.length;
    const next = e.key === "Home" ? 0 : e.key === "End" ? count - 1 : e.key === "ArrowRight" ? (index + 1) % count : (index + count - 1) % count;
    refs.current[items[next].id]?.focus();
  }

  return (
    <nav aria-label={ariaLabel} className={cn("-mx-1 overflow-x-auto px-1 [scrollbar-width:thin]", className)} data-testid="tab-nav">
      <ul className="flex min-w-max gap-1 border-b border-border">
        {items.map((item, index) => {
          const Icon = item.icon;
          return (
            <li key={item.id}>
              <Link
                ref={(el) => {
                  refs.current[item.id] = el;
                }}
                href={item.href}
                aria-current={item.active ? "page" : undefined}
                onClick={(e) => onItemClick?.(e, item)}
                onKeyDown={(e) => onKeyDown(e, index)}
                className={cn(
                  "relative -mb-px flex min-h-11 items-center gap-2 whitespace-nowrap rounded-t-card border-b-2 px-3.5 text-sm font-semibold transition-colors duration-150 motion-reduce:transition-none",
                  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary",
                  item.active ? "border-primary text-primary" : "border-transparent text-text-secondary hover:bg-bg hover:text-text",
                )}
              >
                {Icon ? <Icon className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
                {item.label}
                {item.attention ? (
                  <>
                    <span className="h-2 w-2 shrink-0 rounded-full bg-warning" aria-hidden="true" data-testid={`tab-attention-${item.id}`} />
                    <span className="sr-only">, precisa de atenção</span>
                  </>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
