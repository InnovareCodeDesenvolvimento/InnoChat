import { describe, expect, it } from "vitest";
import { aggregateReport, noShowRate, ticketOf, type ReportGroupRow } from "./aggregate";
import { commissionCentsFor, formatPctText, parsePctText, pctToNumber, resolveCommissionPct } from "./commission";
import { resolveReportRange } from "./range";

describe("herança da comissão", () => {
  it("serviço vence profissional; nulo herda; nenhum dos dois é 0", () => {
    expect(resolveCommissionPct(30, 40)).toBe(30);
    expect(resolveCommissionPct(null, 40)).toBe(40);
    expect(resolveCommissionPct(undefined, 40)).toBe(40);
    expect(resolveCommissionPct(null, null)).toBe(0);
  });

  it("0 no serviço é válido e NÃO herda o do profissional", () => {
    expect(resolveCommissionPct(0, 40)).toBe(0);
  });

  it("valor fora de 0 a 100 ou não numérico é contido", () => {
    expect(resolveCommissionPct(150, null)).toBe(100);
    expect(resolveCommissionPct(-5, null)).toBe(0);
    expect(resolveCommissionPct(Number.NaN, 40)).toBe(0);
  });
});

describe("comissão em centavos", () => {
  it("arredonda ao centavo mais próximo e meio centavo sobe", () => {
    expect(commissionCentsFor(5000, 40)).toBe(2000);
    expect(commissionCentsFor(5000, 33.33)).toBe(1667); // 1666,5
    expect(commissionCentsFor(3333, 12.5)).toBe(417); // 416,625
    expect(commissionCentsFor(1, 50)).toBe(1); // 0,5
    expect(commissionCentsFor(1, 49.99)).toBe(0);
  });

  it("não acumula erro de ponto flutuante nos casos comuns", () => {
    expect(commissionCentsFor(10000, 0.07)).toBe(7);
    expect(commissionCentsFor(2990, 15)).toBe(449); // 448,5
  });

  it("preço zero, negativo ou inválido dá 0; 100% devolve o preço inteiro", () => {
    expect(commissionCentsFor(0, 40)).toBe(0);
    expect(commissionCentsFor(-100, 40)).toBe(0);
    expect(commissionCentsFor(Number.NaN, 40)).toBe(0);
    expect(commissionCentsFor(8000, 100)).toBe(8000);
  });

  it("converte Decimal do Prisma (objeto com toString) e nulo", () => {
    expect(pctToNumber({ toString: () => "12.50" })).toBe(12.5);
    expect(pctToNumber(null)).toBeNull();
    expect(pctToNumber(undefined)).toBeNull();
    expect(pctToNumber(30)).toBe(30);
  });
});

describe("texto digitado de porcentagem", () => {
  it("aceita vírgula, ponto e %; vazio é nulo; recusa o resto", () => {
    expect(parsePctText("40")).toEqual({ ok: true, value: 40 });
    expect(parsePctText("12,5")).toEqual({ ok: true, value: 12.5 });
    expect(parsePctText(" 30 % ")).toEqual({ ok: true, value: 30 });
    expect(parsePctText("")).toEqual({ ok: true, value: null });
    expect(parsePctText("0")).toEqual({ ok: true, value: 0 });
    expect(parsePctText("101")).toEqual({ ok: false });
    expect(parsePctText("12,345")).toEqual({ ok: false });
    expect(parsePctText("abc")).toEqual({ ok: false });
    expect(parsePctText("-5")).toEqual({ ok: false });
  });

  it("formata com vírgula", () => {
    expect(formatPctText(12.5)).toBe("12,5");
    expect(formatPctText(40)).toBe("40");
    expect(formatPctText(null)).toBe("");
  });
});

describe("agregação", () => {
  const row = (over: Partial<ReportGroupRow>): ReportGroupRow => ({
    professionalId: "p1",
    professionalName: "Ana",
    serviceId: "s1",
    serviceName: "Corte",
    completed: 0,
    noShow: 0,
    revenueCents: 0,
    commissionCents: 0,
    estimatedCount: 0,
    withoutPriceCount: 0,
    ...over,
  });

  it("totais, por serviço e por profissional batem entre si", () => {
    const result = aggregateReport([
      row({ completed: 2, revenueCents: 10000, commissionCents: 4000 }),
      row({ serviceId: "s2", serviceName: "Química", completed: 1, noShow: 1, revenueCents: 12000, commissionCents: 3600, estimatedCount: 1 }),
      row({ professionalId: "p2", professionalName: "Bia", completed: 1, noShow: 2, revenueCents: 5000, commissionCents: 0 }),
    ]);
    expect(result.summary).toMatchObject({ completed: 4, noShow: 3, revenueCents: 27000, commissionCents: 7600, ticketCents: 6750, estimatedCount: 1 });
    expect(result.byService.map((l) => [l.name, l.revenueCents])).toEqual([["Corte", 15000], ["Química", 12000]]);
    expect(result.byProfessional.find((l) => l.name === "Ana")).toMatchObject({ completed: 3, noShow: 1, revenueCents: 22000, commissionCents: 7600 });
    expect(result.byProfessional.find((l) => l.name === "Bia")?.noShowRatePercent).toBeCloseTo(66.7, 1);
  });

  it("ordena por faturamento e sem dados devolve zeros sem dividir por zero", () => {
    expect(aggregateReport([]).summary).toMatchObject({ completed: 0, ticketCents: 0, noShowRatePercent: 0 });
    expect(ticketOf(100, 0)).toBe(0);
    expect(noShowRate(0, 0)).toBe(0);
    expect(noShowRate(3, 1)).toBe(25);
  });
});

describe("período no fuso da empresa", () => {
  const tz = "America/Sao_Paulo";
  // 2026-10-02 15:00 em Brasília.
  const now = new Date("2026-10-02T18:00:00.000Z");

  it("este mês, mês passado e últimos 30 dias", () => {
    expect(resolveReportRange({ preset: "this_month" }, now, tz)).toMatchObject({ from: "2026-10-01", to: "2026-10-02", days: 2 });
    expect(resolveReportRange({ preset: "last_month" }, now, tz)).toMatchObject({ from: "2026-09-01", to: "2026-09-30", days: 30 });
    expect(resolveReportRange({ preset: "last_30_days" }, now, tz)).toMatchObject({ from: "2026-09-03", to: "2026-10-02", days: 30 });
  });

  it("mês passado na virada de ano", () => {
    const jan = new Date("2027-01-10T12:00:00.000Z");
    expect(resolveReportRange({ preset: "last_month" }, jan, tz)).toMatchObject({ from: "2026-12-01", to: "2026-12-31" });
  });

  it("às 23h do dia 30 em Brasília (já dia 1º em UTC) o 'hoje' é o do fuso, não o do servidor", () => {
    // 2026-10-01 02:00 UTC = 2026-09-30 23:00 em Brasília.
    const lateNight = new Date("2026-10-01T02:00:00.000Z");
    expect(resolveReportRange({ preset: "this_month" }, lateNight, tz)).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
  });

  it("os instantes da consulta são meia-noite local (UTC-3) e o fim é exclusivo", () => {
    const r = resolveReportRange({ preset: "custom", from: "2026-09-01", to: "2026-09-30" }, now, tz);
    expect(r.fromInstant.toISOString()).toBe("2026-09-01T03:00:00.000Z");
    expect(r.toExclusiveInstant.toISOString()).toBe("2026-10-01T03:00:00.000Z");
  });

  it("personalizado inverte datas trocadas, limita a 366 dias e cai em 'este mês' se for inválido", () => {
    expect(resolveReportRange({ preset: "custom", from: "2026-09-30", to: "2026-09-01" }, now, tz)).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    expect(resolveReportRange({ preset: "custom", from: "2020-01-01", to: "2026-09-30" }, now, tz).days).toBe(366);
    expect(resolveReportRange({ preset: "custom", from: "2026-02-31", to: "2026-09-30" }, now, tz).preset).toBe("this_month");
    expect(resolveReportRange({ preset: "custom" }, now, tz).preset).toBe("this_month");
    expect(resolveReportRange({ preset: "hack'; drop" }, now, tz).preset).toBe("this_month");
  });
});
