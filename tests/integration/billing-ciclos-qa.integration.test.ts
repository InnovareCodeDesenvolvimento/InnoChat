/**
 * QA independente dos 4 ciclos (Íris): cenários de negócio ponta a ponta pela cadeia real do tick
 * (fatura -> baixa -> próxima fatura) com o relógio avançado, em vez de montar a fatura à mão.
 *  - cupom AMOUNT de 3 faturas no semestral cobre 18 meses (não 3 meses) e a 4ª fatura sai cheia;
 *  - cupom PERCENT só-trimestral ONCE: 1ª fatura com desconto, 2ª cheia;
 *  - anual sem cupom: fatura cheia, 12 meses, sem resgate;
 *  - troca mensal -> semestral vale na PRÓXIMA fatura (período de 6 meses, valor cheio, sem pro-rata);
 *  - mensagem pública de cupom recusado é a mesma para ciclo errado e código inexistente;
 *  - MRR com mistura (1 mensal R$ 59,00 + 1 semestral R$ 318,60 = 59,00 + 53,10);
 *  - régua (WhatsApp e e-mail) com trimestral/semestral;
 *  - plano que perdeu um ciclo sem assinantes some da vitrine pública e do cadastro.
 */
import { randomUUID } from "node:crypto";
import { addDays, addMonths } from "date-fns";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";

vi.mock("@/lib/email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
  return { ...actual, sendMail: vi.fn(async () => ({ sent: true })) };
});

const { generateInvoiceForSubscriptionId } = await import("@/modules/billing/tick");
const { createMockMercadoPagoGateway } = await import("@/modules/billing/mercadopago.mock");
const { applyInvoicePayment } = await import("@/modules/billing/service");
const { signUp } = await import("@/modules/signup/service");
const coupons = await import("@/modules/billing/coupons");
const { changeBillingCycle } = await import("@/modules/billing/billing-cycle");
const { updatePlan } = await import("@/modules/billing/admin-service");
const { getFinanceOverview } = await import("@/modules/billing/finance-service");
const { getLandingPlans, resetLandingPlansCache } = await import("@/modules/billing/landing-plans");
const { buildEmailCopy, buildWhatsappMessages } = await import("@/core/billing");

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

async function makePlan(over: { priceCents?: number; q?: number | null; s?: number | null; a?: number | null; active?: boolean; sortOrder?: number } = {}) {
  const plan = await prisma.plan.create({
    data: {
      code: uniq("qa-ciclos-plan"),
      name: "Plano QA Ciclos",
      priceCents: over.priceCents ?? 5900,
      quarterlyPriceCents: over.q === undefined ? 16800 : over.q,
      semiannualPriceCents: over.s === undefined ? 31860 : over.s,
      annualPriceCents: over.a === undefined ? 59000 : over.a,
      maxWhatsappNumbers: 1,
      maxProfessionals: 1,
      active: over.active ?? false,
      sortOrder: over.sortOrder ?? 996,
    },
  });
  planIds.push(plan.id);
  return plan;
}

async function makeCoupon(over: Partial<Parameters<typeof coupons.createCoupon>[0]> = {}) {
  const coupon = await coupons.createCoupon({ code: uniq("QAC").toUpperCase(), kind: "PERCENT", value: 20, duration: "ONCE", ...over }, null);
  couponIds.push(coupon.id);
  return coupon;
}

async function makeTenant(label: string) {
  const slug = uniq(`qa-ciclos-${label}`);
  const tenant = await prisma.tenant.create({ data: { slug, name: `QA ${label}`, timezone: "UTC", document: "52998224725" } });
  const user = await prisma.user.create({ data: { email: `${slug}@example.com`, passwordHash: "x", emailVerifiedAt: new Date() } });
  await prisma.membership.create({ data: { userId: user.id, tenantId: tenant.id, role: "OWNER" } });
  tenantIds.push(tenant.id);
  userIds.push(user.id);
  return tenant;
}

type Cycle = "MONTHLY" | "QUARTERLY" | "SEMIANNUAL" | "ANNUAL";

async function subscribe(tenantId: string, planId: string, cycle: Cycle, couponCode?: string) {
  let couponId: string | null = null;
  let remaining: number | null = null;
  if (couponCode) {
    const adopted = await prisma.$transaction((tx) => coupons.adoptCouponInTx(tx, { code: couponCode, tenantId, planId, cycle, now: new Date() }));
    couponId = adopted.couponId;
    remaining = adopted.cyclesRemaining;
  }
  return prisma.subscription.create({
    data: { tenantId, planId, status: "ACTIVE", currentPeriodEnd: addDays(new Date(), 3), firstPaidAt: new Date(), billingCycle: cycle, couponId, couponCyclesRemaining: remaining },
  });
}

/** Roda o tick no relógio `now`, devolve a fatura nova (a mais recente) e a paga em seguida. */
async function nextInvoiceAndPay(subscriptionId: string, now: Date, tag: string) {
  const { gateway } = createMockMercadoPagoGateway();
  const before = await prisma.invoice.count({ where: { subscriptionId } });
  // Só a assinatura do teste: o tick global varreria todas as empresas do banco com o relógio no futuro.
  await generateInvoiceForSubscriptionId(subscriptionId, gateway);
  const all = await prisma.invoice.findMany({ where: { subscriptionId }, orderBy: { periodStart: "asc" } });
  expect(all.length, "o tick gera exatamente 1 fatura nova").toBe(before + 1);
  const inv = all[all.length - 1]!;
  await applyInvoicePayment(inv.id, now, `mp-qa-ciclos-${RUN}-${tag}-${all.length}`);
  return inv;
}

describe("cupom AMOUNT de 3 faturas no semestral cobre 18 meses", () => {
  it("3 faturas com desconto (6+6+6 = 18 meses de cobertura) e a 4ª sai cheia", async () => {
    const plan = await makePlan();
    const coupon = await makeCoupon({ kind: "AMOUNT", value: 1000, duration: "N_CYCLES", durationCycles: 3, appliesToCycles: ["SEMIANNUAL"] });
    const tenant = await makeTenant("sem3");
    const sub = await subscribe(tenant.id, plan.id, "SEMIANNUAL", coupon.code);
    const start = sub.currentPeriodEnd;
    const invoices = [];
    for (let i = 0; i < 4; i += 1) {
      // Cada rodada acontece 3 dias antes do vencimento do período corrente (mesma folga do cadastro).
      const current = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      invoices.push(await nextInvoiceAndPay(sub.id, addDays(current.currentPeriodEnd, -2), "sem3"));
    }
    expect(invoices.map((i) => i.cycle)).toEqual(["SEMIANNUAL", "SEMIANNUAL", "SEMIANNUAL", "SEMIANNUAL"]);
    expect(invoices.map((i) => i.discountCents)).toEqual([1000, 1000, 1000, 0]);
    expect(invoices.map((i) => i.amountCents)).toEqual([30860, 30860, 30860, 31860]);
    // 3 faturas descontadas cobrem 18 meses; a 4ª começa depois deles.
    expect(invoices[2]!.periodEnd.getTime()).toBe(addMonths(start, 18).getTime());
    expect(invoices[3]!.periodStart.getTime()).toBe(addMonths(start, 18).getTime());
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.couponId).toBeNull();
    expect(after.currentPeriodEnd.getTime()).toBe(addMonths(start, 24).getTime());
    expect(await prisma.couponRedemption.count({ where: { couponId: coupon.id } })).toBe(1);
  });
});

describe("trimestral com cupom PERCENT só-trimestral, uso único", () => {
  it("1ª fatura -20% sobre o preço do trimestre; 2ª fatura cheia", async () => {
    const plan = await makePlan();
    const coupon = await makeCoupon({ kind: "PERCENT", value: 20, duration: "ONCE", appliesToCycles: ["QUARTERLY"] });
    const tenant = await makeTenant("tri-once");
    const sub = await subscribe(tenant.id, plan.id, "QUARTERLY", coupon.code);
    const first = await nextInvoiceAndPay(sub.id, addDays(sub.currentPeriodEnd, -2), "tri");
    expect(first).toMatchObject({ cycle: "QUARTERLY", discountCents: 3360, amountCents: 13440, couponCode: coupon.code });
    expect(first.periodEnd.getTime()).toBe(addMonths(sub.currentPeriodEnd, 3).getTime());
    const current = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    const second = await nextInvoiceAndPay(sub.id, addDays(current.currentPeriodEnd, -2), "tri");
    expect(second).toMatchObject({ cycle: "QUARTERLY", discountCents: 0, amountCents: 16800, couponCode: null });
  });
});

describe("cadastro", () => {
  const base = { segment: null, ownerName: "Dona", password: "senha-forte-123", document: "529.982.247-25", termsVersion: "v1" };

  it("anual sem cupom: fatura de 12 meses com o preço cheio e nenhum resgate", async () => {
    const plan = await makePlan({ active: true, sortOrder: -6100 });
    const slug = uniq("qa-ciclos-anual");
    const { gateway } = createMockMercadoPagoGateway();
    const result = await signUp({ ...base, companyName: "QA Anual", slug, email: `${slug}@example.com`, billingCycle: "ANNUAL" }, gateway);
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: result.tenantSlug } });
    tenantIds.push(tenant.id);
    userIds.push(result.userId);
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    expect(sub).toMatchObject({ planId: plan.id, billingCycle: "ANNUAL", couponId: null });
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    expect(invoice).toMatchObject({ cycle: "ANNUAL", amountCents: 59000, discountCents: 0, couponCode: null });
    // A fatura do fim do teste tem como periodEnd o fim do teste (o teste É o 1º período); o que o pagamento compra são 12 meses a partir dele.
    await applyInvoicePayment(invoice.id, new Date(), `mp-qa-ciclos-${RUN}-anual-signup`);
    const paid = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(paid.currentPeriodEnd.getTime()).toBe(addMonths(sub.currentPeriodEnd, 12).getTime());
    expect(await prisma.couponRedemption.count({ where: { tenantId: tenant.id } })).toBe(0);
  });

  it("cupom só-anual no trimestral: mesma mensagem pública de um código que não existe, e nada é criado", async () => {
    await makePlan({ active: true, sortOrder: -6101 });
    const annualOnly = await makeCoupon({ appliesToCycles: ["ANNUAL"] });
    const { gateway } = createMockMercadoPagoGateway();
    const s1 = uniq("qa-ciclos-w1");
    const s2 = uniq("qa-ciclos-w2");
    const wrong = await signUp({ ...base, companyName: "QA W1", slug: s1, email: `${s1}@example.com`, billingCycle: "QUARTERLY", couponCode: annualOnly.code }, gateway).catch((e) => e);
    const ghost = await signUp({ ...base, companyName: "QA W2", slug: s2, email: `${s2}@example.com`, billingCycle: "QUARTERLY", couponCode: `NAOEXISTE${RUN}` }, gateway).catch((e) => e);
    expect(wrong).toMatchObject({ code: "COUPON_INVALID" });
    expect(ghost).toMatchObject({ code: "COUPON_INVALID" });
    expect(wrong.message).toBe(ghost.message);
    expect(wrong.message).not.toMatch(/anual/i); // não entrega qual cupom existe nem de que ciclo
    expect(await prisma.tenant.count({ where: { slug: { in: [s1, s2] } } })).toBe(0);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: annualOnly.id } })).redemptionsCount).toBe(0);
  });
});

describe("troca de mensal para semestral", () => {
  it("a fatura emitida segue mensal; a PRÓXIMA sai semestral de 6 meses, valor cheio do período e sem pro-rata", async () => {
    const plan = await makePlan();
    const tenant = await makeTenant("troca");
    const sub = await subscribe(tenant.id, plan.id, "MONTHLY");
    const first = await nextInvoiceAndPay(sub.id, addDays(sub.currentPeriodEnd, -2), "troca");
    expect(first).toMatchObject({ cycle: "MONTHLY", amountCents: 5900 });
    const afterFirst = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(afterFirst.currentPeriodEnd.getTime()).toBe(addMonths(sub.currentPeriodEnd, 1).getTime());

    const change = await changeBillingCycle(tenant.id, "SEMIANNUAL");
    expect(change.billingCycle).toBe("SEMIANNUAL");
    // Trocar não cria nem altera fatura sozinho.
    expect(await prisma.invoice.count({ where: { subscriptionId: sub.id } })).toBe(1);

    const second = await nextInvoiceAndPay(sub.id, addDays(afterFirst.currentPeriodEnd, -2), "troca");
    expect(second).toMatchObject({ cycle: "SEMIANNUAL", amountCents: 31860, discountCents: 0 });
    expect(second.periodStart.getTime()).toBe(afterFirst.currentPeriodEnd.getTime());
    expect(second.periodEnd.getTime()).toBe(addMonths(afterFirst.currentPeriodEnd, 6).getTime());
    const done = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(done.currentPeriodEnd.getTime()).toBe(addMonths(afterFirst.currentPeriodEnd, 6).getTime());
  });
});

describe("Admin tenta apagar preço de ciclo em uso", () => {
  it("recusa com a contagem e não grava nada; ciclo sem ninguém apaga", async () => {
    const plan = await makePlan();
    const t1 = await makeTenant("uso1");
    const t2 = await makeTenant("uso2");
    await subscribe(t1.id, plan.id, "SEMIANNUAL");
    await subscribe(t2.id, plan.id, "SEMIANNUAL");
    await expect(updatePlan(plan.id, { semiannualPriceCents: null })).rejects.toMatchObject({ code: "CYCLE_IN_USE", details: { cycle: "SEMIANNUAL", count: 2 }, message: expect.stringContaining("2 assinaturas ativas") });
    expect((await prisma.plan.findUniqueOrThrow({ where: { id: plan.id } })).semiannualPriceCents).toBe(31860);
    await expect(updatePlan(plan.id, { quarterlyPriceCents: null })).resolves.toMatchObject({ quarterlyPriceCents: null });
  });
});

describe("MRR com mistura de ciclos", () => {
  it("1 mensal R$ 59,00 + 1 semestral R$ 318,60 somam 59,00 + 53,10 = R$ 112,10", async () => {
    const before = (await getFinanceOverview()).mrrCents;
    const plan = await makePlan({ priceCents: 5900, s: 31860 });
    const a = await makeTenant("mrr-m");
    const b = await makeTenant("mrr-s");
    await subscribe(a.id, plan.id, "MONTHLY");
    await subscribe(b.id, plan.id, "SEMIANNUAL");
    expect((await getFinanceOverview()).mrrCents - before).toBe(5900 + 5310);
  });
});

describe("régua com fatura trimestral e semestral", () => {
  const data = (cycle: "QUARTERLY" | "SEMIANNUAL", amount: string) => ({
    ownerName: "Ana",
    tenantName: "Salão Teste",
    amount,
    cycle,
    dueDate: "28/10/2026",
    billingUrl: "https://painel.exemplo/assinatura",
    panelUrl: "https://painel.exemplo",
    pixCopyPaste: null,
    lastServiceDate: "31/10/2026",
    daysSuspended: 3,
    daysToCancel: 20,
    cancelDate: "30/11/2026",
    suspendedDate: "01/11/2026",
    retentionDays: 30,
    unpaidDays: 60,
    salesWhatsapp: null,
    trialEndsDate: null,
    trialEndsTime: null,
    trial: null,
    paidDate: null,
    activeUntil: null,
    firstPayment: false,
    trialNotConverted: false,
    firstWhatsapp: false,
  });

  it.each([
    ["QUARTERLY", "R$ 168,00", "do plano trimestral"],
    ["SEMIANNUAL", "R$ 318,60", "do plano semestral"],
  ] as const)("%s: WhatsApp e e-mail dizem '%s %s' e nunca 'por mês'", (cycle, amount, label) => {
    const d = data(cycle, amount);
    for (const step of ["DUE_D1", "DUE_D0", "DUE_D3"] as const) {
      const text = buildWhatsappMessages(step, d).join(" ");
      if (text.includes(amount)) {
        expect(text, step).toContain(`${amount} ${label}`);
        expect(text, step).not.toContain("por mês");
      }
    }
    for (const step of ["GRACE_D1", "GRACE_D2", "GRACE_LAST"] as const) {
      const email = buildEmailCopy(step, d)!;
      const text = [email.subject, email.preheader, ...email.paragraphs].join(" ");
      expect(text, step).toContain(`${amount} ${label}`);
      expect(text, step).not.toContain("por mês");
    }
  });
});

describe("plano que perde um ciclo sem assinantes", () => {
  it("some da vitrine pública (landing) e continua só com o que sobrou", async () => {
    const plan = await makePlan({ active: true, sortOrder: -6200 });
    resetLandingPlansCache();
    const withAll = (await getLandingPlans())!.find((p) => p.id === plan.id)!;
    expect(withAll.cycles.map((c) => c.cycle)).toEqual(["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL"]);
    await updatePlan(plan.id, { quarterlyPriceCents: null, semiannualPriceCents: null });
    resetLandingPlansCache();
    const after = (await getLandingPlans())!.find((p) => p.id === plan.id)!;
    expect(after.cycles.map((c) => c.cycle)).toEqual(["MONTHLY", "ANNUAL"]);
    await updatePlan(plan.id, { annualPriceCents: null });
    resetLandingPlansCache();
    const onlyMonthly = (await getLandingPlans())!.find((p) => p.id === plan.id)!;
    expect(onlyMonthly.cycles.map((c) => c.cycle)).toEqual(["MONTHLY"]);
    expect(onlyMonthly.best).toBeNull();
  });
});
