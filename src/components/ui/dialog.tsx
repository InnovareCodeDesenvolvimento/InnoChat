"use client";

import * as RadixDialog from "@radix-ui/react-dialog";
import { X, type LucideIcon } from "lucide-react";
import { cn } from "@/components/lib/cn";

export const Dialog = RadixDialog.Root;
export const DialogTrigger = RadixDialog.Trigger;
export const DialogClose = RadixDialog.Close;

export function DialogContent({
  className,
  children,
  forceMount,
  container,
  ...props
}: React.ComponentProps<typeof RadixDialog.Content> & { container?: HTMLElement | null }) {
  // Em SSR puro (renderToStaticMarkup), RadixDialog.Portal não renderiza filhos.
  // Se container={null}, renderiza sem Portal (inline), viabilizando testes unitários sem browser DOM.
  if (container === null) {
    return (
      <div className="fixed inset-0 z-50 bg-black/40">
        <RadixDialog.Content
          className={cn(
            "dialog-content-centered fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2",
            "rounded-card border border-border bg-surface p-6 shadow-card",
            "focus:outline-none",
            className,
          )}
          forceMount={forceMount}
          {...props}
        >
          {children}
          <RadixDialog.Close
            className={cn(
              // 44×44 (alvo de toque); centro alinhado ao do selo do `DialogHeader` (p-6 + 22px).
              "absolute right-3 top-6 flex h-11 w-11 items-center justify-center rounded-card text-text-secondary hover:bg-bg",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
            )}
            aria-label="Fechar"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </RadixDialog.Close>
        </RadixDialog.Content>
      </div>
    );
  }

  return (
    <RadixDialog.Portal forceMount={forceMount} container={container}>
      <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=open]:fade-in" />
      <RadixDialog.Content
        className={cn(
          "dialog-content-centered fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2",
          "rounded-card border border-border bg-surface p-6 shadow-card",
          "focus:outline-none",
          className,
        )}
        forceMount={forceMount}
        {...props}
      >
        {children}
        <RadixDialog.Close
          className={cn(
            // 44×44 (alvo de toque); centro alinhado ao do selo do `DialogHeader` (p-6 + 22px).
            "absolute right-3 top-6 flex h-11 w-11 items-center justify-center rounded-card text-text-secondary hover:bg-bg",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
          )}
          aria-label="Fechar"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </RadixDialog.Close>
      </RadixDialog.Content>
    </RadixDialog.Portal>
  );
}

export function DialogTitle({ className, ...props }: React.ComponentProps<typeof RadixDialog.Title>) {
  return <RadixDialog.Title className={cn("font-display text-lg font-bold leading-snug text-text", className)} {...props} />;
}

export type DialogTone = "primary" | "danger" | "warning" | "success";

const TONE_CLASS: Record<DialogTone, string> = {
  primary: "bg-primary/10 text-primary",
  danger: "bg-danger-bg text-danger",
  warning: "bg-warning-bg text-warning",
  success: "bg-success-bg text-success",
};

/**
 * Cabeçalho padrão de diálogo: selo de ícone (mesmo desenho do selo do `PageHeader`: quadrado
 * arredondado 44px, fundo `primary/10`, ícone primary) ao lado de `DialogTitle` + `DialogDescription`.
 * Diálogo de entidade usa o ícone do menu (`navIconFor(...)`); confirmação destrutiva usa um ícone
 * de ação (`Trash2`, `AlertTriangle`, `CalendarX`…) com `tone="danger"`. O selo é decorativo
 * (`aria-hidden`) — o nome acessível do diálogo continua sendo só o `DialogTitle`.
 * `pr-8` reserva o canto do botão Fechar.
 */
export function DialogHeader({
  icon: Icon,
  tone = "primary",
  className,
  children,
}: {
  icon: LucideIcon;
  tone?: DialogTone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex items-start gap-3.5 pr-8", className)}>
      <span
        aria-hidden="true"
        data-dialog-icon=""
        className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-card", TONE_CLASS[tone])}
      >
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1 self-center">{children}</div>
    </div>
  );
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof RadixDialog.Description>) {
  return <RadixDialog.Description className={cn("mt-1 text-sm text-text-secondary", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mt-6 flex flex-wrap justify-end gap-3", className)} {...props} />;
}
