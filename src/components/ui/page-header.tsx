import type { LucideIcon } from "lucide-react";
import { cn } from "@/components/lib/cn";
import { HelpButton } from "@/components/help/help-button";
import type { HelpKey } from "@/components/help/help-content";

export type PageHeaderProps = {
  /** Normalmente uma string; aceita `ReactNode` para os casos em que o título carrega um avatar
   * ao lado do nome (ex.: detalhe de profissional) — sem criar uma segunda prop só para isso. */
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  /** Badge ou pill opcional posicionado ao lado do título (ex.: Modo suporte ativo). */
  badge?: React.ReactNode;
  className?: string;
  /** `hero` (docs premium, ajuste tipográfico pedido pelo dono): só a tela "Início" — ~40px,
   * tracking apertado (`-0.02em`). Telas de trabalho diário (Agenda etc.) ficam no `default`
   * (28px "contido", pedido explícito do dono — não é o `text-2xl`/24px antigo, subiu 4px). */
  size?: "default" | "hero";
  /** Ícone da seção — SEMPRE o mesmo do menu lateral (`navIconFor(...)` em `shell/nav-items.ts`),
   * para o cabeçalho confirmar onde a pessoa está. Selo some no mobile (`sm:flex`): ali o espaço
   * vale mais para o título e o ícone já aparece no menu. */
  icon?: LucideIcon;
  /** Chave do texto de ajuda (`help-content.ts`): põe o "i" no canto superior direito do cabeçalho.
   * É só uma string — atravessa a fronteira Server→Client sem problema. */
  help?: HelpKey;
};

export function PageHeader({ title, description, action, badge, className, size = "default", icon: Icon, help }: PageHeaderProps) {
  const hero = size === "hero";
  return (
    <div className={cn("relative mb-6 flex flex-wrap items-start justify-between gap-4", className)}>
      <div className={cn("flex min-w-0 items-center gap-3.5", help && "max-sm:pr-11")}>
        {Icon ? (
          <span
            aria-hidden="true"
            className={cn(
              "hidden shrink-0 items-center justify-center rounded-card bg-primary/10 text-primary sm:flex",
              hero ? "h-14 w-14" : "h-11 w-11",
            )}
          >
            <Icon className={hero ? "h-7 w-7" : "h-5 w-5"} />
          </span>
        ) : null}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1
              className={cn(
                "font-display text-text",
                hero
                  ? "text-[1.75rem] font-black leading-tight tracking-[-0.02em] sm:text-[2.5rem] sm:leading-none"
                  : "text-[1.75rem] font-bold leading-tight",
              )}
            >
              {title}
            </h1>
            {badge ? <div className="shrink-0">{badge}</div> : null}
          </div>
          {description ? <p className="mt-1.5 text-sm text-text-secondary">{description}</p> : null}
        </div>
      </div>
      {action ? <div className={cn("shrink-0", help && "sm:mr-11")}>{action}</div> : null}
      {help ? <HelpButton helpKey={help} placement="corner" className="right-0 top-0" /> : null}
    </div>
  );
}
