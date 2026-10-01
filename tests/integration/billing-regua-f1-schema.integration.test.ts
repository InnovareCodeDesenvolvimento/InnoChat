/**
 * F1 da régua de cobrança (docs/regua-de-cobranca.md): restrições do banco contra Postgres real.
 * Cobre os índices únicos parciais de `PlatformWhatsappConnection`, a chave única e os CHECKs do outbox
 * `BillingNotice`, o `BillingEvent` append-only, as cascatas e o backfill LEGACY_SENT (a migration SQL
 * de verdade, lida do disco e reexecutada: é idempotente por desenho, e o teste prova isso).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { addDays } from "date-fns";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPrisma } from "@/lib/db/prisma";

const prisma = getPrisma();
const run = randomUUID().slice(0, 8);
const BACKFILL_SQL = readFileSync(join(process.cwd(), "prisma/migrations/20261004100100_regua_f1_backfill_legacy_sent/migration.sql"), "utf8");

const tenantIds: string[] = [];
const planIds: string[] = [];
const connectionIds: string[] = [];
const providerEventIds: string[] = [];

const now = new Date("2026-10-04T12:00:00.000Z");
const isoUtc = (d: Date) => d.toISOString();

async function makePlan() {
  const plan = await prisma.plan.create({
    data: { code: `it-f1-${run}-${planIds.length}`, name: "Plano F1", priceCents: 4990, maxWhatsappNumbers: 1, maxProfessionals: 1, active: false, sortOrder: 999 },
  });
  planIds.push(plan.id);
  return plan;
}

async function makeSub(label: string, overrides: { status?: "ACTIVE" | "SUSPENDED" | "CANCELED" | "TRIALING"; currentPeriodEnd?: Date; suspendedEmailSentAt?: Date | null; canceledAt?: Date | null } = {}) {
  const plan = await makePlan();
  const tenant = await prisma.tenant.create({ data: { slug: `it-f1-${label}-${run}`, name: `F1 ${label}`, timezone: "America/Sao_Paulo" } });
  tenantIds.push(tenant.id);
  const sub = await prisma.subscription.create({
    data: {
      tenantId: tenant.id,
      planId: plan.id,
      status: overrides.status ?? "ACTIVE",
      currentPeriodEnd: overrides.currentPeriodEnd ?? addDays(now, 5),
      suspendedEmailSentAt: overrides.suspendedEmailSentAt ?? null,
      canceledAt: overrides.canceledAt ?? null,
    },
  });
  return { tenant, sub };
}

async function makeInvoice(subscriptionId: string, extra: { isTrialConversion?: boolean; dueReminderEmailSentAt?: Date; dueTodayEmailSentAt?: Date; offsetDays?: number } = {}) {
  const start = addDays(now, extra.offsetDays ?? 0);
  return prisma.invoice.create({
    data: {
      subscriptionId,
      amountCents: 4990,
      periodStart: start,
      periodEnd: addDays(start, 30),
      dueAt: addDays(start, 30),
      isTrialConversion: extra.isTrialConversion ?? false,
      dueReminderEmailSentAt: extra.dueReminderEmailSentAt ?? null,
      dueTodayEmailSentAt: extra.dueTodayEmailSentAt ?? null,
    },
  });
}

function notice(tenantId: string, subscriptionId: string, over: Record<string, unknown> = {}) {
  return {
    tenantId,
    subscriptionId,
    step: "DUE_D1",
    channel: "EMAIL",
    cycleKey: `k-${randomUUID()}`,
    notBefore: now,
    expiresAt: addDays(now, 1),
    nextAttemptAt: now,
    ...over,
  };
}

function connection(over: Record<string, unknown> = {}) {
  const id = randomUUID();
  return { instanceName: `it-f1-${run}-${id.slice(0, 8)}`, webhookTokenHash: `h-${id}`, label: "Cobrança", ...over };
}

async function makeConnection(over: Record<string, unknown> = {}) {
  const c = await prisma.platformWhatsappConnection.create({ data: connection(over) as never });
  connectionIds.push(c.id);
  return c;
}

const ACTIVE = { role: "ACTIVE", status: "CONNECTED", phoneE164: "5584999990001", activatedAt: now };

beforeAll(async () => {
  await prisma.platformWhatsappConnection.deleteMany({});
});

afterAll(async () => {
  await prisma.billingNotice.deleteMany({ where: { id: { startsWith: "legacy_" } } });
  await prisma.providerEvent.deleteMany({ where: { id: { in: providerEventIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.plan.deleteMany({ where: { id: { in: planIds } } });
  await prisma.platformWhatsappConnection.deleteMany({ where: { id: { in: connectionIds } } });
  await prisma.$disconnect();
});

describe("PlatformWhatsappConnection: índices únicos parciais e CHECKs", () => {
  it("aceita 1 ACTIVE + 1 PENDING + vários RETIRED, mas recusa o 2º ACTIVE e o 2º PENDING", async () => {
    const active = await makeConnection(ACTIVE);
    const pending = await makeConnection({});
    await makeConnection({ role: "RETIRED", retiredAt: now, retiredReason: "REPLACED" });
    await makeConnection({ role: "RETIRED", retiredAt: now, retiredReason: "ABANDONED_QR" });

    await expect(prisma.platformWhatsappConnection.create({ data: connection({ ...ACTIVE, phoneE164: "5584999990002" }) as never })).rejects.toMatchObject({ code: "P2002" });
    await expect(prisma.platformWhatsappConnection.create({ data: connection({}) as never })).rejects.toMatchObject({ code: "P2002" });

    // Troca atômica: a antiga sai e a nova assume na MESMA transação, sem violar nenhum índice.
    await prisma.$transaction([
      prisma.platformWhatsappConnection.update({ where: { id: active.id }, data: { role: "RETIRED", retiredAt: now, retiredReason: "REPLACED" } }),
      prisma.platformWhatsappConnection.update({ where: { id: pending.id }, data: { role: "ACTIVE", status: "CONNECTED", phoneE164: "5584999990003", activatedAt: now } }),
    ]);
    const roles = await prisma.platformWhatsappConnection.groupBy({ by: ["role"], _count: true, where: { id: { in: connectionIds } } });
    expect(Object.fromEntries(roles.map((r) => [r.role, r._count]))).toEqual({ ACTIVE: 1, RETIRED: 3 });
  });

  it("recusa papel/status fora do conjunto e papéis sem os campos obrigatórios", async () => {
    await prisma.platformWhatsappConnection.deleteMany({});
    await expect(prisma.platformWhatsappConnection.create({ data: connection({ role: "BOSS" }) as never })).rejects.toThrow();
    await expect(prisma.platformWhatsappConnection.create({ data: connection({ status: "WHATEVER" }) as never })).rejects.toThrow();
    // ACTIVE sem telefone ou sem activatedAt.
    await expect(prisma.platformWhatsappConnection.create({ data: connection({ role: "ACTIVE", activatedAt: now }) as never })).rejects.toThrow();
    await expect(prisma.platformWhatsappConnection.create({ data: connection({ role: "ACTIVE", phoneE164: "5584999990001" }) as never })).rejects.toThrow();
    // RETIRED sem retiredAt.
    await expect(prisma.platformWhatsappConnection.create({ data: connection({ role: "RETIRED" }) as never })).rejects.toThrow();
  });

  it("instanceName e webhookTokenHash são únicos", async () => {
    const c = await makeConnection({});
    await expect(prisma.platformWhatsappConnection.create({ data: connection({ instanceName: c.instanceName, role: "RETIRED", retiredAt: now }) as never })).rejects.toMatchObject({ code: "P2002" });
    await expect(prisma.platformWhatsappConnection.create({ data: connection({ webhookTokenHash: c.webhookTokenHash, role: "RETIRED", retiredAt: now }) as never })).rejects.toMatchObject({ code: "P2002" });
  });
});

describe("BillingNotice: chave única, CHECKs e cascatas", () => {
  it("(cycleKey, step, channel) é único; outro canal ou outra etapa no mesmo ciclo é aceito", async () => {
    const { tenant, sub } = await makeSub("uniq");
    const cycleKey = `cy-${run}`;
    await prisma.billingNotice.create({ data: notice(tenant.id, sub.id, { cycleKey }) as never });
    await expect(prisma.billingNotice.create({ data: notice(tenant.id, sub.id, { cycleKey }) as never })).rejects.toMatchObject({ code: "P2002" });
    await prisma.billingNotice.create({ data: notice(tenant.id, sub.id, { cycleKey, channel: "WHATSAPP" }) as never });
    await prisma.billingNotice.create({ data: notice(tenant.id, sub.id, { cycleKey, step: "DUE_D0" }) as never });
    // Gravação idempotente do planejador: INSERT ... ON CONFLICT DO NOTHING.
    const again = await prisma.billingNotice.createMany({ data: [notice(tenant.id, sub.id, { cycleKey })] as never, skipDuplicates: true });
    expect(again.count).toBe(0);
    expect(await prisma.billingNotice.count({ where: { cycleKey } })).toBe(3);
  });

  it("recusa canal/status inválidos, tentativas negativas e motivo de descarte incoerente", async () => {
    const { tenant, sub } = await makeSub("check");
    await expect(prisma.billingNotice.create({ data: notice(tenant.id, sub.id, { channel: "SMS" }) as never })).rejects.toThrow();
    await expect(prisma.billingNotice.create({ data: notice(tenant.id, sub.id, { status: "DONE" }) as never })).rejects.toThrow();
    await expect(prisma.billingNotice.create({ data: notice(tenant.id, sub.id, { attempts: -1 }) as never })).rejects.toThrow();
    // SKIPPED exige motivo; motivo só com SKIPPED.
    await expect(prisma.billingNotice.create({ data: notice(tenant.id, sub.id, { status: "SKIPPED" }) as never })).rejects.toThrow();
    await expect(prisma.billingNotice.create({ data: notice(tenant.id, sub.id, { status: "PENDING", skippedReason: "PAID" }) as never })).rejects.toThrow();
    await prisma.billingNotice.create({ data: notice(tenant.id, sub.id, { status: "SKIPPED", skippedReason: "PAID" }) as never });
  });

  it("FKs: apagar a empresa leva os avisos; apagar a fatura/conexão só zera a referência", async () => {
    const { tenant, sub } = await makeSub("casc");
    const invoice = await makeInvoice(sub.id);
    const conn = await makeConnection({ role: "RETIRED", retiredAt: now });
    const n = await prisma.billingNotice.create({
      data: notice(tenant.id, sub.id, { invoiceId: invoice.id, channel: "WHATSAPP", platformConnectionId: conn.id, senderPhoneE164: "5584999990001" }) as never,
    });

    await prisma.platformWhatsappConnection.delete({ where: { id: conn.id } });
    let fresh = await prisma.billingNotice.findUniqueOrThrow({ where: { id: n.id } });
    expect(fresh.platformConnectionId).toBeNull();
    expect(fresh.senderPhoneE164).toBe("5584999990001"); // a cópia do número sobrevive

    await prisma.invoice.delete({ where: { id: invoice.id } });
    fresh = await prisma.billingNotice.findUniqueOrThrow({ where: { id: n.id } });
    expect(fresh.invoiceId).toBeNull();

    await prisma.tenant.delete({ where: { id: tenant.id } });
    expect(await prisma.billingNotice.count({ where: { id: n.id } })).toBe(0);
  });
});

describe("BillingEvent: append-only", () => {
  it("UPDATE é proibido, DELETE e cascata da empresa continuam valendo, actorType é validado", async () => {
    const { tenant, sub } = await makeSub("event");
    const ev = await prisma.billingEvent.create({
      data: { tenantId: tenant.id, subscriptionId: sub.id, type: "STATUS_CHANGED", fromStatus: "ACTIVE", toStatus: "PAST_DUE", metadata: { source: "tick" } },
    });
    expect(ev.actorType).toBe("SYSTEM");
    await expect(prisma.billingEvent.update({ where: { id: ev.id }, data: { type: "OUTRO" } })).rejects.toThrow(/append-only/);
    await expect(prisma.billingEvent.create({ data: { tenantId: tenant.id, subscriptionId: sub.id, type: "X", actorType: "ROBOT" } })).rejects.toThrow();

    const second = await prisma.billingEvent.create({ data: { tenantId: tenant.id, subscriptionId: sub.id, type: "PAYMENT_CONFIRMED", actorType: "OWNER" } });
    await prisma.billingEvent.delete({ where: { id: second.id } });
    await prisma.tenant.delete({ where: { id: tenant.id } });
    expect(await prisma.billingEvent.count({ where: { id: ev.id } })).toBe(0);
  });
});

describe("Tenant e PlatformSettings: campos novos", () => {
  it("billingWhatsappE164 aceita só 12-13 dígitos; opt-out e e-mail são opcionais; chave geral nasce desligada", async () => {
    const tenant = await prisma.tenant.create({ data: { slug: `it-f1-contato-${run}`, name: "Contato", timezone: "America/Sao_Paulo" } });
    tenantIds.push(tenant.id);
    expect(tenant.billingEmail).toBeNull();
    expect(tenant.billingWhatsappE164).toBeNull();
    expect(tenant.billingWhatsappOptOutAt).toBeNull();
    for (const bad of ["+5584999990001", "84999990001", "5584999990001999", "55 84 99999 0001"]) {
      await expect(prisma.tenant.update({ where: { id: tenant.id }, data: { billingWhatsappE164: bad } })).rejects.toThrow();
    }
    const ok = await prisma.tenant.update({ where: { id: tenant.id }, data: { billingEmail: "financeiro@example.com", billingWhatsappE164: "5584999990001", billingWhatsappOptOutAt: now } });
    expect(ok.billingWhatsappE164).toBe("5584999990001");
    await prisma.tenant.update({ where: { id: tenant.id }, data: { billingWhatsappE164: "558499999000" } });

    const settings = await prisma.platformSettings.findUnique({ where: { id: 1 }, select: { platformWhatsappEnabled: true } });
    expect(settings?.platformWhatsappEnabled).toBe(false);
  });
});

describe("Backfill LEGACY_SENT (migration de dados, idempotente)", () => {
  it("traduz as marcas antigas para a chave do motor novo, sem tocar no que não foi enviado, e re-executar não muda nada", async () => {
    const periodEnd = new Date("2026-09-20T23:59:00.000Z");
    const canceledAt = new Date("2026-10-01T10:20:30.456Z");

    const paying = await makeSub("lg-pay");
    const tick1 = new Date("2026-10-03T08:00:00.000Z");
    const tick2 = new Date("2026-10-04T09:00:00.000Z");
    const invMarked = await makeInvoice(paying.sub.id, { dueReminderEmailSentAt: tick1, dueTodayEmailSentAt: tick2 });
    const invGenerated = await makeInvoice(paying.sub.id, { offsetDays: 40 });
    const invPendingOutbox = await makeInvoice(paying.sub.id, { offsetDays: 80 });
    const invOld = await makeInvoice(paying.sub.id, { offsetDays: 120 }); // sem nenhuma marca: só o blanket de INVOICE_CREATED

    const trial = await makeSub("lg-trial", { status: "TRIALING" });
    const invTrial = await makeInvoice(trial.sub.id, { isTrialConversion: true, dueReminderEmailSentAt: tick1 });

    const suspended = await makeSub("lg-susp", { status: "SUSPENDED", currentPeriodEnd: periodEnd, suspendedEmailSentAt: tick2 });
    const suspendedNoMark = await makeSub("lg-susp-nomark", { status: "SUSPENDED", currentPeriodEnd: periodEnd });
    const canceled = await makeSub("lg-cancel", { status: "CANCELED", currentPeriodEnd: periodEnd, canceledAt });
    const canceledStale = await makeSub("lg-cancel-stale", { status: "CANCELED", currentPeriodEnd: periodEnd, canceledAt: new Date("2026-10-02T00:00:00.000Z") });
    const canceledPendingMail = await makeSub("lg-cancel-pend", { status: "CANCELED", currentPeriodEnd: periodEnd, canceledAt });

    const events = await Promise.all([
      prisma.providerEvent.create({ data: { provider: "billing-email", providerEventId: `invoice_generated:${invGenerated.id}`, payload: { kind: "invoice_generated" }, processedAt: tick1 } }),
      prisma.providerEvent.create({ data: { provider: "billing-email", providerEventId: `invoice_generated:${invPendingOutbox.id}`, payload: { kind: "invoice_generated" }, processedAt: null } }),
      prisma.providerEvent.create({ data: { provider: "billing-email", providerEventId: `auto_cancel:${canceled.sub.id}:${canceledAt.getTime()}`, payload: { kind: "auto_cancel" }, processedAt: tick2 } }),
      // chave de um cancelamento antigo: a assinatura foi reativada e cancelada de novo (canceledAt diferente)
      prisma.providerEvent.create({ data: { provider: "billing-email", providerEventId: `auto_cancel:${canceledStale.sub.id}:${canceledAt.getTime()}`, payload: { kind: "auto_cancel" }, processedAt: tick2 } }),
      prisma.providerEvent.create({ data: { provider: "billing-email", providerEventId: `auto_cancel:${canceledPendingMail.sub.id}:${canceledAt.getTime()}`, payload: { kind: "auto_cancel" }, processedAt: null } }),
    ]);
    providerEventIds.push(...events.map((e) => e.id));

    // Um aviso já gravado pelo motor novo no mesmo ciclo/etapa não pode ser sobrescrito.
    await prisma.billingNotice.create({
      data: notice(paying.tenant.id, paying.sub.id, { cycleKey: invMarked.id, step: "DUE_D1", status: "SENT", sentAt: tick1, invoiceId: invMarked.id }) as never,
    });

    await prisma.$executeRawUnsafe(BACKFILL_SQL);

    const rows = await prisma.billingNotice.findMany({ where: { tenantId: { in: tenantIds } }, orderBy: [{ cycleKey: "asc" }, { step: "asc" }] });
    const find = (cycleKey: string, step: string) => rows.find((r) => r.cycleKey === cycleKey && r.step === step && r.channel === "EMAIL");
    const periodKey = (subId: string) => `${subId}:${isoUtc(periodEnd)}`;

    // DUE_D1 / DUE_D0 de fatura comum: o do motor novo permanece SENT; o D0 vira LEGACY_SENT.
    expect(find(invMarked.id, "DUE_D1")?.status).toBe("SENT");
    const d0 = find(invMarked.id, "DUE_D0");
    expect(d0).toMatchObject({ status: "SKIPPED", skippedReason: "LEGACY_SENT", subscriptionId: paying.sub.id, tenantId: paying.tenant.id, invoiceId: invMarked.id });
    expect(d0?.createdAt.toISOString()).toBe(tick2.toISOString());
    // Fatura de teste usa as etapas TRIAL_* sob a chave do teste.
    expect(find(`${trial.sub.id}:trial`, "TRIAL_T1")).toMatchObject({ status: "SKIPPED", skippedReason: "LEGACY_SENT", invoiceId: null });
    expect(find(`${trial.sub.id}:trial`, "TRIAL_T0")).toBeUndefined();
    // Fatura gerada: marca precisa, blanket para faturas antigas, e a pendente no outbox antigo NÃO é marcada.
    expect(find(invGenerated.id, "INVOICE_CREATED")?.createdAt.toISOString()).toBe(tick1.toISOString());
    expect(find(invOld.id, "INVOICE_CREATED")).toMatchObject({ skippedReason: "LEGACY_SENT" });
    expect(find(invTrial.id, "INVOICE_CREATED")).toMatchObject({ skippedReason: "LEGACY_SENT" });
    expect(find(invPendingOutbox.id, "INVOICE_CREATED")).toBeUndefined();
    // Suspensão: só com marca e só SUSPENDED; chave = período não pago em ISO UTC (igual ao toISOString do JS).
    expect(find(periodKey(suspended.sub.id), "SUSPENDED")).toMatchObject({ status: "SKIPPED", skippedReason: "LEGACY_SENT", invoiceId: null });
    expect(find(periodKey(suspendedNoMark.sub.id), "SUSPENDED")).toBeUndefined();
    // Cancelamento automático: só quando o canceledAt da assinatura bate com o da marca e o envio foi concluído.
    expect(find(periodKey(canceled.sub.id), "AUTO_CANCELED")).toMatchObject({ skippedReason: "LEGACY_SENT" });
    expect(find(periodKey(canceledStale.sub.id), "AUTO_CANCELED")).toBeUndefined();
    expect(find(periodKey(canceledPendingMail.sub.id), "AUTO_CANCELED")).toBeUndefined();

    // Idempotência: a segunda execução não cria, não duplica e não altera nada.
    const before = rows.map((r) => `${r.id}|${r.status}|${r.updatedAt.toISOString()}`).sort();
    await prisma.$executeRawUnsafe(BACKFILL_SQL);
    const after = (await prisma.billingNotice.findMany({ where: { tenantId: { in: tenantIds } } })).map((r) => `${r.id}|${r.status}|${r.updatedAt.toISOString()}`).sort();
    expect(after).toEqual(before);
  });
});
