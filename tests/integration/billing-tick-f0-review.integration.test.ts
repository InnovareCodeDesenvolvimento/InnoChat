/**
 * Revisão do Órion à F0 da régua (I-1 a I-4, S-4, S-5): suspensão manual sem e-mail de cobrança,
 * exceção fora de `sendBillingMail` isolada por item, abort por prazo, reconsulta antes de enviar,
 * espera de 10 min no reenvio e reativação sem "conta encerrada". `sendMail` mockado; Postgres real.
 */
import { randomUUID } from "node:crypto";
import { addDays, addHours, addMinutes } from "date-fns";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";

type SentMail = { to: string; subject: string; text: string };
const sentEmails: SentMail[] = [];
const control = vi.hoisted(() => ({
  mode: "ok" as "ok" | "fail",
  beforeSend: null as null | ((input: { to: string }) => Promise<void>),
  publicUrlThrows: false,
}));

vi.mock("@/lib/email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
  return {
    ...actual,
    sendMail: vi.fn(async (input: SentMail) => {
      await control.beforeSend?.(input);
      if (control.mode === "fail") return { sent: false };
      sentEmails.push(input);
      return { sent: true };
    }),
  };
});

vi.mock("@/lib/public-url", async () => {
  const actual = await vi.importActual<typeof import("@/lib/public-url")>("@/lib/public-url");
  return {
    ...actual,
    getPublicBaseUrl: vi.fn(async () => {
      if (control.publicUrlThrows) throw new Error("PUBLIC_URL_UNKNOWN");
      return actual.getPublicBaseUrl();
    }),
  };
});

const { runBillingTick } = await import("@/modules/billing/tick");
const { suspendCompanyManually } = await import("@/modules/billing/admin-service");
const { startReactivation } = await import("@/modules/billing/cancellation");
const { createMockMercadoPagoGateway } = await import("@/modules/billing/mercadopago.mock");
const { runMaintenanceTick } = await import("@/modules/maintenance/tick");

const prisma = getPrisma();
const cleanupTenantIds: string[] = [];
const cleanupUserIds: string[] = [];
const cleanupPlanIds: string[] = [];

beforeEach(() => {
  sentEmails.length = 0;
  control.mode = "ok";
  control.beforeSend = null;
  control.publicUrlThrows = false;
});

afterAll(async () => {
  await prisma.providerEvent.deleteMany({ where: { provider: "billing-email" } });
  await prisma.tenant.deleteMany({ where: { id: { in: cleanupTenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await prisma.plan.deleteMany({ where: { id: { in: cleanupPlanIds } } });
  await prisma.$disconnect();
});

async function makeTenantWithOwner(label: string) {
  const slug = `it-f0r-${label}-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const tenant = await prisma.tenant.create({ data: { slug, name: `F0R ${label}`, timezone: "UTC" } });
  cleanupTenantIds.push(tenant.id);
  const email = `${slug}@example.com`;
  const user = await prisma.user.create({ data: { email, passwordHash: "x", emailVerifiedAt: new Date() } });
  cleanupUserIds.push(user.id);
  await prisma.membership.create({ data: { userId: user.id, tenantId: tenant.id, role: "OWNER" } });
  return { tenant, email };
}

async function makePlan(label: string) {
  const plan = await prisma.plan.create({
    data: { code: `it-f0r-${label}-${Date.now()}-${randomUUID().slice(0, 6)}`, name: "Plano F0R", priceCents: 4990, maxWhatsappNumbers: 1, maxProfessionals: 1, active: false, sortOrder: 999 },
  });
  cleanupPlanIds.push(plan.id);
  return plan;
}

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

describe("I-2: suspensão manual do admin não manda e-mail de cobrança", () => {
  it("suspendCompanyManually grava a marca e o tick não envia 'suspenso'", async () => {
    const { tenant, email } = await makeTenantWithOwner("manual-susp");
    const plan = await makePlan("manual-susp");
    const subscription = await prisma.subscription.create({
      data: { tenantId: tenant.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd: addDays(new Date(), 20), firstPaidAt: addDays(new Date(), -10) },
    });

    await suspendCompanyManually(tenant.id);
    const suspended = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(suspended.status).toBe("SUSPENDED");
    expect(suspended.suspendedEmailSentAt).not.toBeNull();

    const { gateway } = createMockMercadoPagoGateway();
    await runBillingTick(new Date(), gateway);
    await runBillingTick(new Date(), gateway);
    expect(mailsTo(email)).toHaveLength(0);
  });
});

describe("I-3: exceção fora de sendBillingMail não aborta o tick", () => {
  it("billingUrlFor lançando: o lembrete conta como falha e as etapas seguintes (anular fatura de teste cancelado) rodam", async () => {
    await makeOpenInvoice("url-throws", addHours(new Date(), 10));

    // Etapa que roda DEPOIS dos envios: fatura de teste cancelado deve ser anulada.
    const { tenant: canceledTenant } = await makeTenantWithOwner("url-throws-trial");
    const plan = await makePlan("url-throws-trial");
    const canceledSub = await prisma.subscription.create({
      data: { tenantId: canceledTenant.id, planId: plan.id, status: "CANCELED", canceledAt: new Date(), currentPeriodEnd: addDays(new Date(), -1), firstPaidAt: null },
    });
    const trialInvoice = await prisma.invoice.create({
      data: {
        subscriptionId: canceledSub.id,
        amountCents: 4990,
        periodStart: addDays(new Date(), -3),
        periodEnd: addDays(new Date(), 27),
        dueAt: addDays(new Date(), 1),
        status: "OPEN",
        isTrialConversion: true,
      },
    });

    control.publicUrlThrows = true;
    const { gateway } = createMockMercadoPagoGateway();
    const summary = await runBillingTick(new Date(), gateway);

    expect(summary.emailsFailed).toBeGreaterThanOrEqual(1);
    expect(summary.remindersSent).toBe(0);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: trialInvoice.id } })).status).toBe("VOID");
  });

  it("depois que a URL volta, a rodada seguinte envia o lembrete que ficou sem marca", async () => {
    const { email, invoice } = await makeOpenInvoice("url-recovers", addHours(new Date(), 10));
    const { gateway } = createMockMercadoPagoGateway();

    control.publicUrlThrows = true;
    await runBillingTick(new Date(), gateway);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).dueReminderEmailSentAt).toBeNull();

    control.publicUrlThrows = false;
    await runBillingTick(new Date(), gateway);
    expect(mailsTo(email)).toHaveLength(1);
  });
});

describe("I-1: abort por prazo deixa o resto para a próxima rodada", () => {
  it("orçamento estourado: nada é enviado, deadlineReached avisa e a rodada seguinte envia 1 vez só", async () => {
    const { email, invoice } = await makeOpenInvoice("deadline", addHours(new Date(), 10));
    const { gateway } = createMockMercadoPagoGateway();

    const aborted = await runBillingTick(new Date(), gateway, { budgetMs: 0 });
    expect(aborted.deadlineReached).toBe(true);
    expect(aborted.skippedByLock).toBeUndefined();
    expect(mailsTo(email)).toHaveLength(0);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).dueReminderEmailSentAt).toBeNull();

    const next = await runBillingTick(new Date(), gateway);
    expect(next.deadlineReached).toBeUndefined();
    expect(mailsTo(email)).toHaveLength(1);

    await runBillingTick(new Date(), gateway);
    expect(mailsTo(email)).toHaveLength(1);
  });

  it("estoura NO MEIO do laço: o enviado fica marcado, o restante sai na rodada seguinte, sem duplicar", async () => {
    const first = await makeOpenInvoice("deadline-mid-a", addHours(new Date(), 3));
    const second = await makeOpenInvoice("deadline-mid-b", addHours(new Date(), 6));
    const { gateway } = createMockMercadoPagoGateway();

    // O 1º envio demora mais que o orçamento: ao voltar, o laço para antes do 2º.
    control.beforeSend = async (input) => {
      if (input.to === first.email) await new Promise((resolve) => setTimeout(resolve, 600));
    };
    const partial = await runBillingTick(new Date(), gateway, { budgetMs: 300 });
    control.beforeSend = null;
    expect(partial.deadlineReached).toBe(true);

    const rest = await runBillingTick(new Date(), gateway);
    expect(rest.deadlineReached).toBeUndefined();
    await runBillingTick(new Date(), gateway);
    expect(mailsTo(first.email)).toHaveLength(1);
    expect(mailsTo(second.email)).toHaveLength(1);
  });
});

describe("S-4: reconsulta logo antes de enviar", () => {
  it("fatura paga no meio do laço não recebe o lembrete", async () => {
    const a = await makeOpenInvoice("paid-mid-a", addHours(new Date(), 4));
    const b = await makeOpenInvoice("paid-mid-b", addHours(new Date(), 8));
    const { gateway } = createMockMercadoPagoGateway();

    // Ao enviar para A (1ª da fila), a fatura de B é paga: B não pode receber o lembrete.
    control.beforeSend = async (input) => {
      if (input.to === a.email) await prisma.invoice.update({ where: { id: b.invoice.id }, data: { status: "PAID", paidAt: new Date() } });
    };
    await runBillingTick(new Date(), gateway);

    expect(mailsTo(a.email)).toHaveLength(1);
    expect(mailsTo(b.email)).toHaveLength(0);
  });

  it("conta reativada (saiu de SUSPENDED) no meio do laço não recebe 'suspenso'", async () => {
    const mk = async (label: string) => {
      const { tenant, email } = await makeTenantWithOwner(label);
      const plan = await makePlan(label);
      const subscription = await prisma.subscription.create({
        data: { tenantId: tenant.id, planId: plan.id, status: "SUSPENDED", currentPeriodEnd: addDays(new Date(), -3), firstPaidAt: addDays(new Date(), -40) },
      });
      return { email, subscription };
    };
    const a = await mk("susp-mid-a");
    const b = await mk("susp-mid-b");
    const { gateway } = createMockMercadoPagoGateway();

    control.beforeSend = async (input) => {
      // A fila é por currentPeriodEnd; ao enviar para um, o outro é reativado.
      const other = input.to === a.email ? b : input.to === b.email ? a : null;
      if (other) await prisma.subscription.update({ where: { id: other.subscription.id }, data: { status: "ACTIVE", currentPeriodEnd: addDays(new Date(), 20) } });
    };
    await runBillingTick(new Date(), gateway);

    const received = [a, b].filter((x) => mailsTo(x.email).length > 0);
    expect(received).toHaveLength(1); // só o 1º da fila; o 2º foi reativado antes do envio
  });
});

describe("I-4: cancelamento automático", () => {
  async function makeSuspendedLong(label: string) {
    const { tenant, email } = await makeTenantWithOwner(label);
    const plan = await makePlan(label);
    const subscription = await prisma.subscription.create({
      data: { tenantId: tenant.id, planId: plan.id, status: "SUSPENDED", currentPeriodEnd: addDays(new Date(), -70), firstPaidAt: addDays(new Date(), -100), suspendedEmailSentAt: new Date() },
    });
    return { tenant, email, subscription };
  }

  it("reenvio respeita a espera de 10 min: 5 min depois não reenvia, 11 min depois sim (1 vez só)", async () => {
    const { email, subscription } = await makeSuspendedLong("retry-wait");
    const { gateway } = createMockMercadoPagoGateway();

    control.mode = "fail";
    const t0 = new Date();
    await runBillingTick(t0, gateway);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).status).toBe("CANCELED");

    control.mode = "ok";
    await runBillingTick(addMinutes(t0, 5), gateway);
    expect(mailsTo(email)).toHaveLength(0);

    await runBillingTick(addMinutes(t0, 11), gateway);
    expect(mailsTo(email)).toHaveLength(1);
    expect(mailsTo(email)[0]!.subject).toContain("foi encerrada");

    await runBillingTick(addMinutes(t0, 30), gateway);
    expect(mailsTo(email)).toHaveLength(1);
  });

  it("reativação (startReactivation) NÃO anuncia 'conta encerrada' e não deixa marca de envio pendente", async () => {
    const { tenant, email, subscription } = await makeSuspendedLong("reactivation");
    const { gateway } = createMockMercadoPagoGateway();

    await startReactivation(tenant.id, { gateway });
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).status).toBe("CANCELED");
    expect(mailsTo(email).filter((m) => m.subject.includes("foi encerrada"))).toHaveLength(0);
    expect(await prisma.providerEvent.count({ where: { provider: "billing-email", providerEventId: { startsWith: `auto_cancel:${subscription.id}:` } } })).toBe(0);

    await runBillingTick(addMinutes(new Date(), 30), gateway);
    expect(mailsTo(email).filter((m) => m.subject.includes("foi encerrada"))).toHaveLength(0);
  });
});

describe("S-5: auditoria e limpeza das marcas billing-email", () => {
  it("desistência (7 dias sem sucesso) grava payload.gaveUp e não envia", async () => {
    const { email, invoice } = await makeOpenInvoice("give-up", addDays(new Date(), 20));
    await prisma.providerEvent.create({
      data: { provider: "billing-email", providerEventId: `invoice_generated:${invoice.id}`, payload: { kind: "invoice_generated" }, createdAt: addDays(new Date(), -8) },
    });
    const { gateway } = createMockMercadoPagoGateway();
    await runBillingTick(new Date(), gateway);

    const row = await prisma.providerEvent.findFirstOrThrow({ where: { provider: "billing-email", providerEventId: `invoice_generated:${invoice.id}` } });
    expect(row.processedAt).not.toBeNull();
    expect(row.payload).toEqual({ kind: "invoice_generated", gaveUp: true });
    expect(mailsTo(email)).toHaveLength(0);
  });

  it("manutenção apaga marcas processadas há mais de 90 dias e mantém as recentes e as pendentes", async () => {
    const id = randomUUID();
    const old = await prisma.providerEvent.create({ data: { provider: "billing-email", providerEventId: `invoice_generated:old-${id}`, payload: {}, processedAt: addDays(new Date(), -91) } });
    const recent = await prisma.providerEvent.create({ data: { provider: "billing-email", providerEventId: `invoice_generated:recent-${id}`, payload: {}, processedAt: addDays(new Date(), -10) } });
    const pending = await prisma.providerEvent.create({ data: { provider: "billing-email", providerEventId: `invoice_generated:pending-${id}`, payload: {}, createdAt: addDays(new Date(), -120) } });

    await runMaintenanceTick(new Date());

    expect(await prisma.providerEvent.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.providerEvent.findUnique({ where: { id: recent.id } })).not.toBeNull();
    expect(await prisma.providerEvent.findUnique({ where: { id: pending.id } })).not.toBeNull();
  });
});
