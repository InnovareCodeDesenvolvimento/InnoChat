/**
 * F6 da régua: visão financeira do Admin + registro global de envios (docs/regua-de-cobranca.md §3.1 e F6) contra
 * Postgres real. Cobre: acesso só de admin (actions e CSV), números do overview com cenários controlados (comparados
 * por DIFERENÇA antes/depois, porque o banco de teste é compartilhado), fuso de São Paulo na virada do mês, registro
 * de envios (destinatário completo, snapshot, filtros, cursor, totais), prévia exata x remontada, reenvio manual
 * (idempotência, opt-out, quem pagou), linha do tempo, retenção, carga inicial de eventos e o CSV (injeção de fórmula,
 * teto de 12 meses).
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sessionState: { userId: string | null } = { userId: null };
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => (sessionState.userId ? { user: { id: sessionState.userId } } : null)) }));
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
const actions = await import("@/modules/billing/finance-actions");
const adminActions = await import("@/modules/billing/admin-actions");
const { getFinanceOverview, listCompanyBillingTimeline, resolveCsvRange } = await import("@/modules/billing/finance-service");
const { listBillingNotices, getBillingNoticePreview, resendBillingNotice } = await import("@/modules/billing/notice-register");
const { buildInvoicesCsv } = await import("@/modules/billing/finance-csv");
const { runBillingTick } = await import("@/modules/billing/tick");
const { applyInvoicePayment } = await import("@/modules/billing/service");
const { createMockMercadoPagoGateway } = await import("@/modules/billing/mercadopago.mock");
const { clearExpiredNoticePersonalData } = await import("@/lib/db/billing-notice-queries");
const { runMaintenanceTick } = await import("@/modules/maintenance/tick");
const csvRoute = await import("@/app/api/admin/finance/invoices.csv/route");

const { prisma, at } = h;
const fixtures = h.newFixtures();
const { gateway } = createMockMercadoPagoGateway();
const DAY = 86_400_000;

let adminId = "";
let plainOwnerId = "";

beforeEach(async () => {
  h.resetMail();
  h.resetWhatsapp();
  if (!adminId) {
    const admin = await prisma.user.create({ data: { email: `f6-admin-${randomUUID()}@example.com`, passwordHash: "x", emailVerifiedAt: new Date(), isPlatformAdmin: true } });
    adminId = admin.id;
    fixtures.userIds.push(admin.id);
  }
  sessionState.userId = adminId;
});
afterEach(async () => {
  await h.cleanup(fixtures);
  fixtures.tenantIds.length = 0;
  fixtures.userIds.length = 0;
  fixtures.planIds.length = 0;
  adminId = "";
  plainOwnerId = "";
});
afterAll(async () => {
  await h.dropTestConnection();
  await prisma.$disconnect();
});

const token = () => randomUUID().slice(0, 8);

// ---------------------------------------------------------------------------------------------------------------
describe("acesso: só admin da plataforma", () => {
  it("nega a quem não é admin e a quem não está logado, em todas as actions e no CSV", async () => {
    const t = await h.makeTenant(fixtures, `acesso${token()}`);
    plainOwnerId = t.user.id;
    const calls: Array<() => Promise<{ ok: boolean; error?: { code: string } }>> = [
      () => actions.getFinanceOverviewAction(),
      () => actions.getCompanyBillingAction(t.tenant.id),
      () => actions.listCompanyBillingTimelineAction(t.tenant.id),
      () => actions.listBillingNoticesAction({}),
      () => actions.getBillingNoticePreviewAction("qualquer"),
      () => actions.resendBillingNoticeAction("qualquer"),
    ];
    sessionState.userId = plainOwnerId;
    for (const call of calls) {
      const result = await call();
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("FORBIDDEN");
    }
    sessionState.userId = null;
    for (const call of calls) {
      const result = await call();
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("UNAUTHENTICATED");
    }
    sessionState.userId = plainOwnerId;
    expect((await csvRoute.GET(new Request("http://localhost/api/admin/finance/invoices.csv"))).status).toBe(403);
    sessionState.userId = null;
    expect((await csvRoute.GET(new Request("http://localhost/api/admin/finance/invoices.csv"))).status).toBe(401);
  });

  it("valida a entrada (data, canal, cursor) com INVALID_PAYLOAD", async () => {
    const bad = await actions.listBillingNoticesAction({ from: "ontem", channel: "SMS", pageSize: 9999 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("INVALID_PAYLOAD");
    const badPageSize = await actions.listBillingNoticesAction({ pageSize: 20 });
    expect(badPageSize.ok).toBe(false);
    if (!badPageSize.ok) expect(badPageSize.error.code).toBe("INVALID_PAYLOAD");
    const badTimelineSize = await actions.listCompanyBillingTimelineAction("qualquer", { pageSize: 1000 });
    expect(badTimelineSize.ok).toBe(false);
    if (!badTimelineSize.ok) expect(badTimelineSize.error.code).toBe("INVALID_PAYLOAD");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("getFinanceOverviewAction: números com cenário controlado", () => {
  it("MRR, assinantes, recebido (virada de mês em São Paulo), próximas renovações, inadimplência, churn e recuperados", async () => {
    // 15/10/2026 12:00 em São Paulo.
    const now = at("2026-10-15T15:00:00Z");
    const before = await getFinanceOverview(now);
    const longAgo = at("2026-06-01T00:00:00Z");

    // A: ativa, vence em 3 dias (entra nas duas janelas de renovação).
    const a = await h.makeTenant(fixtures, `ovA${token()}`);
    await h.makePayingSubscription(fixtures, a.tenant.id, "ovA", { currentPeriodEnd: new Date(now.getTime() + 3 * DAY), priceCents: 10000 });
    // B: ativa, vence em 20 dias (só a janela de 30).
    const b = await h.makeTenant(fixtures, `ovB${token()}`);
    await h.makePayingSubscription(fixtures, b.tenant.id, "ovB", { currentPeriodEnd: new Date(now.getTime() + 20 * DAY), priceCents: 20000 });
    // B2: ativa com cancelamento agendado: conta no MRR, NÃO nas renovações.
    const b2 = await h.makeTenant(fixtures, `ovB2${token()}`);
    const b2sub = await h.makePayingSubscription(fixtures, b2.tenant.id, "ovB2", { currentPeriodEnd: new Date(now.getTime() + 2 * DAY), priceCents: 700 });
    await prisma.subscription.update({ where: { id: b2sub.id }, data: { cancelAtPeriodEnd: true } });
    // C: em atraso (carência): conta no MRR e na inadimplência.
    const c = await h.makeTenant(fixtures, `ovC${token()}`);
    const csub = await h.makePayingSubscription(fixtures, c.tenant.id, "ovC", { status: "PAST_DUE", currentPeriodEnd: new Date(now.getTime() - 1 * DAY), priceCents: 3000 });
    await h.makeOpenInvoice(csub.id, { periodStart: new Date(now.getTime() - 31 * DAY), dueAt: new Date(now.getTime() - 1 * DAY), createdAt: new Date(now.getTime() - 6 * DAY), amountCents: 3000 });
    // D: suspensa há 35 dias: fora do MRR, na inadimplência (+30 dias).
    const d = await h.makeTenant(fixtures, `ovD${token()}`);
    const dsub = await h.makePayingSubscription(fixtures, d.tenant.id, "ovD", { status: "SUSPENDED", currentPeriodEnd: new Date(now.getTime() - 35 * DAY), priceCents: 4000 });
    await h.makeOpenInvoice(dsub.id, { periodStart: new Date(now.getTime() - 65 * DAY), dueAt: new Date(now.getTime() - 35 * DAY), createdAt: new Date(now.getTime() - 40 * DAY), amountCents: 4000 });
    // E: em teste: nem MRR nem inadimplência.
    const e = await h.makeTenant(fixtures, `ovE${token()}`);
    const esub = await h.makePayingSubscription(fixtures, e.tenant.id, "ovE", { currentPeriodEnd: new Date(now.getTime() + 1 * DAY), firstPaidAt: null, priceCents: 9900 });
    await prisma.subscription.update({ where: { id: esub.id }, data: { status: "TRIALING", trialEndsAt: new Date(now.getTime() + 1 * DAY) } });
    await h.makeOpenInvoice(esub.id, { periodStart: new Date(now.getTime() - 2 * DAY), dueAt: new Date(now.getTime() - 1 * DAY), createdAt: new Date(now.getTime() - 2 * DAY), amountCents: 9900, isTrialConversion: true });

    // Cancelamentos do mês: voluntário (dono), involuntário (automático), teste não convertido.
    const mkCanceled = async (label: string, source: string, paid: boolean) => {
      const t = await h.makeTenant(fixtures, `${label}${token()}`);
      const canceledAt = new Date(now.getTime() - 2 * DAY);
      const sub = await h.makePayingSubscription(fixtures, t.tenant.id, label, { status: "ACTIVE", currentPeriodEnd: new Date(now.getTime() - 5 * DAY), firstPaidAt: paid ? longAgo : null });
      await prisma.subscription.update({ where: { id: sub.id }, data: { status: "CANCELED", canceledAt } });
      await prisma.billingEvent.create({
        data: { tenantId: t.tenant.id, subscriptionId: sub.id, type: "CANCELED", toStatus: "CANCELED", metadata: { cancelSource: source }, createdAt: canceledAt },
      });
      return { t, sub };
    };
    await mkCanceled("ovF", "OWNER", true);
    await mkCanceled("ovG", "AUTO_SUSPENDED", true);
    await mkCanceled("ovH", "TRIAL_NOT_CONVERTED", false);

    // Recuperados: pagamento feito em PAST_DUE vale; em ACTIVE não.
    const r = await h.makeTenant(fixtures, `ovR${token()}`);
    const rsub = await h.makePayingSubscription(fixtures, r.tenant.id, "ovR", { currentPeriodEnd: new Date(now.getTime() + 20 * DAY), priceCents: 100 });
    await prisma.billingEvent.create({ data: { tenantId: r.tenant.id, subscriptionId: rsub.id, type: "PAYMENT_CONFIRMED", fromStatus: "PAST_DUE", toStatus: "ACTIVE", metadata: { amountCents: 5000 }, createdAt: new Date(now.getTime() - 3 * DAY) } });
    await prisma.billingEvent.create({ data: { tenantId: r.tenant.id, subscriptionId: rsub.id, type: "PAYMENT_CONFIRMED", fromStatus: "SUSPENDED", toStatus: "ACTIVE", metadata: { amountCents: 2500 }, createdAt: new Date(now.getTime() - 2 * DAY) } });
    await prisma.billingEvent.create({ data: { tenantId: r.tenant.id, subscriptionId: rsub.id, type: "PAYMENT_CONFIRMED", fromStatus: "ACTIVE", toStatus: "ACTIVE", metadata: { amountCents: 999 }, createdAt: new Date(now.getTime() - 1 * DAY) } });
    // Recuperado no mês passado não conta.
    await prisma.billingEvent.create({ data: { tenantId: r.tenant.id, subscriptionId: rsub.id, type: "PAYMENT_CONFIRMED", fromStatus: "PAST_DUE", toStatus: "ACTIVE", metadata: { amountCents: 777 }, createdAt: at("2026-09-20T15:00:00Z") } });

    // Recebido: mês atual x passado, com as bordas do fuso (01/10 00:00 SP = 03:00Z; 01/11 00:00 SP = 03:00Z).
    const paidInvoice = async (offset: number, paidAt: Date, amountCents: number) => {
      await prisma.invoice.create({
        data: {
          subscriptionId: rsub.id,
          amountCents,
          periodStart: new Date(longAgo.getTime() + offset * DAY),
          periodEnd: new Date(longAgo.getTime() + (offset + 30) * DAY),
          dueAt: new Date(longAgo.getTime() + (offset + 30) * DAY),
          status: "PAID",
          paidAt,
        },
      });
    };
    await paidInvoice(1, at("2026-10-10T15:00:00Z"), 7000); // este mês
    await paidInvoice(2, at("2026-09-20T15:00:00Z"), 6000); // mês passado
    await paidInvoice(3, at("2026-10-01T02:00:00Z"), 1111); // 30/09 23:00 em SP: MÊS PASSADO
    await paidInvoice(4, at("2026-10-01T03:00:00Z"), 2222); // 01/10 00:00 em SP: este mês
    await paidInvoice(5, at("2026-11-01T02:00:00Z"), 3333); // 31/10 23:00 em SP: este mês
    await paidInvoice(6, at("2026-11-01T03:00:00Z"), 4444); // 01/11 00:00 em SP: mês que vem, fora

    const after = await getFinanceOverview(now);
    const delta = {
      mrr: after.mrrCents - before.mrrCents,
      active: after.subscribers.active - before.subscribers.active,
      pastDue: after.subscribers.pastDue - before.subscribers.pastDue,
      suspended: after.subscribers.suspended - before.subscribers.suspended,
      trialing: after.subscribers.trialing - before.subscribers.trialing,
      canceledThisMonth: after.subscribers.canceledThisMonth - before.subscribers.canceledThisMonth,
      thisMonth: after.receivedThisMonthCents - before.receivedThisMonthCents,
      lastMonth: after.receivedLastMonthCents - before.receivedLastMonthCents,
      n7: after.upcoming.next7.count - before.upcoming.next7.count,
      c7: after.upcoming.next7.cents - before.upcoming.next7.cents,
      n30: after.upcoming.next30.count - before.upcoming.next30.count,
      c30: after.upcoming.next30.cents - before.upcoming.next30.cents,
      dCount: after.delinquency.count - before.delinquency.count,
      dCents: after.delinquency.cents - before.delinquency.cents,
      d30: after.delinquency.over30DaysCount - before.delinquency.over30DaysCount,
      canceled: after.churn.canceledCount - before.churn.canceledCount,
      voluntary: after.churn.voluntary - before.churn.voluntary,
      involuntary: after.churn.involuntary - before.churn.involuntary,
      payingCanceled: after.churn.payingCanceledCount - before.churn.payingCanceledCount,
      rec: after.recoveredThisMonth.count - before.recoveredThisMonth.count,
      recCents: after.recoveredThisMonth.cents - before.recoveredThisMonth.cents,
    };

    // MRR: A 10000 + B 20000 + B2 700 + C 3000 (PAST_DUE) + R 100 (ativa); D suspensa e E teste de fora; cancelados fora.
    expect(delta.mrr).toBe(10000 + 20000 + 700 + 3000 + 100);
    expect(delta.active).toBe(4); // A, B, B2, R
    expect(delta.pastDue).toBe(1);
    expect(delta.suspended).toBe(1);
    expect(delta.trialing).toBe(1);
    expect(delta.canceledThisMonth).toBe(3);
    // Recebido: este mês = 7000 + 2222 + 3333; mês passado = 6000 + 1111. O de 01/11 00:00 SP não entra em nenhum.
    expect(delta.thisMonth).toBe(7000 + 2222 + 3333);
    expect(delta.lastMonth).toBe(6000 + 1111);
    // Renovações: A (3 dias) em 7 e 30; B (20 dias) só em 30; B2 tem cancelamento agendado; R vence em 20 dias (30).
    expect(delta.n7).toBe(1);
    expect(delta.c7).toBe(10000);
    expect(delta.n30).toBe(3);
    expect(delta.c30).toBe(10000 + 20000 + 100);
    // Inadimplência: C (3000) e D (4000, +30 dias). O teste (E) não entra.
    expect(delta.dCount).toBe(2);
    expect(delta.dCents).toBe(7000);
    expect(delta.d30).toBe(1);
    // Churn do mês: 3 cancelamentos; 1 voluntário, 2 involuntários; só 2 eram pagantes.
    expect(delta.canceled).toBe(3);
    expect(delta.voluntary).toBe(1);
    expect(delta.involuntary).toBe(2);
    expect(delta.payingCanceled).toBe(2);
    // Recuperados: PAST_DUE (5000) e SUSPENDED (2500) deste mês; ACTIVE e o do mês passado ficam de fora.
    expect(delta.rec).toBe(2);
    expect(delta.recCents).toBe(7500);
    expect(after.churn.baseAtMonthStart).toBeGreaterThanOrEqual(before.churn.baseAtMonthStart + 2);
    expect(typeof after.churn.ratePct).toBe("number");
    expect(after.asOf).toBe(now.toISOString());
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Cenário real: o motor envia e GRAVA destino completo + snapshot.
const PERIOD_END = at("2026-10-28T10:00:00Z");
const D1_NOON = at("2026-10-27T15:00:00Z"); // 12:00 SP

async function engineScenario(label: string, tenantOpts: Parameters<typeof h.makeTenant>[2] = {}) {
  const t = await h.makeTenant(fixtures, label, tenantOpts);
  const sub = await h.makePayingSubscription(fixtures, t.tenant.id, label, { currentPeriodEnd: PERIOD_END });
  const invoice = await h.makeOpenInvoice(sub.id, { periodStart: at("2026-09-28T10:00:00Z"), dueAt: PERIOD_END, createdAt: at("2026-10-23T12:00:00Z") });
  return { ...t, sub, invoice };
}
const tick = (now: Date) => runBillingTick(now, gateway, { dispatch: h.tickDispatch });
const todaySp = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());

describe("registro de envios: destino completo, snapshot, prévia e totais", () => {
  it("grava o destino COMPLETO e o texto enviado; o registro mostra para quem foi", async () => {
    const s = await engineScenario(`reg${token()}`, { billingEmail: `financeiro-${token()}@example.com` });
    await tick(D1_NOON);

    const rows = await prisma.billingNotice.findMany({ where: { subscriptionId: s.sub.id, status: "SENT" } });
    const billing = s.tenant.billingEmail as string;
    // O e-mail do financeiro (sem confirmação de posse) recebe no máximo 1 por dia: o 1º aviso vai a ele, o seguinte cai no dono.
    const email = rows.find((r) => r.channel === "EMAIL" && r.recipient?.includes(billing));
    const ownerEmail = rows.find((r) => r.channel === "EMAIL" && r.recipient === s.email);
    const wa = rows.find((r) => r.channel === "WHATSAPP" && r.step === "DUE_D1");
    expect(email && ownerEmail && wa).toBeTruthy();
    expect(email!.recipientKind).toBe("BILLING_EMAIL");
    expect(ownerEmail!.recipientKind).toBe("OWNER");
    expect(email!.renderedSubject).toBeTruthy();
    expect(email!.renderedText).toContain("Salão");
    expect(wa!.recipient).toBe("5584999990001");
    expect(wa!.recipientKind).toBe("BILLING_WHATSAPP");
    expect(wa!.renderedText).toBeTruthy();

    const page = await listBillingNotices({ tenantId: s.tenant.id, from: todaySp(), to: todaySp() });
    const item = page.items.find((i) => i.id === email!.id)!;
    expect(item.stepLabel).toMatch(/Fatura gerada|Lembrete da véspera/);
    expect(item.statusLabel).toBe("Enviado");
    expect(item.channel).toBe("EMAIL");
    expect(item.recipient).toContain(billing);
    expect(item.recipientIsMasked).toBe(false);
    expect(item.recipientKind).toBe("BILLING_EMAIL");
    expect(item.hasSnapshot).toBe(true);
    expect(item.tenant).toEqual({ id: s.tenant.id, name: s.tenant.name, slug: s.tenant.slug });
    expect(item.invoice?.amountCents).toBe(4990);
    const waItem = page.items.find((i) => i.id === wa!.id)!;
    expect(waItem.recipient).toBe("5584999990001");
    expect(waItem.recipientDisplay).toBe("+55 84 99999-0001");
    expect(waItem.senderPhoneDisplay).toBe("+55 84 90000-0000");
    expect(page.totals.sent).toBeGreaterThanOrEqual(2);

    // Prévia EXATA: o mesmo texto que saiu, sem "aproximado".
    const preview = await getBillingNoticePreview(email!.id);
    expect(preview.source).toBe("SNAPSHOT");
    expect(preview.approximate).toBe(false);
    expect(preview.subject).toBe(email!.renderedSubject);
    expect(preview.text).toBe(email!.renderedText);
    const sentMail = h.sentEmails.find((m) => m.subject === email!.renderedSubject);
    expect(sentMail?.text).toBe(email!.renderedText);
    const waPreview = await getBillingNoticePreview(wa!.id);
    const waSent = h.whatsapp.sent.find((m) => m.noticeId === wa!.id)!;
    expect(waPreview.messages[0]).toBe(waSent.text);
    expect(waPreview.subject).toBeNull();
  });

  it("sem snapshot (aviso antigo ou ainda na fila), a prévia é remontada e marcada como aproximada", async () => {
    const s = await engineScenario(`prv${token()}`);
    const queued = await prisma.billingNotice.create({
      data: {
        tenantId: s.tenant.id,
        subscriptionId: s.sub.id,
        invoiceId: s.invoice.id,
        step: "DUE_D0",
        channel: "EMAIL",
        cycleKey: s.invoice.id,
        status: "PENDING",
        notBefore: D1_NOON,
        expiresAt: PERIOD_END,
        nextAttemptAt: D1_NOON,
      },
    });
    const preview = await getBillingNoticePreview(queued.id, D1_NOON);
    expect(preview.source).toBe("REBUILT");
    expect(preview.approximate).toBe(true);
    expect(preview.approximateReason).toContain("remontagem");
    expect(preview.subject).toBeTruthy();
    expect(preview.text).toContain("Salão");

    const missing = await actions.getBillingNoticePreviewAction("nao-existe");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("NOT_FOUND");
  });

  it("filtros, 'só falhas', cursor sem duplicar nem pular, totais sem o filtro de situação e registros antigos mascarados", async () => {
    const q = token();
    const a = await h.makeTenant(fixtures, `fil${q}alfa`);
    const b = await h.makeTenant(fixtures, `fil${q}beta`);
    const subA = await h.makePayingSubscription(fixtures, a.tenant.id, "fa", { currentPeriodEnd: PERIOD_END });
    const subB = await h.makePayingSubscription(fixtures, b.tenant.id, "fb", { currentPeriodEnd: PERIOD_END });
    const base = Date.now() - 3_600_000;
    let n = 0;
    const mk = (sub: { id: string }, tenantId: string, over: Record<string, unknown>) => {
      n += 1;
      return prisma.billingNotice.create({
        data: {
          tenantId,
          subscriptionId: sub.id,
          step: "DUE_D1",
          channel: "EMAIL",
          cycleKey: `fil-${q}-${n}`,
          status: "SENT",
          notBefore: new Date(),
          expiresAt: new Date(base + DAY),
          nextAttemptAt: new Date(),
          updatedAt: new Date(base + n * 60_000),
          ...over,
        },
      });
    };
    await mk(subA, a.tenant.id, { recipient: "alfa@example.com", recipientKind: "OWNER", recipientMasked: "al***@example.com" });
    await mk(subA, a.tenant.id, { channel: "WHATSAPP", step: "DUE_D0", recipient: "5584911112222", recipientKind: "BILLING_WHATSAPP" });
    await mk(subA, a.tenant.id, { status: "FAILED", lastErrorCode: "EMAIL_NOT_SENT", attempts: 2 });
    await mk(subA, a.tenant.id, { status: "SKIPPED", skippedReason: "NO_PLATFORM_NUMBER", channel: "WHATSAPP", step: "SUSPENDED" });
    await mk(subA, a.tenant.id, { status: "SKIPPED", skippedReason: "PAID" });
    await mk(subA, a.tenant.id, { status: "SKIPPED", skippedReason: "LEGACY_SENT" }); // nunca aparece
    await mk(subA, a.tenant.id, { status: "PENDING" });
    await mk(subB, b.tenant.id, { recipientMasked: "jo***@example.com", step: "GRACE_D1" }); // antigo: só mascarado
    await mk(subB, b.tenant.id, { status: "SENT", updatedAt: new Date("2020-01-01T12:00:00Z"), sentAt: new Date("2020-01-01T12:00:00Z") }); // fora do período

    const period = { from: todaySp(), to: todaySp() };
    const all = await listBillingNotices({ ...period, tenantQuery: q });
    expect(all.items).toHaveLength(7); // 9 criadas - LEGACY_SENT - a de 2020 (fora do período)
    expect(all.items.some((i) => i.skippedReason === "LEGACY_SENT")).toBe(false);
    expect(all.totals).toEqual({ sent: 3, failed: 1, skipped: 2, pending: 1 });

    const old = all.items.find((i) => i.step === "GRACE_D1")!;
    expect(old.recipientIsMasked).toBe(true);
    expect(old.recipient).toBe("jo***@example.com");
    expect(old.recipientNote).toContain("Registro anterior");

    const byName = await listBillingNotices({ ...period, tenantQuery: `${q}BETA` });
    expect(byName.items).toHaveLength(1);
    expect(byName.items[0].tenant.name).toContain("beta");

    const wa = await listBillingNotices({ ...period, tenantQuery: q, channel: "WHATSAPP" });
    expect(wa.items.map((i) => i.channel)).toEqual(["WHATSAPP", "WHATSAPP"]);
    // Os totais ignoram o filtro de situação mas respeitam o de canal.
    expect(wa.totals).toEqual({ sent: 1, failed: 0, skipped: 1, pending: 0 });

    const byStep = await listBillingNotices({ ...period, tenantQuery: q, step: "SUSPENDED" });
    expect(byStep.items).toHaveLength(1);
    expect(byStep.items[0].stepLabel).toBe("Aviso de suspensão");
    expect(byStep.items[0].skippedReasonLabel).toContain("Sem número de WhatsApp");

    const failed = await listBillingNotices({ ...period, tenantQuery: q, status: "FAILED" });
    expect(failed.items).toHaveLength(1);
    expect(failed.items[0].lastErrorLabel).toContain("e-mail");
    expect(failed.items[0].canResend).toBe(true);
    expect(failed.totals.sent).toBe(3);

    const onlyFailures = await listBillingNotices({ ...period, tenantQuery: q, onlyFailures: true });
    expect(onlyFailures.items.map((i) => `${i.status}/${i.skippedReason ?? ""}`).sort()).toEqual(["FAILED/", "SKIPPED/NO_PLATFORM_NUMBER"]);

    const outsidePeriod = await listBillingNotices({ from: "2020-01-01", to: "2020-01-02", tenantQuery: q });
    expect(outsidePeriod.items).toHaveLength(1);

    // A mesma lista com pageSize 10 vem inteira numa página só (7 linhas), na mesma ordem.
    const small = await listBillingNotices({ ...period, tenantQuery: q, pageSize: 10 });
    expect(small.items.map((i) => i.id)).toEqual(all.items.map((i) => i.id));
    expect(small).toMatchObject({ page: 1, pageSize: 10, totalItems: 7, totalPages: 1 });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("resendBillingNoticeAction: reenvio manual", () => {
  const deps = { sendWhatsapp: h.fakeSendWhatsapp, sleep: async () => undefined };

  it("recria o aviso manual, envia, é idempotente e o original continua como estava", async () => {
    const s = await engineScenario(`rs${token()}`);
    h.mailControl.mode = "fail";
    await tick(D1_NOON);
    const failed = await prisma.billingNotice.findFirst({ where: { subscriptionId: s.sub.id, channel: "EMAIL", step: "DUE_D1" } });
    expect(failed?.status).toBe("FAILED");
    expect(failed?.recipient).toBeTruthy(); // até a tentativa que falhou guarda para quem era
    h.sentEmails.length = 0;
    h.mailControl.mode = "ok";

    const later = new Date(D1_NOON.getTime() + 10 * 60_000);
    const first = await resendBillingNotice(failed!.id, adminId, later, deps);
    expect(first.alreadyQueued).toBe(false);
    expect(first.status).toBe("SENT");
    expect(h.sentEmails.filter((m) => m.to === s.email)).toHaveLength(1);
    const created = await prisma.billingNotice.findUnique({ where: { id: first.noticeId } });
    expect(created?.cycleKey).toBe(`${failed!.cycleKey}:resend:${failed!.id}`);
    expect(created?.recipient).toBe(s.email);

    const second = await resendBillingNotice(failed!.id, adminId, later, deps);
    expect(second.alreadyQueued).toBe(true);
    expect(second.noticeId).toBe(first.noticeId);
    expect(h.sentEmails.filter((m) => m.to === s.email)).toHaveLength(1);
    expect((await prisma.billingNotice.findUnique({ where: { id: failed!.id } }))?.status).toBe("FAILED");
  });

  it("não reenvia o que não deve: já pago, opt-out, e quem pagou depois do erro vira SKIPPED/PAID", async () => {
    const s = await engineScenario(`rs2${token()}`);
    h.mailControl.mode = "fail";
    await tick(D1_NOON);
    h.mailControl.mode = "ok";
    h.sentEmails.length = 0;
    const failed = (await prisma.billingNotice.findFirst({ where: { subscriptionId: s.sub.id, channel: "EMAIL", step: "DUE_D1" } }))!;

    // Pagou depois do erro (a fatura do AVISO: o tick já gerou a do próximo ciclo): o reenvio é criado mas o despachante
    // reconfere e NÃO cobra.
    await applyInvoicePayment(failed.invoiceId as string, new Date(D1_NOON.getTime() + 5 * 60_000));
    h.sentEmails.length = 0;
    const result = await resendBillingNotice(failed.id, adminId, new Date(D1_NOON.getTime() + 10 * 60_000), deps);
    expect(result.status).toBe("SKIPPED");
    expect(h.sentEmails.filter((m) => m.subject.toLowerCase().includes("vence"))).toHaveLength(0);
    const skipped = await prisma.billingNotice.findUnique({ where: { id: result.noticeId } });
    expect(skipped?.skippedReason).toBe("PAID");

    // Já foi pago/enviado: não é reenviável.
    const sentOne = await prisma.billingNotice.findFirst({ where: { subscriptionId: s.sub.id, status: "SENT" } });
    if (sentOne) {
      const refused = await actions.resendBillingNoticeAction(sentOne.id);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.code).toBe("NOT_RESENDABLE");
    }
    const paidSkip = await actions.resendBillingNoticeAction(skipped!.id);
    expect(paidSkip.ok).toBe(false);
    if (!paidSkip.ok) expect(paidSkip.error.code).toBe("NOT_RESENDABLE");

    // Opt-out no WhatsApp é respeitado antes mesmo de criar o aviso.
    const o = await engineScenario(`rs3${token()}`, { optOut: true });
    const waFailed = await prisma.billingNotice.create({
      data: { tenantId: o.tenant.id, subscriptionId: o.sub.id, step: "DUE_D1", channel: "WHATSAPP", cycleKey: `opt-${token()}`, status: "FAILED", notBefore: new Date(), expiresAt: new Date(), nextAttemptAt: new Date() },
    });
    const optOut = await actions.resendBillingNoticeAction(waFailed.id);
    expect(optOut.ok).toBe(false);
    if (!optOut.ok) expect(optOut.error.code).toBe("OPTED_OUT");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("detalhe da empresa e linha do tempo", () => {
  it("getCompanyBillingAction: plano, status efetivo, contato mascarado, faturas e valor pago", async () => {
    const s = await engineScenario(`det${token()}`, { billingEmail: "financeiro@empresa.com.br" });
    await prisma.invoice.create({
      data: { subscriptionId: s.sub.id, amountCents: 8000, periodStart: at("2026-07-01T00:00:00Z"), periodEnd: at("2026-08-01T00:00:00Z"), dueAt: at("2026-08-01T00:00:00Z"), status: "PAID", paidAt: at("2026-07-30T00:00:00Z") },
    });
    const result = await actions.getCompanyBillingAction(s.tenant.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.company).toMatchObject({ id: s.tenant.id, planName: "Plano IT", billingEmailMasked: "fi***@empresa.com.br", whatsappOptIn: true });
    expect(result.data.company.billingWhatsappMasked).toBe("5584****0001");
    expect(result.data.invoices.length).toBe(2);
    expect(result.data.lifetimeValueCents).toBe(8000);
    const missing = await actions.getCompanyBillingAction("nao-existe");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("NOT_FOUND");
  });

  it("listCompanyBillingTimelineAction: avisos e eventos juntos, frases prontas, cursor sem duplicar", async () => {
    const s = await engineScenario(`tl${token()}`);
    await tick(D1_NOON);
    const base = Date.now() + 60_000; // à frente dos avisos recém-criados
    await prisma.billingEvent.create({ data: { tenantId: s.tenant.id, subscriptionId: s.sub.id, type: "MANUAL_PAYMENT", actorType: "ADMIN", createdAt: new Date(base) } });
    await prisma.billingEvent.create({ data: { tenantId: s.tenant.id, subscriptionId: s.sub.id, type: "STATUS_CHANGED", fromStatus: "ACTIVE", toStatus: "PAST_DUE", createdAt: new Date(base - 1000) } });
    await prisma.billingNotice.create({
      data: { tenantId: s.tenant.id, subscriptionId: s.sub.id, step: "SUSPENDED", channel: "WHATSAPP", cycleKey: `tl-legacy-${token()}`, status: "SKIPPED", skippedReason: "LEGACY_SENT", notBefore: new Date(), expiresAt: new Date(), nextAttemptAt: new Date() },
    });

    const first = await listCompanyBillingTimeline(s.tenant.id);
    expect(first.items[0]).toMatchObject({ kind: "EVENT", type: "MANUAL_PAYMENT", actor: "ADMIN", label: "Pagamento baixado manualmente pelo admin" });
    expect(first.items[1].label).toBe("Situação mudou de Ativa para Em atraso");
    const notices = first.items.filter((i) => i.kind === "NOTICE");
    expect(notices.length).toBeGreaterThanOrEqual(2);
    expect(notices.some((i) => i.label === "Lembrete da véspera enviado por WhatsApp")).toBe(true);
    expect(first.items.some((i) => i.label.includes("Enviado antes da régua"))).toBe(false); // LEGACY_SENT fora
    const waNotice = notices.find((i) => i.channel === "WHATSAPP")!;
    expect(waNotice.recipient).toBe("5584999990001");

    expect(first).toMatchObject({ page: 1, pageSize: 25 });
    expect(first.totalItems).toBe(first.items.length);
    expect(first.totalPages).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("paginação por página (registro de envios e linha do tempo)", () => {
  async function tenantWithNotices(total: number) {
    const q = token();
    const t = await h.makeTenant(fixtures, `pg${q}`);
    const sub = await h.makePayingSubscription(fixtures, t.tenant.id, "pg", { currentPeriodEnd: PERIOD_END });
    const base = Date.now() - 3_600_000;
    for (let n = 1; n <= total; n += 1) {
      await prisma.billingNotice.create({
        data: {
          tenantId: t.tenant.id,
          subscriptionId: sub.id,
          step: "DUE_D1",
          channel: n % 2 === 0 ? "WHATSAPP" : "EMAIL",
          cycleKey: `pg-${q}-${n}`,
          status: "SENT",
          notBefore: new Date(),
          expiresAt: new Date(),
          nextAttemptAt: new Date(),
          updatedAt: new Date(base + n * 1000),
        },
      });
    }
    return { ...t, sub, q };
  }

  it("página 1, a do meio e a última; trocar o pageSize; página fora do intervalo devolve a última", async () => {
    const t = await tenantWithNotices(25); // 13 e-mails (ímpares) e 12 WhatsApp (pares)
    const filter = { tenantId: t.tenant.id };
    const everything = await listBillingNotices({ ...filter, pageSize: 100 });
    expect(everything).toMatchObject({ page: 1, pageSize: 100, totalItems: 25, totalPages: 1 });
    const order = everything.items.map((i) => i.id);
    expect(order).toHaveLength(25);
    // Mais recente primeiro (data desc, id desc).
    const times = everything.items.map((i) => new Date(i.at).getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);

    const p1 = await listBillingNotices({ ...filter, page: 1, pageSize: 10 });
    const p2 = await listBillingNotices({ ...filter, page: 2, pageSize: 10 });
    const p3 = await listBillingNotices({ ...filter, page: 3, pageSize: 10 });
    expect([p1.page, p2.page, p3.page]).toEqual([1, 2, 3]);
    expect([p1.items.length, p2.items.length, p3.items.length]).toEqual([10, 10, 5]);
    for (const p of [p1, p2, p3]) expect(p).toMatchObject({ pageSize: 10, totalItems: 25, totalPages: 3 });
    // As três páginas juntas são exatamente a lista inteira, na mesma ordem, sem repetir nem pular.
    expect([...p1.items, ...p2.items, ...p3.items].map((i) => i.id)).toEqual(order);

    // Trocar o pageSize recalcula as páginas (e a página 2 de 25 em 25 já não existe: volta para a última).
    const s25 = await listBillingNotices({ ...filter, page: 1, pageSize: 25 });
    expect(s25).toMatchObject({ page: 1, pageSize: 25, totalItems: 25, totalPages: 1 });
    expect(s25.items).toHaveLength(25);
    const s25p2 = await listBillingNotices({ ...filter, page: 2, pageSize: 25 });
    expect(s25p2.page).toBe(1);
    expect(s25p2.items).toHaveLength(25);
    const s50 = await listBillingNotices({ ...filter, pageSize: 50 });
    expect(s50).toMatchObject({ page: 1, pageSize: 50, totalPages: 1 });

    // Fora do intervalo: devolve a última página válida (com os itens dela).
    const beyond = await listBillingNotices({ ...filter, page: 99, pageSize: 10 });
    expect(beyond.page).toBe(3);
    expect(beyond.items.map((i) => i.id)).toEqual(p3.items.map((i) => i.id));
    // Página zero ou negativa vira a 1ª; pela action também.
    expect((await listBillingNotices({ ...filter, page: 0, pageSize: 10 })).page).toBe(1);
    const viaAction = await actions.listBillingNoticesAction({ ...filter, page: -4, pageSize: 10 });
    expect(viaAction.ok && viaAction.data.page).toBe(1);
    const viaActionBeyond = await actions.listBillingNoticesAction({ ...filter, page: 50, pageSize: 10 });
    expect(viaActionBeyond.ok && viaActionBeyond.data.page).toBe(3);
    // Sem pageSize o padrão é 25.
    const dflt = await actions.listBillingNoticesAction(filter);
    expect(dflt.ok && dflt.data.pageSize).toBe(25);
  });

  it("filtro + paginação: o count e as páginas seguem os mesmos filtros; os cartões ignoram só a situação", async () => {
    const t = await tenantWithNotices(25);
    const wa1 = await listBillingNotices({ tenantId: t.tenant.id, channel: "WHATSAPP", page: 1, pageSize: 10 });
    const wa2 = await listBillingNotices({ tenantId: t.tenant.id, channel: "WHATSAPP", page: 2, pageSize: 10 });
    expect(wa1).toMatchObject({ totalItems: 12, totalPages: 2, page: 1 });
    expect(wa1.items).toHaveLength(10);
    expect(wa2.page).toBe(2);
    expect(wa2.items).toHaveLength(2);
    expect([...wa1.items, ...wa2.items].every((i) => i.channel === "WHATSAPP")).toBe(true);
    expect(new Set([...wa1.items, ...wa2.items].map((i) => i.id)).size).toBe(12);
    expect(wa1.totals).toEqual({ sent: 12, failed: 0, skipped: 0, pending: 0 });

    // Sem resultado: a resposta continua bem formada (1 página vazia).
    const none = await listBillingNotices({ tenantId: t.tenant.id, onlyFailures: true, pageSize: 10 });
    expect(none).toMatchObject({ items: [], page: 1, pageSize: 10, totalItems: 0, totalPages: 1 });
    const noneBeyond = await listBillingNotices({ tenantQuery: `nao-existe-${t.q}`, page: 7 });
    expect(noneBeyond).toMatchObject({ items: [], page: 1, totalItems: 0, totalPages: 1 });
  });

  it("linha do tempo: páginas de avisos e eventos juntos, na ordem, sem repetir; pageSize e página fora do intervalo", async () => {
    const t = await tenantWithNotices(12);
    const base = Date.now() - 3_600_000;
    for (let n = 1; n <= 13; n += 1) {
      await prisma.billingEvent.create({
        data: { tenantId: t.tenant.id, subscriptionId: t.sub.id, type: "STATUS_CHANGED", fromStatus: "ACTIVE", toStatus: "PAST_DUE", createdAt: new Date(base + n * 1000 + 500) },
      });
    }
    const all = await listCompanyBillingTimeline(t.tenant.id, { pageSize: 100 });
    expect(all).toMatchObject({ page: 1, pageSize: 100, totalItems: 25, totalPages: 1 });
    expect(all.items).toHaveLength(25);
    const order = all.items.map((i) => i.id);
    const p1 = await listCompanyBillingTimeline(t.tenant.id, { page: 1, pageSize: 10 });
    const p2 = await listCompanyBillingTimeline(t.tenant.id, { page: 2, pageSize: 10 });
    const p3 = await listCompanyBillingTimeline(t.tenant.id, { page: 3, pageSize: 10 });
    expect([p1.items.length, p2.items.length, p3.items.length]).toEqual([10, 10, 5]);
    for (const p of [p1, p2, p3]) expect(p).toMatchObject({ totalItems: 25, totalPages: 3, pageSize: 10 });
    expect([...p1.items, ...p2.items, ...p3.items].map((i) => i.id)).toEqual(order);
    // Avisos e eventos intercalados pela data (evento n em +500 ms do aviso n; 13 eventos e 12 avisos).
    expect(p1.items.slice(0, 4).map((i) => i.kind)).toEqual(["EVENT", "EVENT", "NOTICE", "EVENT"]);

    const beyond = await listCompanyBillingTimeline(t.tenant.id, { page: 40, pageSize: 10 });
    expect(beyond.page).toBe(3);
    expect(beyond.items.map((i) => i.id)).toEqual(p3.items.map((i) => i.id));
    const viaAction = await actions.listCompanyBillingTimelineAction(t.tenant.id, { page: 2, pageSize: 25 });
    expect(viaAction.ok && viaAction.data.page).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("paginação por página: Admin → Empresas e Admin → Cobrança", () => {
  it("empresas: páginas numeradas cobrem tudo na ordem, pageSize só 10|25|50|100 e página fora do intervalo devolve a última", async () => {
    for (let i = 0; i < 12; i += 1) {
      const t = await h.makeTenant(fixtures, `emp${token()}`);
      await h.makePayingSubscription(fixtures, t.tenant.id, "emp", { currentPeriodEnd: PERIOD_END });
    }
    const first = await adminActions.listCompaniesAction({ page: 1, pageSize: 10 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.data).toMatchObject({ page: 1, pageSize: 10 });
    expect(first.data.totalItems).toBeGreaterThanOrEqual(12);
    expect(first.data.totalPages).toBe(Math.ceil(first.data.totalItems / 10));
    expect(first.data.items).toHaveLength(10);

    const ids: string[] = [];
    for (let page = 1; page <= first.data.totalPages; page += 1) {
      const r = await adminActions.listCompaniesAction({ page, pageSize: 10 });
      expect(r.ok && r.data.page).toBe(page);
      if (r.ok) ids.push(...r.data.items.map((i) => i.tenantId));
    }
    expect(ids).toHaveLength(first.data.totalItems);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([...ids].sort());

    const last = await adminActions.listCompaniesAction({ page: 99_999, pageSize: 10 });
    expect(last.ok && last.data.page).toBe(first.data.totalPages);
    expect(last.ok && last.data.items.length).toBe(first.data.totalItems - 10 * (first.data.totalPages - 1));
    const bigger = await adminActions.listCompaniesAction({ page: 1, pageSize: 100 });
    expect(bigger.ok && bigger.data.totalPages).toBe(Math.ceil(first.data.totalItems / 100));
    const dflt = await adminActions.listCompaniesAction();
    expect(dflt.ok && dflt.data.pageSize).toBe(25);
    const bad = await adminActions.listCompaniesAction({ pageSize: 20 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("INVALID_PAYLOAD");
  });

  it("faturas: filtros + páginas (count com os mesmos filtros), página 1, do meio e última, e pageSize", async () => {
    const t = await h.makeTenant(fixtures, `fat${token()}`);
    const sub = await h.makePayingSubscription(fixtures, t.tenant.id, "fat", { currentPeriodEnd: PERIOD_END });
    for (let n = 0; n < 25; n += 1) {
      await prisma.invoice.create({
        data: {
          subscriptionId: sub.id,
          amountCents: 1000 + n,
          periodStart: new Date(Date.UTC(2024, 0, 1 + n)),
          periodEnd: new Date(Date.UTC(2024, 0, 2 + n)),
          dueAt: new Date(Date.UTC(2024, 0, 2 + n)),
          status: n < 15 ? "OPEN" : "PAID",
          paidAt: n < 15 ? null : new Date(Date.UTC(2024, 0, 2 + n)),
        },
      });
    }
    const filter = { tenantId: t.tenant.id };
    const all = await adminActions.listInvoicesAdminAction({ ...filter, pageSize: 100 });
    expect(all.ok && all.data).toMatchObject({ page: 1, pageSize: 100, totalItems: 25, totalPages: 1 });
    const order = all.ok ? all.data.items.map((i) => i.id) : [];
    expect(order).toHaveLength(25);

    const pages = [];
    for (const page of [1, 2, 3]) pages.push(await adminActions.listInvoicesAdminAction({ ...filter, page, pageSize: 10 }));
    expect(pages.map((p) => p.ok && p.data.items.length)).toEqual([10, 10, 5]);
    for (const p of pages) expect(p.ok && p.data).toMatchObject({ totalItems: 25, totalPages: 3, pageSize: 10 });
    expect(pages.flatMap((p) => (p.ok ? p.data.items.map((i) => i.id) : []))).toEqual(order);

    // Filtro de situação + página: 15 abertas = 10 + 5.
    const open2 = await adminActions.listInvoicesAdminAction({ ...filter, status: "OPEN", page: 2, pageSize: 10 });
    expect(open2.ok && open2.data).toMatchObject({ page: 2, totalItems: 15, totalPages: 2 });
    expect(open2.ok && open2.data.items.length).toBe(5);
    expect(open2.ok && open2.data.items.every((i) => i.status === "OPEN")).toBe(true);
    // Filtro de período de vencimento (jan/2024, dias 2 a 11): 10 faturas.
    const period = await adminActions.listInvoicesAdminAction({ ...filter, fromDate: "2024-01-02", toDate: "2024-01-12", pageSize: 10 });
    expect(period.ok && period.data).toMatchObject({ totalItems: 10, totalPages: 1 });
    // Fora do intervalo: última página; pageSize inválido recusado.
    const beyond = await adminActions.listInvoicesAdminAction({ ...filter, page: 40, pageSize: 10 });
    expect(beyond.ok && beyond.data.page).toBe(3);
    expect(beyond.ok && beyond.data.items.length).toBe(5);
    const bad = await adminActions.listInvoicesAdminAction({ ...filter, pageSize: 30 });
    expect(bad.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("retenção de 12 meses e carga inicial de eventos", () => {
  it("a manutenção zera destino completo e texto com mais de 12 meses, sem mexer na data nem nos recentes", async () => {
    const s = await engineScenario(`ret${token()}`);
    const oldAt = new Date(Date.now() - 400 * DAY);
    const mk = (cycleKey: string, updatedAt: Date) =>
      prisma.billingNotice.create({
        data: {
          tenantId: s.tenant.id,
          subscriptionId: s.sub.id,
          step: "DUE_D1",
          channel: "EMAIL",
          cycleKey,
          status: "SENT",
          notBefore: oldAt,
          expiresAt: oldAt,
          nextAttemptAt: oldAt,
          updatedAt,
          recipient: "alguem@example.com",
          recipientKind: "OWNER",
          recipientMasked: "al***@example.com",
          renderedSubject: "Assunto",
          renderedText: "Texto",
        },
      });
    const old = await mk(`ret-old-${token()}`, oldAt);
    const recent = await mk(`ret-new-${token()}`, new Date(Date.now() - 30 * DAY));

    await runMaintenanceTick(new Date());

    const oldAfter = await prisma.billingNotice.findUnique({ where: { id: old.id } });
    expect(oldAfter).toMatchObject({ recipient: null, renderedSubject: null, renderedText: null, recipientMasked: "al***@example.com" });
    expect(oldAfter!.updatedAt.getTime()).toBe(oldAt.getTime()); // não vai para o topo do registro
    const recentAfter = await prisma.billingNotice.findUnique({ where: { id: recent.id } });
    expect(recentAfter).toMatchObject({ recipient: "alguem@example.com", renderedText: "Texto" });

    // Depois da retenção a tela cai no mascarado, marcado como registro anterior, e a prévia é remontada (aproximada).
    const page = await listBillingNotices({ tenantId: s.tenant.id, from: "2020-01-01" });
    const oldItem = page.items.find((i) => i.id === old.id)!;
    expect(oldItem.recipientIsMasked).toBe(true);
    expect(oldItem.hasSnapshot).toBe(false);
    expect((await getBillingNoticePreview(old.id)).approximate).toBe(true);

    expect(await clearExpiredNoticePersonalData(new Date(Date.now() - 365 * DAY))).toBe(0); // idempotente
  });

  it("a carga inicial deriva cancelamentos e pagamentos antigos, marcada como backfill, e é idempotente", async () => {
    const t = await h.makeTenant(fixtures, `bf${token()}`);
    const sub = await h.makePayingSubscription(fixtures, t.tenant.id, "bf", { currentPeriodEnd: at("2026-05-01T00:00:00Z") });
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: "CANCELED", canceledAt: at("2026-06-10T12:00:00Z") } });
    const paid = await prisma.invoice.create({
      data: { subscriptionId: sub.id, amountCents: 4990, periodStart: at("2026-04-01T00:00:00Z"), periodEnd: at("2026-05-01T00:00:00Z"), dueAt: at("2026-05-01T00:00:00Z"), status: "PAID", paidAt: at("2026-04-30T12:00:00Z") },
    });

    const dir = path.join(process.cwd(), "prisma", "migrations");
    const folder = fs.readdirSync(dir).find((d) => d.endsWith("_regua_f6_backfill_billing_events"))!;
    const sql = fs.readFileSync(path.join(dir, folder, "migration.sql"), "utf8");
    const statements = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(2);
    for (let run = 0; run < 2; run += 1) for (const statement of statements) await prisma.$executeRawUnsafe(statement);

    const events = await prisma.billingEvent.findMany({ where: { subscriptionId: sub.id }, orderBy: { type: "asc" } });
    expect(events.map((e) => e.type)).toEqual(["CANCELED", "PAYMENT_CONFIRMED"]);
    expect(events[0].createdAt.toISOString()).toBe("2026-06-10T12:00:00.000Z");
    expect(events[0].metadata).toMatchObject({ backfill: true, cancelSource: "AUTO_SUSPENDED" });
    expect(events[1]).toMatchObject({ invoiceId: paid.id, fromStatus: null });
    expect(events[1].metadata).toMatchObject({ backfill: true, amountCents: 4990 });
    expect((await getFinanceOverview()).approximateHistory.hasBackfilledEvents).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("CSV de faturas: GET /api/admin/finance/invoices.csv", () => {
  it("neutraliza injeção de fórmula, escapa aspas e traz as colunas certas", async () => {
    const evilName = '=HYPERLINK("http://evil.example","clique")';
    const t = await h.makeTenant(fixtures, `csv${token()}`, { document: "52998224725" });
    await prisma.tenant.update({ where: { id: t.tenant.id }, data: { name: evilName } });
    const sub = await h.makePayingSubscription(fixtures, t.tenant.id, "csv", { currentPeriodEnd: at("2026-08-01T00:00:00Z"), priceCents: 4990 });
    await prisma.plan.update({ where: { id: sub.planId }, data: { name: "+SOMA(1;2)" } });
    await prisma.invoice.create({
      data: { subscriptionId: sub.id, amountCents: 4990, periodStart: at("2026-07-01T10:00:00Z"), periodEnd: at("2026-08-01T10:00:00Z"), dueAt: at("2026-08-01T10:00:00Z"), status: "PAID", paidAt: at("2026-07-30T15:00:00Z"), mpPaymentId: "mp-123", paidByPaymentId: "mp-123" },
    });
    await prisma.invoice.create({
      data: { subscriptionId: sub.id, amountCents: 4990, periodStart: at("2026-08-01T10:00:00Z"), periodEnd: at("2026-09-01T10:00:00Z"), dueAt: at("2026-09-01T10:00:00Z"), status: "PAID", paidAt: at("2026-08-30T15:00:00Z"), paidByPaymentId: "manual" },
    });

    const { csv, filename, rows } = await buildInvoicesCsv({ from: "2026-08-01", to: "2026-09-30", status: "PAID" });
    expect(filename).toBe("faturas-2026-08-01_a_2026-09-30.csv");
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("﻿Empresa;Documento;Plano;Competência;Vencimento;Valor;Status;Pago em;Forma;Id da fatura;Id do pagamento MP");
    const mine = lines.filter((l) => l.includes("evil.example"));
    expect(mine).toHaveLength(2);
    // O nome da empresa e o do plano (iniciados por = e +) ganham apóstrofo; as aspas são dobradas.
    const prefix = `"'=HYPERLINK(""http://evil.example"",""clique"")";52998224725;"'+SOMA(1;2)";`;
    for (const line of mine) expect(line.startsWith(prefix)).toBe(true);
    expect(rows).toBeGreaterThanOrEqual(2);
    // Nenhuma célula começa com = + - @ (fora do apóstrofo de proteção).
    for (const line of lines.slice(1)) {
      for (const cell of line.split(";")) expect(/^"?[=+\-@]/.test(cell)).toBe(false);
    }
    const pix = mine.find((l) => l.includes(";mp-123"))!;
    expect(pix).toContain(";49,90;PAID;");
    expect(pix).toContain(";PIX;");
    expect(mine.find((l) => !l.includes(";mp-123"))).toContain(";MANUAL;");
    expect(pix).toContain(";2026-07;");
  });

  it("recusa mais de 12 meses, datas inválidas e status inválido, com status HTTP e corpo estruturado", async () => {
    expect(() => resolveCsvRange({ from: "2024-01-01", to: "2026-01-01" })).toThrowError(/12 meses/);
    expect(() => resolveCsvRange({ from: "2026-02-01", to: "2026-01-01" })).toThrowError(/anterior/);
    expect(() => resolveCsvRange({ from: "2026-13-45", to: "2026-12-01" })).toThrowError();
    // Exatamente 12 meses passa; padrão (sem datas) também.
    expect(() => resolveCsvRange({ from: "2025-10-02", to: "2026-10-01" })).not.toThrow();
    expect(() => resolveCsvRange({})).not.toThrow();

    const tooBig = await csvRoute.GET(new Request("http://localhost/api/admin/finance/invoices.csv?from=2024-01-01&to=2026-01-01"));
    expect(tooBig.status).toBe(400);
    expect((await tooBig.json()).error.code).toBe("INVALID_PAYLOAD");
    const badStatus = await csvRoute.GET(new Request("http://localhost/api/admin/finance/invoices.csv?status=XPTO"));
    expect(badStatus.status).toBe(400);
    const badDate = await csvRoute.GET(new Request("http://localhost/api/admin/finance/invoices.csv?from=ontem"));
    expect(badDate.status).toBe(400);

    const ok = await csvRoute.GET(new Request("http://localhost/api/admin/finance/invoices.csv?from=2026-08-01&to=2026-08-31&status=PAID"));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("text/csv");
    expect(ok.headers.get("content-disposition")).toContain('attachment; filename="faturas-2026-08-01_a_2026-08-31.csv"');
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });
});
