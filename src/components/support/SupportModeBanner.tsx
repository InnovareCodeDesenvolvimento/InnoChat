"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, LogOut, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HelpButton } from "@/components/help/help-button";
import { exitSupportAction } from "@/app/(platform)/admin/empresas/[tenantId]/_actions/exitSupportAction";
import type { Result } from "@/lib/result";
import type { ExitSupportOutput } from "@/modules/support/types";

export type SupportModeBannerProps = {
  /** Nome da empresa onde a sessão de suporte está ativa */
  tenantName: string;
  /** Timestamp em ms em que a sessão expira */
  expiresAtMs: number;
  /** Timestamp em ms de referência vindo do servidor para evitar erro de hidratação */
  serverNowMs?: number;
  /** ID da empresa para redirecionamento após sair (opcional, fallback) */
  tenantId?: string;
  /** Custom action para encerramento (injetável para testes) */
  onExitAction?: () => Promise<Result<ExitSupportOutput>>;
};

/** Formata a contagem regressiva em "Xh Ym" ou "Xm Ys" ou "Xs" */
export function formatSupportCountdown(diffMs: number): string {
  if (diffMs <= 0) return "0s";
  const totalSeconds = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}min`;
  }
  if (minutes > 0) {
    return `${minutes}min ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Banner persistente de alto contraste no topo do painel durante impersonação de suporte.
 * Conta o tempo restante a cada 30 segundos, exibe botão de encerramento seguro e
 * fecha a sessão automaticamente caso o tempo expire.
 */
export function SupportModeBanner({
  tenantName,
  expiresAtMs,
  serverNowMs,
  tenantId,
  onExitAction = exitSupportAction,
}: SupportModeBannerProps) {
  const [now, setNow] = useState(() => serverNowMs ?? Date.now());
  const [isExiting, setIsExiting] = useState(false);
  const autoExitedRef = useRef(false);

  useEffect(() => {
    // Sincroniza relógio real do cliente sem setState síncrono no mount
    const initialTimer = setTimeout(() => setNow(Date.now()), 0);
    const intervalId = setInterval(() => {
      setNow(Date.now());
    }, 30_000);

    return () => {
      clearTimeout(initialTimer);
      clearInterval(intervalId);
    };
  }, []);

  const remainingMs = expiresAtMs - now;
  const isExpired = remainingMs <= 0;

  const handleExit = useCallback(async () => {
    if (isExiting) return;
    setIsExiting(true);

    try {
      const res = await onExitAction();
      if (res.ok && res.data.redirectTo) {
        // Hard navigation intencional para limpar estado e cookies de impersonação do cliente
        window.location.href = res.data.redirectTo;
        return;
      }
      // Fallback via GET direto se a action falhar
      const fallbackUrl = tenantId ? `/admin/empresas/${tenantId}` : "/admin/empresas";
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = `/api/support/exit?fallback=${encodeURIComponent(fallbackUrl)}`;
    } catch {
      // Fallback de contingência
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = "/api/support/exit";
    }
  }, [isExiting, onExitAction, tenantId]);

  useEffect(() => {
    if (isExpired && !autoExitedRef.current) {
      autoExitedRef.current = true;
      handleExit();
    }
  }, [isExpired, handleExit]);

  return (
    <aside
      role="status"
      aria-live="polite"
      data-testid="support-mode-banner"
      className="sticky top-0 z-50 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-warning/40 bg-sidebar px-4 py-2.5 text-sidebar-text shadow-md sm:px-6"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5 basis-64">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-warning/20 text-warning"
          aria-hidden="true"
        >
          {isExpired ? (
            <AlertTriangle className="h-4 w-4 animate-pulse" />
          ) : (
            <ShieldAlert className="h-4 w-4" />
          )}
        </span>

        <p className="min-w-0 text-sm font-medium leading-snug">
          {isExpired ? (
            <span className="font-semibold text-warning">
              Sessão de suporte expirada. Saindo da conta…
            </span>
          ) : (
            <>
              Você está conectado como suporte em{" "}
              <strong className="font-semibold text-white">{tenantName}</strong>{" "}
              <span className="text-sidebar-text/80">
                (expira em {formatSupportCountdown(remainingMs)}).
              </span>
            </>
          )}
        </p>

        <HelpButton
          helpKey="admin.modoSuporte"
          placement="inline"
          className="text-sidebar-text hover:text-white"
        />
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={handleExit}
          isLoading={isExiting}
          loadingText="Saindo…"
          className="border-white/20 bg-white/10 text-white hover:bg-white/20 focus-visible:outline-white"
        >
          <LogOut className="h-4 w-4 shrink-0" aria-hidden="true" />
          Sair da conta e voltar ao Admin
        </Button>
      </div>
    </aside>
  );
}
