import { describe, expect, it } from "vitest";
import {
  asBillingCycle,
  bestCycle,
  BILLING_CYCLES,
  buildCycleOptions,
  computeNextPeriodEnd,
  couponAcceptsCycle,
  couponCyclesLabel,
  couponDurationHint,
  couponDurationLabel,
  couponIneligibleReason,
  couponRemainingLabel,
  couponSummary,
  CYCLE_INFO,
  cycleEveryLabel,
  cycleMonths,
  cycleSavings,
  cycleSavingsLabel,
  cycleTitle,
  effectiveCycle,
  grossCentsFor,
  initialCouponCycles,
  invoiceCoverageSuffix,
  isValidCouponCode,
  MIN_CHARGE_CENTS,
  mrrContributionCents,
  normalizeCouponCode,
  normalizeCouponCycles,
  offeredCycles,
  parseBillingCycle,
  planOffersCycle,
  priceFor,
  priceInvoice,
  suggestCyclePrices,
} from "@/core/billing";

const ALL = { priceCents: 5900, quarterlyPriceCents: 16800, semiannualPriceCents: 31900, annualPriceCents: 59000 };
const ONLY_MONTHLY = { priceCents: 5900, quarterlyPriceCents: null, semiannualPriceCents: null, annualPriceCents: null };
const ONLY_ANNUAL = { ...ONLY_MONTHLY, annualPriceCents: 59000 };

describe("ciclos: tabela única", () => {
  it("quatro ciclos com meses, rótulo e 'a cada N meses'", () => {
    expect(BILLING_CYCLES).toEqual(["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL"]);
    expect(BILLING_CYCLES.map(cycleMonths)).toEqual([1, 3, 6, 12]);
    expect(BILLING_CYCLES.map(cycleTitle)).toEqual(["Mensal", "Trimestral", "Semestral", "Anual"]);
    expect(BILLING_CYCLES.map(cycleEveryLabel)).toEqual(["a cada 1 mês", "a cada 3 meses", "a cada 6 meses", "a cada 12 meses"]);
    expect(CYCLE_INFO.QUARTERLY.word).toBe("trimestral");
  });

  it("valor desconhecido: parse devolve null, asBillingCycle cai em mensal", () => {
    expect(parseBillingCycle("SEMIANNUAL")).toBe("SEMIANNUAL");
    expect(parseBillingCycle("BIMONTHLY")).toBeNull();
    expect(parseBillingCycle(undefined)).toBeNull();
    expect(asBillingCycle("garbage")).toBe("MONTHLY");
  });
});

describe("preço por ciclo e ciclos oferecidos", () => {
  it("priceFor devolve o preço do período; nulo = não oferece; mensal sempre existe", () => {
    expect(priceFor(ALL, "MONTHLY")).toBe(5900);
    expect(priceFor(ALL, "QUARTERLY")).toBe(16800);
    expect(priceFor(ALL, "SEMIANNUAL")).toBe(31900);
    expect(priceFor(ALL, "ANNUAL")).toBe(59000);
    expect(priceFor(ONLY_MONTHLY, "QUARTERLY")).toBeNull();
    expect(planOffersCycle(ONLY_MONTHLY, "MONTHLY")).toBe(true);
    expect(planOffersCycle(ONLY_MONTHLY, "ANNUAL")).toBe(false);
  });

  it("preço zero ou negativo vindo de fora conta como não oferecido", () => {
    expect(priceFor({ ...ONLY_MONTHLY, quarterlyPriceCents: 0 }, "QUARTERLY")).toBeNull();
    expect(priceFor({ ...ONLY_MONTHLY, quarterlyPriceCents: -5 }, "QUARTERLY")).toBeNull();
  });

  it("offeredCycles na ordem, mensal primeiro", () => {
    expect(offeredCycles(ALL)).toEqual(["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL"]);
    expect(offeredCycles(ONLY_ANNUAL)).toEqual(["MONTHLY", "ANNUAL"]);
    expect(offeredCycles(ONLY_MONTHLY)).toEqual(["MONTHLY"]);
  });

  it("pedir um ciclo que o plano não oferece cai em mensal (nenhum ciclo é tratado como mensal por engano quando existe)", () => {
    for (const cycle of ["QUARTERLY", "SEMIANNUAL", "ANNUAL"] as const) {
      expect(effectiveCycle(ONLY_MONTHLY, cycle)).toBe("MONTHLY");
      expect(effectiveCycle(ALL, cycle)).toBe(cycle);
    }
    expect(effectiveCycle(ONLY_ANNUAL, "QUARTERLY")).toBe("MONTHLY");
    expect(effectiveCycle(ONLY_ANNUAL, "ANNUAL")).toBe("ANNUAL");
  });

  it("grossCentsFor lê o preço do ciclo", () => {
    expect(grossCentsFor(ALL, "QUARTERLY")).toBe(16800);
    expect(grossCentsFor(ONLY_MONTHLY, "SEMIANNUAL")).toBe(5900);
  });
});

describe("economia, MRR e arredondamentos", () => {
  it("economia em reais, em % e meses grátis, vs. mensal x meses", () => {
    const q = cycleSavings(ALL, "QUARTERLY");
    expect(q.savingsCents).toBe(900); // 177,00 - 168,00
    expect(q.percent).toBe(5); // 5,08% arredonda para 5
    expect(q.freeMonths).toBe(0);
    expect(q.perMonthCents).toBe(5600);
    const s = cycleSavings(ALL, "SEMIANNUAL");
    expect(s.savingsCents).toBe(3500); // 354,00 - 319,00
    expect(s.percent).toBe(10);
    expect(s.perMonthCents).toBe(5317); // 31900 / 6 = 5316,67
    const a = cycleSavings(ALL, "ANNUAL");
    expect(a.savingsCents).toBe(11800);
    expect(a.percent).toBe(17); // 16,67%
    expect(a.freeMonths).toBe(2);
    expect(a.freeMonthsExact).toBe(true);
    expect(a.perMonthCents).toBe(4917);
  });

  it("ciclo não oferecido ou sem desconto: economia zero", () => {
    expect(cycleSavings(ONLY_MONTHLY, "ANNUAL")).toMatchObject({ savingsCents: 0, percent: 0, periodCents: null, perMonthCents: null });
    expect(cycleSavings({ ...ONLY_MONTHLY, annualPriceCents: 70800 }, "ANNUAL").savingsCents).toBe(0);
    expect(cycleSavings({ ...ONLY_MONTHLY, annualPriceCents: 90000 }, "ANNUAL").savingsCents).toBe(0);
  });

  it("rótulo: meses grátis quando fecham, senão % de desconto", () => {
    expect(cycleSavingsLabel(ALL, "ANNUAL")).toBe("2 meses grátis");
    expect(cycleSavingsLabel(ALL, "QUARTERLY")).toBe("5% de desconto");
    expect(cycleSavingsLabel(ALL, "SEMIANNUAL")).toBe("10% de desconto");
    expect(cycleSavingsLabel(ALL, "MONTHLY")).toBeNull();
    expect(cycleSavingsLabel(ONLY_MONTHLY, "ANNUAL")).toBeNull();
    expect(cycleSavingsLabel({ ...ONLY_MONTHLY, annualPriceCents: 70800 }, "ANNUAL")).toBeNull();
    expect(cycleSavingsLabel({ ...ONLY_MONTHLY, semiannualPriceCents: 30000 }, "SEMIANNUAL")).toBe("15% de desconto");
    expect(cycleSavingsLabel({ ...ONLY_MONTHLY, semiannualPriceCents: 29500 }, "SEMIANNUAL")).toBe("1 mês grátis");
  });

  it("MRR é o preço do período dividido pelos meses", () => {
    expect(mrrContributionCents(ALL, "MONTHLY")).toBe(5900);
    expect(mrrContributionCents(ALL, "QUARTERLY")).toBe(5600);
    expect(mrrContributionCents(ALL, "SEMIANNUAL")).toBe(5317);
    expect(mrrContributionCents(ALL, "ANNUAL")).toBe(4917);
    // plano que deixou de oferecer o ciclo: conta como mensal
    expect(mrrContributionCents(ONLY_MONTHLY, "ANNUAL")).toBe(5900);
    expect(mrrContributionCents(ONLY_ANNUAL, "QUARTERLY")).toBe(5900);
  });

  it("melhor ciclo = menor valor por mês; null se nenhum economiza", () => {
    expect(bestCycle(ALL)?.cycle).toBe("ANNUAL");
    expect(bestCycle(ONLY_MONTHLY)).toBeNull();
    expect(bestCycle({ ...ONLY_MONTHLY, quarterlyPriceCents: 17700 })).toBeNull();
    expect(bestCycle({ ...ONLY_MONTHLY, quarterlyPriceCents: 16800, annualPriceCents: 70000 })?.cycle).toBe("QUARTERLY");
  });

  it("opções do seletor só trazem os ciclos oferecidos", () => {
    expect(buildCycleOptions(ALL).map((o) => o.cycle)).toEqual(["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL"]);
    expect(buildCycleOptions(ONLY_MONTHLY).map((o) => o.cycle)).toEqual(["MONTHLY"]);
    const annual = buildCycleOptions(ALL).find((o) => o.cycle === "ANNUAL")!;
    expect(annual).toMatchObject({ months: 12, periodCents: 59000, perMonthCents: 4917, savingsCents: 11800, percent: 17, savingsLabel: "2 meses grátis" });
  });
});

describe("sugerir preços", () => {
  it("trimestral -5%, semestral -10%, anual 2 meses grátis, em reais inteiros", () => {
    const [q, s, a] = suggestCyclePrices(5900);
    expect(q).toMatchObject({ cycle: "QUARTERLY", fullCents: 17700, rawCents: 16815, roundedCents: 16800 });
    expect(s).toMatchObject({ cycle: "SEMIANNUAL", fullCents: 35400, rawCents: 31860, roundedCents: 31900 });
    expect(a).toMatchObject({ cycle: "ANNUAL", fullCents: 70800, rawCents: 59000, roundedCents: 59000 });
  });

  it("nunca passa do mensal x meses nem cai abaixo do mínimo", () => {
    for (const monthly of [100, 101, 150, 990, 4999, 12345, 999999]) {
      for (const s of suggestCyclePrices(monthly)) {
        expect(s.roundedCents).toBeLessThanOrEqual(s.fullCents);
        expect(s.roundedCents).toBeGreaterThanOrEqual(MIN_CHARGE_CENTS);
        expect(s.roundedCents % 100).toBe(s.roundedCents === s.fullCents ? s.fullCents % 100 : 0);
      }
    }
  });

  it("mensal inválido não sugere nada", () => {
    expect(suggestCyclePrices(0)).toEqual([]);
    expect(suggestCyclePrices(99)).toEqual([]);
    expect(suggestCyclePrices(Number.NaN)).toEqual([]);
  });
});

describe("priceInvoice", () => {
  it("sem cupom: bruto do ciclo, para cada um dos 4", () => {
    expect(priceInvoice(ALL, "MONTHLY", null)).toEqual({ cycle: "MONTHLY", grossCents: 5900, discountCents: 0, netCents: 5900 });
    expect(priceInvoice(ALL, "QUARTERLY", null)).toEqual({ cycle: "QUARTERLY", grossCents: 16800, discountCents: 0, netCents: 16800 });
    expect(priceInvoice(ALL, "SEMIANNUAL", null)).toEqual({ cycle: "SEMIANNUAL", grossCents: 31900, discountCents: 0, netCents: 31900 });
    expect(priceInvoice(ALL, "ANNUAL", null)).toEqual({ cycle: "ANNUAL", grossCents: 59000, discountCents: 0, netCents: 59000 });
  });

  it("PERCENT: desconto arredondado para baixo; líquido = bruto - desconto", () => {
    const p = priceInvoice(ALL, "MONTHLY", { kind: "PERCENT", value: 20 });
    expect(p.discountCents).toBe(1180);
    expect(p.netCents).toBe(4720);
    expect(priceInvoice({ ...ONLY_MONTHLY, priceCents: 4999 }, "MONTHLY", { kind: "PERCENT", value: 10 }).discountCents).toBe(499);
    const q = priceInvoice(ALL, "QUARTERLY", { kind: "PERCENT", value: 10 });
    expect(q.discountCents).toBe(1680);
    expect(q.netCents).toBe(15120);
  });

  it("AMOUNT: desconta o valor fixo por fatura, seja qual for o ciclo", () => {
    expect(priceInvoice(ALL, "ANNUAL", { kind: "AMOUNT", value: 5000 })).toMatchObject({ discountCents: 5000, netCents: 54000 });
    expect(priceInvoice(ALL, "SEMIANNUAL", { kind: "AMOUNT", value: 5000 })).toMatchObject({ discountCents: 5000, netCents: 26900 });
  });

  it("AMOUNT maior que a fatura nunca deixa negativo: cai no mínimo", () => {
    for (const cycle of BILLING_CYCLES) {
      const p = priceInvoice(ALL, cycle, { kind: "AMOUNT", value: 99999999 });
      expect(p.netCents).toBe(MIN_CHARGE_CENTS);
      expect(p.discountCents).toBe(p.grossCents - MIN_CHARGE_CENTS);
    }
  });

  it("PERCENT de 100% cai no mínimo do Mercado Pago, nunca em zero", () => {
    const p = priceInvoice(ALL, "QUARTERLY", { kind: "PERCENT", value: 100 });
    expect(p.netCents).toBe(MIN_CHARGE_CENTS);
    expect(p.grossCents - p.discountCents).toBe(p.netCents);
  });

  it("fatura já no mínimo não recebe desconto", () => {
    const p = priceInvoice({ ...ONLY_MONTHLY, priceCents: 100 }, "MONTHLY", { kind: "PERCENT", value: 50 });
    expect(p).toEqual({ cycle: "MONTHLY", grossCents: 100, discountCents: 0, netCents: 100 });
  });

  it("ciclo pedido sem preço no plano cobra o mensal", () => {
    expect(priceInvoice(ONLY_MONTHLY, "SEMIANNUAL", null)).toMatchObject({ cycle: "MONTHLY", grossCents: 5900 });
    expect(priceInvoice(ONLY_ANNUAL, "QUARTERLY", null).cycle).toBe("MONTHLY");
  });
});

describe("código e duração do cupom", () => {
  it("normaliza para maiúsculas e valida o formato", () => {
    expect(normalizeCouponCode("  verao-10 ")).toBe("VERAO-10");
    expect(isValidCouponCode("VERAO_10")).toBe(true);
    expect(isValidCouponCode("AB")).toBe(false);
    expect(isValidCouponCode("com espaço")).toBe(false);
    expect(isValidCouponCode("A".repeat(33))).toBe(false);
  });

  it("ciclos iniciais contam FATURAS: ONCE=1, N_CYCLES=N, FOREVER=nulo", () => {
    expect(initialCouponCycles("ONCE", null)).toBe(1);
    expect(initialCouponCycles("N_CYCLES", 3)).toBe(3);
    expect(initialCouponCycles("FOREVER", null)).toBeNull();
  });

  it("textos falam em faturas e não têm travessão", () => {
    const all = [
      couponSummary("PERCENT", 20, "ONCE", null),
      couponSummary("AMOUNT", 5000, "N_CYCLES", 3),
      couponSummary("PERCENT", 10, "FOREVER", null),
      couponCyclesLabel(["QUARTERLY"]),
      couponDurationLabel("N_CYCLES", 1),
      couponDurationHint(3, ["QUARTERLY"]),
      couponDurationHint(3, []),
      couponRemainingLabel(2),
      invoiceCoverageSuffix("SEMIANNUAL"),
    ];
    for (const text of all) expect(text).not.toContain("—");
    expect(couponSummary("PERCENT", 20, "ONCE", null)).toBe("20% de desconto na primeira fatura");
    expect(couponDurationLabel("N_CYCLES", 3)).toBe("nas 3 primeiras faturas");
    expect(couponDurationLabel("FOREVER", null)).toBe("em todas as faturas");
    expect(couponRemainingLabel(null)).toBe("em todas as próximas faturas");
    expect(couponRemainingLabel(1)).toBe("em mais 1 fatura");
  });

  it("duração em faturas mostra os meses de cada ciclo", () => {
    expect(couponDurationHint(3, ["QUARTERLY"])).toBe("3 faturas, cerca de 9 meses no trimestral");
    expect(couponDurationHint(1, ["ANNUAL"])).toBe("1 fatura, cerca de 12 meses no anual");
    expect(couponDurationHint(1, ["MONTHLY"])).toBe("1 fatura, cerca de 1 mês no mensal");
    expect(couponDurationHint(3, [])).toBe("3 faturas: de 3 meses no mensal a 36 meses no anual");
  });

  it("rótulo dos ciclos do cupom", () => {
    expect(couponCyclesLabel([])).toBe("todos os ciclos");
    expect(couponCyclesLabel([...BILLING_CYCLES])).toBe("todos os ciclos");
    expect(couponCyclesLabel(["ANNUAL"])).toBe("só no anual");
    expect(couponCyclesLabel(["SEMIANNUAL", "QUARTERLY"])).toBe("trimestral e semestral");
    expect(couponCyclesLabel(["MONTHLY", "QUARTERLY", "ANNUAL"])).toBe("mensal, trimestral e anual");
  });
});

describe("ciclos do cupom", () => {
  it("normaliza: só os 4, sem repetir, na ordem; os 4 marcados viram vazio (todos)", () => {
    expect(normalizeCouponCycles([])).toEqual([]);
    expect(normalizeCouponCycles(["ANNUAL", "QUARTERLY", "ANNUAL"])).toEqual(["QUARTERLY", "ANNUAL"]);
    expect(normalizeCouponCycles(["ANNUAL", "SEMIANNUAL", "QUARTERLY", "MONTHLY"])).toEqual([]);
    expect(normalizeCouponCycles(["LIXO", "MONTHLY"])).toEqual(["MONTHLY"]);
  });

  it("lista vazia aceita qualquer ciclo; lista com ciclos só aceita eles", () => {
    for (const cycle of BILLING_CYCLES) expect(couponAcceptsCycle([], cycle)).toBe(true);
    expect(couponAcceptsCycle(["QUARTERLY"], "QUARTERLY")).toBe(true);
    expect(couponAcceptsCycle(["QUARTERLY"], "MONTHLY")).toBe(false);
    expect(couponAcceptsCycle(["QUARTERLY", "ANNUAL"], "SEMIANNUAL")).toBe(false);
  });
});

describe("couponIneligibleReason", () => {
  const base = { active: true, validFrom: null, validUntil: null, maxRedemptions: null, redemptionsCount: 0, appliesToCycles: [] as string[], planIds: [] };
  const ctx = { planId: "p1", cycle: "MONTHLY" as const, now: new Date("2026-10-10T12:00:00Z") };

  it("vale quando tudo bate", () => {
    expect(couponIneligibleReason(base, ctx)).toBeNull();
  });
  it("desativado, janela, limite, plano e ciclo", () => {
    expect(couponIneligibleReason({ ...base, active: false }, ctx)).toBe("INACTIVE");
    expect(couponIneligibleReason({ ...base, validFrom: new Date("2026-11-01T00:00:00Z") }, ctx)).toBe("NOT_STARTED");
    expect(couponIneligibleReason({ ...base, validUntil: new Date("2026-10-01T00:00:00Z") }, ctx)).toBe("EXPIRED");
    expect(couponIneligibleReason({ ...base, maxRedemptions: 5, redemptionsCount: 5 }, ctx)).toBe("EXHAUSTED");
    expect(couponIneligibleReason({ ...base, planIds: ["p2"] }, ctx)).toBe("WRONG_PLAN");
    expect(couponIneligibleReason({ ...base, planIds: ["p1", "p2"] }, ctx)).toBeNull();
  });
  it("por ciclo: cada um dos 4 contra uma lista", () => {
    const only = { ...base, appliesToCycles: ["QUARTERLY", "ANNUAL"] };
    expect(couponIneligibleReason(only, { ...ctx, cycle: "QUARTERLY" })).toBeNull();
    expect(couponIneligibleReason(only, { ...ctx, cycle: "ANNUAL" })).toBeNull();
    expect(couponIneligibleReason(only, { ...ctx, cycle: "MONTHLY" })).toBe("WRONG_CYCLE");
    expect(couponIneligibleReason(only, { ...ctx, cycle: "SEMIANNUAL" })).toBe("WRONG_CYCLE");
  });
});

describe("computeNextPeriodEnd por ciclo", () => {
  const input = { currentPeriodEnd: new Date("2026-10-15T12:00:00Z"), wasSuspended: false, paidAt: new Date("2026-10-10T12:00:00Z") };
  it.each([
    [3, "2027-01-15T12:00:00.000Z"],
    [6, "2027-04-15T12:00:00.000Z"],
    [12, "2027-10-15T12:00:00.000Z"],
  ])("%i meses mantêm o dia-âncora", (months, expected) => {
    expect(computeNextPeriodEnd({ ...input, months }).toISOString()).toBe(expected);
  });
  it("sem months continua mensal", () => {
    expect(computeNextPeriodEnd(input).toISOString()).toBe("2026-11-15T12:00:00.000Z");
  });
  it("suspensa: conta a partir do pagamento", () => {
    expect(computeNextPeriodEnd({ ...input, wasSuspended: true, months: 3 }).toISOString()).toBe("2027-01-10T12:00:00.000Z");
  });
});
