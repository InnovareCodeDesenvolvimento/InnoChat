"use client";

import { ShieldCheck, User } from "lucide-react";
import { cn } from "@/components/lib/cn";

export type SupportChatBadgeProps = {
  /** Se a sessão atual é uma impersonação de suporte */
  isSupportImpersonation?: boolean;
  /** Nome do administrador da plataforma executando a impersonação */
  adminName?: string | null;
  className?: string;
};

/**
 * Selo persistente exibido no compositor de mensagens quando um administrador
 * está impersonando a empresa em modo suporte.
 * Deixa claro que a mensagem enviada receberá o identificador de suporte da plataforma.
 */
export function SupportChatBadge({
  isSupportImpersonation,
  adminName,
  className,
}: SupportChatBadgeProps) {
  if (!isSupportImpersonation) {
    return null;
  }

  const displayName = adminName?.trim() || "Suporte";

  return (
    <div
      role="status"
      data-testid="support-chat-badge"
      className={cn(
        "flex flex-wrap items-center gap-1.5 rounded-card border border-warning/40 bg-warning-bg/90 px-2.5 py-1 text-xs text-warning",
        className,
      )}
    >
      <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="font-semibold text-text">Enviando como suporte InnoChat</span>
      <span className="inline-flex items-center gap-1 rounded bg-surface px-1.5 py-0.5 text-[11px] font-medium text-text-secondary border border-border">
        <User className="h-3 w-3 shrink-0" aria-hidden="true" />
        <span className="max-w-[140px] truncate">{displayName}</span>
      </span>
    </div>
  );
}
