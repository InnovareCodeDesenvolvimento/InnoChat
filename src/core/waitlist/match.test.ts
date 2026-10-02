import { describe, expect, it } from "vitest";
import {
  describePreference,
  desiredDateToISO,
  isoToDesiredDate,
  minuteOfDayInTimezone,
  parseMinute,
  periodContainsMinute,
  pickSlotForPreference,
  preferenceAcceptsMinute,
  slotTouchesFreedRange,
} from "./match";

const TZ = "America/Sao_Paulo";
// 10:00 em São Paulo (UTC-3) no dia 2026-10-05.
const at = (hhmm: string) => new Date(`2026-10-05T${hhmm}:00-03:00`);

describe("período", () => {
  it("manhã < 12h, tarde 12h às 18h, noite a partir das 18h, qualquer sempre serve", () => {
    expect(periodContainsMinute("MORNING", 11 * 60 + 59)).toBe(true);
    expect(periodContainsMinute("MORNING", 12 * 60)).toBe(false);
    expect(periodContainsMinute("AFTERNOON", 12 * 60)).toBe(true);
    expect(periodContainsMinute("AFTERNOON", 18 * 60)).toBe(false);
    expect(periodContainsMinute("EVENING", 18 * 60)).toBe(true);
    expect(periodContainsMinute("ANY", 3 * 60)).toBe(true);
  });
  it("minuto do dia no fuso da empresa, não em UTC", () => {
    expect(minuteOfDayInTimezone(at("10:30"), TZ)).toBe(10 * 60 + 30);
  });
});

describe("preferência (janela vale no lugar do período)", () => {
  const morningWindowAfternoon = { period: "MORNING", windowStartMin: 14 * 60, windowEndMin: 16 * 60 };
  it("com janela, o período é ignorado", () => {
    expect(preferenceAcceptsMinute(morningWindowAfternoon, 10 * 60)).toBe(false);
    expect(preferenceAcceptsMinute(morningWindowAfternoon, 14 * 60)).toBe(true);
    expect(preferenceAcceptsMinute(morningWindowAfternoon, 15 * 60 + 59)).toBe(true);
    expect(preferenceAcceptsMinute(morningWindowAfternoon, 16 * 60)).toBe(false);
  });
  it("sem janela vale o período", () => {
    expect(preferenceAcceptsMinute({ period: "EVENING", windowStartMin: null, windowEndMin: null }, 19 * 60)).toBe(true);
    expect(preferenceAcceptsMinute({ period: "EVENING", windowStartMin: null, windowEndMin: null }, 9 * 60)).toBe(false);
  });
});

describe("horário que abriu", () => {
  it("só conta o horário que toca o intervalo liberado", () => {
    const from = at("10:00");
    const to = at("10:30");
    expect(slotTouchesFreedRange(at("10:00"), 30, from, to)).toBe(true);
    expect(slotTouchesFreedRange(at("09:30"), 30, from, to)).toBe(false); // termina quando o liberado começa
    expect(slotTouchesFreedRange(at("09:30"), 60, from, to)).toBe(true); // 60 min invade o liberado
    expect(slotTouchesFreedRange(at("10:30"), 30, from, to)).toBe(false);
  });

  it("escolhe o primeiro horário que cabe na preferência e toca o liberado", () => {
    const slots = [at("09:00"), at("09:30"), at("10:00"), at("10:30"), at("15:00")];
    const freed = { from: at("10:00"), to: at("11:00") };
    expect(pickSlotForPreference({ slots, pref: { period: "ANY", windowStartMin: null, windowEndMin: null }, timezone: TZ, durationMin: 30, freed })?.toISOString()).toBe(at("10:00").toISOString());
    expect(pickSlotForPreference({ slots, pref: { period: "AFTERNOON", windowStartMin: null, windowEndMin: null }, timezone: TZ, durationMin: 30, freed })).toBeNull();
    // Sem `freed` (oferta manual) qualquer horário livre serve: o primeiro da tarde.
    expect(pickSlotForPreference({ slots, pref: { period: "AFTERNOON", windowStartMin: null, windowEndMin: null }, timezone: TZ, durationMin: 30 })?.toISOString()).toBe(at("15:00").toISOString());
  });
});

describe("apoio", () => {
  it("dia da fila vai e volta como data de calendário, sem deslocar por fuso", () => {
    expect(desiredDateToISO(isoToDesiredDate("2026-10-05"))).toBe("2026-10-05");
  });
  it("texto do pedido para o painel", () => {
    expect(describePreference({ period: "ANY", windowStartMin: null, windowEndMin: null })).toBe("Qualquer horário");
    expect(describePreference({ period: "MORNING", windowStartMin: null, windowEndMin: null })).toBe("Manhã");
    expect(describePreference({ period: "ANY", windowStartMin: 14 * 60, windowEndMin: 16 * 60 + 30 })).toBe("14:00 às 16:30");
  });
  it("parseMinute aceita HH:mm e recusa o resto", () => {
    expect(parseMinute("09:30")).toBe(570);
    expect(parseMinute("9:05")).toBe(545);
    expect(parseMinute("24:00")).toBe(1440);
    expect(parseMinute("25:00")).toBeNull();
    expect(parseMinute("abc")).toBeNull();
  });
});
