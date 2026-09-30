"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import {
  appointmentIdsToHighlight,
  createRefreshCoordinator,
  hasAppointmentChange,
  pollBaseInterval,
  type RefreshCoordinator,
} from "./live-refresh";
import { useNotificationCenter, usePlatformNotificationCenter, type useNotificationFeed } from "./use-notification-center";
import type { AppNotification, BellNotification } from "./types";

/** Valor que o sino consome — igual para o tenant e para o admin da plataforma. */
type CenterValue = ReturnType<typeof useNotificationFeed<BellNotification>>;

type LiveAppointmentsValue = {
  /** Sobe a cada refresh ao vivo — as telas que buscam dados no client refazem a leitura. */
  version: number;
  /** Ids de agendamento que acabaram de mudar (destaque por ~5 s). */
  highlightedIds: ReadonlySet<string>;
};

const CenterContext = createContext<CenterValue | null>(null);
const EMPTY_SET: ReadonlySet<string> = new Set();
const LiveContext = createContext<LiveAppointmentsValue>({ version: 0, highlightedIds: EMPTY_SET });

const HIGHLIGHT_MS = 5000;

/** Diálogo aberto ou arraste em andamento: melhor não trocar os dados debaixo do usuário. */
function isUserBusy(): boolean {
  if (typeof document === "undefined") return false;
  return (
    document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]') !== null ||
    document.body.dataset.apptDrag === "1"
  );
}

/**
 * Dono do polling de notificações e do "atualizar sozinho". Fica acima da topbar E do conteúdo,
 * por isso o sino (topbar) e as páginas (Agenda, Agendamentos, Clientes, Início) leem o mesmo
 * estado. Quando o poll traz mudança de agendamento: `router.refresh()` (server components),
 * `version++` (telas que buscam no client) e destaque dos ids alterados. Se houver diálogo aberto
 * ou arraste, adia e mostra "Há atualizações — Atualizar".
 */
export function NotificationCenterProvider({
  tenantSlug,
  children,
}: {
  tenantSlug: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  const [version, setVersion] = useState(0);
  const [highlightedIds, setHighlightedIds] = useState<ReadonlySet<string>>(EMPTY_SET);
  const [deferred, setDeferred] = useState(false);
  const coordinatorRef = useRef<RefreshCoordinator | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const coordinator = createRefreshCoordinator({
      isBusy: isUserBusy,
      onDeferredChange: setDeferred,
      onFlush: (ids) => {
        router.refresh();
        setVersion((v) => v + 1);
        if (ids.length > 0) {
          setHighlightedIds(new Set(ids));
          if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
          highlightTimerRef.current = setTimeout(() => setHighlightedIds(EMPTY_SET), HIGHLIGHT_MS);
        }
      },
    });
    coordinatorRef.current = coordinator;
    return () => {
      coordinator.dispose();
      coordinatorRef.current = null;
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, [router]);

  const onFresh = useCallback((fresh: AppNotification[]) => {
    if (!hasAppointmentChange(fresh)) return;
    coordinatorRef.current?.notify(appointmentIdsToHighlight(fresh));
  }, []);

  const center = useNotificationCenter(tenantSlug, {
    onFresh,
    getBaseIntervalMs: () => pollBaseInterval(pathnameRef.current),
  });

  const live = useMemo(() => ({ version, highlightedIds }), [version, highlightedIds]);

  return (
    <CenterContext.Provider value={center}>
      <LiveContext.Provider value={live}>
        {children}
        {deferred ? (
          <div className="fixed inset-x-4 bottom-[4.5rem] z-[60] flex justify-center sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2">
            <div
              role="status"
              className="flex items-center gap-3 rounded-full border border-border bg-surface py-1.5 pl-4 pr-1.5 text-sm text-text shadow-card-hover"
            >
              Há atualizações
              <button
                type="button"
                onClick={() => coordinatorRef.current?.flushNow()}
                className="inline-flex min-h-[44px] items-center gap-1.5 rounded-full bg-primary px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-primary-strong motion-reduce:transition-none"
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Atualizar
              </button>
            </div>
          </div>
        ) : null}
      </LiveContext.Provider>
    </CenterContext.Provider>
  );
}

/**
 * Central do admin da plataforma: mesmo sino, mesmos toasts, mesmo polling (30 s). Não faz
 * live-refresh das páginas do admin (decisão da fase 2) — por isso não há `LiveContext` aqui.
 */
export function PlatformNotificationCenterProvider({ children }: { children: React.ReactNode }) {
  const center = usePlatformNotificationCenter();
  return <CenterContext.Provider value={center}>{children}</CenterContext.Provider>;
}

export function useNotificationCenterContext(): CenterValue {
  const value = useContext(CenterContext);
  if (!value) throw new Error("useNotificationCenterContext() precisa estar dentro de <NotificationCenterProvider>.");
  return value;
}

/** Fila de atendimento: quantos clientes aguardam atendente (badge do menu). 0 fora do provider. */
export function useAttendanceWaitingCount(): number {
  return useContext(CenterContext)?.attendanceWaitingCount ?? 0;
}

/** A tela Atendimento sincroniza o badge com a fila que acabou de ler (sem esperar o próximo poll). */
export function useSetAttendanceWaitingCount(): (count: number) => void {
  const set = useContext(CenterContext)?.setAttendanceWaitingCount;
  return useCallback((count: number) => set?.(count), [set]);
}

/** Telas com dados no client: `version` para refazer a leitura, `highlightedIds` para realçar. */
export function useLiveAppointments(): LiveAppointmentsValue {
  return useContext(LiveContext);
}

/**
 * Chama `callback` toda vez que o painel detectar mudança de agendamento (nunca na montagem).
 * Use para recarregar em silêncio — sem piscar skeleton — a lista que a tela já tem.
 */
export function useOnAppointmentsChanged(callback: () => void): void {
  const { version } = useLiveAppointments();
  const callbackRef = useRef(callback);
  const lastVersionRef = useRef(version);
  useEffect(() => {
    callbackRef.current = callback;
  });
  useEffect(() => {
    if (version === lastVersionRef.current) return;
    lastVersionRef.current = version;
    callbackRef.current();
  }, [version]);
}
