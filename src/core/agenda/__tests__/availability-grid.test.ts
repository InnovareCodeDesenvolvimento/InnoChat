import { describe, expect, it } from "vitest";
import { computeAvailableDays, computeAvailableSlots } from "../availability";
import type { WorkingHourRule } from "../types";

const TZ = "America/Sao_Paulo"; // UTC-3, sem horário de verão desde 2019
const WED: WorkingHourRule[] = [{ weekday: 3, startTime: "09:00", endTime: "18:00" }]; // 2026-09-30 é quarta
const NOW = new Date("2026-09-29T12:00:00Z");

function slotsOf(over: Partial<Parameters<typeof computeAvailableSlots>[0]>): string[] {
  const slots = computeAvailableSlots({
    dateISO: "2026-09-30",
    timezone: TZ,
    workingHours: WED,
    closedRanges: [],
    busy: [],
    serviceDurationMin: 30,
    slotGranularityMin: 30,
    minLeadTimeMin: 0,
    now: NOW,
    ...over,
  });
  // Rótulo local HH:mm de cada início (UTC-3).
  return slots.map((s) => new Date(s.getTime() - 3 * 3600_000).toISOString().slice(11, 16));
}

describe("computeAvailableSlots — grade ancorada na meia-noite local (BUG-16)", () => {
  it("grade 30, serviço de 45 min ocupando 09:00 → o próximo livre é 10:00 (nunca 09:45)", () => {
    const busy = [
      { startsAt: new Date("2026-09-30T12:00:00Z"), blockEndsAt: new Date("2026-09-30T12:45:00Z") }, // 09:00-09:45 local
    ];
    const slots = slotsOf({ busy, serviceDurationMin: 45 });
    expect(slots[0]).toBe("10:00");
    expect(slots).not.toContain("09:45");
    expect(slots).not.toContain("10:15");
    expect(slots.slice(0, 3)).toEqual(["10:00", "10:30", "11:00"]);
  });

  it("grade 15 → :00/:15/:30/:45", () => {
    const slots = slotsOf({ slotGranularityMin: 15, serviceDurationMin: 15 });
    expect(slots.slice(0, 5)).toEqual(["09:00", "09:15", "09:30", "09:45", "10:00"]);
  });

  it("janela livre começando 09:10 → primeiro candidato 09:30", () => {
    const busy = [{ startsAt: new Date("2026-09-30T12:00:00Z"), blockEndsAt: new Date("2026-09-30T12:10:00Z") }];
    expect(slotsOf({ busy })[0]).toBe("09:30");
  });

  it("expediente que não começa em hora redonda (09:10) também ancora na grade", () => {
    const wh: WorkingHourRule[] = [{ weekday: 3, startTime: "09:10", endTime: "11:00" }];
    expect(slotsOf({ workingHours: wh })).toEqual(["09:30", "10:00", "10:30"]);
  });

  it("o serviço tem que terminar dentro da janela (17:30 + 45 min não cabe)", () => {
    const slots = slotsOf({ serviceDurationMin: 45 });
    expect(slots[slots.length - 1]).toBe("17:00");
  });

  it("antecedência mínima corta candidatos anteriores ao limite, mantendo a grade", () => {
    // now = 09:40 local; lead 30 → earliest 10:10 → primeiro candidato 10:30.
    const now = new Date("2026-09-30T12:40:00Z");
    expect(slotsOf({ now, minLeadTimeMin: 30 })[0]).toBe("10:30");
  });

  it("bloqueio no meio (12:00-13:00) não oferece candidatos dentro dele e retoma em 13:00", () => {
    const closedRanges = [{ startsAt: new Date("2026-09-30T15:00:00Z"), endsAt: new Date("2026-09-30T16:00:00Z") }];
    const slots = slotsOf({ closedRanges });
    expect(slots).toContain("11:30");
    expect(slots).not.toContain("12:00");
    expect(slots).not.toContain("12:30");
    expect(slots).toContain("13:00");
  });

  it("dia sem expediente devolve vazio", () => {
    expect(slotsOf({ dateISO: "2026-10-01" })).toEqual([]);
  });

  it("dia de troca de horário de verão (New_York, 08/03/2026): candidatos seguem o relógio de parede, sem duplicar", () => {
    const wh: WorkingHourRule[] = [{ weekday: 0, startTime: "01:00", endTime: "05:00" }]; // domingo 08/03/2026
    const slots = computeAvailableSlots({
      dateISO: "2026-03-08",
      timezone: "America/New_York",
      workingHours: wh,
      closedRanges: [],
      busy: [],
      serviceDurationMin: 30,
      slotGranularityMin: 60,
      minLeadTimeMin: 0,
      now: new Date("2026-03-01T00:00:00Z"),
    });
    expect(slots[0].toISOString()).toBe("2026-03-08T06:00:00.000Z"); // 01:00 EST
    expect(new Set(slots.map((s) => s.getTime())).size).toBe(slots.length);
  });
});

describe("computeAvailableDays com a grade ancorada", () => {
  it("segue listando só dias com vaga", () => {
    const { days } = computeAvailableDays({
      timezone: TZ,
      workingHours: WED,
      closedRanges: [],
      busy: [],
      serviceDurationMin: 45,
      slotGranularityMin: 30,
      minLeadTimeMin: 0,
      maxHorizonDays: 16,
      now: NOW,
      fromDateISO: "2026-09-29",
      limit: 5,
    });
    expect(days).toEqual(["2026-09-30", "2026-10-07", "2026-10-14"]);
  });
});
