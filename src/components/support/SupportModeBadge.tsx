"use client";

import { useState } from "react";
import { Eye, ShieldCheck, X } from "lucide-react";
import { cn } from "@/components/lib/cn";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { HelpButton } from "@/components/help/help-button";

export type SupportModeBadgeProps = {
  /** Se a sessão atual é uma impersonação de suporte */
  isSupportImpersonation?: boolean;
  /** Estado aberto inicial (útil para SSR em testes) */
  defaultOpen?: boolean;
  className?: string;
};

/**
 * Pill discreto que confirma no topo das páginas de catálogo que a navegação
 * está ocorrendo em modo de suporte. O clique abre uma explicação rápida
 * com atalho para o texto completo de ajuda do modo suporte.
 */
export function SupportModeBadge({ isSupportImpersonation, defaultOpen = false, className }: SupportModeBadgeProps) {
  const [open, setOpen] = useState(defaultOpen);

  if (!isSupportImpersonation) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="support-mode-badge"
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning-bg px-2.5 py-1 text-xs font-medium text-warning",
          "hover:border-warning/60 hover:bg-warning/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-warning",
          "cursor-pointer transition-colors duration-150 motion-reduce:transition-none",
          className,
        )}
      >
        <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>Modo suporte ativo</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent container={null} className="max-w-md">
          <DialogHeader icon={ShieldCheck}>
            <DialogTitle>Modo suporte ativo</DialogTitle>
            <DialogDescription>
              Você está vendo e operando esta empresa como suporte da plataforma InnoChat.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2 text-sm text-text-secondary">
            <p>
              Suas ações ficam registradas no histórico com seu nome e o motivo informado ao entrar.
            </p>
            <div className="flex items-center gap-2 rounded-card border border-border bg-bg p-3 text-xs text-text">
              <span className="font-semibold text-text">O que isso significa?</span>
              <span className="text-text-secondary">Veja a explicação detalhada do modo suporte:</span>
              <HelpButton helpKey="admin.modoSuporte" placement="inline" />
            </div>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              icon={X}
              onClick={() => setOpen(false)}
            >
              Entendi
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
