import { describe, expect, it } from "vitest";
import {
  firstNameForGreeting,
  formatDayLabelFromISO,
  formatDurationLabel,
  formatLeadLabel,
  formatLongDayLabel,
  formatRelativeDayLabel,
  formatWhenLabel,
} from "../format";

const SP = "America/Sao_Paulo";

describe("formatDurationLabel", () => {
  it.each([
    [40, "40 min"],
    [5, "5 min"],
    [59, "59 min"],
    [60, "1h"],
    [90, "1h30"],
    [125, "2h05"],
    [120, "2h"],
  ])("%i min -> %s", (min, expected) => {
    expect(formatDurationLabel(min)).toBe(expected);
  });
});

describe("formatLongDayLabel", () => {
  it("dia da semana por extenso + dd/MM no fuso do tenant", () => {
    expect(formatLongDayLabel(new Date("2026-10-02T15:00:00Z"), SP)).toBe("sexta-feira, 02/10");
    expect(formatLongDayLabel(new Date("2026-10-04T15:00:00Z"), SP)).toBe("domingo, 04/10");
    expect(formatLongDayLabel(new Date("2026-10-03T15:00:00Z"), SP)).toBe("sábado, 03/10");
    expect(formatLongDayLabel(new Date("2026-09-30T15:00:00Z"), SP)).toBe("quarta-feira, 30/09");
  });

  it("respeita a virada de dia por fuso (02:00Z ainda é o dia anterior em São Paulo)", () => {
    expect(formatLongDayLabel(new Date("2026-10-02T02:00:00Z"), SP)).toBe("quinta-feira, 01/10");
  });
});

describe("formatDayLabelFromISO (BUG-15)", () => {
  it("usa o meio-dia local: não desloca o dia em fuso com offset grande", () => {
    expect(formatDayLabelFromISO("2026-10-01", "Pacific/Kiritimati")).toBe("Qui 01/10");
    expect(formatDayLabelFromISO("2026-10-01", "Pacific/Pago_Pago")).toBe("Qui 01/10");
  });

  it("São Paulo e UTC", () => {
    expect(formatDayLabelFromISO("2026-10-02", SP)).toBe("Sex 02/10");
    expect(formatDayLabelFromISO("2026-09-30", "UTC")).toBe("Qua 30/09");
  });
});

describe("formatRelativeDayLabel", () => {
  it("Hoje, Amanhã e dia comum", () => {
    expect(formatRelativeDayLabel("2026-09-30", "2026-09-30", SP)).toBe("Hoje · Qua 30/09");
    expect(formatRelativeDayLabel("2026-10-01", "2026-09-30", SP)).toBe("Amanhã · Qui 01/10");
    expect(formatRelativeDayLabel("2026-10-02", "2026-09-30", SP)).toBe("Sex 02/10");
  });

  it("amanhã atravessa o fim do mês/ano", () => {
    expect(formatRelativeDayLabel("2027-01-01", "2026-12-31", SP)).toBe("Amanhã · Sex 01/01");
  });

  it("dia passado não vira Hoje", () => {
    expect(formatRelativeDayLabel("2026-09-29", "2026-09-30", SP)).toBe("Ter 29/09");
  });
});

describe("formatLeadLabel", () => {
  it.each([
    [120, "2 horas"],
    [30, "30 minutos"],
    [90, "1h30"],
    [1440, "24 horas"],
    [60, "1 hora"],
    [1, "1 minuto"],
    [0, "0 minutos"],
    [2880, "48 horas"],
  ])("%i min -> %s", (min, expected) => {
    expect(formatLeadLabel(min)).toBe(expected);
  });
});

describe("formatWhenLabel", () => {
  const now = new Date("2026-09-30T13:12:00Z"); // 10:12 em São Paulo (quarta)

  it("hoje, amanhã e data", () => {
    expect(formatWhenLabel(new Date("2026-09-30T17:00:00Z"), now, SP)).toBe("hoje às 14:00");
    expect(formatWhenLabel(new Date("2026-10-01T12:00:00Z"), now, SP)).toBe("amanhã às 09:00");
    expect(formatWhenLabel(new Date("2026-10-05T12:00:00Z"), now, SP)).toBe("Seg 05/10 às 09:00");
  });

  it("compara o dia no fuso do tenant, não em UTC", () => {
    // 22:30 em SP de 30/09 = 01:30Z de 01/10: continua hoje para quem está em SP.
    expect(formatWhenLabel(new Date("2026-10-01T01:30:00Z"), now, SP)).toBe("hoje às 22:30");
  });
});

describe("firstNameForGreeting", () => {
  it("primeiro nome de name; senão de pushName", () => {
    expect(firstNameForGreeting("Maria Souza", "Mah")).toBe("Maria");
    expect(firstNameForGreeting(null, "João Pedro")).toBe("João");
    expect(firstNameForGreeting("  ", "Ana")).toBe("Ana");
  });

  it("exige pelo menos 2 letras", () => {
    expect(firstNameForGreeting("J", null)).toBeNull();
    expect(firstNameForGreeting("J.", "Bia")).toBe("Bia");
    expect(firstNameForGreeting(null, "🙂")).toBeNull();
    expect(firstNameForGreeting("123", "…")).toBeNull();
  });

  it("limpa pontuação das pontas e preserva acento/hífen", () => {
    expect(firstNameForGreeting("*Ana*, do salão", null)).toBe("Ana");
    expect(firstNameForGreeting("Ana-Clara Lima", null)).toBe("Ana-Clara");
    expect(firstNameForGreeting("😀 Zoé", null)).toBe("Zoé");
  });

  it("nada utilizável devolve null", () => {
    expect(firstNameForGreeting(null, null)).toBeNull();
  });
});
