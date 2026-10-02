/**
 * Melhoria 6 (plano anual + cupons) contra Postgres real: resgate atômico e concorrente, cálculo da fatura
 * (ciclo, cupom, mínimo), consumo de ciclos do cupom, baixa de fatura anual (+12 meses), cadastro com cupom,
 * troca de ciclo, MRR e travas do Admin. `sendMail` é mockado.
 */
import { randomUUID } from "node:crypto";
import { addDays } from "date-fns";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";

vi.mock("@/lib/email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
  return { ...actual, sendMail: vi.fn(async () => ({ sent: true })) };
});

const { runBillingTick } = await import("@/modules/billing/tick");
const { createMockMercadoPagoGateway } = await import("@/modules/billing/mercadopago.mock");
const { applyInvoicePayment } = await import("@/modules/billing/service");
const { signUp } = await import("@/modules/signup/service");
const coupons = await import("@/modules/billing/coupons");
const { changeBillingCycle } = await import("@/modules/billing/billing-cycle");
const { updatePlan, billingMonthlyTotals } = await import("@/modules/billing/admin-service");
const { getFinanceOverview } = await import("@/modules/billing/finance-service");
const { MIN_CHARGE_CENTS } = await import("@/core/billing");

const prisma = getPrisma();
const tenantIds: string[] = [];
const userIds: string[] = [];
const couponIds: string[] = [];
const planIds: string[] = [];

const RUN = randomUUID().slice(0, 6);
let seq = 0;
const uniq = (label: string) => `${label}-${RUN}-${++seq}`;

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.coupon.deleteMany({ where: { id: { in: couponIds } } });
  await prisma.plan.deleteMany({ where: { id: { in: planIds } } });
  await prisma.$disconnect();
});

async function makePlan(over: Partial<{ priceCents: number; annualPriceCents: number | null; sortOrder: number; active: boolean }> = {}) {
  const plan = await prisma.plan.create({
    data: {
      code: uniq("it-anual-plan"),
      name: "Plano Anual IT",
      priceCents: over.priceCents ?? 5900,
      annualPriceCents: over.annualPriceCents === undefined ? 59000 : over.annualPriceCents,
      maxWhatsappNumbers: 1,
      maxProfessionals: 1,
      active: over.active ?? false,
      sortOrder: over.sortOrder ?? 998,
    },
  });
  planIds.push(plan.id);
  return plan;
}

async function makeCoupon(over: Partial<Parameters<typeof coupons.createCoupon>[0]> = {}) {
  const coupon = await coupons.createCoupon(
    {
      code: uniq("CUP").toUpperCase(),
      kind: "PERCENT",
      value: 20,
      duration: "ONCE",
      appliesToCycle: "ANY",
      ...over,
    },
    null,
  );
  couponIds.push(coupon.id);
  return coupon;
}

async function makeTenant(label: string) {
  const slug = uniq(`it-anual-${label}`);
  const tenant = await prisma.tenant.create({ data: { slug, name: `Anual ${label}`, timezone: "UTC", document: "52998224725" } });
  const user = await prisma.user.create({ data: { email: `${slug}@example.com`, passwordHash: "x", emailVerifiedAt: new Date() } });
  await prisma.membership.create({ data: { userId: user.id, tenantId: tenant.id, role: "OWNER" } });
  tenantIds.push(tenant.id);
  userIds.push(user.id);
  return tenant;
}

async function makeSubscription(
  tenantId: string,
  planId: string,
  over: Partial<{ billingCycle: string; couponId: string | null; couponCyclesRemaining: number | null; periodEnd: Date; status: "ACTIVE" | "TRIALING"; firstPaidAt: Date | null }> = {},
) {
  return prisma.subscription.create({
    data: {
      tenantId,
      planId,
      status: over.status ?? "ACTIVE",
      currentPeriodEnd: over.periodEnd ?? addDays(new Date(), 3),
      firstPaidAt: over.firstPaidAt === undefined ? new Date() : over.firstPaidAt,
      billingCycle: over.billingCycle ?? "MONTHLY",
      couponId: over.couponId ?? null,
      couponCyclesRemaining: over.couponCyclesRemaining ?? null,
    },
  });
}

async function adopt(tenantId: string, planId: string, code: string, cycle: "MONTHLY" | "ANNUAL" = "MONTHLY") {
  return prisma.$transaction((tx) => coupons.adoptCouponInTx(tx, { code, tenantId, planId, cycle, now: new Date() }));
}

/** Roda o tick só para esta assinatura: o resto da base de teste é de outros arquivos (limpos no afterAll deles). */
async function tickInvoiceFor(subscriptionId: string) {
  const { gateway } = createMockMercadoPagoGateway();
  await runBillingTick(new Date(), gateway);
  return prisma.invoice.findMany({ where: { subscriptionId }, orderBy: { periodStart: "asc" } });
}

beforeAll(async () => {
  // Garante o piso de MIN_CHARGE_CENTS esperado nos testes de cálculo.
  expect(MIN_CHARGE_CENTS).toBe(100);
});

describe("resgate atômico de cupom", () => {
  it("duas empresas disputando o ÚLTIMO uso: só uma ganha, o contador nunca passa do limite", async () => {
    const plan = await makePlan();
    const coupon = await makeCoupon({ maxRedemptions: 1 });
    const [a, b] = await Promise.all([makeTenant("race-a"), makeTenant("race-b")]);

    const results = await Promise.allSettled([adopt(a.id, plan.id, coupon.code), adopt(b.id, plan.id, coupon.code)]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as { code: string }).code).toBe("COUPON_EXHAUSTED");
    const fresh = await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } });
    expect(fresh.redemptionsCount).toBe(1);
    expect(await prisma.couponRedemption.count({ where: { couponId: coupon.id } })).toBe(1); // a transação perdedora desfez o resgate
  });

  it("muitas empresas ao mesmo tempo com limite 3: exatamente 3 entram", async () => {
    const plan = await makePlan();
    const coupon = await makeCoupon({ maxRedemptions: 3 });
    const tenants = await Promise.all(Array.from({ length: 6 }, (_, i) => makeTenant(`many-${i}`)));
    const results = await Promise.allSettled(tenants.map((t) => adopt(t.id, plan.id, coupon.code)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).redemptionsCount).toBe(3);
  });

  it("a mesma empresa não adota o mesmo cupom duas vezes (nem em paralelo)", async () => {
    const plan = await makePlan();
    const coupon = await makeCoupon();
    const tenant = await makeTenant("twice");
    const results = await Promise.allSettled([adopt(tenant.id, plan.id, coupon.code), adopt(tenant.id, plan.id, coupon.code)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as { code: string }).code).toBe("COUPON_ALREADY_USED");
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).redemptionsCount).toBe(1);
  });

  it("cupom desativado, vencido, de outro plano ou de outro ciclo é recusado com código próprio", async () => {
    const plan = await makePlan();
    const other = await makePlan();
    const tenant = await makeTenant("reject");

    const off = await makeCoupon({ active: false });
    await expect(adopt(tenant.id, plan.id, off.code)).rejects.toMatchObject({ code: "COUPON_INVALID" });

    const expired = await makeCoupon({ validFrom: new Date("2020-01-01T00:00:00Z"), validUntil: new Date("2020-02-01T00:00:00Z") });
    await expect(adopt(tenant.id, plan.id, expired.code)).rejects.toMatchObject({ code: "COUPON_EXPIRED" });

    const future = await makeCoupon({ validFrom: addDays(new Date(), 10) });
    await expect(adopt(tenant.id, plan.id, future.code)).rejects.toMatchObject({ code: "COUPON_NOT_STARTED" });

    const onlyOther = await makeCoupon({ planIds: [other.id] });
    await expect(adopt(tenant.id, plan.id, onlyOther.code)).rejects.toMatchObject({ code: "COUPON_WRONG_PLAN" });

    const annualOnly = await makeCoupon({ appliesToCycle: "ANNUAL" });
    await expect(adopt(tenant.id, plan.id, annualOnly.code, "MONTHLY")).rejects.toMatchObject({ code: "COUPON_WRONG_CYCLE" });

    await expect(adopt(tenant.id, plan.id, "NAO-EXISTE-XYZ")).rejects.toMatchObject({ code: "COUPON_INVALID" });
    // Nada disso gastou uso.
    for (const c of [off, expired, future, onlyOther, annualOnly]) {
      expect((await prisma.coupon.findUniqueOrThrow({ where: { id: c.id } })).redemptionsCount).toBe(0);
    }
  });
});

describe("fatura gerada pelo tick: ciclo e cupom", () => {
  it("anual: 1 fatura de 12 meses com o preço anual, cycle ANNUAL e periodEnd 12 meses depois", async () => {
    const plan = await makePlan({ priceCents: 5900, annualPriceCents: 59000 });
    const tenant = await makeTenant("annual-inv");
    const sub = await makeSubscription(tenant.id, plan.id, { billingCycle: "ANNUAL" });

    const invoices = await tickInvoiceFor(sub.id);
    expect(invoices).toHaveLength(1);
    const inv = invoices[0]!;
    expect(inv.cycle).toBe("ANNUAL");
    expect(inv.amountCents).toBe(59000);
    expect(inv.discountCents).toBe(0);
    expect(inv.couponCode).toBeNull();
    expect(inv.periodStart.getTime()).toBe(sub.currentPeriodEnd.getTime());
    const expectedEnd = new Date(sub.currentPeriodEnd);
    expectedEnd.setMonth(expectedEnd.getMonth() + 12);
    expect(inv.periodEnd.getTime()).toBe(expectedEnd.getTime());

    // Rodar de novo não duplica.
    expect(await tickInvoiceFor(sub.id)).toHaveLength(1);
  });

  it("mensal continua 1 mês e preço mensal", async () => {
    const plan = await makePlan();
    const tenant = await makeTenant("monthly-inv");
    const sub = await makeSubscription(tenant.id, plan.id);
    const [inv] = await tickInvoiceFor(sub.id);
    expect(inv!.cycle).toBe("MONTHLY");
    expect(inv!.amountCents).toBe(5900);
    const expectedEnd = new Date(sub.currentPeriodEnd);
    expectedEnd.setMonth(expectedEnd.getMonth() + 1);
    expect(inv!.periodEnd.getTime()).toBe(expectedEnd.getTime());
  });

  it("anual pedido num plano sem preço anual cai em mensal (admin tirou o preço depois)", async () => {
    const plan = await makePlan({ annualPriceCents: null });
    const tenant = await makeTenant("annual-removed");
    const sub = await makeSubscription(tenant.id, plan.id, { billingCycle: "ANNUAL" });
    const [inv] = await tickInvoiceFor(sub.id);
    expect(inv!.cycle).toBe("MONTHLY");
    expect(inv!.amountCents).toBe(5900);
  });

  it("cupom ONCE: desconta na 1ª fatura, grava snapshots, limpa couponId e cyclesRemaining juntos", async () => {
    const plan = await makePlan();
    const coupon = await makeCoupon({ kind: "PERCENT", value: 20, duration: "ONCE" });
    const tenant = await makeTenant("once");
    const adopted = await adopt(tenant.id, plan.id, coupon.code);
    const sub = await makeSubscription(tenant.id, plan.id, { couponId: adopted.couponId, couponCyclesRemaining: adopted.cyclesRemaining });

    const [inv] = await tickInvoiceFor(sub.id);
    expect(inv!.amountCents).toBe(4720);
    expect(inv!.discountCents).toBe(1180);
    expect(inv!.amountCents + inv!.discountCents).toBe(5900); // bruto = líquido + desconto
    expect(inv!.couponCode).toBe(coupon.code);
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.couponId).toBeNull();
    expect(after.couponCyclesRemaining).toBeNull();
    const redemption = await prisma.couponRedemption.findUniqueOrThrow({ where: { couponId_tenantId: { couponId: coupon.id, tenantId: tenant.id } } });
    expect(redemption.invoiceId).toBe(inv!.id);
    expect(redemption.discountCents).toBe(1180);
  });

  it("cupom N_CYCLES (3): decrementa a cada fatura e só zera na terceira; FOREVER nunca decrementa", async () => {
    const plan = await makePlan();
    const three = await makeCoupon({ kind: "AMOUNT", value: 1000, duration: "N_CYCLES", durationCycles: 3 });
    const tenant = await makeTenant("ncycles");
    const adopted = await adopt(tenant.id, plan.id, three.code);
    expect(adopted.cyclesRemaining).toBe(3);
    const sub = await makeSubscription(tenant.id, plan.id, { couponId: adopted.couponId, couponCyclesRemaining: 3 });

    const { gateway } = createMockMercadoPagoGateway();
    const { createInvoiceForPeriodTracked } = await import("@/modules/billing/service");
    const { loadInvoiceCharge } = await import("@/modules/billing/coupons");
    const remaining: Array<number | null> = [];
    for (let i = 0; i < 3; i += 1) {
      const current = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      const charge = await loadInvoiceCharge(current, plan);
      expect(charge.discountCents).toBe(1000);
      const periodStart = new Date(Date.UTC(2031, i, 1));
      await createInvoiceForPeriodTracked({
        subscriptionId: sub.id,
        amountCents: charge.netCents,
        charge,
        periodStart,
        periodEnd: new Date(Date.UTC(2031, i + 1, 1)),
        dueAt: periodStart,
        payerEmail: "x@example.com",
        description: "teste",
        gateway,
      });
      remaining.push((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).couponCyclesRemaining);
    }
    expect(remaining).toEqual([2, 1, null]);
    const final = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(final.couponId).toBeNull();
    expect(await prisma.invoice.count({ where: { subscriptionId: sub.id, discountCents: 1000 } })).toBe(3);
    // A 4ª fatura já sai sem desconto.
    const charge4 = await loadInvoiceCharge(final, plan);
    expect(charge4.discountCents).toBe(0);
    // Adoção continua sendo UM resgate, não três.
    expect(await prisma.couponRedemption.count({ where: { couponId: three.id } })).toBe(1);

    const forever = await makeCoupon({ kind: "PERCENT", value: 10, duration: "FOREVER" });
    const t2 = await makeTenant("forever");
    const a2 = await adopt(t2.id, plan.id, forever.code);
    expect(a2.cyclesRemaining).toBeNull();
    const sub2 = await makeSubscription(t2.id, plan.id, { couponId: a2.couponId, couponCyclesRemaining: null });
    const [inv2] = await tickInvoiceFor(sub2.id);
    expect(inv2!.discountCents).toBe(590);
    const after2 = await prisma.subscription.findUniqueOrThrow({ where: { id: sub2.id } });
    expect(after2.couponId).toBe(forever.id);
    expect(after2.couponCyclesRemaining).toBeNull();
  });

  it("AMOUNT maior que a fatura nunca deixa negativo: cobra o mínimo", async () => {
    const plan = await makePlan({ priceCents: 3000, annualPriceCents: null });
    const coupon = await makeCoupon({ kind: "AMOUNT", value: 999_999, duration: "ONCE" });
    const tenant = await makeTenant("floor");
    const adopted = await adopt(tenant.id, plan.id, coupon.code);
    const sub = await makeSubscription(tenant.id, plan.id, { couponId: adopted.couponId, couponCyclesRemaining: 1 });
    const [inv] = await tickInvoiceFor(sub.id);
    expect(inv!.amountCents).toBe(MIN_CHARGE_CENTS);
    expect(inv!.discountCents).toBe(3000 - MIN_CHARGE_CENTS);
  });

  it("cupom só do plano mensal não desconta (nem gasta ciclo) quando a assinatura está no anual", async () => {
    const plan = await makePlan();
    const coupon = await makeCoupon({ appliesToCycle: "MONTHLY", duration: "N_CYCLES", durationCycles: 2 });
    const tenant = await makeTenant("paused");
    const adopted = await adopt(tenant.id, plan.id, coupon.code, "MONTHLY");
    const sub = await makeSubscription(tenant.id, plan.id, { billingCycle: "ANNUAL", couponId: adopted.couponId, couponCyclesRemaining: 2 });
    const [inv] = await tickInvoiceFor(sub.id);
    expect(inv!.cycle).toBe("ANNUAL");
    expect(inv!.discountCents).toBe(0);
    expect(inv!.amountCents).toBe(59000);
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.couponId).toBe(coupon.id);
    expect(after.couponCyclesRemaining).toBe(2);
  });

  it("cupom desativado DEPOIS da adoção continua descontando até acabar", async () => {
    const plan = await makePlan();
    const coupon = await makeCoupon({ duration: "N_CYCLES", durationCycles: 2 });
    const tenant = await makeTenant("deactivated-after");
    const adopted = await adopt(tenant.id, plan.id, coupon.code);
    const sub = await makeSubscription(tenant.id, plan.id, { couponId: adopted.couponId, couponCyclesRemaining: 2 });
    await coupons.setCouponActive(coupon.id, false);
    const [inv] = await tickInvoiceFor(sub.id);
    expect(inv!.discountCents).toBe(1180);
  });
});

describe("baixa de fatura anual", () => {
  it("fatura ANNUAL paga avança currentPeriodEnd em 12 meses; mensal continua 1", async () => {
    const plan = await makePlan();
    const tenant = await makeTenant("pay-annual");
    const sub = await makeSubscription(tenant.id, plan.id, { billingCycle: "ANNUAL" });
    const [inv] = await tickInvoiceFor(sub.id);
    expect(inv!.cycle).toBe("ANNUAL");

    await applyInvoicePayment(inv!.id, new Date(), "mp-it-anual-1");
    const paid = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    const expected = new Date(sub.currentPeriodEnd);
    expected.setMonth(expected.getMonth() + 12);
    expect(paid.currentPeriodEnd.getTime()).toBe(expected.getTime());
    // Idempotente: o mesmo pagamento de novo não soma outro ano.
    await applyInvoicePayment(inv!.id, new Date(), "mp-it-anual-1");
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).currentPeriodEnd.getTime()).toBe(expected.getTime());

    const t2 = await makeTenant("pay-monthly");
    const sub2 = await makeSubscription(t2.id, plan.id);
    const [inv2] = await tickInvoiceFor(sub2.id);
    await applyInvoicePayment(inv2!.id, new Date(), "mp-it-anual-2");
    const paid2 = await prisma.subscription.findUniqueOrThrow({ where: { id: sub2.id } });
    const expected2 = new Date(sub2.currentPeriodEnd);
    expected2.setMonth(expected2.getMonth() + 1);
    expect(paid2.currentPeriodEnd.getTime()).toBe(expected2.getTime());
  });

  it("trocar o ciclo da assinatura DEPOIS de emitida a fatura não muda o que a fatura já emitida cobre", async () => {
    const plan = await makePlan();
    const tenant = await makeTenant("switch-after");
    const sub = await makeSubscription(tenant.id, plan.id); // mensal
    const [inv] = await tickInvoiceFor(sub.id);
    const result = await changeBillingCycle(tenant.id, "ANNUAL");
    expect(result.openInvoiceKeepsOldCycle).toBe(true);
    await applyInvoicePayment(inv!.id, new Date(), "mp-it-anual-3");
    const paid = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    const expected = new Date(sub.currentPeriodEnd);
    expected.setMonth(expected.getMonth() + 1); // a fatura era mensal
    expect(paid.currentPeriodEnd.getTime()).toBe(expected.getTime());
    expect(paid.billingCycle).toBe("ANNUAL");
  });
});

describe("troca de ciclo pelo dono", () => {
  it("recusa anual quando o plano não tem preço anual; aceita quando tem", async () => {
    const noAnnual = await makePlan({ annualPriceCents: null });
    const t1 = await makeTenant("cycle-no");
    await makeSubscription(t1.id, noAnnual.id);
    await expect(changeBillingCycle(t1.id, "ANNUAL")).rejects.toMatchObject({ code: "ANNUAL_NOT_AVAILABLE" });

    const plan = await makePlan();
    const t2 = await makeTenant("cycle-yes");
    await makeSubscription(t2.id, plan.id);
    const ok = await changeBillingCycle(t2.id, "ANNUAL");
    expect(ok).toMatchObject({ billingCycle: "ANNUAL", openInvoiceKeepsOldCycle: false, couponPaused: false });
    expect((await prisma.subscription.findUniqueOrThrow({ where: { tenantId: t2.id } })).billingCycle).toBe("ANNUAL");
  });

  it("avisa quando o cupom em uso não vale no ciclo novo", async () => {
    const plan = await makePlan();
    const coupon = await makeCoupon({ appliesToCycle: "MONTHLY" });
    const tenant = await makeTenant("cycle-coupon");
    const adopted = await adopt(tenant.id, plan.id, coupon.code);
    await makeSubscription(tenant.id, plan.id, { couponId: adopted.couponId, couponCyclesRemaining: 1 });
    expect((await changeBillingCycle(tenant.id, "ANNUAL")).couponPaused).toBe(true);
  });
});

describe("aplicar cupom pela tela Assinatura", () => {
  it("aplica, grava na assinatura e recusa um segundo cupom e o mesmo cupom de novo", async () => {
    const plan = await makePlan();
    const c1 = await makeCoupon({ duration: "N_CYCLES", durationCycles: 2 });
    const c2 = await makeCoupon();
    const tenant = await makeTenant("apply");
    await makeSubscription(tenant.id, plan.id);

    const preview = await coupons.applyCouponToSubscription(tenant.id, ` ${c1.code.toLowerCase()} `);
    expect(preview.pricing.netCents).toBe(4720);
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    expect(sub.couponId).toBe(c1.id);
    expect(sub.couponCyclesRemaining).toBe(2);

    await expect(coupons.applyCouponToSubscription(tenant.id, c2.code)).rejects.toMatchObject({ code: "COUPON_ALREADY_APPLIED" });
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: c2.id } })).redemptionsCount).toBe(0);
  });

  it("duas abas aplicando ao mesmo tempo: só uma grava", async () => {
    const plan = await makePlan();
    const a = await makeCoupon();
    const b = await makeCoupon();
    const tenant = await makeTenant("apply-race");
    await makeSubscription(tenant.id, plan.id);
    const results = await Promise.allSettled([coupons.applyCouponToSubscription(tenant.id, a.code), coupons.applyCouponToSubscription(tenant.id, b.code)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const used = await prisma.coupon.findMany({ where: { id: { in: [a.id, b.id] } } });
    expect(used.reduce((n, c) => n + c.redemptionsCount, 0)).toBe(1); // o perdedor desfez o uso
  });
});

describe("cadastro com plano anual e cupom", () => {
  it("a fatura do fim do teste já sai anual e com o cupom; resgate e snapshots gravados", async () => {
    // Plano mais "barato" na ordem: é o que o cadastro assume.
    const plan = await makePlan({ sortOrder: -5000, active: true });
    const coupon = await makeCoupon({ kind: "PERCENT", value: 10, duration: "ONCE", appliesToCycle: "ANNUAL" });
    const slug = uniq("it-anual-signup");
    const { gateway } = createMockMercadoPagoGateway();
    const result = await signUp(
      { companyName: "Cadastro Anual", slug, segment: null, ownerName: "Dona", email: `${slug}@example.com`, password: "senha-forte-123", document: "529.982.247-25", termsVersion: "v1", billingCycle: "ANNUAL", couponCode: coupon.code.toLowerCase() },
      gateway,
    );
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: result.tenantSlug } });
    tenantIds.push(tenant.id);
    userIds.push(result.userId);

    const sub = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    expect(sub.planId).toBe(plan.id);
    expect(sub.billingCycle).toBe("ANNUAL");
    expect(sub.couponId).toBeNull(); // ONCE: já gasto na fatura do teste
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    expect(invoice.cycle).toBe("ANNUAL");
    expect(invoice.amountCents).toBe(53100);
    expect(invoice.discountCents).toBe(5900);
    expect(invoice.couponCode).toBe(coupon.code);
    expect(invoice.isTrialConversion).toBe(true);
    const redemption = await prisma.couponRedemption.findUniqueOrThrow({ where: { couponId_tenantId: { couponId: coupon.id, tenantId: tenant.id } } });
    expect(redemption.invoiceId).toBe(invoice.id);

    // Pagar a fatura anual do teste soma 12 meses ao fim do teste.
    await applyInvoicePayment(invoice.id, new Date(), "mp-it-anual-signup");
    const paid = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    const expected = new Date(sub.currentPeriodEnd);
    expected.setMonth(expected.getMonth() + 12);
    expect(paid.currentPeriodEnd.getTime()).toBe(expected.getTime());
  });

  it("cupom inválido derruba o cadastro inteiro (nada fica pela metade)", async () => {
    await makePlan({ sortOrder: -5001, active: true });
    const slug = uniq("it-anual-signup-bad");
    const { gateway } = createMockMercadoPagoGateway();
    await expect(
      signUp({ companyName: "Cadastro Ruim", slug, segment: null, ownerName: "Dona", email: `${slug}@example.com`, password: "senha-forte-123", document: "529.982.247-25", termsVersion: "v1", couponCode: "NAO-EXISTE-ABC" }, gateway),
    ).rejects.toMatchObject({ code: "COUPON_INVALID" });
    expect(await prisma.tenant.count({ where: { slug } })).toBe(0);
    expect(await prisma.user.count({ where: { email: `${slug}@example.com` } })).toBe(0);
  });

  it("ciclo anual num plano sem preço anual é recusado", async () => {
    await makePlan({ sortOrder: -5002, active: true, annualPriceCents: null });
    const slug = uniq("it-anual-signup-noannual");
    const { gateway } = createMockMercadoPagoGateway();
    await expect(
      signUp({ companyName: "Sem Anual", slug, segment: null, ownerName: "Dona", email: `${slug}@example.com`, password: "senha-forte-123", document: "529.982.247-25", termsVersion: "v1", billingCycle: "ANNUAL" }, gateway),
    ).rejects.toMatchObject({ code: "INVALID_CYCLE" });
  });
});

describe("Admin: cupons e preço anual", () => {
  it("valida código, valores e duração", async () => {
    await expect(coupons.createCoupon({ code: "a b", kind: "PERCENT", value: 10, duration: "ONCE", appliesToCycle: "ANY" }, null)).rejects.toMatchObject({ code: "INVALID_COUPON_CODE" });
    await expect(coupons.createCoupon({ code: uniq("BAD").toUpperCase(), kind: "PERCENT", value: 101, duration: "ONCE", appliesToCycle: "ANY" }, null)).rejects.toMatchObject({ code: "INVALID_COUPON" });
    await expect(coupons.createCoupon({ code: uniq("BAD").toUpperCase(), kind: "PERCENT", value: 10, duration: "N_CYCLES", appliesToCycle: "ANY" }, null)).rejects.toMatchObject({ code: "INVALID_COUPON" });
    await expect(coupons.createCoupon({ code: uniq("BAD").toUpperCase(), kind: "PERCENT", value: 10, duration: "ONCE", durationCycles: 3, appliesToCycle: "ANY" }, null)).rejects.toMatchObject({ code: "INVALID_COUPON" });
  });

  it("código duplicado (mesmo em minúsculas) é recusado; código é gravado em maiúsculas", async () => {
    const c = await makeCoupon();
    expect(c.code).toBe(c.code.toUpperCase());
    await expect(coupons.createCoupon({ code: c.code.toLowerCase(), kind: "PERCENT", value: 10, duration: "ONCE", appliesToCycle: "ANY" }, null)).rejects.toMatchObject({ code: "COUPON_CODE_TAKEN" });
  });

  it("depois de usado, tipo/valor/duração/ciclo travam; prazo, limite e planos ainda mudam", async () => {
    const plan = await makePlan();
    const c = await makeCoupon();
    const tenant = await makeTenant("locked");
    await adopt(tenant.id, plan.id, c.code);
    const same = { kind: "PERCENT" as const, value: 20, duration: "ONCE" as const, appliesToCycle: "ANY" as const };
    await expect(coupons.updateCoupon(c.id, { ...same, value: 30 })).rejects.toMatchObject({ code: "COUPON_LOCKED" });
    await expect(coupons.updateCoupon(c.id, { ...same, maxRedemptions: 0 })).rejects.toMatchObject({ code: "INVALID_COUPON" });
    const updated = await coupons.updateCoupon(c.id, { ...same, maxRedemptions: 10, validUntil: addDays(new Date(), 30), planIds: [plan.id], description: "novo" });
    expect(updated.maxRedemptions).toBe(10);
    expect(await prisma.couponPlan.count({ where: { couponId: c.id } })).toBe(1);
    await expect(coupons.updateCoupon(c.id, { ...same, maxRedemptions: 0 })).rejects.toBeTruthy();
  });

  it("listagem é paginada e filtra por situação e busca; resgates também", async () => {
    const plan = await makePlan();
    const marker = uniq("LST").toUpperCase();
    const on = await makeCoupon({ code: `${marker}-A` });
    const off = await makeCoupon({ code: `${marker}-B`, active: false });
    const tenant = await makeTenant("list");
    await adopt(tenant.id, plan.id, on.code);

    const all = await coupons.listCoupons({ search: marker, pageSize: 10 });
    expect(all.totalItems).toBe(2);
    expect(all.items.map((i) => i.code).sort()).toEqual([`${marker}-A`, `${marker}-B`]);
    const onlyOff = await coupons.listCoupons({ search: marker, status: "inactive" });
    expect(onlyOff.items.map((i) => i.id)).toEqual([off.id]);
    expect(onlyOff.items[0]!.state).toBe("INACTIVE");
    const page2 = await coupons.listCoupons({ search: marker, pageSize: 10, page: 99 });
    expect(page2.page).toBe(1); // fora do intervalo devolve a última página válida

    const redemptions = await coupons.listCouponRedemptions(on.id, { pageSize: 10 });
    expect(redemptions.totalItems).toBe(1);
    expect(redemptions.items[0]!.tenantId).toBe(tenant.id);
  });

  it("updatePlan valida o preço anual (mínimo e no máximo 12 mensalidades) e aceita null", async () => {
    const plan = await makePlan({ priceCents: 5900, annualPriceCents: null });
    await expect(updatePlan(plan.id, { annualPriceCents: 50 })).rejects.toMatchObject({ code: "INVALID_ANNUAL_PRICE" });
    await expect(updatePlan(plan.id, { annualPriceCents: 5900 * 12 + 1 })).rejects.toMatchObject({ code: "INVALID_ANNUAL_PRICE" });
    expect((await updatePlan(plan.id, { annualPriceCents: 59000 })).annualPriceCents).toBe(59000);
    expect((await updatePlan(plan.id, { annualPriceCents: null })).annualPriceCents).toBeNull();
  });
});

describe("MRR e renovações respeitam o anual", () => {
  it("MRR conta o anual como preço anual / 12 (Financeiro e Admin Cobrança)", async () => {
    const before = (await getFinanceOverview()).mrrCents;
    const beforeBilling = (await billingMonthlyTotals()).mrrCents;
    const plan = await makePlan({ priceCents: 5900, annualPriceCents: 59000 });
    const monthlyTenant = await makeTenant("mrr-m");
    const annualTenant = await makeTenant("mrr-a");
    await makeSubscription(monthlyTenant.id, plan.id, { periodEnd: addDays(new Date(), 20) });
    await makeSubscription(annualTenant.id, plan.id, { billingCycle: "ANNUAL", periodEnd: addDays(new Date(), 20) });

    const after = await getFinanceOverview();
    expect(after.mrrCents - before).toBe(5900 + 4917);
    expect((await billingMonthlyTotals()).mrrCents - beforeBilling).toBe(5900 + 4917);
    // Renovação é caixa: o anual entra pelo valor cheio do ano nos próximos 30 dias.
    expect(after.upcoming.next30.cents).toBeGreaterThanOrEqual(5900 + 59000);
  });
});
