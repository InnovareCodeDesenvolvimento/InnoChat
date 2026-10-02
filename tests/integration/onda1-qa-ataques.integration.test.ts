/**
 * Ataques de QA da Onda 1 (cupons) contra Postgres real: bordas exatas de validade, código com curinga/injeção,
 * enumeração de códigos pela mensagem e escopo do "já usou" por empresa. Complementa
 * `billing-annual-coupons.integration.test.ts` (que já cobre a disputa do último uso e a adoção em paralelo).
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getPrisma } from "@/lib/db/prisma";

const coupons = await import("@/modules/billing/coupons");

const prisma = getPrisma();
const RUN = randomUUID().slice(0, 6).toUpperCase();
const couponIds: string[] = [];
const planIds: string[] = [];
const tenantIds: string[] = [];

afterAll(async () => {
  await prisma.couponRedemption.deleteMany({ where: { couponId: { in: couponIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.coupon.deleteMany({ where: { id: { in: couponIds } } });
  await prisma.plan.deleteMany({ where: { id: { in: planIds } } });
  await prisma.$disconnect();
});

async function makePlan() {
  const plan = await prisma.plan.create({
    data: { code: `it-ata-${RUN.toLowerCase()}-${planIds.length}`, name: "Plano Ataque IT", priceCents: 10000, annualPriceCents: 100000, maxWhatsappNumbers: 1, maxProfessionals: 1, active: false, sortOrder: 995 },
  });
  planIds.push(plan.id);
  return plan;
}

let n = 0;
async function makeCoupon(over: Record<string, unknown> = {}) {
  const c = await prisma.coupon.create({
    data: { code: `ITATK${RUN}${++n}`, kind: "PERCENT", value: 10, duration: "ONCE", appliesToCycle: "ANY", active: true, ...over },
  });
  couponIds.push(c.id);
  return c;
}

const rejects = (p: Promise<unknown>) => p.then(() => null, (e: { code?: string }) => e.code ?? "ERRO_SEM_CODIGO");

describe("bordas exatas de validade do cupom", () => {
  it("vale até o último milissegundo de validUntil e deixa de valer 1 ms depois", async () => {
    const plan = await makePlan();
    const until = new Date("2030-06-15T02:59:59.999Z");
    const c = await makeCoupon({ validUntil: until });
    const ok = await coupons.previewCoupon({ code: c.code, planId: plan.id, cycle: "MONTHLY", now: until });
    expect(ok.pricing.netCents).toBe(9000);
    expect(await rejects(coupons.previewCoupon({ code: c.code, planId: plan.id, cycle: "MONTHLY", now: new Date(until.getTime() + 1) }))).toBe("COUPON_EXPIRED");
  });

  it("começa a valer exatamente em validFrom e não 1 ms antes", async () => {
    const plan = await makePlan();
    const from = new Date("2030-06-15T03:00:00.000Z");
    const c = await makeCoupon({ validFrom: from });
    expect(await rejects(coupons.previewCoupon({ code: c.code, planId: plan.id, cycle: "MONTHLY", now: new Date(from.getTime() - 1) }))).not.toBeNull();
    const ok = await coupons.previewCoupon({ code: c.code, planId: plan.id, cycle: "MONTHLY", now: from });
    expect(ok.coupon.code).toBe(c.code);
  });

  it("no limite: com maxRedemptions = redemptionsCount - 1 já é recusado, com folga de 1 ainda passa", async () => {
    const plan = await makePlan();
    const full = await makeCoupon({ maxRedemptions: 2, redemptionsCount: 2 });
    const one = await makeCoupon({ maxRedemptions: 2, redemptionsCount: 1 });
    expect(await rejects(coupons.previewCoupon({ code: full.code, planId: plan.id, cycle: "MONTHLY" }))).not.toBeNull();
    expect((await coupons.previewCoupon({ code: one.code, planId: plan.id, cycle: "MONTHLY" })).coupon.code).toBe(one.code);
  });
});

describe("código de cupom hostil", () => {
  it("espaços e minúsculas normalizam; curinga, aspas e SQL nunca casam com outro cupom", async () => {
    const plan = await makePlan();
    const c = await makeCoupon();
    const viaSpaces = await coupons.previewCoupon({ code: `  ${c.code.toLowerCase()}  `, planId: plan.id, cycle: "MONTHLY" });
    expect(viaSpaces.coupon.code).toBe(c.code);
    for (const hostile of [`ITATK${RUN}%`, `ITATK${RUN}_`, "%", "' OR '1'='1", `${c.code}'; DROP TABLE coupons;--`, "A".repeat(500), "<script>alert(1)</script>", "\u0000"]) {
      const code = await rejects(coupons.previewCoupon({ code: hostile, planId: plan.id, cycle: "MONTHLY" }));
      expect(code, JSON.stringify(hostile).slice(0, 40)).toBe("COUPON_INVALID");
    }
    expect(await prisma.coupon.count({ where: { id: c.id } })).toBe(1);
  });

  it("não existe e desativado dão a MESMA resposta (a tela pública não enumera códigos)", async () => {
    const plan = await makePlan();
    const off = await makeCoupon({ active: false });
    const a = await coupons.previewCoupon({ code: off.code, planId: plan.id, cycle: "MONTHLY" }).catch((e: Error & { code?: string }) => ({ code: e.code, message: e.message }));
    const b = await coupons.previewCoupon({ code: `NAOEXISTE${RUN}`, planId: plan.id, cycle: "MONTHLY" }).catch((e: Error & { code?: string }) => ({ code: e.code, message: e.message }));
    expect(a).toEqual(b);
  });
});

describe("'já usou' é por empresa", () => {
  it("a empresa que já adotou é avisada; outra empresa ainda pode ver o mesmo cupom válido", async () => {
    const plan = await makePlan();
    const c = await makeCoupon({ maxRedemptions: 10 });
    const mk = async (label: string) => {
      const t = await prisma.tenant.create({ data: { slug: `it-ata-${label}-${RUN.toLowerCase()}`, name: `Ataque ${label}`, timezone: "UTC" } });
      tenantIds.push(t.id);
      return t;
    };
    const a = await mk("a");
    const b = await mk("b");
    await prisma.couponRedemption.create({ data: { couponId: c.id, tenantId: a.id } });
    expect(await rejects(coupons.previewCoupon({ code: c.code, planId: plan.id, cycle: "MONTHLY", tenantId: a.id }))).toBe("COUPON_ALREADY_USED");
    expect((await coupons.previewCoupon({ code: c.code, planId: plan.id, cycle: "MONTHLY", tenantId: b.id })).coupon.code).toBe(c.code);
  });
});
