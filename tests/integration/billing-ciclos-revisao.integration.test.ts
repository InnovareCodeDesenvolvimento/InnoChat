/**
 * Correções da revisão do Órion aos 4 ciclos (docs/seguranca/revisao-4-ciclos.md), contra Postgres real:
 *  - I-1: fim do período pago com `addMonths` (31/08 + 6 = 28/02, 31/01 + 3 = 30/04, 31/05 + 1 = 30/06) e o
 *    `periodStart` da fatura seguinte não desliza;
 *  - I-2: trocar de plano para um que não tem o ciclo atual é recusado; a troca de ciclo vale contra o plano da
 *    PRÓXIMA fatura; apagar preço e trocar de ciclo ao mesmo tempo nunca deixa a assinatura num ciclo sem preço;
 *  - S-2: preço de período abaixo de 50% das mensalidades só salva com `confirmLowPrice`.
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
const { applyInvoicePayment, changePlan } = await import("@/modules/billing/service");
const { changeBillingCycle } = await import("@/modules/billing/billing-cycle");
const { updatePlan } = await import("@/modules/billing/admin-service");

const prisma = getPrisma();
const tenantIds: string[] = [];
const userIds: string[] = [];
const planIds: string[] = [];
const RUN = randomUUID().slice(0, 6);
let seq = 0;
const uniq = (label: string) => `${label}-${RUN}-${++seq}`;

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.plan.deleteMany({ where: { id: { in: planIds } } });
  await prisma.$disconnect();
});

type Cycle = "MONTHLY" | "QUARTERLY" | "SEMIANNUAL" | "ANNUAL";

async function makePlan(over: { name?: string; q?: number | null; s?: number | null; a?: number | null; sortOrder?: number; active?: boolean } = {}) {
  const plan = await prisma.plan.create({
    data: {
      code: uniq("rev-plan"),
      name: over.name ?? "Plano Revisao",
      priceCents: 5900,
      quarterlyPriceCents: over.q === undefined ? 16800 : over.q,
      semiannualPriceCents: over.s === undefined ? 31860 : over.s,
      annualPriceCents: over.a === undefined ? 59000 : over.a,
      maxWhatsappNumbers: 5,
      maxProfessionals: 10,
      active: over.active ?? true,
      sortOrder: over.sortOrder ?? 995,
    },
  });
  planIds.push(plan.id);
  return plan;
}

async function makeTenant(label: string) {
  const slug = uniq(`rev-${label}`);
  const tenant = await prisma.tenant.create({ data: { slug, name: `Rev ${label}`, timezone: "UTC", document: "52998224725" } });
  const user = await prisma.user.create({ data: { email: `${slug}@example.com`, passwordHash: "x", emailVerifiedAt: new Date() } });
  await prisma.membership.create({ data: { userId: user.id, tenantId: tenant.id, role: "OWNER" } });
  tenantIds.push(tenant.id);
  userIds.push(user.id);
  return tenant;
}

async function subscribe(tenantId: string, planId: string, cycle: Cycle, currentPeriodEnd: Date, pendingPlanId: string | null = null) {
  return prisma.subscription.create({
    data: { tenantId, planId, pendingPlanId, status: "ACTIVE", currentPeriodEnd, firstPaidAt: new Date(), billingCycle: cycle },
  });
}

async function nextInvoiceAndPay(subscriptionId: string, now: Date, tag: string) {
  const { gateway } = createMockMercadoPagoGateway();
  const before = await prisma.invoice.count({ where: { subscriptionId } });
  // Só a assinatura do teste: o tick global varreria todas as empresas do banco com o relógio no futuro.
  await generateInvoiceForSubscriptionId(subscriptionId, gateway);
  const all = await prisma.invoice.findMany({ where: { subscriptionId }, orderBy: { periodStart: "asc" } });
  expect(all.length, "o tick gera exatamente 1 fatura nova").toBe(before + 1);
  const inv = all[all.length - 1]!;
  await applyInvoicePayment(inv.id, now, `mp-rev-${RUN}-${tag}-${all.length}`);
  return inv;
}

/** Dia e mês na hora local do servidor (o `addMonths` do date-fns também trabalha em hora local). */
function ymd(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

describe("I-1: fim do período pago não estoura o fim do mês", () => {
  const cases: Array<{ label: string; cycle: Cycle; from: Date; expected: string }> = [
    { label: "31/08/2026 + 6 meses = 28/02/2027", cycle: "SEMIANNUAL", from: new Date(2026, 7, 31, 12), expected: "2027-02-28" },
    { label: "31/08/2027 + 6 meses = 29/02/2028 (bissexto)", cycle: "SEMIANNUAL", from: new Date(2027, 7, 31, 12), expected: "2028-02-29" },
    { label: "31/01/2026 + 3 meses = 30/04/2026", cycle: "QUARTERLY", from: new Date(2026, 0, 31, 12), expected: "2026-04-30" },
    { label: "31/05/2026 + 1 mês = 30/06/2026", cycle: "MONTHLY", from: new Date(2026, 4, 31, 12), expected: "2026-06-30" },
  ];

  for (const c of cases) {
    it(c.label, async () => {
      const plan = await makePlan({ active: false });
      const tenant = await makeTenant("fimmes");
      const sub = await subscribe(tenant.id, plan.id, c.cycle, c.from);
      const invoice = await prisma.invoice.create({
        data: {
          subscriptionId: sub.id,
          amountCents: 1000,
          cycle: c.cycle,
          periodStart: c.from,
          periodEnd: addMonths(c.from, c.cycle === "SEMIANNUAL" ? 6 : c.cycle === "QUARTERLY" ? 3 : 1),
          dueAt: c.from,
          status: "OPEN",
        },
      });
      await applyInvoicePayment(invoice.id, addDays(c.from, -1), `mp-rev-${RUN}-fimmes-${seq}`);
      const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
      expect(ymd(after.currentPeriodEnd)).toBe(c.expected);
    });
  }

  it("o currentPeriodEnd gravado bate com o periodEnd da fatura e o periodStart da seguinte não desliza", async () => {
    const plan = await makePlan({ active: false });
    const tenant = await makeTenant("deslize");
    const start = new Date(2026, 7, 31, 12);
    const sub = await subscribe(tenant.id, plan.id, "SEMIANNUAL", start);
    const first = await nextInvoiceAndPay(sub.id, addDays(start, -2), "deslize");
    expect(ymd(first.periodEnd)).toBe("2027-02-28");
    const afterFirst = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(afterFirst.currentPeriodEnd.getTime()).toBe(first.periodEnd.getTime());
    const second = await nextInvoiceAndPay(sub.id, addDays(afterFirst.currentPeriodEnd, -2), "deslize");
    expect(second.periodStart.getTime()).toBe(first.periodEnd.getTime());
    expect(ymd(second.periodStart)).toBe("2027-02-28");
  });
});

describe("I-2(a): changePlan não troca o ciclo em silêncio", () => {
  it("recusa upgrade para plano sem o ciclo atual, com a mensagem pedida, e não grava nada", async () => {
    const small = await makePlan({ name: "Pequeno Rev", sortOrder: 990 });
    const big = await makePlan({ name: "Grande Rev", s: null, sortOrder: 991 });
    const tenant = await makeTenant("troca-up");
    await subscribe(tenant.id, small.id, "SEMIANNUAL", addDays(new Date(), 10));

    await expect(changePlan(tenant.id, big.id)).rejects.toMatchObject({
      code: "CYCLE_NOT_AVAILABLE_ON_PLAN",
      message: "O plano Grande Rev não tem pagamento a cada 6 meses. Escolha outro ciclo antes de trocar de plano.",
    });
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    expect(sub).toMatchObject({ planId: small.id, pendingPlanId: null, billingCycle: "SEMIANNUAL" });

    // Depois de escolher outro ciclo que os dois têm (o trimestral), a troca passa e o ciclo continua o escolhido.
    await changeBillingCycle(tenant.id, "QUARTERLY");
    await expect(changePlan(tenant.id, big.id)).resolves.toEqual({ appliedImmediately: true, trialInvoiceRepriced: false });
    expect(await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenant.id } })).toMatchObject({ planId: big.id, billingCycle: "QUARTERLY" });
  });

  it("recusa também o downgrade agendado para plano sem o ciclo atual", async () => {
    const small = await makePlan({ name: "Menor Rev", a: null, sortOrder: 992 });
    const big = await makePlan({ name: "Maior Rev", sortOrder: 993 });
    const tenant = await makeTenant("troca-down");
    await subscribe(tenant.id, big.id, "ANNUAL", addDays(new Date(), 10));
    await expect(changePlan(tenant.id, small.id)).rejects.toMatchObject({
      code: "CYCLE_NOT_AVAILABLE_ON_PLAN",
      message: "O plano Menor Rev não tem pagamento a cada 12 meses. Escolha outro ciclo antes de trocar de plano.",
    });
    expect((await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenant.id } })).pendingPlanId).toBeNull();
  });

  it("quem já caiu no mensal por outro caminho (ciclo guardado que o plano atual não oferece) não fica presa", async () => {
    const a = await makePlan({ name: "A Rev", s: null, sortOrder: 994 });
    const b = await makePlan({ name: "B Rev", s: null, sortOrder: 996 });
    const tenant = await makeTenant("legado");
    await subscribe(tenant.id, a.id, "SEMIANNUAL", addDays(new Date(), 10));
    await expect(changePlan(tenant.id, b.id)).resolves.toEqual({ appliedImmediately: true, trialInvoiceRepriced: false });
  });
});

describe("I-2(c): changeBillingCycle valida contra o plano da próxima fatura", () => {
  it("com downgrade agendado, o ciclo precisa existir no plano pendente", async () => {
    const current = await makePlan({ name: "Atual Rev", sortOrder: 997 });
    const pending = await makePlan({ name: "Pendente Rev", s: null, sortOrder: 989 });
    const tenant = await makeTenant("pendente");
    await subscribe(tenant.id, current.id, "MONTHLY", addDays(new Date(), 10), pending.id);

    await expect(changeBillingCycle(tenant.id, "SEMIANNUAL")).rejects.toMatchObject({ code: "CYCLE_NOT_AVAILABLE", message: expect.stringContaining("Pendente Rev") });
    expect((await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenant.id } })).billingCycle).toBe("MONTHLY");
    await expect(changeBillingCycle(tenant.id, "QUARTERLY")).resolves.toMatchObject({ billingCycle: "QUARTERLY" });
  });
});

describe("I-2(b): apagar preço e trocar de ciclo ao mesmo tempo", () => {
  it("em 8 disputas, nunca sobra assinatura num ciclo sem preço", async () => {
    for (let i = 0; i < 8; i++) {
      const plan = await makePlan({ active: false });
      const tenant = await makeTenant(`corrida${i}`);
      await subscribe(tenant.id, plan.id, "MONTHLY", addDays(new Date(), 10));
      const settled = await Promise.allSettled([updatePlan(plan.id, { semiannualPriceCents: null }), changeBillingCycle(tenant.id, "SEMIANNUAL")]);
      // Quem perdeu a disputa recebe o erro de negócio certo (nunca um erro inesperado).
      for (const r of settled) {
        if (r.status === "rejected") expect(["CYCLE_IN_USE", "CYCLE_NOT_AVAILABLE"]).toContain((r.reason as { code?: string }).code);
      }
      const [p, s] = await Promise.all([prisma.plan.findUniqueOrThrow({ where: { id: plan.id } }), prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenant.id } })]);
      expect(p.semiannualPriceCents === null && s.billingCycle === "SEMIANNUAL", `rodada ${i}: plano sem preço semestral e assinatura semestral`).toBe(false);
    }
  });
});

describe("S-2: preço de período abaixo de 50% das mensalidades pede confirmação", () => {
  it("recusa sem confirmLowPrice, aceita com o flag (que não é gravado) e aceita 50% exato sem flag", async () => {
    const plan = await makePlan({ active: false, q: null, s: null, a: null });
    // Mensal 59,00 x 3 = 177,00; metade = 88,50.
    await expect(updatePlan(plan.id, { quarterlyPriceCents: 800 })).rejects.toMatchObject({
      code: "LOW_CYCLE_PRICE_UNCONFIRMED",
      details: { cycle: "QUARTERLY", periodCents: 800, halfOfFullCents: 8850 },
    });
    expect((await prisma.plan.findUniqueOrThrow({ where: { id: plan.id } })).quarterlyPriceCents).toBeNull();

    await expect(updatePlan(plan.id, { quarterlyPriceCents: 800, confirmLowPrice: true })).resolves.toMatchObject({ quarterlyPriceCents: 800 });
    await expect(updatePlan(plan.id, { quarterlyPriceCents: 8850 })).resolves.toMatchObject({ quarterlyPriceCents: 8850 });
  });

  it("editar outra coisa de um plano que já tem preço baixo não pede confirmação de novo, mas mudar o mensal sim", async () => {
    const plan = await makePlan({ active: false, q: 800, s: null, a: null });
    await expect(updatePlan(plan.id, { name: "Outro nome" })).resolves.toMatchObject({ name: "Outro nome" });
    await expect(updatePlan(plan.id, { priceCents: 9900 })).rejects.toMatchObject({ code: "LOW_CYCLE_PRICE_UNCONFIRMED" });
  });
});
