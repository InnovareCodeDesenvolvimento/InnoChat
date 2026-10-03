/**
 * Migration 20261013000000 (4 ciclos + cupom com lista de ciclos) contra Postgres real: CHECKs de preço,
 * de ciclo (assinatura e fatura), de appliesToCycles, default e o backfill da coluna antiga.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getPrisma } from "@/lib/db/prisma";

const prisma = getPrisma();
const RUN = randomUUID().slice(0, 6).toUpperCase();
let seq = 0;
const uniq = (l: string) => `${l}-${RUN}-${++seq}`;
const planIds: string[] = [];
const couponIds: string[] = [];
const tenantIds: string[] = [];

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.coupon.deleteMany({ where: { id: { in: couponIds } } });
  await prisma.plan.deleteMany({ where: { id: { in: planIds } } });
  await prisma.$disconnect();
});

async function makePlan(extra: Record<string, unknown> = {}) {
  const plan = await prisma.plan.create({
    data: {
      code: uniq("it-ciclos").toLowerCase(),
      name: "Plano Ciclos IT",
      priceCents: 5900,
      maxWhatsappNumbers: 1,
      maxProfessionals: 1,
      active: false,
      sortOrder: 997,
      ...extra,
    },
  });
  planIds.push(plan.id);
  return plan;
}

async function makeCoupon(extra: Record<string, unknown> = {}) {
  const c = await prisma.coupon.create({
    data: { code: uniq("CICL"), kind: "PERCENT", value: 10, ...extra },
  });
  couponIds.push(c.id);
  return c;
}

describe("Plan: preços trimestral e semestral", () => {
  it("ficam nulos por padrão (ciclo não oferecido) e aceitam valores > 0", async () => {
    const p = await makePlan();
    expect(p.quarterlyPriceCents).toBeNull();
    expect(p.semiannualPriceCents).toBeNull();
    const q = await makePlan({ quarterlyPriceCents: 16000, semiannualPriceCents: 30000, annualPriceCents: 59000 });
    expect(q.quarterlyPriceCents).toBe(16000);
    expect(q.semiannualPriceCents).toBe(30000);
  });

  it("recusa zero e negativo", async () => {
    await expect(makePlan({ quarterlyPriceCents: 0 })).rejects.toThrow();
    await expect(makePlan({ semiannualPriceCents: 0 })).rejects.toThrow();
    await expect(makePlan({ quarterlyPriceCents: -1 })).rejects.toThrow();
    await expect(makePlan({ semiannualPriceCents: -5 })).rejects.toThrow();
  });
});

describe("ciclo da assinatura e da fatura", () => {
  it("aceita os 4 valores e recusa os demais", async () => {
    const plan = await makePlan();
    const tenant = await prisma.tenant.create({ data: { name: "T Ciclos", slug: uniq("t-ciclos").toLowerCase(), timezone: "America/Sao_Paulo" } });
    tenantIds.push(tenant.id);
    const now = new Date();
    const sub = await prisma.subscription.create({
      data: { tenantId: tenant.id, planId: plan.id, currentPeriodEnd: now },
    });
    for (const cycle of ["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL"]) {
      await prisma.subscription.update({ where: { id: sub.id }, data: { billingCycle: cycle } });
    }
    await expect(
      prisma.subscription.update({ where: { id: sub.id }, data: { billingCycle: "BIMONTHLY" } }),
    ).rejects.toThrow();

    let n = 0;
    const inv = (cycle: string) =>
      prisma.invoice.create({
        data: {
          subscriptionId: sub.id,
          amountCents: 1000,
          dueAt: now,
          periodStart: new Date(now.getTime() + ++n * 86_400_000),
          periodEnd: now,
          cycle,
        },
      });
    for (const c of ["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL"]) await inv(c);
    await expect(inv("WEEKLY")).rejects.toThrow();
  });
});

describe("Coupon.appliesToCycles", () => {
  it("default é lista vazia (todos) e a coluna antiga mantém ANY", async () => {
    const c = await makeCoupon();
    expect(c.appliesToCycles).toEqual([]);
    expect(c.appliesToCycle).toBe("ANY");
  });

  it("aceita subconjuntos dos 4 ciclos", async () => {
    const c = await makeCoupon({ appliesToCycles: ["QUARTERLY", "SEMIANNUAL"] });
    expect(c.appliesToCycles).toEqual(["QUARTERLY", "SEMIANNUAL"]);
    const all = await makeCoupon({ appliesToCycles: ["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL"] });
    expect(all.appliesToCycles).toHaveLength(4);
  });

  it("recusa elemento fora do conjunto e elemento NULL", async () => {
    await expect(makeCoupon({ appliesToCycles: ["MONTHLY", "WEEKLY"] })).rejects.toThrow();
    await expect(makeCoupon({ appliesToCycles: ["ANY"] })).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO coupons (id, code, kind, value, "appliesToCycles", "updatedAt") VALUES ('x${RUN}', 'NULL-${RUN}', 'PERCENT', 10, ARRAY['MONTHLY', NULL]::TEXT[], now())`,
      ),
    ).rejects.toThrow();
  });

  it("a coluna antiga continua válida (ANY | MONTHLY | ANNUAL)", async () => {
    const c = await makeCoupon({ appliesToCycle: "ANNUAL", appliesToCycles: ["ANNUAL"] });
    expect(c.appliesToCycle).toBe("ANNUAL");
    await expect(makeCoupon({ appliesToCycle: "QUARTERLY" })).rejects.toThrow();
  });

  it("backfill: a expressão da migration converte ANY/MONTHLY/ANNUAL", async () => {
    const rows = await prisma.$queryRawUnsafe<{ v: string; r: string[] }[]>(
      `SELECT v, CASE v WHEN 'MONTHLY' THEN ARRAY['MONTHLY'] WHEN 'ANNUAL' THEN ARRAY['ANNUAL'] ELSE ARRAY[]::TEXT[] END AS r
         FROM (VALUES ('ANY'), ('MONTHLY'), ('ANNUAL')) AS t(v)`,
    );
    const m = Object.fromEntries(rows.map((x) => [x.v, x.r]));
    expect(m).toEqual({ ANY: [], MONTHLY: ["MONTHLY"], ANNUAL: ["ANNUAL"] });
  });
});
