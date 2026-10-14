"use client";

import { ShieldCheck } from "lucide-react";
import { cn } from "@/components/lib/cn";
import { HelpButton } from "@/components/help/help-button";

export type SupportAttentionBannerProps = {
  /** Se a sessão atual é uma impersonação de suporte */
  isSupportImpersonation?: boolean;
  className?: string;
};

/**
 * Banner de atenção exibido no topo da lista ou tela de atendimento quando o admin
 * está impersonando a empresa. Lembra que as respostas saem identificadas como suporte.
 */
export function SupportAttentionBanner({
  isSupportImpersonation,
  className,
}: SupportAttentionBannerProps) {
  if (!isSupportImpersonation) {
    return null;
  }

  return (
    <div
      role="status"
      data-testid="support-attention-banner"
      className={cn(
        "mb-3 flex items-center justify-between gap-3 rounded-card border border-warning/40 bg-warning-bg p-3 text-xs text-text shadow-sm",
        className,
      )}
    >
      <div className="flex items-center gap-2.5">
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-warning/20 text-warning"
          aria-hidden="true"
        >
          <ShieldCheck className="h-4 w-4" />
        </span>
        <p className="leading-snug">
          <strong className="font-semibold text-text">Você está respondendo como suporte InnoChat.</strong>{" "}
          <span className="text-text-secondary">
            O cliente vê um selo &quot;Suporte&quot; na mensagem enviada.
          </span>
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <HelpButton helpKey="admin.modoSuporte" placement="inline" />
      </div>
    </div>
  );
}
