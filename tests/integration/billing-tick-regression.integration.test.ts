/**
 * O que a F0 e a revisão do Órion fixaram no tick de cobrança e CONTINUA valendo depois do motor novo da F2
 * (os testes das marcas `*SentAt` e do outbox em `ProviderEvent` foram substituídos por
 * `billing-dunning-*.integration.test.ts`): sino do Admin quando o e-mail não sai, tick que não deixa a trava
 * presa, descrição do Pix sem travessão, exceção ao montar o aviso isolada por item, orçamento no meio da fila
 * e limpeza das marcas antigas da F0. SMTP dublê; Postgres real.
 */
import { randomUUID } from "node:crypto";
import { addDays } from "date-fns";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({ publicUrlThrows: false }));

vi.mock("@/lib/email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
  const helpers = await import("./dunning.helpers");
  return { ...actual, sendMail: helpers.fakeSendMail(actual) };
});
vi.mock("@/modules/platform-whatsapp/sender", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/modules/platform-whatsapp/sender")>();
  const helpers = await import("./dunning.helpers");
  return { ...original, sendPlatformWhatsapp: helpers.fakeSendWhatsapp };
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

const h = await import("./dunning.helpers");
const { runBillingTick, BILLING_TICK_LOCK_NAME } = await import("@/modules/billing/tick");
const { withAdvisoryLock } = await import("@/lib/db/advisory-lock");
const { generateInvoiceDescription } = await import("@/modules/billing/service");
const { createMockMercadoPagoGateway } = await import("@/modules/billing/mercadopago.mock");
const { listPlatformNotifications } = await import("@/modules/platform-notifications/service");
const { runMaintenanceTick } = await import("@/modules/maintenance/tick");
const { dispatchDueNotices } = await import("@/modules/billing/dunning/dispatcher");
const { enqueueNotices } = await import("@/modules/billing/dunning/outbox");
const { loadDunningSubject } = await import("@/modules/billing/dunning/snapshot");
const { planNotices } = await import("@/core/billing");

const { prisma, at } = h;
const fixtures = h.newFixtures();
const { gateway } = createMockMercadoPagoGateway();
const tick = (now: Date) => runBillingTick(now, gateway, { dispatch: h.tickDispatch });
const mails = (email: string) => h.sentEmails.filter((m) => m.to === email);

const PERIOD_END = at("2026-10-28T10:00:00Z");
const D1_NOON = at("2026-10-27T15:00:00Z");

async function scenario(label: string) {
  const t = await h.makeTenant(fixtures, label, { billingWhatsappE164: null });
  const sub = await h.makePayingSubscription(fixtures, t.tenant.id, label, { currentPeriodEnd: PERIOD_END });
  const invoice = await h.makeOpenInvoice(sub.id, { periodStart: PERIOD_END, dueAt: PERIOD_END, createdAt: at("2026-10-23T13:00:00Z") });
  return { ...t, sub, invoice };
}

beforeEach(() => {
  h.resetMail();
  h.resetWhatsapp();
  control.publicUrlThrows = false;
});
afterEach(async () => {
  await h.cleanup(fixtures);
  fixtures.tenantIds.length = 0;
  fixtures.userIds.length = 0;
  fixtures.planIds.length = 0;
});
afterAll(async () => {
  await prisma.providerEvent.deleteMany({ where: { provider: "billing-email" } });
  await h.dropTestConnection();
  await prisma.$disconnect();
});

describe("R1: aviso no sino do Admin quando o e-mail não sai", () => {
  it("emailsFailed > 0 no último tick vira BILLING_EMAIL_FAILING (derivado, sem tabela), sem dado pessoal no texto", async () => {
    await scenario("bell");
    h.mailControl.mode = "fail";
    const summary = await tick(D1_NOON);
    expect(summary.emailsFailed).toBeGreaterThan(0);

    const admin = await prisma.user.create({ data: { email: `it-reg-admin-${randomUUID()}@example.com`, passwordHash: "x", emailVerifiedAt: new Date() } });
    fixtures.userIds.push(admin.id);
    const { items } = await listPlatformNotifications(admin.id);
    const alert = items.find((item) => item.kind === "BILLING_EMAIL_FAILING");
    expect(alert).toBeDefined();
    expect(alert!.severity).toBe("danger");
    expect(alert!.body).not.toMatch(/@/);
  });
});

describe("R8: um tick por vez", () => {
  it("erro no meio do tick não deixa a trava presa", async () => {
    await expect(
      withAdvisoryLock(BILLING_TICK_LOCK_NAME, async () => {
        throw new Error("falha no meio");
      }),
    ).rejects.toThrow("falha no meio");
    expect(await withAdvisoryLock(BILLING_TICK_LOCK_NAME, async () => "ok")).toEqual({ acquired: true, value: "ok" });
  });
});

describe("R16: descrição do pagamento no Mercado Pago", () => {
  it("sem travessão: 'Assinatura InnoChat (empresa)'", () => {
    expect(generateInvoiceDescription("Salão da Ana")).toBe("Assinatura InnoChat (Salão da Ana)");
  });
});

describe("I-3: exceção ao montar o aviso não aborta o tick", () => {
  it("URL pública desconhecida: o aviso vira FAILED/UNEXPECTED_ERROR, as etapas seguintes do tick rodam e a rodada seguinte envia", async () => {
    const s = await scenario("url");
    // Etapa que vem DEPOIS da régua no tick e precisa rodar mesmo com o aviso falhando: anular a fatura do teste cancelado.
    const trial = await h.makeTenant(fixtures, "url-trial", { billingWhatsappE164: null });
    const plan = await h.makePlan(fixtures, "url-trial");
    const trialSub = await prisma.subscription.create({
      data: { tenantId: trial.tenant.id, planId: plan.id, status: "CANCELED", canceledAt: at("2026-10-20T10:00:00Z"), cancelRequestedAt: at("2026-10-20T10:00:00Z"), trialEndsAt: at("2026-10-15T10:00:00Z"), currentPeriodEnd: at("2026-10-15T10:00:00Z"), firstPaidAt: null },
    });
    const trialInvoice = await h.makeOpenInvoice(trialSub.id, { periodStart: at("2026-10-12T10:00:00Z"), dueAt: at("2026-10-15T10:00:00Z"), createdAt: at("2026-10-12T10:00:00Z"), isTrialConversion: true });

    control.publicUrlThrows = true;
    const first = await tick(D1_NOON);
    expect(first.noticesFailed).toBeGreaterThanOrEqual(2);
    expect(await prisma.billingNotice.findFirst({ where: { subscriptionId: s.sub.id, step: "DUE_D1", channel: "EMAIL" } })).toMatchObject({ status: "FAILED", lastErrorCode: "UNEXPECTED_ERROR", attempts: 1 });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: trialInvoice.id } })).status).toBe("VOID");
    expect(mails(s.email)).toHaveLength(0);

    control.publicUrlThrows = false;
    await tick(at("2026-10-27T15:06:00Z"));
    expect(mails(s.email)).toHaveLength(2);
  });
});

describe("I-1: orçamento no meio da fila", () => {
  it("estourou depois do primeiro: o enviado fica SENT, o resto volta à fila sem contar tentativa e sai na rodada seguinte, sem duplicar", async () => {
    const subjects = [] as Awaited<ReturnType<typeof scenario>>[];
    for (let i = 0; i < 3; i += 1) subjects.push(await scenario(`mid-${i}`));
    for (const s of subjects) {
      const subject = await loadDunningSubject(s.sub.id, D1_NOON);
      await enqueueNotices({ tenantId: s.tenant.id, subscriptionId: s.sub.id }, planNotices(subject!.input, D1_NOON).filter((p) => p.step === "DUE_D1" && p.channel === "EMAIL"));
    }
    let checks = 0;
    const budget = { isOver: () => (checks += 1) > 1 };
    const first = await dispatchDueNotices(D1_NOON, { budget, deps: h.tickDispatch });
    expect(first.sent).toBe(1);
    const rows = await prisma.billingNotice.findMany({ where: { subscriptionId: { in: subjects.map((s) => s.sub.id) }, step: "DUE_D1" } });
    expect(rows.filter((r) => r.status === "SENT")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "PENDING" && r.attempts === 0)).toHaveLength(2);

    await dispatchDueNotices(D1_NOON, { deps: h.tickDispatch });
    await dispatchDueNotices(D1_NOON, { deps: h.tickDispatch });
    expect(h.sentEmails.filter((m) => subjects.some((s) => s.email === m.to))).toHaveLength(3);
  });
});

describe("S-5: limpeza das marcas antigas da F0 (billing-email)", () => {
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
