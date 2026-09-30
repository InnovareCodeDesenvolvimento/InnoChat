import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appointmentIdsToHighlight,
  createRefreshCoordinator,
  hasAppointmentChange,
  pollBaseInterval,
} from "./live-refresh";
import type { NotificationKind } from "./types";

const n = (kind: NotificationKind, appointmentId?: string) => ({
  kind,
  appointment: appointmentId
    ? { id: appointmentId, startsAt: "", contactName: "", serviceName: "", professionalName: "" }
    : undefined,
});

describe("hasAppointmentChange", () => {
  it("os 5 tipos de mudança de agendamento pedem refresh", () => {
    for (const kind of [
      "APPOINTMENT_CREATED",
      "APPOINTMENT_RESCHEDULED",
      "APPOINTMENT_CANCELED",
      "APPOINTMENT_COMPLETED",
      "APPOINTMENT_NO_SHOW",
    ] as const) {
      expect(hasAppointmentChange([n(kind)])).toBe(true);
    }
  });
  it("lembrete, WhatsApp, trial e pagamento não pedem refresh", () => {
    expect(hasAppointmentChange([n("APPOINTMENT_UPCOMING"), n("WHATSAPP_DISCONNECTED"), n("TRIAL_ENDING"), n("PAYMENT_CONFIRMED")])).toBe(false);
    expect(hasAppointmentChange([])).toBe(false);
  });
});

describe("appointmentIdsToHighlight", () => {
  it("só ids de mudanças de agendamento, sem repetir", () => {
    expect(
      appointmentIdsToHighlight([n("APPOINTMENT_CREATED", "a"), n("APPOINTMENT_RESCHEDULED", "a"), n("APPOINTMENT_UPCOMING", "b"), n("APPOINTMENT_CANCELED", "c"), n("TRIAL_ENDING")]),
    ).toEqual(["a", "c"]);
  });
});

describe("pollBaseInterval", () => {
  it("15 s em agenda, agendamentos e atendimento, 30 s no resto", () => {
    expect(pollBaseInterval("/salao/agenda")).toBe(15_000);
    expect(pollBaseInterval("/salao/agendamentos")).toBe(15_000);
    expect(pollBaseInterval("/salao/atendimento")).toBe(15_000);
    expect(pollBaseInterval("/salao/inicio")).toBe(30_000);
    expect(pollBaseInterval("/salao/clientes")).toBe(30_000);
    expect(pollBaseInterval(null)).toBe(30_000);
  });
});

describe("createRefreshCoordinator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("debounce: várias mudanças seguidas viram UM refresh, com os ids somados", () => {
    const onFlush = vi.fn();
    const c = createRefreshCoordinator({ isBusy: () => false, onFlush });
    c.notify(["a"]);
    c.notify(["b"]);
    c.notify(["a"]);
    expect(onFlush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(["a", "b"]);
  });

  it("com diálogo aberto adia, avisa 'deferred' e só atualiza quando fecha", () => {
    let busy = true;
    const onFlush = vi.fn();
    const onDeferredChange = vi.fn();
    const c = createRefreshCoordinator({ isBusy: () => busy, onFlush, onDeferredChange });
    c.notify(["x"]);
    vi.advanceTimersByTime(300);
    expect(onFlush).not.toHaveBeenCalled();
    expect(onDeferredChange).toHaveBeenLastCalledWith(true);

    vi.advanceTimersByTime(5000);
    expect(onFlush).not.toHaveBeenCalled();

    busy = false;
    vi.advanceTimersByTime(1000);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(["x"]);
    expect(onDeferredChange).toHaveBeenLastCalledWith(false);
  });

  it("mudança nova durante o adiamento não gera segundo refresh", () => {
    let busy = true;
    const onFlush = vi.fn();
    const c = createRefreshCoordinator({ isBusy: () => busy, onFlush });
    c.notify(["a"]);
    vi.advanceTimersByTime(300);
    c.notify(["b"]);
    vi.advanceTimersByTime(300);
    busy = false;
    vi.advanceTimersByTime(1000);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith(["a", "b"]);
  });

  it("flushNow atualiza mesmo ocupado e não dispara duas vezes", () => {
    const onFlush = vi.fn();
    const c = createRefreshCoordinator({ isBusy: () => true, onFlush });
    c.notify(["a"]);
    vi.advanceTimersByTime(300);
    c.flushNow();
    c.flushNow();
    vi.advanceTimersByTime(5000);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("dispose cancela tudo", () => {
    const onFlush = vi.fn();
    const c = createRefreshCoordinator({ isBusy: () => false, onFlush });
    c.notify(["a"]);
    c.dispose();
    vi.advanceTimersByTime(5000);
    expect(onFlush).not.toHaveBeenCalled();
  });
});
