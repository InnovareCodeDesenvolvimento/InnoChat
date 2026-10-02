/**
 * Revisão do Órion à régua de cobranca (2026-10-01): regressão dos 6 IMPORTANTES contra Postgres real.
 *  4. suspensão MANUAL nunca vira PAST_DUE pela carência nova (nem cobra);
 *  3. Pix antigo cancelado ao regerar + segundo pagamento numa fatura PAGA acende o sino do admin;
 *  1. contato de cobrança não confirmado: 1 mensagem por dia (WhatsApp e e-mail do financeiro);
 *  5. SENDING preso respeita maxAttempts e a 3a tentativa de gravar SENT;
 *  6. migration de dados apaga LEGACY_SENT/SUSPENDED de quem não está mais suspenso (e o backfill da suspensão manual).
 * (2, retenção do ProviderEvent, e o "SIM" estão em platform-whatsapp.integration.test.ts.)
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const h = await import("./dunning.helpers");
const { runBillingTick } = await import("@/modules/billing/tick");
const { applyInvoicePayment, regeneratePixForInvoice } = await import("@/modules/billing/service");
const { suspendCompanyManually, reactivateCompanyManually } = await import("@/modules/billing/admin-service");
const { createMockMercadoPagoGateway } = await import("@/modules/billing/mercadopago.mock");
const { claimDueBillingNotices } = await import("@/lib/db/billing-notice-queries");
const { failExhaustedStuckNotices, markNoticeSentSafely } = await import("@/modules/billing/dunning/outbox");
const { listPlatformNotifications } = await import("@/modules/platform-notifications/service");
const { effectiveStatus } = await import("@/core/billing");

const { prisma, at } = h;
const fixtures = h.newFixtures();
const mock = createMockMercadoPagoGateway();
const { gateway } = mock;

beforeEach(() => {
  h.resetMail();
  h.resetWhatsapp();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await h.cleanup(fixtures);
  fixtures.tenantIds.length = 0;
  fixtures.userIds.length = 0;
  fixtures.planIds.length = 0;
});
afterAll(async () => {
  await h.dropTestConnection();
  await prisma.$disconnect();
});

const tick = (now: Date) => runBillingTick(now, gateway, { dispatch: h.tickDispatch });
const mails = (email: string) => h.sentEmails.filter((m) => m.to === email);

// 28/10/2026 12:00 em SP: dentro das janelas de e-mail e de WhatsApp.
const NOW = at("2026-10-28T15:00:00Z");

describe("4. suspensão manual não vira PAST_DUE pela carência nova", () => {
  /** Suspensão manual ANTIGA: vencimento gravado só 2 dias atrás (a carência de 3 dias a "reabriria"). */
  async function legacyManual(label: string, over: { status: "SUSPENDED" | "PAST_DUE"; manual: boolean }) {
    const t = await h.makeTenant(fixtures, label);
    const sub = await h.makePayingSubscription(fixtures, t.tenant.id, label, { currentPeriodEnd: at("2026-10-26T10:00:00Z"), status: over.status });
    if (over.manual) await prisma.subscription.update({ where: { id: sub.id }, data: { manualSuspendedAt: at("2026-10-24T10:00:00Z") } });
    await h.makeOpenInvoice(sub.id, { periodStart: at("2026-10-26T10:00:00Z"), dueAt: at("2026-10-26T10:00:00Z"), createdAt: at("2026-10-21T13:00:00Z") });
    return { ...t, sub };
  }

  it("status efetivo: com manualSuspendedAt fica SUSPENDED mesmo dentro da carência; sem ele é PAST_DUE", () => {
    const base = { status: "SUSPENDED" as const, trialEndsAt: null, currentPeriodEnd: at("2026-10-26T10:00:00Z"), firstPaidAt: at("2026-06-01T00:00:00Z"), cancelAtPeriodEnd: false };
    expect(effectiveStatus(base, NOW)).toBe("PAST_DUE");
    expect(effectiveStatus({ ...base, manualSuspendedAt: at("2026-10-24T10:00:00Z") }, NOW)).toBe("SUSPENDED");
    // a suspensão manual também acaba no cancelamento automático (60 dias), como antes
    expect(effectiveStatus({ ...base, manualSuspendedAt: at("2026-10-24T10:00:00Z") }, at("2027-01-30T00:00:00Z"))).toBe("CANCELED");
  });

  it("SUSPENDED manual antiga: o tick mantém SUSPENDED e não sai nenhum aviso (e-mail ou WhatsApp)", async () => {
    const s = await legacyManual("man-susp", { status: "SUSPENDED", manual: true });
    await tick(NOW);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: s.sub.id } })).status).toBe("SUSPENDED");
    expect(await h.noticesOf(s.sub.id)).toHaveLength(0);
    expect(mails(s.email)).toHaveLength(0);
    expect(h.whatsapp.sent.filter((m) => m.tenantId === s.tenant.id)).toHaveLength(0);
  });

  it("já revertida a PAST_DUE no banco: o tick volta para SUSPENDED e não cobra atraso", async () => {
    const s = await legacyManual("man-pastdue", { status: "PAST_DUE", manual: true });
    await tick(NOW);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: s.sub.id } })).status).toBe("SUSPENDED");
    expect(await h.noticesOf(s.sub.id)).toHaveLength(0);
    expect(mails(s.email)).toHaveLength(0);
  });

  it("controle: a MESMA situação sem a marca é atraso comum (vira PAST_DUE e cobra)", async () => {
    const s = await legacyManual("man-control", { status: "SUSPENDED", manual: false });
    await tick(NOW);
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: s.sub.id } })).status).toBe("PAST_DUE");
    expect(mails(s.email).length).toBeGreaterThan(0);
  });

  it("suspendCompanyManually grava a marca; pagamento e reativação manual a limpam", async () => {
    const t = await h.makeTenant(fixtures, "man-flow");
    const sub = await h.makePayingSubscription(fixtures, t.tenant.id, "man-flow", { currentPeriodEnd: at("2026-12-20T10:00:00Z") });
    await suspendCompanyManually(t.tenant.id, "admin-1");
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).manualSuspendedAt).not.toBeNull();
    await reactivateCompanyManually(t.tenant.id, "admin-1");
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).manualSuspendedAt).toBeNull();

    await suspendCompanyManually(t.tenant.id, "admin-1");
    const invoice = await h.makeOpenInvoice(sub.id, { periodStart: at("2026-12-20T10:00:00Z"), dueAt: at("2026-12-20T10:00:00Z"), createdAt: at("2026-12-15T10:00:00Z") });
    await applyInvoicePayment(invoice.id, NOW, "pay-x");
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.manualSuspendedAt).toBeNull();
    expect(after.status).toBe("ACTIVE");
  });
});

describe("3. Pix antigo não pode ser pago depois de regerado", () => {
  async function invoiceWithPix(label: string) {
    const t = await h.makeTenant(fixtures, label, { document: "52998224725" });
    const sub = await h.makePayingSubscription(fixtures, t.tenant.id, label, { currentPeriodEnd: at("2026-10-28T10:00:00Z") });
    const invoice = await h.makeOpenInvoice(sub.id, { periodStart: at("2026-10-28T10:00:00Z"), dueAt: at("2026-10-28T10:00:00Z"), createdAt: at("2026-10-23T13:00:00Z") });
    return { ...t, sub, invoice };
  }

  it("regerar o Pix cancela o anterior no Mercado Pago e grava o novo", async () => {
    const s = await invoiceWithPix("regen");
    const first = await regeneratePixForInvoice(s.invoice.id, s.email, gateway);
    expect(first.mpPaymentId).toBeTruthy();
    // o primeiro Pix "venceu" no banco (a regeração só acontece perto de expirar), mas ainda vale no MP
    await prisma.invoice.update({ where: { id: s.invoice.id }, data: { pixExpiresAt: new Date(Date.now() + 3_600_000) } });
    const second = await regeneratePixForInvoice(s.invoice.id, s.email, gateway);
    expect(second.mpPaymentId).not.toBe(first.mpPaymentId);
    expect(mock.cancelledPaymentIds).toContain(first.mpPaymentId);
    expect(mock.cancelledPaymentIds).not.toContain(second.mpPaymentId);
  });

  it("falha ao cancelar o antigo só é logada: o Pix novo é entregue mesmo assim", async () => {
    const s = await invoiceWithPix("regen-fail");
    await prisma.invoice.update({ where: { id: s.invoice.id }, data: { mpPaymentId: "pix-que-nao-existe-no-mp", pixExpiresAt: new Date(Date.now() + 3_600_000) } });
    const fresh = await regeneratePixForInvoice(s.invoice.id, s.email, gateway);
    expect(fresh.mpPaymentId).toMatch(/^mock_pay_/);
  });

  it("segundo pagamento numa fatura já PAGA: marca duplicatePaymentAt uma vez e acende o sino do admin; o mesmo pagamento reentregue não", async () => {
    const s = await invoiceWithPix("dup");
    await applyInvoicePayment(s.invoice.id, NOW, "pay-A");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoice.id } })).paidByPaymentId).toBe("pay-A");

    const again = await applyInvoicePayment(s.invoice.id, NOW, "pay-A");
    expect(again).toEqual({ alreadyProcessed: true });
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoice.id } })).duplicatePaymentAt).toBeNull();

    const second = await applyInvoicePayment(s.invoice.id, new Date(NOW.getTime() + 60_000), "pay-B");
    expect(second).toEqual({ alreadyProcessed: true, duplicate: true });
    const marked = await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoice.id } });
    expect(marked.duplicatePaymentAt?.getTime()).toBe(NOW.getTime() + 60_000);
    await applyInvoicePayment(s.invoice.id, new Date(NOW.getTime() + 120_000), "pay-B");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoice.id } })).duplicatePaymentAt?.getTime()).toBe(NOW.getTime() + 60_000); // não sobrescreve

    // só um mês foi somado
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: s.sub.id } });
    expect(sub.currentPeriodEnd.getTime()).toBeLessThan(at("2026-12-01T00:00:00Z").getTime());

    const admin = await prisma.user.create({ data: { email: `it-dup-${randomUUID()}@example.com`, passwordHash: "x", isPlatformAdmin: true, totpSecretEnc: "enc:v1:x", totpEnabledAt: new Date() } });
    fixtures.userIds.push(admin.id);
    const bell = await listPlatformNotifications(admin.id);
    const dup = bell.items.filter((i) => i.kind === "PAYMENT_DUPLICATE" && i.id === `pdup:${s.invoice.id}`);
    expect(dup).toHaveLength(1);
    expect(dup[0]!.severity).toBe("danger");
  });

  it("pagamento duplicado depois da baixa MANUAL também é sinalizado", async () => {
    const s = await invoiceWithPix("dup-manual");
    await applyInvoicePayment(s.invoice.id, NOW); // baixa manual (sem id de pagamento)
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoice.id } })).paidByPaymentId).toBe("manual");
    expect(await applyInvoicePayment(s.invoice.id, NOW, "pix-pago-depois")).toEqual({ alreadyProcessed: true, duplicate: true });
  });
});

describe("1. contato de cobrança sem confirmação de posse", () => {
  const D1_NOON = at("2026-10-27T15:00:00Z"); // 12:00 SP, véspera do vencimento
  const PERIOD_END = at("2026-10-28T10:00:00Z");

  async function scenario(label: string, opts: Parameters<typeof h.makeTenant>[2]) {
    const t = await h.makeTenant(fixtures, label, opts);
    const sub = await h.makePayingSubscription(fixtures, t.tenant.id, label, { currentPeriodEnd: PERIOD_END });
    await h.makeOpenInvoice(sub.id, { periodStart: PERIOD_END, dueAt: PERIOD_END, createdAt: at("2026-10-23T13:00:00Z") });
    return { ...t, sub };
  }

  it("número NÃO confirmado: só 1 aviso por dia, com o convite SIM/SAIR; o segundo, que perderia o prazo, é encerrado", async () => {
    const s = await scenario("wa-unconf", { unconfirmedPhone: true });
    await tick(D1_NOON);
    const mine = h.whatsapp.sent.filter((m) => m.tenantId === s.tenant.id);
    expect(new Set(mine.map((m) => m.noticeId)).size).toBe(1);
    expect(mine[0]!.text).toContain("Responda SIM");
    const rows = await prisma.billingNotice.findMany({ where: { subscriptionId: s.sub.id, channel: "WHATSAPP" } });
    expect(rows.filter((r) => r.status === "SENT")).toHaveLength(1);
    expect(rows.find((r) => r.skippedReason === "UNCONFIRMED_DAILY_LIMIT")).toBeTruthy();
  });

  it("número CONFIRMADO: sem limite diário e sem o convite", async () => {
    const s = await scenario("wa-conf", {});
    await tick(D1_NOON);
    const mine = h.whatsapp.sent.filter((m) => m.tenantId === s.tenant.id);
    expect(new Set(mine.map((m) => m.noticeId)).size).toBe(2);
    expect(mine.every((m) => !m.text.includes("Responda SIM"))).toBe(true);
  });

  it("e-mail do financeiro (sem confirmação): 1 mensagem por dia; o excedente vai para o dono", async () => {
    const billing = `financeiro-${randomUUID().slice(0, 6)}@example.com`;
    const s = await scenario("mail-cap", { billingEmail: billing });
    await tick(D1_NOON);
    expect(mails(billing)).toHaveLength(1);
    expect(mails(s.email).length).toBeGreaterThanOrEqual(1); // a véspera (2o aviso do dia) caiu no dono
  });
});

describe("5. SENDING preso e gravação do SENT", () => {
  async function stuckNotice(attempts: number) {
    const t = await h.makeTenant(fixtures, `stuck${attempts}`);
    const sub = await h.makePayingSubscription(fixtures, t.tenant.id, `stuck${attempts}`, { currentPeriodEnd: at("2026-12-20T10:00:00Z") });
    const old = new Date(NOW.getTime() - 3_600_000);
    const notice = await prisma.billingNotice.create({
      data: {
        tenantId: t.tenant.id,
        subscriptionId: sub.id,
        step: "DUE_D1",
        channel: "EMAIL",
        cycleKey: `it-stuck-${randomUUID()}`,
        status: "SENDING",
        attempts,
        notBefore: old,
        expiresAt: new Date(NOW.getTime() + 86_400_000),
        nextAttemptAt: old,
        updatedAt: old,
      },
    });
    return notice;
  }
  const claim = () => claimDueBillingNotices({ now: NOW, limit: 50, stuckBefore: new Date(NOW.getTime() - 30 * 60_000), maxAttempts: 5, channel: "EMAIL" });

  it("recuperar um SENDING preso conta como tentativa; ao esgotar, não é mais reivindicado e vira FAILED", async () => {
    const notice = await stuckNotice(3);
    const first = (await claim()).filter((n) => n.id === notice.id);
    expect(first).toHaveLength(1);
    expect(first[0]!.attempts).toBe(4);

    // preso de novo
    await prisma.billingNotice.update({ where: { id: notice.id }, data: { updatedAt: new Date(NOW.getTime() - 3_600_000) } });
    expect((await claim()).filter((n) => n.id === notice.id)).toHaveLength(1);
    await prisma.billingNotice.update({ where: { id: notice.id }, data: { updatedAt: new Date(NOW.getTime() - 3_600_000) } });
    expect((await claim()).filter((n) => n.id === notice.id)).toHaveLength(0); // 5 tentativas gastas

    const failed = await failExhaustedStuckNotices(new Date(NOW.getTime() - 30 * 60_000), 5);
    expect(failed).toBeGreaterThanOrEqual(1);
    const row = await prisma.billingNotice.findUniqueOrThrow({ where: { id: notice.id } });
    expect(row).toMatchObject({ status: "FAILED", lastErrorCode: "STUCK_MAX_ATTEMPTS" });
  });

  it("markNoticeSentSafely faz uma 3a tentativa mínima quando as duas primeiras gravações falham", async () => {
    const notice = await stuckNotice(0);
    // Não usa `vi.spyOn`: o delegate do Prisma é um proxy e o `mockRestore` o deixaria sem o método para os testes seguintes.
    const delegate = prisma.billingNotice as unknown as { updateMany: (...args: unknown[]) => Promise<unknown> };
    const original = delegate.updateMany;
    const fake = vi
      .fn()
      .mockRejectedValueOnce(new Error("db caiu 1"))
      .mockRejectedValueOnce(new Error("db caiu 2"))
      .mockImplementation((...args: unknown[]) => original.apply(delegate, args));
    delegate.updateMany = fake;
    try {
      await markNoticeSentSafely(notice.id, NOW, { recipientMasked: "an***@x.com", providerMessageId: "pm", platformConnectionId: "fk-que-nao-existe" });
    } finally {
      delegate.updateMany = original;
    }
    expect(fake).toHaveBeenCalledTimes(3);
    const row = await prisma.billingNotice.findUniqueOrThrow({ where: { id: notice.id } });
    expect(row.status).toBe("SENT");
    expect(row.sentAt?.getTime()).toBe(NOW.getTime());
  });
});

describe("6. migrations de dados da revisão", () => {
  const dir = path.join(process.cwd(), "prisma", "migrations");
  const dataSql = fs.readFileSync(path.join(dir, "20261006100100_regua_revisao_orion_dados", "migration.sql"), "utf8");
  const columnsSql = fs.readFileSync(path.join(dir, "20261006100000_regua_revisao_orion_colunas", "migration.sql"), "utf8");
  const backfillSql = columnsSql.slice(columnsSql.indexOf('UPDATE "subscriptions"'));
  const cycleKey = (id: string, d: Date) => `${id}:${d.toISOString()}`;

  async function legacySuspended(label: string, status: "SUSPENDED" | "PAST_DUE" | "ACTIVE") {
    const t = await h.makeTenant(fixtures, label);
    const periodEnd = at("2026-10-26T10:00:00Z");
    const sub = await h.makePayingSubscription(fixtures, t.tenant.id, label, { currentPeriodEnd: periodEnd, status });
    const when = at("2026-10-27T10:00:00Z");
    await prisma.billingNotice.create({
      data: { tenantId: t.tenant.id, subscriptionId: sub.id, step: "SUSPENDED", channel: "EMAIL", cycleKey: cycleKey(sub.id, periodEnd), status: "SKIPPED", skippedReason: "LEGACY_SENT", notBefore: when, expiresAt: when, nextAttemptAt: when },
    });
    return { sub, periodEnd };
  }

  it("apaga o LEGACY_SENT/SUSPENDED só de quem hoje está PAST_DUE/ACTIVE no mesmo ciclo; quem segue SUSPENDED fica; idempotente", async () => {
    const pastDue = await legacySuspended("leg-pd", "PAST_DUE");
    const active = await legacySuspended("leg-ac", "ACTIVE");
    const still = await legacySuspended("leg-su", "SUSPENDED");
    // ACTIVE em OUTRO ciclo (pagou depois): a chave não é a do ciclo atual, então a linha não é tocada
    const paid = await legacySuspended("leg-paid", "ACTIVE");
    await prisma.subscription.update({ where: { id: paid.sub.id }, data: { currentPeriodEnd: at("2026-11-26T10:00:00Z") } });

    await prisma.$executeRawUnsafe(dataSql);
    await prisma.$executeRawUnsafe(dataSql); // idempotente

    const count = (subId: string) => prisma.billingNotice.count({ where: { subscriptionId: subId, step: "SUSPENDED", skippedReason: "LEGACY_SENT" } });
    expect(await count(pastDue.sub.id)).toBe(0);
    expect(await count(active.sub.id)).toBe(0);
    expect(await count(still.sub.id)).toBe(1);
    expect(await count(paid.sub.id)).toBe(1);
  });

  it("depois do apagamento, a suspensão REAL do mesmo ciclo recebe o e-mail de suspensão", async () => {
    const t = await h.makeTenant(fixtures, "leg-real");
    const periodEnd = at("2026-10-26T10:00:00Z"); // carência de 3 dias termina em 29/10 23:59 (SP)
    const sub = await h.makePayingSubscription(fixtures, t.tenant.id, "leg-real", { currentPeriodEnd: periodEnd, status: "PAST_DUE" });
    const when = at("2026-10-27T10:00:00Z");
    await prisma.billingNotice.create({
      data: { tenantId: t.tenant.id, subscriptionId: sub.id, step: "SUSPENDED", channel: "EMAIL", cycleKey: cycleKey(sub.id, periodEnd), status: "SKIPPED", skippedReason: "LEGACY_SENT", notBefore: when, expiresAt: when, nextAttemptAt: when },
    });
    await prisma.$executeRawUnsafe(dataSql);
    await tick(at("2026-10-30T15:00:00Z")); // já suspensa de verdade
    const row = await prisma.billingNotice.findFirst({ where: { subscriptionId: sub.id, step: "SUSPENDED", channel: "EMAIL" } });
    expect(row?.status).toBe("SENT");
    expect(mails(t.email).some((m) => /suspens/i.test(m.subject))).toBe(true);
  });

  it("backfill da suspensão manual: marca só quem tem MANUAL_SUSPEND do ciclo atual e hoje está SUSPENDED/PAST_DUE", async () => {
    const periodEnd = at("2026-10-23T10:00:00Z");
    const mk = async (label: string, status: "SUSPENDED" | "PAST_DUE" | "ACTIVE", eventPeriodEnd: Date | null) => {
      const t = await h.makeTenant(fixtures, label);
      const sub = await h.makePayingSubscription(fixtures, t.tenant.id, label, { currentPeriodEnd: periodEnd, status });
      if (eventPeriodEnd) {
        await prisma.billingEvent.create({ data: { tenantId: t.tenant.id, subscriptionId: sub.id, type: "MANUAL_SUSPEND", actorType: "ADMIN", metadata: { currentPeriodEnd: eventPeriodEnd.toISOString() } } });
      }
      return sub;
    };
    const suspended = await mk("bf-su", "SUSPENDED", periodEnd);
    const pastDue = await mk("bf-pd", "PAST_DUE", periodEnd);
    const other = await mk("bf-old", "SUSPENDED", at("2026-09-01T00:00:00Z")); // evento de OUTRO ciclo
    const none = await mk("bf-none", "SUSPENDED", null); // suspensão antiga, sem evento
    const active = await mk("bf-ac", "ACTIVE", periodEnd);

    await prisma.$executeRawUnsafe(backfillSql);
    const flagged = async (id: string) => (await prisma.subscription.findUniqueOrThrow({ where: { id } })).manualSuspendedAt !== null;
    expect(await flagged(suspended.id)).toBe(true);
    expect(await flagged(pastDue.id)).toBe(true);
    expect(await flagged(other.id)).toBe(false);
    expect(await flagged(none.id)).toBe(false);
    expect(await flagged(active.id)).toBe(false);
  });
});
