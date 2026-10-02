import { describe, expect, it } from "vitest";
import {
  annualFreeMonths,
  annualSavingsCents,
  annualSavingsLabel,
  computeNextPeriodEnd,
  couponCycleRuleLabel,
  couponDurationLabel,
  couponIneligibleReason,
  couponSummary,
  effectiveCycle,
  initialCouponCycles,
  isValidCouponCode,
  MIN_CHARGE_CENTS,
  mrrContributionCents,
  normalizeCouponCode,
  planOffersAnnual,
  priceInvoice,
} from "@/core/billing";

const PLAN = { priceCents: 5900, annualPriceCents: 59000 };
const NO_ANNUAL = { priceCents: 5900, annualPriceCents: null };

describe("plano anual", () => {
  it("economia = 12 mensalidades menos o anual; meses grátis inteiros", () => {
    expect(annualSavingsCents(PLAN)).toBe(11800);
    expect(annualFreeMonths(PLAN)).toBe(2);
    expect(annualSavingsLabel(PLAN)).toBe("2 meses grátis");
  });

  it("economia que não fecha meses vira valor em reais", () => {
    expect(annualSavingsLabel({ priceCents: 5900, annualPriceCents: 60000 })!.replace(/\s/g, " ")).toBe("economize R$ 108,00 no ano");
  });

  it("sem anual, ou anual sem desconto: nenhuma economia", () => {
    expect(planOffersAnnual(NO_ANNUAL)).toBe(false);
    expect(annualSavingsCents(NO_ANNUAL)).toBe(0);
    expect(annualSavingsLabel(NO_ANNUAL)).toBeNull();
    expect(annualSavingsLabel({ priceCents: 5900, annualPriceCents: 70800 })).toBeNull();
  });

  it("MRR do anual é o preço anual dividido por 12", () => {
    expect(mrrContributionCents(PLAN, "ANNUAL")).toBe(4917);
    expect(mrrContributionCents(PLAN, "MONTHLY")).toBe(5900);
    expect(mrrContributionCents(NO_ANNUAL, "ANNUAL")).toBe(5900);
  });

  it("pedir anual num plano sem preço anual cai em mensal", () => {
    expect(effectiveCycle(NO_ANNUAL, "ANNUAL")).toBe("MONTHLY");
    expect(effectiveCycle(PLAN, "ANNUAL")).toBe("ANNUAL");
  });
});

describe("priceInvoice", () => {
  it("sem cupom: bruto do ciclo", () => {
    expect(priceInvoice(PLAN, "MONTHLY", null)).toEqual({ cycle: "MONTHLY", grossCents: 5900, discountCents: 0, netCents: 5900 });
    expect(priceInvoice(PLAN, "ANNUAL", null)).toEqual({ cycle: "ANNUAL", grossCents: 59000, discountCents: 0, netCents: 59000 });
  });

  it("PERCENT: desconto arredondado para baixo; líquido = bruto - desconto", () => {
    const p = priceInvoice(PLAN, "MONTHLY", { kind: "PERCENT", value: 20 });
    expect(p.discountCents).toBe(1180);
    expect(p.netCents).toBe(4720);
    expect(priceInvoice({ priceCents: 4999, annualPriceCents: null }, "MONTHLY", { kind: "PERCENT", value: 10 }).discountCents).toBe(499);
  });

  it("AMOUNT: desconta o valor fixo por fatura", () => {
    const p = priceInvoice(PLAN, "ANNUAL", { kind: "AMOUNT", value: 5000 });
    expect(p.discountCents).toBe(5000);
    expect(p.netCents).toBe(54000);
  });

  it("AMOUNT maior que a fatura nunca deixa negativo: cai no mínimo", () => {
    const p = priceInvoice(PLAN, "MONTHLY", { kind: "AMOUNT", value: 999999 });
    expect(p.netCents).toBe(MIN_CHARGE_CENTS);
    expect(p.discountCents).toBe(5900 - MIN_CHARGE_CENTS);
  });

  it("PERCENT de 100% cai no mínimo do Mercado Pago, nunca em zero", () => {
    const p = priceInvoice(PLAN, "MONTHLY", { kind: "PERCENT", value: 100 });
    expect(p.netCents).toBe(MIN_CHARGE_CENTS);
    expect(p.grossCents - p.discountCents).toBe(p.netCents);
  });

  it("fatura já no mínimo não recebe desconto", () => {
    const p = priceInvoice({ priceCents: 100, annualPriceCents: null }, "MONTHLY", { kind: "PERCENT", value: 50 });
    expect(p).toEqual({ cycle: "MONTHLY", grossCents: 100, discountCents: 0, netCents: 100 });
  });

  it("anual pedido sem preço anual cobra o mensal", () => {
    expect(priceInvoice(NO_ANNUAL, "ANNUAL", null).cycle).toBe("MONTHLY");
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

  it("ciclos iniciais: ONCE=1, N_CYCLES=N, FOREVER=nulo", () => {
    expect(initialCouponCycles("ONCE", null)).toBe(1);
    expect(initialCouponCycles("N_CYCLES", 3)).toBe(3);
    expect(initialCouponCycles("FOREVER", null)).toBeNull();
  });

  it("textos sem travessão", () => {
    const all = [couponSummary("PERCENT", 20, "ONCE", null), couponSummary("AMOUNT", 5000, "N_CYCLES", 3), couponSummary("PERCENT", 10, "FOREVER", null), couponCycleRuleLabel("ANNUAL"), couponDurationLabel("N_CYCLES", 1)];
    for (const text of all) expect(text).not.toContain("—");
    expect(couponSummary("PERCENT", 20, "ONCE", null)).toBe("20% de desconto na primeira cobrança");
    expect(couponDurationLabel("N_CYCLES", 3)).toBe("nas 3 primeiras cobranças");
  });
});

describe("couponIneligibleReason", () => {
  const base = { active: true, validFrom: null, validUntil: null, maxRedemptions: null, redemptionsCount: 0, appliesToCycle: "ANY" as const, planIds: [] };
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
    expect(couponIneligibleReason({ ...base, appliesToCycle: "ANNUAL" }, ctx)).toBe("WRONG_CYCLE");
  });
});

describe("computeNextPeriodEnd com ciclo anual", () => {
  it("anual soma 12 meses mantendo o dia-âncora", () => {
    const next = computeNextPeriodEnd({ currentPeriodEnd: new Date("2026-10-15T12:00:00Z"), wasSuspended: false, paidAt: new Date("2026-10-10T12:00:00Z"), months: 12 });
    expect(next.toISOString()).toBe("2027-10-15T12:00:00.000Z");
  });
  it("sem months continua mensal", () => {
    const next = computeNextPeriodEnd({ currentPeriodEnd: new Date("2026-10-15T12:00:00Z"), wasSuspended: false, paidAt: new Date("2026-10-10T12:00:00Z") });
    expect(next.toISOString()).toBe("2026-11-15T12:00:00.000Z");
  });
});
