import { describe, expect, it } from "vitest";
import { normalizeText, parseInput } from "../index";

// 2026-09-30 é quarta-feira (relógio do seed).
const clock = { today: "2026-09-30", nowLocal: "10:00" };
const p = (s: string) => parseInput(s, clock);

describe("normalizeText", () => {
  it.each([
    ["Menu", "menu"],
    ["MENÚ", "menu"],
    ["  Escóva  ", "escova"],
    ["Confirmar!", "confirmar"],
    ["0️⃣", "0"],
    ["2️⃣", "2"],
    ["👍🏽", "👍"],
    ["?", "?"],
    ["..", ".."],
    ["ok!!!", "ok"],
    ["a   b", "a b"],
  ])("%j -> %j", (raw, expected) => {
    expect(normalizeText(raw)).toBe(expected);
  });
});

describe("normalizeText: entrada hostil (ReDoS)", () => {
  it("60 mil '!' seguidos de 'a' normalizam em menos de 50 ms", () => {
    const hostile = "!".repeat(60000) + "a";
    const t0 = performance.now();
    const out = normalizeText(hostile);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(out.length).toBeLessThanOrEqual(4000);
  });
  it("60 mil '! ' alternados, 60 mil espaços e 'a' + 60 mil '!' também", () => {
    for (const hostile of ["! ".repeat(30000) + "a", " ".repeat(60000) + "a", "a" + "!".repeat(60000)]) {
      const t0 = performance.now();
      normalizeText(hostile);
      expect(performance.now() - t0).toBeLessThan(50);
    }
  });
  it("continua aparando a pontuação final de texto normal", () => {
    expect(normalizeText("oi!!! ?.")).toBe("oi");
    expect(normalizeText("a" + "!".repeat(100))).toBe("a");
  });
});

describe("parseInput: número (CA-07)", () => {
  it.each(["2", "2️⃣", "2.", "2)", "#2", "opção 2", "Opcao 2", "nº 2", " 02 ", "n° 2"])("%j -> 2", (raw) => {
    expect(p(raw).number).toBe(2);
  });
  it("0, texto e hora não são número de opção", () => {
    expect(p("0").number).toBeNull();
    expect(p("15h").number).toBeNull();
    expect(p("amanhã").number).toBeNull();
  });
});

describe("parseInput: data (CA-08, hoje é quarta 2026-09-30)", () => {
  it.each([
    ["hoje", "2026-09-30"],
    ["amanhã", "2026-10-01"],
    ["Amanha", "2026-10-01"],
    ["depois de amanhã", "2026-10-02"],
    ["sexta", "2026-10-02"],
    ["sexta-feira", "2026-10-02"],
    ["sex", "2026-10-02"],
    ["quarta", "2026-09-30"],
    ["quarta que vem", "2026-10-07"],
    ["próxima segunda", "2026-10-05"],
    ["domingo", "2026-10-04"],
    ["02/10", "2026-10-02"],
    ["2/10", "2026-10-02"],
    ["02-10", "2026-10-02"],
    ["02/10/26", "2026-10-02"],
    ["02/10/2027", "2027-10-02"],
    ["dia 15", "2026-10-15"],
    ["dia 30", "2026-09-30"],
    ["15 de outubro", "2026-10-15"],
    ["1 de março", "2027-03-01"],
    ["Sex 02/10", "2026-10-02"],
  ])("%j -> %s", (raw, date) => {
    expect(p(raw).date).toBe(date);
  });
  it("data impossível não vira data", () => {
    expect(p("31/02").date).toBeNull();
    expect(p("32/10").date).toBeNull();
  });
  it("virada de ano", () => {
    expect(parseInput("dia 5", { today: "2026-12-20", nowLocal: "10:00" }).date).toBe("2027-01-05");
    expect(parseInput("sexta", { today: "2026-12-30", nowLocal: "10:00" }).date).toBe("2027-01-01");
  });
});

describe("parseInput: hora e período (CA-09)", () => {
  it.each([
    ["15h", "15:00"],
    ["15 h", "15:00"],
    ["15hs", "15:00"],
    ["15:00", "15:00"],
    ["15:30", "15:30"],
    ["15h30", "15:30"],
    ["15.30", "15:30"],
    ["9h", "09:00"],
    ["3 da tarde", "15:00"],
    ["3 e meia da tarde", "15:30"],
    ["8 da noite", "20:00"],
    ["8 da manhã", "08:00"],
    ["meio dia", "12:00"],
    ["meio-dia", "12:00"],
    ["às 15", "15:00"],
    ["amanhã 15h", "15:00"],
  ])("%j -> %s", (raw, time) => {
    expect(p(raw).time).toBe(time);
  });
  it("hora inválida", () => {
    expect(p("25h").time).toBeNull();
    expect(p("15:75").time).toBeNull();
  });
  it("não confunde data com hora", () => {
    expect(p("02/10").time).toBeNull();
  });
  it.each([
    ["tarde", "afternoon"],
    ["de manhã", "morning"],
    ["noite", "evening"],
  ])("período %j", (raw, period) => {
    expect(p(raw).period).toBe(period);
  });
  it("saudação não é período", () => {
    expect(p("boa tarde").period).toBeNull();
    expect(p("bom dia").period).toBeNull();
  });
  it("'sexta à tarde' → sexta + tarde", () => {
    const r = p("sexta à tarde");
    expect(r.date).toBe("2026-10-02");
    expect(r.period).toBe("afternoon");
    expect(r.time).toBeNull();
  });
  it("data + hora", () => {
    const r = p("amanhã 15h");
    expect(r.date).toBe("2026-10-01");
    expect(r.time).toBe("15:00");
  });
});

describe("parseInput: sim/não por emoji", () => {
  it.each(["👍", "👍🏽", "✅", "👌", "👍👍"])("%j é sim", (raw) => {
    expect(p(raw).yes).toBe(true);
    expect(p(raw).no).toBe(false);
  });
  it.each(["❌", "👎"])("%j é não", (raw) => {
    expect(p(raw).no).toBe(true);
  });
  it("texto não é emoji", () => {
    expect(p("sim").yes).toBe(false);
  });
});
