import { describe, expect, it } from "vitest";
import {
  badgeText,
  formatCountdown,
  isImminent,
  minutesUntilStart,
  formatRelativeTime,
  groupNotifications,
  handoffBody,
  isOffHoursHandoff,
  latestCreatedAt,
  mergeNotifications,
  nextPollDelay,
  pickToasts,
  stripTitleCount,
  titleWithCount,
  unreadAriaLabel,
} from "./notification-utils";
import type { AppNotification } from "./types";

const NOW = new Date("2026-09-29T15:00:00.000Z");

function make(id: string, createdAt: string, extra: Partial<AppNotification> = {}): AppNotification {
  return {
    id,
    kind: "APPOINTMENT_CREATED",
    severity: "info",
    title: `t${id}`,
    body: "",
    href: null,
    createdAt,
    read: false,
    source: "WHATSAPP",
    ...extra,
  };
}

describe("formatRelativeTime", () => {
  it("cobre agora, minutos, horas, ontem, dias e data", () => {
    expect(formatRelativeTime("2026-09-29T14:59:40.000Z", NOW)).toBe("agora mesmo");
    expect(formatRelativeTime("2026-09-29T14:55:00.000Z", NOW)).toBe("há 5 min");
    expect(formatRelativeTime("2026-09-29T12:00:00.000Z", NOW)).toBe("há 3h");
    expect(formatRelativeTime("2026-09-28T13:00:00.000Z", NOW)).toBe("ontem");
    expect(formatRelativeTime("2026-09-25T15:00:00.000Z", NOW)).toBe("há 4 dias");
    expect(formatRelativeTime("2026-09-10T15:00:00.000Z", NOW)).toBe("10/09");
  });
  it("data no futuro ou inválida vira 'agora mesmo'", () => {
    expect(formatRelativeTime("2026-09-29T16:00:00.000Z", NOW)).toBe("agora mesmo");
    expect(formatRelativeTime("lixo", NOW)).toBe("agora mesmo");
  });
});

describe("nextPollDelay (backoff)", () => {
  it("30 s sem falhas, dobra a cada falha e trava no teto de 5 min", () => {
    expect(nextPollDelay(0)).toBe(30_000);
    expect(nextPollDelay(1)).toBe(60_000);
    expect(nextPollDelay(2)).toBe(120_000);
    expect(nextPollDelay(3)).toBe(240_000);
    expect(nextPollDelay(4)).toBe(300_000);
    expect(nextPollDelay(50)).toBe(300_000);
  });
});

describe("badge e título", () => {
  it("9+ a partir de 10 e aria-label com o número exato", () => {
    expect(badgeText(3)).toBe("3");
    expect(badgeText(9)).toBe("9");
    expect(badgeText(10)).toBe("9+");
    expect(unreadAriaLabel(0)).toBe("Notificações, nenhuma não lida");
    expect(unreadAriaLabel(1)).toBe("Notificações, 1 notificação não lida");
    expect(unreadAriaLabel(12)).toBe("Notificações, 12 notificações não lidas");
  });
  it("prefixa e remove '(n)' sem acumular", () => {
    expect(titleWithCount("InnoChat — Painel", 3)).toBe("(3) InnoChat — Painel");
    expect(titleWithCount("(3) InnoChat — Painel", 5)).toBe("(5) InnoChat — Painel");
    expect(titleWithCount("(3) InnoChat — Painel", 0)).toBe("InnoChat — Painel");
    expect(stripTitleCount("(12) Agenda")).toBe("Agenda");
  });
});

describe("groupNotifications", () => {
  it("agrupa por dia civil no fuso da empresa", () => {
    const items = [
      make("a", "2026-09-29T14:00:00.000Z"),
      make("b", "2026-09-29T02:30:00.000Z"), // 28/09 23:30 em São Paulo → ontem
      make("c", "2026-09-20T12:00:00.000Z"),
    ];
    const groups = groupNotifications(items, "America/Sao_Paulo", NOW);
    expect(groups.map((g) => [g.key, g.items.map((i) => i.id)])).toEqual([
      ["today", ["a"]],
      ["yesterday", ["b"]],
      ["earlier", ["c"]],
    ]);
  });
  it("não devolve grupos vazios", () => {
    expect(groupNotifications([], "America/Sao_Paulo", NOW)).toEqual([]);
  });
});

describe("merge e âncora", () => {
  it("dedupe por id (novo vence) e ordena do mais recente", () => {
    const merged = mergeNotifications(
      [make("a", "2026-09-29T10:00:00.000Z"), make("b", "2026-09-29T09:00:00.000Z")],
      [make("c", "2026-09-29T11:00:00.000Z"), make("a", "2026-09-29T10:00:00.000Z", { read: true })],
    );
    expect(merged.map((n) => n.id)).toEqual(["c", "a", "b"]);
    expect(merged[1].read).toBe(true);
  });
  it("latestCreatedAt usa o fallback quando vazio", () => {
    expect(latestCreatedAt([], "2000-01-01")).toBe("2000-01-01");
    expect(latestCreatedAt([make("a", "2026-09-29T10:00:00.000Z"), make("b", "2026-09-29T12:00:00.000Z")], "2000-01-01")).toBe(
      "2026-09-29T12:00:00.000Z",
    );
  });
});

describe("pickToasts", () => {
  const fresh = [
    make("1", "2026-09-29T10:00:00.000Z"),
    make("2", "2026-09-29T10:01:00.000Z"),
    make("3", "2026-09-29T10:02:00.000Z"),
    make("4", "2026-09-29T10:03:00.000Z"),
    make("5", "2026-09-29T10:04:00.000Z", { byMe: true }),
    make("6", "2026-09-29T10:05:00.000Z", { read: true }),
  ];
  it("no máximo 3, as mais recentes, sem as do próprio usuário nem lidas", () => {
    expect(pickToasts(fresh, 0).map((n) => n.id)).toEqual(["4", "3", "2"]);
  });
  it("respeita os toasts já visíveis", () => {
    expect(pickToasts(fresh, 2).map((n) => n.id)).toEqual(["4"]);
    expect(pickToasts(fresh, 3)).toEqual([]);
  });
});

describe("contador do próximo atendimento", () => {
  it("formata agora, minutos e horas", () => {
    expect(formatCountdown(-3)).toBe("agora");
    expect(formatCountdown(0)).toBe("agora");
    expect(formatCountdown(25)).toBe("em 25 min");
    expect(formatCountdown(60)).toBe("em 1h");
    expect(formatCountdown(80)).toBe("em 1h 20 min");
  });
  it("arredonda para cima e destaca até 15 min", () => {
    expect(minutesUntilStart("2026-09-29T15:00:25.000Z", NOW)).toBe(1);
    expect(minutesUntilStart("2026-09-29T15:25:00.000Z", NOW)).toBe(25);
    expect(minutesUntilStart("2026-09-29T14:50:00.000Z", NOW)).toBe(-10);
    expect(isImminent(15)).toBe(true);
    expect(isImminent(16)).toBe(false);
    expect(isImminent(-2)).toBe(true);
  });
});

describe("pediu atendente (HANDOFF_REQUESTED)", () => {
  const handoff = (offHours: boolean, body: string) =>
    ({
      ...make("h1", "2026-09-29T14:00:00.000Z", { severity: "warning", body }),
      kind: "HANDOFF_REQUESTED",
      handoff: { contactId: "c1", contactName: "Maria", offHours, answered: false, ended: false },
    }) as unknown as AppNotification;

  it("fora do horário: detecta e tira o sufixo do corpo (o selo mostra)", () => {
    const n = handoff(true, "Maria · fora do horário");
    expect(isOffHoursHandoff(n)).toBe(true);
    expect(handoffBody(n)).toBe("Maria");
  });

  it("dentro do horário: corpo intacto e sem selo", () => {
    const n = handoff(false, "Maria");
    expect(isOffHoursHandoff(n)).toBe(false);
    expect(handoffBody(n)).toBe("Maria");
  });

  it("outro tipo de notificação nunca ganha o selo", () => {
    const n = make("a", "2026-09-29T14:00:00.000Z", { body: "x · fora do horário" });
    expect(isOffHoursHandoff(n)).toBe(false);
    expect(handoffBody(n)).toBe("x · fora do horário");
  });
});
