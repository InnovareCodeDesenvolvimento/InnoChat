/**
 * F0 da régua de cobrança (docs/regua-de-cobranca.md): e-mail que não saiu não vira "enviado"
 * (R1-R3), "vence hoje" só até 24h depois do vencimento (R6), e-mail do cancelamento automático
 * (R4), tick com trava (R8) e descrição do Pix sem travessão (R16). `sendMail` mockado e
 * controlável; Postgres real.
 */
import { randomUUID } from "node:crypto";
import { addDays, addHours, addMinutes } from "date-fns";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";

type SentMail = { to: string; subject: string; text: string };
const sentEmails: SentMail[] = [];
const mailControl: { mode: "ok" | "fail" | "not_configured" | "throw"; gate: Promise<void> | null; onCall: (() => void) | null } = {
  mode: "ok",
  gate: null,
  onCall: null,
};

vi.mock("@/lib/email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
  return {
    ...actual,
    sendMail: vi.fn(async (input: SentMail) => {
      mailControl.onCall?.();
      if (mailControl.gate) await mailControl.gate;
      if (mailControl.mode === "not_configured") throw new actual.SmtpNotConfiguredError();
      if (mailControl.mode === "throw") throw new Error("boom");
      if (mailControl.mode === "fail") return { sent: false };
      sentEmails.push(input);
      return { sent: true };
    }),
  };
});

const { runBillingTick, BILLING_TICK_LOCK_NAME } = await import("@/modules/billing/tick");
const { withAdvisoryLock } = await import("@/lib/db/advisory-lock");
const { generateInvoiceDescription } = await import("@/modules/billing/service");
const { createMockMercadoPagoGateway } = await import("@/modules/billing/mercadopago.mock");
const { listPlatformNotifications } = await import("@/modules/platform-notifications/service");

const prisma = getPrisma();
const cleanupTenantIds: string[] = [];
const cleanupUserIds: string[] = [];

beforeEach(() => {
  sentEmails.length = 0;
  mailControl.mode = "ok";
  mailControl.gate = null;
  mailControl.onCall = null;
});

afterAll(async () => {
  await prisma.providerEvent.deleteMany({ where: { provider: "billing-email" } });
  await prisma.tenant.deleteMany({ where: { id: { in: cleanupTenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await prisma.$disconnect();
});

async function makeTenantWithOwner(label: string) {
  const slug = `it-f0-${label}-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const tenant = await prisma.tenant.create({ data: { slug, name: `F0 ${label}`, timezone: "UTC" } });
  cleanupTenantIds.push(tenant.id);
  const email = `${slug}@example.com`;
  const user = await prisma.user.create({ data: { email, passwordHash: "x", emailVerifiedAt: new Date() } });
  cleanupUserIds.push(user.id);
  await prisma.membership.create({ data: { userId: user.id, tenantId: tenant.id, role: "OWNER" } });
  return { tenant, email };
}

async function makePlan(label: string) {
  return prisma.plan.create({
    data: {
      code: `it-f0-${label}-${Date.now()}-${randomUUID().slice(0, 6)}`,
      name: "Plano F0",
      priceCents: 4990,
      maxWhatsappNumbers: 1,
      maxProfessionals: 1,
      active: false,
      sortOrder: 999,
    },
  });
}

/** Assinatura ACTIVE com UMA fatura OPEN vencendo em `dueAt` (fora da janela de geração de fatura nova). */
async function makeOpenInvoice(label: string, dueAt: Date) {
  const { tenant, email } = await makeTenantWithOwner(label);
  const plan = await makePlan(label);
  const subscription = await prisma.subscription.create({
    data: { tenantId: tenant.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd: addDays(new Date(), 20), firstPaidAt: addDays(new Date(), -30) },
  });
  const invoice = await prisma.invoice.create({
    data: {
      subscriptionId: subscription.id,
      amountCents: 4990,
      periodStart: addDays(dueAt, -30),
      periodEnd: dueAt,
      dueAt,
      status: "OPEN",
      pixCopyPaste: "pix-copia-e-cola",
      pixExpiresAt: addDays(new Date(), 2),
    },
  });
  return { tenant, email, subscription, invoice };
}

const mailsTo = (email: string) => sentEmails.filter((m) => m.to === email);
const suspensionMails = (email: string) => mailsTo(email).filter((m) => m.subject.includes("suspenso"));

describe("F0 R1/R3: e-mail que não saiu não grava a marca *SentAt", () => {
  it("lembrete de véspera: SMTP falhando ({sent:false}) não marca; a próxima rodada envia", async () => {
    const { email, invoice } = await makeOpenInvoice("due-fail", addHours(new Date(), 10));
    const { gateway } = createMockMercadoPagoGateway();

    mailControl.mode = "fail";
    const failed = await runBillingTick(new Date(), gateway);
    expect(failed.emailsFailed).toBeGreaterThanOrEqual(1);
    expect(failed.remindersSent).toBe(0);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).dueReminderEmailSentAt).toBeNull();

    mailControl.mode = "ok";
    await runBillingTick(new Date(), gateway);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).dueReminderEmailSentAt).not.toBeNull();
    expect(mailsTo(email)).toHaveLength(1);

    await runBillingTick(new Date(), gateway); // marcado: não duplica
    expect(mailsTo(email)).toHaveLength(1);
  });

  it("SmtpNotConfiguredError e erro inesperado também não marcam", async () => {
    const { invoice } = await makeOpenInvoice("due-throw", addHours(new Date(), 10));
    const { gateway } = createMockMercadoPagoGateway();

    for (const mode of ["not_configured", "throw"] as const) {
      mailControl.mode = mode;
      await runBillingTick(new Date(), gateway);
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).dueReminderEmailSentAt).toBeNull();
    }
  });

  it("suspensão: falha não marca `suspendedEmailSentAt`; a próxima rodada envia 1 vez só", async () => {
    const { tenant, email } = await makeTenantWithOwner("susp-fail");
    const plan = await makePlan("susp-fail");
    const subscription = await prisma.subscription.create({
      data: { tenantId: tenant.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd: addDays(new Date(), -5), firstPaidAt: addDays(new Date(), -40) },
    });
    const { gateway } = createMockMercadoPagoGateway();

    mailControl.mode = "fail";
    await runBillingTick(new Date(), gateway);
    const afterFail = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(afterFail.status).toBe("SUSPENDED"); // o status avançou, o e-mail ficou pendente
    expect(afterFail.suspendedEmailSentAt).toBeNull();

    mailControl.mode = "ok";
    const retry = await runBillingTick(new Date(), gateway);
    expect(retry.suspensionEmailsSent).toBeGreaterThanOrEqual(1);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).suspendedEmailSentAt).not.toBeNull();
    expect(suspensionMails(email)).toHaveLength(1);

    await runBillingTick(new Date(), gateway);
    expect(suspensionMails(email)).toHaveLength(1);
  });
});

describe("F0 R2: e-mail de fatura gerada (envio único, com nova tentativa)", () => {
  it("falha na criação não perde o aviso: a rodada seguinte envia, uma vez só", async () => {
    const { tenant, email } = await makeTenantWithOwner("gen-fail");
    const plan = await makePlan("gen-fail");
    const subscription = await prisma.subscription.create({
      data: { tenantId: tenant.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd: addDays(new Date(), 3), firstPaidAt: addDays(new Date(), -27) },
    });
    const { gateway } = createMockMercadoPagoGateway();

    mailControl.mode = "fail";
    const first = await runBillingTick(new Date(), gateway);
    expect(first.invoicesCreated).toBe(1);
    expect(first.emailsFailed).toBeGreaterThanOrEqual(1);
    expect(mailsTo(email)).toHaveLength(0);

    mailControl.mode = "ok";
    // O reenvio espera 10 min (a 1a tentativa pode estar em curso): a rodada seguinte "11 min depois".
    await runBillingTick(addMinutes(new Date(), 11), gateway);
    expect(mailsTo(email).filter((m) => m.subject.toLowerCase().includes("fatura"))).toHaveLength(1);

    await runBillingTick(new Date(), gateway);
    expect(mailsTo(email).filter((m) => m.subject.toLowerCase().includes("fatura"))).toHaveLength(1);
    expect(await prisma.invoice.count({ where: { subscriptionId: subscription.id } })).toBe(1);
  });

  it("SMTP ok na criação: envia 1 vez e não repete nas rodadas seguintes", async () => {
    const { tenant, email } = await makeTenantWithOwner("gen-ok");
    const plan = await makePlan("gen-ok");
    await prisma.subscription.create({
      data: { tenantId: tenant.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd: addDays(new Date(), 3), firstPaidAt: addDays(new Date(), -27) },
    });
    const { gateway } = createMockMercadoPagoGateway();
    await runBillingTick(new Date(), gateway);
    await runBillingTick(new Date(), gateway);
    expect(mailsTo(email)).toHaveLength(1);
  });
});

describe("F0 R1: aviso no sino do Admin quando o e-mail não sai", () => {
  it("emailsFailed > 0 no último tick vira BILLING_EMAIL_FAILING (derivado, sem tabela)", async () => {
    await makeOpenInvoice("bell", addHours(new Date(), 10));
    const { gateway } = createMockMercadoPagoGateway();
    mailControl.mode = "fail";
    await runBillingTick(new Date(), gateway);

    const admin = await prisma.user.create({ data: { email: `it-f0-admin-${randomUUID()}@example.com`, passwordHash: "x", emailVerifiedAt: new Date() } });
    cleanupUserIds.push(admin.id);
    const { items } = await listPlatformNotifications(admin.id);
    const alert = items.find((item) => item.kind === "BILLING_EMAIL_FAILING");
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe("danger");
    expect(alert!.body).not.toMatch(/@/); // nenhum e-mail/dado pessoal no texto
  });
});

describe("F0 R6: 'vence hoje' só até 24h depois do vencimento", () => {
  it("venceu há 2h: envia o 'vence hoje'", async () => {
    const { email, invoice } = await makeOpenInvoice("today-in", addHours(new Date(), -2));
    const { gateway } = createMockMercadoPagoGateway();
    await runBillingTick(new Date(), gateway);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).dueTodayEmailSentAt).not.toBeNull();
    expect(mailsTo(email)).toHaveLength(1);
  });

  it("venceu há 30h (fora da janela): não envia e não marca", async () => {
    const { email, invoice } = await makeOpenInvoice("today-out", addHours(new Date(), -30));
    const { gateway } = createMockMercadoPagoGateway();
    await runBillingTick(new Date(), gateway);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).dueTodayEmailSentAt).toBeNull();
    expect(mailsTo(email)).toHaveLength(0);
  });
});

describe("F0 R4: cancelamento automático avisa o dono (uma vez)", () => {
  it("60 dias suspensa: e-mail de conta encerrada com dados guardados, reativação e CSV; rodar de novo não repete", async () => {
    const { tenant, email } = await makeTenantWithOwner("auto-cancel");
    const plan = await makePlan("auto-cancel");
    const subscription = await prisma.subscription.create({
      data: { tenantId: tenant.id, planId: plan.id, status: "SUSPENDED", currentPeriodEnd: addDays(new Date(), -70), firstPaidAt: addDays(new Date(), -100), suspendedEmailSentAt: new Date() },
    });
    const { gateway } = createMockMercadoPagoGateway();

    await runBillingTick(new Date(), gateway);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).status).toBe("CANCELED");
    const mails = mailsTo(email);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toContain("foi encerrada");
    expect(mails[0]!.text).toContain("60 dias");
    expect(mails[0]!.text).toContain("90 dias");
    expect(mails[0]!.text).toMatch(/Reative/i);
    expect(mails[0]!.text).toContain("CSV");
    expect(mails[0]!.text).not.toContain("—");

    await runBillingTick(new Date(), gateway);
    await runBillingTick(new Date(), gateway);
    expect(mailsTo(email)).toHaveLength(1);
  });

  it("teste não convertido (7 dias): texto de teste; SMTP fora no cancelamento: reenvia depois, 1 vez só", async () => {
    const { tenant, email } = await makeTenantWithOwner("auto-cancel-trial");
    const plan = await makePlan("auto-cancel-trial");
    const ended = addDays(new Date(), -10);
    const subscription = await prisma.subscription.create({
      data: { tenantId: tenant.id, planId: plan.id, status: "SUSPENDED", trialEndsAt: ended, currentPeriodEnd: ended, firstPaidAt: null, suspendedEmailSentAt: new Date() },
    });
    const { gateway } = createMockMercadoPagoGateway();

    mailControl.mode = "fail";
    await runBillingTick(new Date(), gateway);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).status).toBe("CANCELED"); // o cancelamento não depende do e-mail
    expect(mailsTo(email)).toHaveLength(0);

    mailControl.mode = "ok";
    await runBillingTick(addMinutes(new Date(), 11), gateway);
    const mails = mailsTo(email);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain("teste terminou");
    expect(mails[0]!.text).toContain("7 dias");

    await runBillingTick(new Date(), gateway);
    expect(mailsTo(email)).toHaveLength(1);
  });

  it("cancelamento agendado pelo dono NÃO dispara o e-mail de cancelamento automático", async () => {
    const { tenant, email } = await makeTenantWithOwner("sched-cancel");
    const plan = await makePlan("sched-cancel");
    await prisma.subscription.create({
      data: { tenantId: tenant.id, planId: plan.id, status: "ACTIVE", cancelAtPeriodEnd: true, cancelRequestedAt: addDays(new Date(), -10), currentPeriodEnd: addDays(new Date(), -1), firstPaidAt: addDays(new Date(), -40) },
    });
    const { gateway } = createMockMercadoPagoGateway();
    await runBillingTick(new Date(), gateway);
    expect(mailsTo(email)).toHaveLength(0);
  });
});

describe("F0 R8: um tick por vez (advisory lock)", () => {
  it("trava já tomada: o tick sai sem fazer nada e sem enviar e-mail", async () => {
    const { email } = await makeOpenInvoice("lock-held", addHours(new Date(), 10));
    const { gateway } = createMockMercadoPagoGateway();

    const outcome = await withAdvisoryLock(BILLING_TICK_LOCK_NAME, async () => runBillingTick(new Date(), gateway));
    expect(outcome.acquired).toBe(true);
    if (!outcome.acquired) return;
    expect(outcome.value.skippedByLock).toBe(true);
    expect(outcome.value.remindersSent).toBe(0);
    expect(mailsTo(email)).toHaveLength(0);

    // Trava solta ao fim: o tick seguinte trabalha normalmente.
    const next = await runBillingTick(new Date(), gateway);
    expect(next.skippedByLock).toBeUndefined();
    expect(mailsTo(email)).toHaveLength(1);
  });

  it("dois ticks concorrentes: o segundo sai na hora e o e-mail sai 1 vez só", async () => {
    const { email } = await makeOpenInvoice("lock-concurrent", addHours(new Date(), 10));
    const { gateway } = createMockMercadoPagoGateway();

    let release!: () => void;
    mailControl.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      mailControl.onCall = () => resolve();
    });

    const first = runBillingTick(new Date(), gateway); // trava e fica parado dentro do envio
    await started;
    const second = await runBillingTick(new Date(), gateway);
    expect(second.skippedByLock).toBe(true);

    release();
    const firstResult = await first;
    expect(firstResult.skippedByLock).toBeUndefined();
    expect(mailsTo(email)).toHaveLength(1);
  });

  it("erro no meio do tick não deixa a trava presa", async () => {
    const outcome = withAdvisoryLock(BILLING_TICK_LOCK_NAME, async () => {
      throw new Error("falha no meio");
    });
    await expect(outcome).rejects.toThrow("falha no meio");
    const again = await withAdvisoryLock(BILLING_TICK_LOCK_NAME, async () => "ok");
    expect(again).toEqual({ acquired: true, value: "ok" });
  });
});

describe("F0 R16: descrição do pagamento no Mercado Pago", () => {
  it("sem travessão: 'Assinatura InnoChat (empresa)'", () => {
    expect(generateInvoiceDescription("Salão da Ana")).toBe("Assinatura InnoChat (Salão da Ana)");
  });
});
