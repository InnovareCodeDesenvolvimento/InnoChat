/**
 * Quatro ciclos (mensal, trimestral, semestral, anual) contra Postgres real: fatura de cada ciclo com e sem cupom,
 * decremento de cupom por FATURA, cupom por lista de ciclos, plano que deixou de oferecer o ciclo, troca de ciclo,
 * baixa que avança 1/3/6/12 meses pelo ciclo da FATURA, reativação, cadastro (senha e Google), bloqueio de apagar
 * preço com assinatura ativa, MRR do Financeiro e do Admin Cobrança e o texto da régua. `sendMail` é mockado.
 */
import { randomUUID } from "node:crypto";
import { addDays, addMonths } from "date-fns";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";

vi.mock("@/lib/email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
  return { ...actual, sendMail: vi.fn(async () => ({ sent: true })) };
});

const { runBillingTick } = await import("@/modules/billing/tick");
const { createMockMercadoPagoGateway } = await import("@/modules/billing/mercadopago.mock");
const { applyInvoicePayment, createInvoiceForPeriodTracked } = await import("@/modules/billing/service");
const { signUp, signUpWithGoogle } = await import("@/modules/signup/service");
const coupons = await import("@/modules/billing/coupons");
const { changeBillingCycle } = await import("@/modules/billing/billing-cycle");
const { updatePlan, billingMonthlyTotals, liveCycleUsageByPlan, listInvoicesAdmin } = await import("@/modules/billing/admin-service");
const { getFinanceOverview } = await import("@/modules/billing/finance-service");
const { buildInvoicesCsv } = await import("@/modules/billing/finance-csv");
const { startReactivation } = await import("@/modules/billing/cancellation");
const { loadDunningSubject } = await import("@/modules/billing/dunning/snapshot");
const { buildNoticeCopyContext } = await import("@/modules/billing/dunning/context");
const { buildWhatsappMessages } = await import("@/core/billing");

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

type Prices = { priceCents: number; quarterlyPriceCents: number | null; semiannualPriceCents: number | null; annualPriceCents: number | null };
const FULL: Prices = { priceCents: 5900, quarterlyPriceCents: 16800, semiannualPriceCents: 31900, annualPriceCents: 59000 };

async function makePlan(over: Partial<Prices & { sortOrder: number; active: boolean }> = {}) {
  const plan = await prisma.plan.create({
    data: {
      code: uniq("it-ciclos-plan"),
      name: "Plano Ciclos IT",
      priceCents: over.priceCents ?? FULL.priceCents,
      quarterlyPriceCents: over.quarterlyPriceCents === undefined ? FULL.quarterlyPriceCents : over.quarterlyPriceCents,
      semiannualPriceCents: over.semiannualPriceCents === undefined ? FULL.semiannualPriceCents : over.semiannualPriceCents,
      annualPriceCents: over.annualPriceCents === undefined ? FULL.annualPriceCents : over.annualPriceCents,
      maxWhatsappNumbers: 1,
      maxProfessionals: 1,
      active: over.active ?? false,
      sortOrder: over.sortOrder ?? 997,
    },
  });
  planIds.push(plan.id);
  return plan;
}

async function makeCoupon(over: Partial<Parameters<typeof coupons.createCoupon>[0]> = {}) {
  const coupon = await coupons.createCoupon({ code: uniq("CIC").toUpperCase(), kind: "PERCENT", value: 20, duration: "ONCE", ...over }, null);
  couponIds.push(coupon.id);
  return coupon;
}

async function makeTenant(label: string) {
  const slug = uniq(`it-ciclos-${label}`);
  const tenant = await prisma.tenant.create({ data: { slug, name: `Ciclos ${label}`, timezone: "UTC", document: "52998224725" } });
  const user = await prisma.user.create({ data: { email: `${slug}@example.com`, passwordHash: "x", emailVerifiedAt: new Date() } });
  await prisma.membership.create({ data: { userId: user.id, tenantId: tenant.id, role: "OWNER" } });
  tenantIds.push(tenant.id);
  userIds.push(user.id);
  return tenant;
}

async function makeSubscription(
  tenantId: string,
  planId: string,
  over: Partial<{ billingCycle: string; couponId: string | null; couponCyclesRemaining: number | null; periodEnd: Date; status: "ACTIVE" | "TRIALING" | "CANCELED"; firstPaidAt: Date | null }> = {},
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
      ...(over.status === "CANCELED" ? { canceledAt: new Date() } : {}),
    },
  });
}

async function adopt(tenantId: string, planId: string, code: string, cycle: "MONTHLY" | "QUARTERLY" | "SEMIANNUAL" | "ANNUAL" = "MONTHLY") {
  return prisma.$transaction((tx) => coupons.adoptCouponInTx(tx, { code, tenantId, planId, cycle, now: new Date() }));
}

async function tickInvoiceFor(subscriptionId: string) {
  const { gateway } = createMockMercadoPagoGateway();
  await runBillingTick(new Date(), gateway);
  return prisma.invoice.findMany({ where: { subscriptionId }, orderBy: { periodStart: "asc" } });
}

const CYCLES = [
  { cycle: "QUARTERLY", months: 3, price: 16800 },
  { cycle: "SEMIANNUAL", months: 6, price: 31900 },
  { cycle: "ANNUAL", months: 12, price: 59000 },
] as const;

describe.each(CYCLES)("fatura do tick no ciclo $cycle", ({ cycle, months, price }) => {
  it("1 fatura com o preço do período, ciclo gravado e periodEnd N meses depois (sem duplicar)", async () => {
    const plan = await makePlan();
    const tenant = await makeTenant(`inv-${cycle}`);
    const sub = await makeSubscription(tenant.id, plan.id, { billingCycle: cycle });
    const invoices = await tickInvoiceFor(sub.id);
    expect(invoices).toHaveLength(1);
    const inv = invoices[0]!;
    expect(inv.cycle).toBe(cycle);
    expect(inv.amountCents).toBe(price);
    expect(inv.discountCents).toBe(0);
    expect(inv.periodStart.getTime()).toBe(sub.currentPeriodEnd.getTime());
    expect(inv.periodEnd.getTime()).toBe(addMonths(sub.currentPeriodEnd, months).getTime());
    expect(await tickInvoiceFor(sub.id)).toHaveLength(1);
  });

  it("com cupom de 20% desconta sobre o preço do período, e o líquido + desconto fecha o bruto", async () => {
    const plan = await makePlan();
    const coupon = await makeCoupon({ kind: "PERCENT", value: 20 });
    const tenant = await makeTenant(`cup-${cycle}`);
    const adopted = await adopt(tenant.id, plan.id, coupon.code, cycle);
    const sub = await makeSubscription(tenant.id, plan.id, { billingCycle: cycle, couponId: adopted.couponId, couponCyclesRemaining: adopted.cyclesRemaining });
    const [inv] = await tickInvoiceFor(sub.id);
    expect(inv!.cycle).toBe(cycle);
    expect(inv!.discountCents).toBe(Math.floor(price * 0.2));
    expect(inv!.amountCents + inv!.discountCents).toBe(price);
    expect(inv!.couponCode).toBe(coupon.code);
  });

  it("a baixa avança currentPeriodEnd pelo ciclo da FATURA (idempotente)", async () => {
    const plan = await makePlan();
    const tenant = await makeTenant(`pay-${cycle}`);
    const sub = await makeSubscription(tenant.id, plan.id, { billingCycle: cycle });
    const [inv] = await tickInvoiceFor(sub.id);
    await applyInvoicePayment(inv!.id, new Date(), `mp-ciclos-${RUN}-${cycle}`);
    const expected = new Date(sub.currentPeriodEnd);
    expected.setMonth(expected.getMonth() + months);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).currentPeriodEnd.getTime()).toBe(expected.getTime());
    await applyInvoicePayment(inv!.id, new Date(), `mp-ciclos-${RUN}-${cycle}`);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).currentPeriodEnd.getTime()).toBe(expected.getTime());
  });
});

describe("cupom conta FATURAS, não meses", () => {
  it("3 faturas num plano trimestral: decrementa a cada fatura e só zera na terceira (3 x 3 = 9 meses)", async () => {
    const plan = await makePlan();
    const coupon = await makeCoupon({ kind: "AMOUNT", value: 1000, duration: "N_CYCLES", durationCycles: 3, appliesToCycles: ["QUARTERLY"] });
    const tenant = await makeTenant("faturas");
    const adopted = await adopt(tenant.id, plan.id, coupon.code, "QUARTERLY");
    expect(adopted.cyclesRemaining).toBe(3);
    const sub = await makeSubscription(tenant.id, plan.id, { billingCycle: "QUARTERLY", couponId: adopted.couponId, couponCyclesRemaining: 3 });
    const { gateway } = createMockMercadoPagoGateway();
    const remaining: Array<number | null> = [];
    for (let i = 0; i < 3; i += 1) {
      const current = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      const charge = await coupons.loadInvoiceCharge(current, plan);
      expect(charge).toMatchObject({ cycle: "QUARTERLY", discountCents: 1000, netCents: 15800 });
      const periodStart = addMonths(new Date(Date.UTC(2032, 0, 1)), i * 3);
      await createInvoiceForPeriodTracked({
        subscriptionId: sub.id,
        amountCents: charge.netCents,
        charge,
        periodStart,
        periodEnd: addMonths(periodStart, 3),
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
    expect((await coupons.loadInvoiceCharge(final, plan)).discountCents).toBe(0);
    expect(await prisma.couponRedemption.count({ where: { couponId: coupon.id } })).toBe(1);
  });
});

describe("cupom por lista de ciclos", () => {
  it("lista [trimestral, semestral]: aceita os dois, recusa mensal e anual com mensagem que diz quais valem", async () => {
    const plan = await makePlan();
    const coupon = await makeCoupon({ appliesToCycles: ["SEMIANNUAL", "QUARTERLY"] });
    expect(coupon.appliesToCycles).toEqual(["QUARTERLY", "SEMIANNUAL"]);
    expect(coupon.appliesToCycle).toBe("ANY"); // coluna depreciada fica no default
    const tenant = await makeTenant("lista");
    await expect(adopt(tenant.id, plan.id, coupon.code, "MONTHLY")).rejects.toMatchObject({ code: "COUPON_WRONG_CYCLE", message: expect.stringContaining("trimestral e semestral") });
    await expect(adopt(tenant.id, plan.id, coupon.code, "ANNUAL")).rejects.toMatchObject({ code: "COUPON_WRONG_CYCLE" });
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).redemptionsCount).toBe(0);
    await expect(adopt(tenant.id, plan.id, coupon.code, "SEMIANNUAL")).resolves.toMatchObject({ code: coupon.code });
  });

  it("os 4 ciclos marcados viram lista vazia (todos); lista vazia aceita qualquer ciclo", async () => {
    const plan = await makePlan();
    const all = await makeCoupon({ appliesToCycles: ["ANNUAL", "MONTHLY", "SEMIANNUAL", "QUARTERLY"] });
    expect(all.appliesToCycles).toEqual([]);
    const tenant = await makeTenant("todos");
    await expect(adopt(tenant.id, plan.id, all.code, "QUARTERLY")).resolves.toBeTruthy();
  });

  it("ciclo inexistente é recusado na criação", async () => {
    await expect(coupons.createCoupon({ code: uniq("BADC").toUpperCase(), kind: "PERCENT", value: 10, duration: "ONCE", appliesToCycles: ["BIMONTHLY"] }, null)).rejects.toMatchObject({ code: "INVALID_COUPON" });
  });

  it("depois do 1º resgate, mudar a lista de ciclos trava (COUPON_LOCKED); mesma lista passa", async () => {
    const plan = await makePlan();
    const coupon = await makeCoupon({ appliesToCycles: ["QUARTERLY"] });
    const tenant = await makeTenant("trava");
    await adopt(tenant.id, plan.id, coupon.code, "QUARTERLY");
    const same = { kind: "PERCENT" as const, value: 20, duration: "ONCE" as const, appliesToCycles: ["QUARTERLY"], description: "nova" };
    await expect(coupons.updateCoupon(coupon.id, same)).resolves.toBeTruthy();
    await expect(coupons.updateCoupon(coupon.id, { ...same, appliesToCycles: ["QUARTERLY", "ANNUAL"] })).rejects.toMatchObject({ code: "COUPON_LOCKED" });
  });

  it("cupom só do trimestral não desconta (nem gasta fatura) quando a assinatura está no semestral", async () => {
    const plan = await makePlan();
    const coupon = await makeCoupon({ appliesToCycles: ["QUARTERLY"], duration: "N_CYCLES", durationCycles: 2 });
    const tenant = await makeTenant("pausado");
    const adopted = await adopt(tenant.id, plan.id, coupon.code, "QUARTERLY");
    const sub = await makeSubscription(tenant.id, plan.id, { billingCycle: "SEMIANNUAL", couponId: adopted.couponId, couponCyclesRemaining: 2 });
    const [inv] = await tickInvoiceFor(sub.id);
    expect(inv).toMatchObject({ cycle: "SEMIANNUAL", discountCents: 0, amountCents: 31900 });
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.couponId).toBe(coupon.id);
    expect(after.couponCyclesRemaining).toBe(2);
  });
});

describe("plano que deixou de oferecer o ciclo", () => {
  it.each(["QUARTERLY", "SEMIANNUAL", "ANNUAL"] as const)("assinatura %s num plano só mensal cobra mensal, sem gastar cupom do ciclo", async (cycle) => {
    const plan = await makePlan({ quarterlyPriceCents: null, semiannualPriceCents: null, annualPriceCents: null });
    const coupon = await makeCoupon({ appliesToCycles: [cycle], duration: "N_CYCLES", durationCycles: 2 });
    const tenant = await makeTenant(`sem-${cycle}`);
    const adopted = await adopt(tenant.id, plan.id, coupon.code, cycle).catch(() => null);
    // O cupom só vale no ciclo que o plano não tem: a adoção direta no ciclo antigo ainda é possível pelo serviço,
    // mas a fatura sai mensal e o cupom fica guardado.
    const sub = await makeSubscription(tenant.id, plan.id, { billingCycle: cycle, couponId: adopted?.couponId ?? null, couponCyclesRemaining: adopted ? 2 : null });
    const [inv] = await tickInvoiceFor(sub.id);
    expect(inv).toMatchObject({ cycle: "MONTHLY", amountCents: 5900, discountCents: 0 });
    expect(inv!.periodEnd.getTime()).toBe(addMonths(sub.currentPeriodEnd, 1).getTime());
    if (adopted) expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).couponCyclesRemaining).toBe(2);
  });

  it("plano com só o anual: assinatura trimestral cai em mensal; anual segue anual", async () => {
    const plan = await makePlan({ quarterlyPriceCents: null, semiannualPriceCents: null });
    const t1 = await makeTenant("so-anual-q");
    const s1 = await makeSubscription(t1.id, plan.id, { billingCycle: "QUARTERLY" });
    expect((await tickInvoiceFor(s1.id))[0]).toMatchObject({ cycle: "MONTHLY", amountCents: 5900 });
    const t2 = await makeTenant("so-anual-a");
    const s2 = await makeSubscription(t2.id, plan.id, { billingCycle: "ANNUAL" });
    expect((await tickInvoiceFor(s2.id))[0]).toMatchObject({ cycle: "ANNUAL", amountCents: 59000 });
  });
});

describe("troca de ciclo pelo dono", () => {
  it("troca para qualquer ciclo que o plano ofereça e recusa o que ele não oferece", async () => {
    const plan = await makePlan({ semiannualPriceCents: null });
    const tenant = await makeTenant("troca");
    await makeSubscription(tenant.id, plan.id);
    for (const cycle of ["QUARTERLY", "ANNUAL", "MONTHLY"] as const) {
      expect(await changeBillingCycle(tenant.id, cycle)).toMatchObject({ billingCycle: cycle, couponPaused: false });
      expect((await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenant.id } })).billingCycle).toBe(cycle);
    }
    await expect(changeBillingCycle(tenant.id, "SEMIANNUAL")).rejects.toMatchObject({ code: "CYCLE_NOT_AVAILABLE", message: expect.stringContaining("semestral") });
    expect((await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenant.id } })).billingCycle).toBe("MONTHLY");
  });

  it("vale na próxima fatura: a fatura já emitida segue no ciclo antigo e avança só 1 mês", async () => {
    const plan = await makePlan();
    const tenant = await makeTenant("troca-depois");
    const sub = await makeSubscription(tenant.id, plan.id);
    const [inv] = await tickInvoiceFor(sub.id);
    expect((await changeBillingCycle(tenant.id, "SEMIANNUAL")).openInvoiceKeepsOldCycle).toBe(true);
    await applyInvoicePayment(inv!.id, new Date(), `mp-ciclos-${RUN}-troca`);
    const paid = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(paid.currentPeriodEnd.getTime()).toBe(addMonths(sub.currentPeriodEnd, 1).getTime());
    expect(paid.billingCycle).toBe("SEMIANNUAL");
  });

  it("avisa que o cupom fica guardado quando a lista dele não inclui o ciclo novo", async () => {
    const plan = await makePlan();
    const coupon = await makeCoupon({ appliesToCycles: ["MONTHLY", "QUARTERLY"] });
    const tenant = await makeTenant("troca-cupom");
    const adopted = await adopt(tenant.id, plan.id, coupon.code);
    await makeSubscription(tenant.id, plan.id, { couponId: adopted.couponId, couponCyclesRemaining: 1 });
    expect((await changeBillingCycle(tenant.id, "QUARTERLY")).couponPaused).toBe(false);
    expect((await changeBillingCycle(tenant.id, "SEMIANNUAL")).couponPaused).toBe(true);
  });
});

describe("reativação de assinatura cancelada", () => {
  it("fatura de reativação sai no ciclo da assinatura, com o período certo", async () => {
    const plan = await makePlan();
    const tenant = await makeTenant("reativa");
    const sub = await makeSubscription(tenant.id, plan.id, { billingCycle: "SEMIANNUAL", status: "CANCELED", periodEnd: addDays(new Date(), -100) });
    const { gateway } = createMockMercadoPagoGateway();
    const { invoiceId } = await startReactivation(tenant.id, { gateway });
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(inv).toMatchObject({ cycle: "SEMIANNUAL", amountCents: 31900 });
    expect(inv.periodEnd.getTime()).toBe(addMonths(inv.periodStart, 6).getTime());
    await applyInvoicePayment(inv.id, new Date(), `mp-ciclos-${RUN}-reativa`);
    const back = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(back.status).toBe("ACTIVE");
    const diffDays = (back.currentPeriodEnd.getTime() - Date.now()) / 86_400_000;
    expect(diffDays).toBeGreaterThan(180);
    expect(diffDays).toBeLessThan(186);
  });
});

describe("cadastro com ciclo e cupom", () => {
  it("senha: trimestral com cupom da lista, fatura do teste já no ciclo e líquida", async () => {
    const plan = await makePlan({ sortOrder: -5100, active: true });
    const coupon = await makeCoupon({ kind: "PERCENT", value: 10, appliesToCycles: ["QUARTERLY"] });
    const slug = uniq("it-ciclos-signup");
    const { gateway } = createMockMercadoPagoGateway();
    const result = await signUp(
      { companyName: "Cadastro Trimestral", slug, segment: null, ownerName: "Dona", email: `${slug}@example.com`, password: "senha-forte-123", document: "529.982.247-25", phone: "(84) 99999-8888", termsVersion: "v1", billingCycle: "QUARTERLY", couponCode: coupon.code.toLowerCase() },
      gateway,
    );
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: result.tenantSlug } });
    tenantIds.push(tenant.id);
    userIds.push(result.userId);
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    expect(sub).toMatchObject({ planId: plan.id, billingCycle: "QUARTERLY" });
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    expect(invoice).toMatchObject({ cycle: "QUARTERLY", amountCents: 15120, discountCents: 1680, couponCode: coupon.code, isTrialConversion: true });
    await applyInvoicePayment(invoice.id, new Date(), `mp-ciclos-${RUN}-signup`);
    const paid = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    const expected = new Date(sub.currentPeriodEnd);
    expected.setMonth(expected.getMonth() + 3);
    expect(paid.currentPeriodEnd.getTime()).toBe(expected.getTime());
  });

  it("recusa o ciclo que o plano não oferece (INVALID_CYCLE); o cupom de outro ciclo só é descartado (a conta nasce)", async () => {
    await makePlan({ sortOrder: -5101, active: true, semiannualPriceCents: null });
    const coupon = await makeCoupon({ appliesToCycles: ["ANNUAL"] });
    const { gateway } = createMockMercadoPagoGateway();
    const base = { companyName: "Recusa", segment: null, ownerName: "Dona", password: "senha-forte-123", document: "529.982.247-25", phone: "(84) 99999-8888", termsVersion: "v1" };
    const s1 = uniq("it-ciclos-rec1");
    await expect(signUp({ ...base, slug: s1, email: `${s1}@example.com`, billingCycle: "SEMIANNUAL" }, gateway)).rejects.toMatchObject({ code: "INVALID_CYCLE" });
    const s2 = uniq("it-ciclos-rec2");
    const dropped = await signUp({ ...base, slug: s2, email: `${s2}@example.com`, billingCycle: "QUARTERLY", couponCode: coupon.code }, gateway);
    expect(dropped.couponDropped).toBe(true);
    const droppedTenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: dropped.tenantSlug } });
    tenantIds.push(droppedTenant.id);
    userIds.push(dropped.userId);
    expect(await prisma.user.count({ where: { email: `${s1}@example.com` } })).toBe(0); // o INVALID_CYCLE não criou nada
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).redemptionsCount).toBe(0);
  });

  it("Google: o mesmo contrato de ciclo e cupom vale (semestral com cupom)", async () => {
    const plan = await makePlan({ sortOrder: -5102, active: true });
    const coupon = await makeCoupon({ kind: "AMOUNT", value: 5000, appliesToCycles: ["SEMIANNUAL"] });
    const email = `${uniq("it-ciclos-google")}@example.com`;
    const { gateway } = createMockMercadoPagoGateway();
    const result = await signUpWithGoogle(
      { email, googleSub: uniq("sub"), ownerName: "Dona Google", companyName: uniq("Empresa Google"), document: "529.982.247-25", phone: "(84) 99999-8888", termsVersion: "v1", billingCycle: "SEMIANNUAL", couponCode: coupon.code },
      gateway,
    );
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: result.tenantSlug } });
    tenantIds.push(tenant.id);
    userIds.push(result.userId);
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    expect(sub).toMatchObject({ planId: plan.id, billingCycle: "SEMIANNUAL" });
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    expect(invoice).toMatchObject({ cycle: "SEMIANNUAL", amountCents: 26900, discountCents: 5000 });
  });
});

describe("Admin Planos: preços por ciclo", () => {
  it("valida cada ciclo: mínimo e no máximo as mensalidades do período; aceita e remove (null)", async () => {
    const plan = await makePlan({ quarterlyPriceCents: null, semiannualPriceCents: null, annualPriceCents: null });
    await expect(updatePlan(plan.id, { quarterlyPriceCents: 50 })).rejects.toMatchObject({ code: "INVALID_CYCLE_PRICE" });
    await expect(updatePlan(plan.id, { quarterlyPriceCents: 5900 * 3 + 1 })).rejects.toMatchObject({ code: "INVALID_CYCLE_PRICE" });
    await expect(updatePlan(plan.id, { semiannualPriceCents: 5900 * 6 + 1 })).rejects.toMatchObject({ code: "INVALID_CYCLE_PRICE" });
    await expect(updatePlan(plan.id, { annualPriceCents: 5900 * 12 + 1 })).rejects.toMatchObject({ code: "INVALID_CYCLE_PRICE" });
    const ok = await updatePlan(plan.id, { quarterlyPriceCents: 16800, semiannualPriceCents: 31900, annualPriceCents: 59000 });
    expect(ok).toMatchObject({ quarterlyPriceCents: 16800, semiannualPriceCents: 31900, annualPriceCents: 59000 });
    const cleared = await updatePlan(plan.id, { quarterlyPriceCents: null, semiannualPriceCents: null, annualPriceCents: null });
    expect(cleared).toMatchObject({ quarterlyPriceCents: null, semiannualPriceCents: null, annualPriceCents: null });
  });

  it("baixar o mensal abaixo do que um ciclo já cobra é recusado", async () => {
    const plan = await makePlan();
    await expect(updatePlan(plan.id, { priceCents: 5000 })).rejects.toMatchObject({ code: "INVALID_CYCLE_PRICE" });
  });

  it("não deixa apagar o preço de um ciclo com assinatura ativa nele, e diz quantas", async () => {
    const plan = await makePlan();
    const [a, b, c] = await Promise.all([makeTenant("uso-a"), makeTenant("uso-b"), makeTenant("uso-c")]);
    await makeSubscription(a.id, plan.id, { billingCycle: "QUARTERLY" });
    await makeSubscription(b.id, plan.id, { billingCycle: "QUARTERLY", status: "TRIALING" });
    await makeSubscription(c.id, plan.id, { billingCycle: "ANNUAL", status: "CANCELED" });
    await expect(updatePlan(plan.id, { quarterlyPriceCents: null })).rejects.toMatchObject({
      code: "CYCLE_IN_USE",
      message: expect.stringContaining("2 assinaturas ativas"),
      details: { cycle: "QUARTERLY", count: 2 },
    });
    expect((await prisma.plan.findUniqueOrThrow({ where: { id: plan.id } })).quarterlyPriceCents).toBe(16800);
    // Só tem assinatura CANCELADA no anual: pode apagar.
    await expect(updatePlan(plan.id, { annualPriceCents: null })).resolves.toMatchObject({ annualPriceCents: null });
    // Semestral sem ninguém: pode apagar.
    await expect(updatePlan(plan.id, { semiannualPriceCents: null })).resolves.toMatchObject({ semiannualPriceCents: null });
    // Alterar o valor (sem apagar) segue permitido mesmo em uso.
    await expect(updatePlan(plan.id, { quarterlyPriceCents: 17000 })).resolves.toMatchObject({ quarterlyPriceCents: 17000 });

    const usage = await liveCycleUsageByPlan();
    expect(usage[plan.id]).toEqual({ QUARTERLY: 2 });
  });

  it("uma assinatura só: mensagem no singular", async () => {
    const plan = await makePlan();
    const tenant = await makeTenant("uso-um");
    await makeSubscription(tenant.id, plan.id, { billingCycle: "SEMIANNUAL" });
    await expect(updatePlan(plan.id, { semiannualPriceCents: null })).rejects.toMatchObject({ message: expect.stringContaining("1 assinatura ativa usa") });
  });
});

describe("MRR, renovações e visões do Admin respeitam os 4 ciclos", () => {
  it("MRR = preço do período / meses (Financeiro e Admin Cobrança)", async () => {
    const before = (await getFinanceOverview()).mrrCents;
    const beforeBilling = (await billingMonthlyTotals()).mrrCents;
    const plan = await makePlan();
    for (const cycle of ["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL"] as const) {
      const tenant = await makeTenant(`mrr-${cycle}`);
      await makeSubscription(tenant.id, plan.id, { billingCycle: cycle, periodEnd: addDays(new Date(), 20) });
    }
    const expected = 5900 + 5600 + 5317 + 4917;
    const after = await getFinanceOverview();
    expect(after.mrrCents - before).toBe(expected);
    expect((await billingMonthlyTotals()).mrrCents - beforeBilling).toBe(expected);
    // Renovação é caixa: os próximos 30 dias entram pelo valor cheio de cada período.
    expect(after.upcoming.next30.cents).toBeGreaterThanOrEqual(5900 + 16800 + 31900 + 59000);
  });

  it("ciclo que o plano deixou de oferecer conta como mensal no MRR", async () => {
    const before = (await getFinanceOverview()).mrrCents;
    const plan = await makePlan({ quarterlyPriceCents: null, semiannualPriceCents: null, annualPriceCents: null });
    const tenant = await makeTenant("mrr-sem");
    await makeSubscription(tenant.id, plan.id, { billingCycle: "ANNUAL", periodEnd: addDays(new Date(), 20) });
    expect((await getFinanceOverview()).mrrCents - before).toBe(5900);
  });

  it("lista do Admin Cobrança e CSV trazem o ciclo da fatura", async () => {
    const plan = await makePlan();
    const tenant = await makeTenant("lista");
    const sub = await makeSubscription(tenant.id, plan.id, { billingCycle: "SEMIANNUAL" });
    const [inv] = await tickInvoiceFor(sub.id);
    const list = await listInvoicesAdmin({ tenantId: tenant.id });
    expect(list.items.find((i) => i.id === inv!.id)?.cycle).toBe("SEMIANNUAL");
    const { csv } = await buildInvoicesCsv({ from: inv!.dueAt.toISOString().slice(0, 10), to: inv!.dueAt.toISOString().slice(0, 10) });
    const lines = csv.split("\r\n");
    expect(lines[0]).toContain("Plano;Ciclo;Competência");
    expect(lines.find((l) => l.includes(inv!.id))).toContain(";Semestral;");
  });
});

describe("régua: o texto do aviso sai com o ciclo da fatura", () => {
  it.each([
    ["QUARTERLY", "R$ 168,00 do plano trimestral"],
    ["SEMIANNUAL", "R$ 319,00 do plano semestral"],
    ["ANNUAL", "R$ 590,00 do plano anual"],
  ] as const)("fatura %s: o WhatsApp diz '%s'", async (cycle, text) => {
    const plan = await makePlan();
    const tenant = await makeTenant(`regua-${cycle}`);
    const sub = await makeSubscription(tenant.id, plan.id, { billingCycle: cycle });
    const [inv] = await tickInvoiceFor(sub.id);
    const subject = await loadDunningSubject(sub.id, new Date());
    expect(subject).not.toBeNull();
    const context = await buildNoticeCopyContext({ step: "DUE_D1", invoiceId: inv!.id, subject: subject!, ownerFirstName: "Ana", now: new Date(), firstWhatsapp: false });
    expect(context.data.cycle).toBe(cycle);
    const message = buildWhatsappMessages("DUE_D1", context.data).join(" ").replace(/ /g, " ");
    expect(message).toContain(text);
    expect(message).not.toContain("por mês");
  });
});
