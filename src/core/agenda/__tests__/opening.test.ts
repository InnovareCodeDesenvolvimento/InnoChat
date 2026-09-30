import { describe, expect, it } from "vitest";
import { teamOpening } from "../opening";
import type { WorkingHourRule } from "../types";

const TZ = "America/Sao_Paulo"; // UTC-3
// Seg-Sex 09:00-18:00 (Ana) união Sáb 09:00-13:00 (Bia).
const HOURS: WorkingHourRule[] = [
  ...[1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: "09:00", endTime: "18:00" })),
  { weekday: 6, startTime: "09:00", endTime: "13:00" },
];

function open(nowISO: string, closedRanges: { startsAt: Date; endsAt: Date }[] = [], workingHours = HOURS, horizonDays?: number) {
  return teamOpening({ timezone: TZ, workingHours, closedRanges, now: new Date(nowISO), horizonDays });
}

describe("teamOpening", () => {
  it("dentro do expediente: openNow true e próxima abertura no dia seguinte", () => {
    const r = open("2026-09-30T13:12:00Z"); // quarta 10:12 local
    expect(r.openNow).toBe(true);
    expect(r.nextOpenAt?.toISOString()).toBe("2026-10-01T12:00:00.000Z");
  });

  it("antes da abertura: fechado, abre hoje", () => {
    const r = open("2026-09-30T10:00:00Z"); // 07:00 local
    expect(r.openNow).toBe(false);
    expect(r.nextOpenAt?.toISOString()).toBe("2026-09-30T12:00:00.000Z");
  });

  it("depois do fechamento: fechado, abre amanhã", () => {
    const r = open("2026-09-30T22:00:00Z"); // 19:00 local
    expect(r.openNow).toBe(false);
    expect(r.nextOpenAt?.toISOString()).toBe("2026-10-01T12:00:00.000Z");
  });

  it("fim exato do expediente já é fechado; início exato é aberto", () => {
    expect(open("2026-09-30T21:00:00Z").openNow).toBe(false); // 18:00
    expect(open("2026-09-30T12:00:00Z").openNow).toBe(true); // 09:00
  });

  it("virada de semana: sábado à tarde → segunda", () => {
    const r = open("2026-10-03T18:00:00Z"); // sáb 15:00 local, fechou às 13:00
    expect(r.openNow).toBe(false);
    expect(r.nextOpenAt?.toISOString()).toBe("2026-10-05T12:00:00.000Z"); // seg 09:00
  });

  it("exceção de feriado: dia inteiro fechado é pulado", () => {
    const holiday = [{ startsAt: new Date("2026-10-01T03:00:00Z"), endsAt: new Date("2026-10-02T02:59:00Z") }];
    const r = open("2026-09-30T22:00:00Z", holiday);
    expect(r.openNow).toBe(false);
    expect(r.nextOpenAt?.toISOString()).toBe("2026-10-02T12:00:00.000Z");
  });

  it("exceção cobrindo o agora: fechado mesmo com expediente", () => {
    const closed = [{ startsAt: new Date("2026-09-30T12:00:00Z"), endsAt: new Date("2026-09-30T21:00:00Z") }];
    const r = open("2026-09-30T13:12:00Z", closed);
    expect(r.openNow).toBe(false);
    expect(r.nextOpenAt?.toISOString()).toBe("2026-10-01T12:00:00.000Z");
  });

  it("bloqueio parcial (almoço): fechado durante, reabre depois", () => {
    const lunch = [{ startsAt: new Date("2026-09-30T15:00:00Z"), endsAt: new Date("2026-09-30T16:00:00Z") }];
    const r = open("2026-09-30T15:30:00Z", lunch);
    expect(r.openNow).toBe(false);
    expect(r.nextOpenAt?.toISOString()).toBe("2026-09-30T16:00:00.000Z");
  });

  it("sem expediente cadastrado: fechado e sem próxima abertura", () => {
    expect(open("2026-09-30T13:12:00Z", [], [])).toEqual({ openNow: false, nextOpenAt: null });
  });

  it("respeita horizonDays", () => {
    const onlyMonday: WorkingHourRule[] = [{ weekday: 1, startTime: "09:00", endTime: "18:00" }];
    const now = "2026-09-29T13:00:00Z"; // terça; próxima segunda = 05/10
    expect(open(now, [], onlyMonday, 3).nextOpenAt).toBeNull();
    expect(open(now, [], onlyMonday, 14).nextOpenAt?.toISOString()).toBe("2026-10-05T12:00:00.000Z");
  });

  it("usa o dia LOCAL do tenant (madrugada UTC ainda é o dia anterior em São Paulo)", () => {
    const r = open("2026-10-01T01:00:00Z"); // 30/09 22:00 local
    expect(r.openNow).toBe(false);
    expect(r.nextOpenAt?.toISOString()).toBe("2026-10-01T12:00:00.000Z");
  });
});
