import type { AppNotification, NotificationKind } from "./types";

/**
 * Lógica pura do "atualizar a tela sozinho quando entra agendamento novo" (sem F5). Separada do
 * React para ser testável com timers falsos: QUANDO atualizar, o que destacar e como adiar
 * enquanto o usuário está no meio de um formulário.
 */

/** Tipos que mudam dados de agendamento (UPCOMING é só lembrete — não muda nada na tela). */
const APPOINTMENT_CHANGE_KINDS: ReadonlySet<NotificationKind> = new Set<NotificationKind>([
  "APPOINTMENT_CREATED",
  "APPOINTMENT_RESCHEDULED",
  "APPOINTMENT_CANCELED",
  "APPOINTMENT_COMPLETED",
  "APPOINTMENT_NO_SHOW",
]);

export function isAppointmentChange(notification: Pick<AppNotification, "kind">): boolean {
  return APPOINTMENT_CHANGE_KINDS.has(notification.kind);
}

/** O lote traz alguma mudança de agendamento? (Decide se vale um refresh.) */
export function hasAppointmentChange(fresh: Pick<AppNotification, "kind">[]): boolean {
  return fresh.some(isAppointmentChange);
}

/** Ids de agendamento a destacar por alguns segundos depois do refresh (únicos). */
export function appointmentIdsToHighlight(fresh: Pick<AppNotification, "kind" | "appointment">[]): string[] {
  const ids = new Set<string>();
  for (const n of fresh) {
    if (isAppointmentChange(n) && n.appointment?.id) ids.add(n.appointment.id);
  }
  return [...ids];
}

/** Intervalo de polling: 15 s em agenda, agendamentos e atendimento (onde o F5 doía), 30 s no resto. */
export function pollBaseInterval(pathname: string | null | undefined): number {
  const path = pathname ?? "";
  return /\/(agenda|agendamentos|atendimento)(\/|$)/.test(path) ? 15_000 : 30_000;
}

export type RefreshCoordinatorOptions = {
  /** Há diálogo aberto ou arraste em andamento? Se sim, o refresh espera. */
  isBusy: () => boolean;
  /** Executa o refresh de fato (`router.refresh()` + avisar as telas). */
  onFlush: (highlightIds: string[]) => void;
  /** `true` enquanto há atualização adiada por causa de `isBusy` (mostra "Atualizar"). */
  onDeferredChange?: (deferred: boolean) => void;
  debounceMs?: number;
  busyCheckMs?: number;
};

export type RefreshCoordinator = {
  /** Registra que houve mudança; vários chamados seguidos viram UM refresh (debounce). */
  notify: (highlightIds?: string[]) => void;
  /** Atualiza agora (botão "Atualizar"), mesmo com diálogo aberto. */
  flushNow: () => void;
  dispose: () => void;
};

export function createRefreshCoordinator(options: RefreshCoordinatorOptions): RefreshCoordinator {
  const { isBusy, onFlush, onDeferredChange, debounceMs = 300, busyCheckMs = 1000 } = options;
  let hasPending = false;
  let deferred = false;
  const ids = new Set<string>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let busyTimer: ReturnType<typeof setInterval> | null = null;

  function setDeferred(value: boolean) {
    if (deferred === value) return;
    deferred = value;
    onDeferredChange?.(value);
  }

  function clearTimers() {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (busyTimer) clearInterval(busyTimer);
    debounceTimer = null;
    busyTimer = null;
  }

  function flush() {
    clearTimers();
    setDeferred(false);
    if (!hasPending) return;
    const highlight = [...ids];
    hasPending = false;
    ids.clear();
    onFlush(highlight);
  }

  function attempt() {
    debounceTimer = null;
    if (!isBusy()) {
      flush();
      return;
    }
    setDeferred(true);
    if (!busyTimer) {
      busyTimer = setInterval(() => {
        if (!isBusy()) flush();
      }, busyCheckMs);
    }
  }

  return {
    notify(highlightIds = []) {
      hasPending = true;
      for (const id of highlightIds) ids.add(id);
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(attempt, debounceMs);
    },
    flushNow: flush,
    dispose() {
      clearTimers();
      hasPending = false;
      ids.clear();
    },
  };
}
