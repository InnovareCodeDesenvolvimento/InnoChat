/**
 * `runBillingTick` (docs/contratos.md, `POST /api/internal/v1/billing/tick`) contra Postgres
 * real: gera fatura 5 dias antes do vencimento, regenera Pix expirado, persiste mudança de
 * status e dispara e-mail — tudo IDEMPOTENTE (rodar 2x não duplica nada). `sendMail` mockado.
 */
import { randomUUID } from "node:crypto";
import { addDays } from "date-fns";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";

const sentEmails: { to: string; subject: string }[] = [];

vi.mock("@/lib/email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
  return {
    ...actual,
    sendMail: vi.fn(async (input: { to: string; subject: string }) => {
      sentEmails.push(input);
      return { sent: true };
    }),
  };
});

const { runBillingTick } = await import("@/modules/billing/tick");
const { createMockMercadoPagoGateway } = await import("@/modules/billing/mercadopago.mock");
const { createProfessional } = await import("@/modules/agenda/catalog");

const prisma = getPrisma();
const cleanupTenantIds: string[] = [];

/**
 * Hoje às 15:00 UTC: dentro da janela de e-mail da régua (08h às 20h) no fuso das empresas de teste (UTC).
 * Os avisos só saem dentro da janela, então o teste que confere e-mail não pode depender da hora em que roda.
 */
function windowNow(): Date {
  const now = new Date();
  now.setUTCHours(15, 0, 0, 0);
  return now;
}

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: cleanupTenantIds } } });
  await prisma.$disconnect();
});

async function makeTenantWithOwner(label: string) {
  const slug = `it-tick-${label}-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const tenant = await prisma.tenant.create({ data: { slug, name: `Tick ${label}`, timezone: "UTC" } });
  const user = await prisma.user.create({ data: { email: `${slug}@example.com`, passwordHash: "x", emailVerifiedAt: new Date() } });
  await prisma.membership.create({ data: { userId: user.id, tenantId: tenant.id, role: "OWNER" } });
  return { tenant, user };
}

async function makePlan(label: string, overrides: Partial<{ priceCents: number; maxProfessionals: number | null }> = {}) {
  return prisma.plan.create({
    data: {
      code: `it-tick-${label}-${Date.now()}-${randomUUID().slice(0, 6)}`,
      name: "Plano IT",
      priceCents: overrides.priceCents ?? 4990,
      maxWhatsappNumbers: 1,
      maxProfessionals: overrides.maxProfessionals ?? 1,
      active: false,
      sortOrder: 999,
    },
  });
}

describe("runBillingTick — geração de fatura (5 dias antes)", () => {
  it("gera 1 fatura para o próximo ciclo; rodar 2x não duplica", async () => {
    const { tenant } = await makeTenantWithOwner("invoice-gen");
    cleanupTenantIds.push(tenant.id);
    const plan = await makePlan("invoice-gen");

    const currentPeriodEnd = addDays(new Date(), 3); // dentro da janela de 5 dias
    const subscription = await prisma.subscription.create({
      data: { tenantId: tenant.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd },
    });

    const { gateway } = createMockMercadoPagoGateway();
    const first = await runBillingTick(new Date(), gateway);
    expect(first.invoicesCreated).toBe(1);

    const invoices = await prisma.invoice.findMany({ where: { subscriptionId: subscription.id } });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.periodStart.getTime()).toBe(currentPeriodEnd.getTime());

    const second = await runBillingTick(new Date(), gateway);
    expect(second.invoicesCreated).toBe(0);

    const invoicesAfter = await prisma.invoice.findMany({ where: { subscriptionId: subscription.id } });
    expect(invoicesAfter).toHaveLength(1); // não duplicou
  });

  it("NÃO gera fatura extra para quem ainda está em TRIALING (já tem a fatura do cadastro)", async () => {
    const { tenant } = await makeTenantWithOwner("trial-no-extra");
    cleanupTenantIds.push(tenant.id);
    const plan = await makePlan("trial-no-extra");

    const trialEndsAt = addDays(new Date(), 0.5);
    const subscription = await prisma.subscription.create({
      data: { tenantId: tenant.id, planId: plan.id, status: "TRIALING", trialEndsAt, currentPeriodEnd: trialEndsAt },
    });
    await prisma.invoice.create({
      data: { subscriptionId: subscription.id, amountCents: plan.priceCents, periodStart: new Date(), periodEnd: trialEndsAt, dueAt: trialEndsAt, status: "OPEN" },
    });

    const { gateway } = createMockMercadoPagoGateway();
    const result = await runBillingTick(new Date(), gateway);
    expect(result.invoicesCreated).toBe(0);

    const invoices = await prisma.invoice.findMany({ where: { subscriptionId: subscription.id } });
    expect(invoices).toHaveLength(1);
  });
});

describe("runBillingTick — regeneração de Pix expirado", () => {
  it("regera o Pix de uma fatura OPEN com pixExpiresAt vencido", async () => {
    const { tenant } = await makeTenantWithOwner("pix-expired");
    cleanupTenantIds.push(tenant.id);
    // O Mercado Pago exige CPF/CNPJ do pagador para Pix (`payer.identification`) — sem
    // `Tenant.document`, `createPixPayment` falha cedo com `missing_payer_document` e o tick só
    // loga e segue (nunca derruba), o que faria este teste falhar por um motivo NÃO relacionado
    // à regeneração em si.
    await prisma.tenant.update({ where: { id: tenant.id }, data: { document: "52998224725" } });
    const plan = await makePlan("pix-expired");
    const currentPeriodEnd = addDays(new Date(), 20); // fora da janela de geração de fatura
    const subscription = await prisma.subscription.create({ data: { tenantId: tenant.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd } });
    const invoice = await prisma.invoice.create({
      data: {
        subscriptionId: subscription.id,
        amountCents: plan.priceCents,
        periodStart: new Date(0),
        periodEnd: currentPeriodEnd,
        dueAt: addDays(new Date(), 10),
        status: "OPEN",
        pixQrCode: "old-qr",
        pixCopyPaste: "old-copy-paste",
        pixExpiresAt: addDays(new Date(), -1), // expirado
      },
    });

    const { gateway } = createMockMercadoPagoGateway();
    const result = await runBillingTick(new Date(), gateway);
    expect(result.pixRegenerated).toBe(1);

    const reloaded = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(reloaded.pixCopyPaste).not.toBe("old-copy-paste");
    expect(reloaded.pixExpiresAt!.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("runBillingTick — reconciliação de status e e-mail de suspensão", () => {
  it("TRIALING vencido sem pagar → PAST_DUE → (rodando de novo mais tarde) mantém consistência sem duplicar e-mail", async () => {
    const { tenant } = await makeTenantWithOwner("status-past-due");
    cleanupTenantIds.push(tenant.id);
    const plan = await makePlan("status-past-due");

    const trialEndsAt = new Date(Date.now() - 12 * 60 * 60 * 1000); // trial venceu há 12h (dentro da carência de 1 dia)
    await prisma.subscription.create({
      data: { tenantId: tenant.id, planId: plan.id, status: "TRIALING", trialEndsAt, currentPeriodEnd: trialEndsAt },
    });

    const { gateway } = createMockMercadoPagoGateway();
    const result = await runBillingTick(new Date(), gateway);
    expect(result.statusChanges).toBe(1);

    const reloaded = await prisma.subscription.findFirstOrThrow({ where: { tenantId: tenant.id } });
    expect(reloaded.status).toBe("PAST_DUE");

    // Rodar de novo no mesmo instante não muda nada de novo.
    const secondRun = await runBillingTick(new Date(), gateway);
    expect(secondRun.statusChanges).toBe(0);
  });

  it("SUSPENDED dispara e-mail de suspensão 1x só, mesmo rodando o tick várias vezes", async () => {
    const { tenant } = await makeTenantWithOwner("status-suspended");
    cleanupTenantIds.push(tenant.id);
    const plan = await makePlan("status-suspended");

    // currentPeriodEnd + carência já vencidos → efetivo SUSPENDED já na primeira rodada.
    const currentPeriodEnd = addDays(new Date(), -5);
    await prisma.subscription.create({
      data: { tenantId: tenant.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd, firstPaidAt: addDays(new Date(), -40) },
    });

    const { gateway } = createMockMercadoPagoGateway();
    const now = windowNow();
    const first = await runBillingTick(now, gateway);
    expect(first.suspensionEmailsSent).toBe(1);

    const second = await runBillingTick(now, gateway);
    expect(second.suspensionEmailsSent).toBe(0);

    const suspensionEmails = sentEmails.filter((e) => e.subject.includes("suspenso"));
    expect(suspensionEmails).toHaveLength(1);
  });

  it("60+ dias em SUSPENDED vira CANCELED e persiste `canceledAt` (correção 2026-09-28 — sem isto, a anonimização de LGPD nunca teria data de referência)", async () => {
    const { tenant } = await makeTenantWithOwner("status-canceled");
    cleanupTenantIds.push(tenant.id);
    const plan = await makePlan("status-canceled");

    // Vencido há bem mais que carência (1 dia) + 60 dias em SUSPENDED → efetivo já CANCELED.
    const currentPeriodEnd = addDays(new Date(), -70);
    await prisma.subscription.create({
      data: { tenantId: tenant.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd, firstPaidAt: addDays(new Date(), -100) },
    });

    const { gateway } = createMockMercadoPagoGateway();
    const now = new Date();
    await runBillingTick(now, gateway);

    const reloaded = await prisma.subscription.findFirstOrThrow({ where: { tenantId: tenant.id } });
    expect(reloaded.status).toBe("CANCELED");
    expect(reloaded.canceledAt).not.toBeNull();
    expect(reloaded.canceledAt!.getTime()).toBe(now.getTime());
  });
});

describe("runBillingTick — teste não convertido (decisão do dono, 2026-09-29)", () => {
  async function makeUnconvertedTrial(label: string, trialEndedDaysAgo: number) {
    const { tenant } = await makeTenantWithOwner(label);
    cleanupTenantIds.push(tenant.id);
    const plan = await makePlan(label);
    const trialEndsAt = addDays(new Date(), -trialEndedDaysAgo);
    const subscription = await prisma.subscription.create({
      data: { tenantId: tenant.id, planId: plan.id, status: "TRIALING", trialEndsAt, currentPeriodEnd: trialEndsAt },
    });
    const invoice = await prisma.invoice.create({
      data: {
        subscriptionId: subscription.id,
        amountCents: plan.priceCents,
        periodStart: addDays(trialEndsAt, -3),
        periodEnd: trialEndsAt,
        dueAt: trialEndsAt,
        status: "OPEN",
        isTrialConversion: true,
      },
    });
    return { tenant, subscription, invoice };
  }

  it("suspensão de teste manda o e-mail 'seu teste terminou' (não 'falta de pagamento') e NÃO gera 2ª fatura", async () => {
    const { subscription } = await makeUnconvertedTrial("trial-suspend", 3);
    const { gateway } = createMockMercadoPagoGateway();
    const result = await runBillingTick(windowNow(), gateway);
    expect(result.suspensionEmailsSent).toBeGreaterThanOrEqual(1);

    const reloaded = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(reloaded.status).toBe("SUSPENDED");
    expect(await prisma.invoice.count({ where: { subscriptionId: subscription.id } })).toBe(1);

    expect(sentEmails.some((e) => e.to.startsWith("it-tick-trial-suspend-") && e.subject.includes("teste terminou"))).toBe(true);
    expect(sentEmails.some((e) => e.to.startsWith("it-tick-trial-suspend-") && e.subject.includes("suspenso"))).toBe(false);
  });

  it("conta cancela 1+7 dias após o fim do teste e a fatura OPEN vira VOID; rodar de novo é idempotente", async () => {
    const { subscription, invoice } = await makeUnconvertedTrial("trial-cancel", 9);
    const { gateway } = createMockMercadoPagoGateway();
    const first = await runBillingTick(new Date(), gateway);
    expect(first.invoicesVoided).toBeGreaterThanOrEqual(1);

    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).status).toBe("CANCELED");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("VOID");

    const second = await runBillingTick(new Date(), gateway);
    expect(second.invoicesVoided).toBe(0);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("VOID");
  });

  it("ainda SUSPENDED (fatura OPEN) antes de completar os 7 dias de suspensão", async () => {
    const { subscription, invoice } = await makeUnconvertedTrial("trial-not-yet", 7);
    const { gateway } = createMockMercadoPagoGateway();
    await runBillingTick(new Date(), gateway);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).status).toBe("SUSPENDED");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("OPEN");
  });

  it("ex-pagante segue com 60 dias: 9 dias após o vencimento continua SUSPENDED e a fatura não é anulada", async () => {
    const { tenant } = await makeTenantWithOwner("paid-before");
    cleanupTenantIds.push(tenant.id);
    const plan = await makePlan("paid-before");
    const end = addDays(new Date(), -9);
    const subscription = await prisma.subscription.create({
      data: { tenantId: tenant.id, planId: plan.id, status: "SUSPENDED", currentPeriodEnd: end, firstPaidAt: addDays(new Date(), -60) },
    });
    const invoice = await prisma.invoice.create({
      data: { subscriptionId: subscription.id, amountCents: 100, periodStart: addDays(end, -30), periodEnd: end, dueAt: end, status: "OPEN" },
    });
    const { gateway } = createMockMercadoPagoGateway();
    await runBillingTick(new Date(), gateway);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).status).toBe("SUSPENDED");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("OPEN");
  });

  it("fatura VOID não recebe Pix novo nem lembrete de vencimento", async () => {
    const { subscription, invoice } = await makeUnconvertedTrial("trial-void-quiet", 20);
    await prisma.subscription.update({ where: { id: subscription.id }, data: { status: "CANCELED", canceledAt: new Date() } });
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "VOID" } });

    const mailsBefore = sentEmails.length;
    const { gateway } = createMockMercadoPagoGateway();
    await runBillingTick(new Date(), gateway);

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(after.status).toBe("VOID");
    expect(after.pixCopyPaste).toBeNull();
    expect(await prisma.billingNotice.count({ where: { invoiceId: invoice.id } })).toBe(0);
    expect(sentEmails.slice(mailsBefore).some((e) => e.to.startsWith("it-tick-trial-void-quiet-"))).toBe(false);
  });

  it("conta cancelada pelo dono (não pelo tick) também tem a fatura de teste anulada na rodada seguinte", async () => {
    const { subscription, invoice } = await makeUnconvertedTrial("trial-owner-cancel", 0);
    await prisma.subscription.update({ where: { id: subscription.id }, data: { status: "CANCELED", canceledAt: new Date() } });
    const { gateway } = createMockMercadoPagoGateway();
    await runBillingTick(new Date(), gateway);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("VOID");
  });
});

describe("Limite de profissionais por plano (§7.2) — checado no servidor", () => {
  it("bloqueia criar profissional além do limite do plano (PLAN_LIMIT_REACHED)", async () => {
    const { tenant } = await makeTenantWithOwner("plan-limit");
    cleanupTenantIds.push(tenant.id);
    const plan = await makePlan("plan-limit", { maxProfessionals: 1 });
    await prisma.subscription.create({ data: { tenantId: tenant.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd: addDays(new Date(), 30) } });

    await createProfessional(tenant.id, { name: "Primeiro", active: true, sortOrder: 0 });
    await expect(createProfessional(tenant.id, { name: "Segundo", active: true, sortOrder: 1 })).rejects.toMatchObject({
      code: "PLAN_LIMIT_REACHED",
    });
  });

  it("override em Tenant tem precedência sobre o limite do plano", async () => {
    const { tenant } = await makeTenantWithOwner("plan-limit-override");
    cleanupTenantIds.push(tenant.id);
    const plan = await makePlan("plan-limit-override", { maxProfessionals: 1 });
    await prisma.subscription.create({ data: { tenantId: tenant.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd: addDays(new Date(), 30) } });
    await prisma.tenant.update({ where: { id: tenant.id }, data: { maxProfessionalsOverride: 2 } });

    await createProfessional(tenant.id, { name: "Primeiro", active: true, sortOrder: 0 });
    await createProfessional(tenant.id, { name: "Segundo", active: true, sortOrder: 1 });
    await expect(createProfessional(tenant.id, { name: "Terceiro", active: true, sortOrder: 2 })).rejects.toMatchObject({
      code: "PLAN_LIMIT_REACHED",
    });
  });
});
