import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/components/lib/cn";
import { HelpButton } from "@/components/help/help-button";
import type { HelpKey } from "@/components/help/help-content";

/**
 * Vocabulário visual local da tela de Backup, copiado da estrutura/hierarquia do
 * `AdminUI.tsx` do TRM Outlet (Panel/RowShell/StatusPill/StatCard) — só as cores
 * vêm dos tokens do InnoChat (claro/escuro: `bg-surface`, `border-border`,
 * `text-text`, `shadow-card`…), nunca classes fixas (`bg-white`, `ring-border-subtle`)
 * copiadas do outro projeto. Fica em `admin/backup` porque hoje só a tela de Backup
 * usa este padrão; se outra tela do admin quiser o mesmo visual, promove para
 * `components/admin/admin-ui.tsx`.
 */

/* ────────────────────────────────────────────────────────────────────────── */
/* Painel: seção com título, descrição e ação opcional no cabeçalho           */
/* ────────────────────────────────────────────────────────────────────────── */

export function Panel({
  id,
  title,
  description,
  action,
  help,
  children,
  className,
  bodyClassName,
}: {
  /** Só quando este painel é alvo de um link de âncora (`href="#id"`). */
  id?: string;
  title?: string;
  description?: string;
  action?: ReactNode;
  help?: HelpKey;
  children: ReactNode;
  className?: string;
  /** Passe "p-0" quando o conteúdo for uma lista que sangra até a borda. */
  bodyClassName?: string;
}) {
  return (
    <section
      id={id}
      tabIndex={id ? -1 : undefined}
      className={cn("overflow-hidden rounded-card border border-border bg-surface shadow-card", className)}
    >
      {title ? (
        <div className={cn("flex flex-wrap items-center justify-between gap-3 border-b border-border bg-bg/60 px-5 py-4", help && "relative pr-14")}>
          <div className="min-w-0">
            <h2 className="font-display text-base font-bold text-text">{title}</h2>
            {description ? <p className="mt-0.5 text-xs text-text-secondary">{description}</p> : null}
          </div>
          {action}
          {help ? <HelpButton helpKey={help} placement="corner" className="right-3 top-3" /> : null}
        </div>
      ) : null}
      <div className={cn("p-5", bodyClassName)}>{children}</div>
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Selo de status                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

export type PillTone = "success" | "warning" | "danger" | "info" | "neutral" | "primary";

const PILL: Record<PillTone, string> = {
  success: "bg-success-bg text-success ring-success/30",
  warning: "bg-warning-bg text-warning ring-warning/30",
  danger: "bg-danger-bg text-danger ring-danger/30",
  info: "bg-bg text-text-secondary ring-border",
  primary: "bg-primary/10 text-primary ring-primary/30",
  neutral: "bg-bg text-text-secondary ring-border",
};

export function StatusPill({ children, tone = "neutral", className }: { children: ReactNode; tone?: PillTone; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ring-1", PILL[tone], className)}>
      {children}
    </span>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Linha de lista                                                             */
/* ────────────────────────────────────────────────────────────────────────── */

/** Linha padrão das listas do Panel: bloco identificador à esquerda, ações à direita, empilha no mobile. */
export function RowShell({
  children,
  actions,
  leading,
  className,
}: {
  children: ReactNode;
  actions?: ReactNode;
  leading?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-4 px-5 py-4 transition-colors hover:bg-bg/60", className)}>
      {leading}
      <div className="min-w-[220px] flex-1">{children}</div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Cartão de estatística textual (grade de 4 no topo da tela)                 */
/* ────────────────────────────────────────────────────────────────────────── */

export type StatTone = "primary" | "success" | "warning" | "danger" | "neutral";

const STAT_TONE: Record<StatTone, string> = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  danger: "bg-danger-bg text-danger",
  neutral: "bg-bg text-text-secondary",
};

/* ────────────────────────────────────────────────────────────────────────── */
/* Estado vazio — para usar DENTRO de um Panel (sangrado, sem borda própria)  */
/* ────────────────────────────────────────────────────────────────────────── */

export function PanelEmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
}) {
  return (
    <div className="px-6 py-14 text-center" role="status">
      <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-bg text-text-secondary" aria-hidden="true">
        <Icon className="h-6 w-6" />
      </div>
      <p className="font-display text-sm font-black text-text">{title}</p>
      {description ? <p className="mx-auto mt-1.5 max-w-sm text-xs leading-relaxed text-text-secondary">{description}</p> : null}
    </div>
  );
}

export function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = "neutral",
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: StatTone;
}) {
  return (
    <div className="rounded-card border border-border bg-surface p-5 shadow-card">
      <div className={cn("mb-3 flex h-9 w-9 items-center justify-center rounded-full", STAT_TONE[tone])}>
        <Icon className="h-4 w-4" aria-hidden="true" />
      </div>
      <p className="text-xs text-text-secondary">{label}</p>
      <div className="mt-1 text-base font-semibold text-text">{value}</div>
      {hint ? <p className="mt-1 text-xs text-text-secondary">{hint}</p> : null}
    </div>
  );
}
