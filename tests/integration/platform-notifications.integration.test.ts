/**
 * Central de notificações do admin da plataforma (docs/contratos.md) contra Postgres real: cada
 * kind, leitura de uma e de todas (por usuário), poll, paginação e guarda de admin. O banco de
 * teste pode ter dados de outros arquivos, então as asserções procuram ids específicos e usam
 * diferenças de contador — nunca totais absolutos (exceto logo após "marcar todas").
 */
import { randomUUID } from "node:crypto";
import { addDays } from "date-fns";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import type { AdminNotification } from "@/modules/platform-notifications/types";

const sessionState: { userId: string | null } = { userId: null };
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => (sessionState.userId ? { user: { id: sessionState.userId } } : null)) }));

const actions = await import("@/modules/platform-notifications/actions");
const { runMaintenanceTick } = await import("@/modules/maintenance/tick");

const prisma = getPrisma();
const tenantIds: string[] = [];
const userIds: string[] = [];
let planId: string | null = null;
let savedSettings: Awaited<ReturnType<typeof readSettings>> = null;

async function readSettings() {
  return prisma.platformSettings.findUnique({
    where: { id: 1 },
    select: { lastBillingTickAt: true, lastMaintenanceTickAt: true, lastMpWebhookRejectedAt: true, lastMpWebhookRejection: true },
  });
}

async function getPlanId() {
  if (!planId) {
    const plan = await prisma.plan.create({
      data: { code: `it-pn-${randomUUID().slice(0, 8)}`, name: "Plano IT admin notif", priceCents: 4990, maxWhatsappNumbers: 5, maxProfessionals: null, active: false, sortOrder: 999 },
    });
    planId = plan.id;
  }
  return planId;
}

async function makeAdmin(isPlatformAdmin = true) {
  const u = await prisma.user.create({ data: { email: `it-pn-${randomUUID().slice(0, 8)}@example.test`, passwordHash: "x", isPlatformAdmin, totpSecretEnc: isPlatformAdmin ? "enc:v1:x" : null, totpEnabledAt: isPlatformAdmin ? new Date() : null } });
  userIds.push(u.id);
  return u;
}

async function makeTenant(label: string, sub?: Partial<{ status: "TRIALING" | "ACTIVE" | "SUSPENDED" | "CANCELED"; currentPeriodEnd: Date; trialEndsAt: Date; canceledAt: Date }>) {
  const tenant = await prisma.tenant.create({ data: { slug: `it-pn-${label}-${randomUUID().slice(0, 8)}`, name: `PN ${label}`, timezone: "UTC" } });
  tenantIds.push(tenant.id);
  const subscription = await prisma.subscription.create({
    data: {
      tenantId: tenant.id,
      planId: await getPlanId(),
      status: sub?.status ?? "ACTIVE",
      currentPeriodEnd: sub?.currentPeriodEnd ?? addDays(new Date(), 20),
      trialEndsAt: sub?.trialEndsAt,
      canceledAt: sub?.canceledAt,
    },
  });
  return { tenant, subscription };
}

/** Percorre todas as páginas e devolve todos os itens. */
async function listAll() {
  const items: AdminNotification[] = [];
  let cursor: string | undefined;
  let unreadCount = 0;
  for (let guard = 0; guard < 50; guard += 1) {
    const r = await actions.listPlatformNotificationsAction({ cursor });
    if (!r.ok) throw new Error(`list falhou: ${r.error.code}`);
    items.push(...r.data.items);
    unreadCount = r.data.unreadCount;
    if (!r.data.nextCursor) break;
    cursor = r.data.nextCursor;
  }
  return { items, unreadCount };
}

beforeEach(() => {
  sessionState.userId = null;
});

savedSettings = await readSettings();

afterAll(async () => {
  await prisma.platformSettings.update({
    where: { id: 1 },
    data: {
      lastBillingTickAt: savedSettings?.lastBillingTickAt ?? null,
      lastMaintenanceTickAt: savedSettings?.lastMaintenanceTickAt ?? null,
      lastMpWebhookRejectedAt: savedSettings?.lastMpWebhookRejectedAt ?? null,
      lastMpWebhookRejection: savedSettings?.lastMpWebhookRejection ?? undefined,
    },
  });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  if (planId) await prisma.plan.delete({ where: { id: planId } });
  await prisma.$disconnect();
});

describe("admin notifications — guarda", () => {
  it("sem sessão: UNAUTHENTICATED; usuário comum: FORBIDDEN — nas três actions", async () => {
    const normal = await makeAdmin(false);
    for (const userId of [null, normal.id]) {
      sessionState.userId = userId;
      const expected = userId ? "FORBIDDEN" : "UNAUTHENTICATED";
      expect(await actions.listPlatformNotificationsAction({})).toMatchObject({ ok: false, error: { code: expected } });
      expect(await actions.pollPlatformNotificationsAction({ since: new Date().toISOString() })).toMatchObject({ ok: false, error: { code: expected } });
      expect(await actions.markPlatformNotificationsReadAction({ all: true })).toMatchObject({ ok: false, error: { code: expected } });
    }
  });

  it("valida entrada: sem ids/all, id malformado, cursor inválido, since inválido", async () => {
    const admin = await makeAdmin();
    sessionState.userId = admin.id;
    expect(await actions.markPlatformNotificationsReadAction({})).toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });
    expect(await actions.markPlatformNotificationsReadAction({ ids: ["bad key!"] })).toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });
    expect(await actions.listPlatformNotificationsAction({ cursor: "lixo" })).toMatchObject({ ok: false, error: { code: "INVALID_CURSOR" } });
    expect(await actions.pollPlatformNotificationsAction({ since: "nao-e-data" })).toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });
  });
});

describe("admin notifications — cada kind", () => {
  it("TENANT_SIGNED_UP e TRIAL_ENDING (faltam <= 24h)", async () => {
    const admin = await makeAdmin();
    sessionState.userId = admin.id;
    const { tenant, subscription } = await makeTenant("signup", { status: "TRIALING", trialEndsAt: new Date(Date.now() + 10 * 3_600_000) });
    const { items } = await listAll();

    const signup = items.find((i) => i.id === `signup:${tenant.id}`);
    expect(signup).toMatchObject({ kind: "TENANT_SIGNED_UP", severity: "info", href: "/admin/empresas", read: false, tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug } });
    expect(signup?.body).toContain(tenant.name);

    const trial = items.find((i) => i.id === `trial:${subscription.id}`);
    expect(trial).toMatchObject({ kind: "TRIAL_ENDING", severity: "warning", tenant: { id: tenant.id } });

    // trial que ainda tem mais de 24h NÃO notifica
    const far = await makeTenant("trialfar", { status: "TRIALING", trialEndsAt: new Date(Date.now() + 40 * 3_600_000) });
    expect((await listAll()).items.some((i) => i.id === `trial:${far.subscription.id}`)).toBe(false);
  });

  it("PAYMENT_RECEIVED: fatura paga com valor e link da cobrança; fatura aberta não", async () => {
    const admin = await makeAdmin();
    sessionState.userId = admin.id;
    const { tenant, subscription } = await makeTenant("pay");
    const now = new Date();
    const paid = await prisma.invoice.create({
      data: { subscriptionId: subscription.id, amountCents: 12345, periodStart: now, periodEnd: addDays(now, 30), dueAt: now, status: "PAID", paidAt: now },
    });
    const open = await prisma.invoice.create({
      data: { subscriptionId: subscription.id, amountCents: 999, periodStart: addDays(now, 30), periodEnd: addDays(now, 60), dueAt: now, status: "OPEN" },
    });
    const { items } = await listAll();
    const item = items.find((i) => i.id === `pay:${paid.id}`);
    expect(item).toMatchObject({ kind: "PAYMENT_RECEIVED", severity: "success", href: "/admin/cobranca", tenant: { id: tenant.id } });
    expect(item?.body).toMatch(/123,45/);
    expect(items.some((i) => i.id === `pay:${open.id}`)).toBe(false);
  });

  it("TENANT_SUSPENDED e TENANT_CANCELED (canceladas antes da janela de 30 dias não aparecem)", async () => {
    const admin = await makeAdmin();
    sessionState.userId = admin.id;
    const susp = await makeTenant("susp", { status: "SUSPENDED", currentPeriodEnd: addDays(new Date(), -5) });
    const canc = await makeTenant("canc", { status: "CANCELED", canceledAt: addDays(new Date(), -2) });
    const oldCanc = await makeTenant("oldcanc", { status: "CANCELED", canceledAt: addDays(new Date(), -40) });
    const { items } = await listAll();

    expect(items.find((i) => i.id.startsWith(`susp:${susp.subscription.id}:`))).toMatchObject({ kind: "TENANT_SUSPENDED", severity: "warning", tenant: { id: susp.tenant.id } });
    expect(items.find((i) => i.id.startsWith(`cancel:${canc.subscription.id}:`))).toMatchObject({ kind: "TENANT_CANCELED", severity: "danger", tenant: { id: canc.tenant.id } });
    expect(items.some((i) => i.id.startsWith(`cancel:${oldCanc.subscription.id}:`))).toBe(false);
  });

  it("WHATSAPP_DISCONNECTED: instância de qualquer empresa que caiu; sandbox, removida e reconectada não", async () => {
    const admin = await makeAdmin();
    sessionState.userId = admin.id;
    const { tenant } = await makeTenant("wa");
    const mk = (label: string, extra: Record<string, unknown>) =>
      prisma.whatsappInstance.create({
        data: { tenantId: tenant.id, instanceName: `it-pn-${label}-${randomUUID().slice(0, 8)}`, label, webhookToken: randomUUID(), status: "DISCONNECTED", disconnectedAt: new Date(), ...extra },
      });
    const down = await mk("Caiu", {});
    const sandbox = await mk("Sandbox", { sandbox: true });
    const removed = await mk("Removida", { deletedAt: new Date() });
    const back = await mk("Voltou", { status: "CONNECTED", disconnectedAt: null });

    const { items } = await listAll();
    const found = items.find((i) => i.id.startsWith(`wa:${down.id}:`));
    expect(found).toMatchObject({ kind: "WHATSAPP_DISCONNECTED", severity: "danger", href: "/admin/saude", tenant: { id: tenant.id } });
    expect(found?.body).toContain("Caiu");
    for (const other of [sandbox, removed, back]) expect(items.some((i) => i.id.startsWith(`wa:${other.id}:`))).toBe(false);
  });

  it("MP_WEBHOOK_REJECTED: lê o diagnóstico da PlatformSettings (com o motivo)", async () => {
    const admin = await makeAdmin();
    sessionState.userId = admin.id;
    const at = new Date(Date.now() - 60_000);
    await prisma.platformSettings.update({ where: { id: 1 }, data: { lastMpWebhookRejectedAt: at, lastMpWebhookRejection: { reason: "invalid_signature" } } });
    const { items } = await listAll();
    const item = items.find((i) => i.id === `mpwh:${at.getTime()}`);
    expect(item).toMatchObject({ kind: "MP_WEBHOOK_REJECTED", severity: "danger", href: "/admin/saude" });
    expect(item?.body).toContain("invalid_signature");
    expect(item?.tenant).toBeUndefined();
  });

  it("TICK_LATE: billing > 2h e maintenance > 26h, com a mesma regra da Saúde; em dia não aparece", async () => {
    const admin = await makeAdmin();
    sessionState.userId = admin.id;
    const billingAt = new Date(Date.now() - 5 * 3_600_000);
    const maintAt = new Date(Date.now() - 30 * 3_600_000);
    await prisma.platformSettings.update({ where: { id: 1 }, data: { lastBillingTickAt: billingAt, lastMaintenanceTickAt: maintAt } });

    let { items } = await listAll();
    expect(items.find((i) => i.id === `tick:billing:${billingAt.getTime()}`)).toMatchObject({ kind: "TICK_LATE", severity: "warning", href: "/admin/saude" });
    expect(items.find((i) => i.id === `tick:maintenance:${maintAt.getTime()}`)).toMatchObject({ kind: "TICK_LATE" });

    const okBilling = new Date(Date.now() - 30 * 60_000);
    const okMaint = new Date(Date.now() - 3_600_000);
    await prisma.platformSettings.update({ where: { id: 1 }, data: { lastBillingTickAt: okBilling, lastMaintenanceTickAt: okMaint } });
    ({ items } = await listAll());
    expect(items.some((i) => i.kind === "TICK_LATE")).toBe(false);
  });
});

describe("admin notifications — leitura, poll e paginação", () => {
  it("marcar uma, marcar todas, por usuário; novas depois de 'todas' voltam como não lidas", async () => {
    const a1 = await makeAdmin();
    const a2 = await makeAdmin();
    const { tenant } = await makeTenant("read");
    const key = `signup:${tenant.id}`;

    sessionState.userId = a1.id;
    const before = await listAll();
    expect(before.items.find((i) => i.id === key)?.read).toBe(false);

    const one = await actions.markPlatformNotificationsReadAction({ ids: [key] });
    expect(one).toMatchObject({ ok: true, data: { unreadCount: before.unreadCount - 1 } });
    const afterOne = await listAll();
    expect(afterOne.items.find((i) => i.id === key)?.read).toBe(true);
    // idempotente
    expect(await actions.markPlatformNotificationsReadAction({ ids: [key] })).toMatchObject({ ok: true, data: { unreadCount: before.unreadCount - 1 } });

    // o outro admin não é afetado
    sessionState.userId = a2.id;
    expect((await listAll()).items.find((i) => i.id === key)?.read).toBe(false);

    // todas (a2) → zero; nova empresa depois volta como 1 não lida
    expect(await actions.markPlatformNotificationsReadAction({ all: true })).toMatchObject({ ok: true, data: { unreadCount: 0 } });
    expect((await listAll()).unreadCount).toBe(0);
    await new Promise((r) => setTimeout(r, 15));
    const { tenant: fresh } = await makeTenant("read2");
    const after = await listAll();
    expect(after.unreadCount).toBe(1);
    expect(after.items.find((i) => i.id === `signup:${fresh.id}`)?.read).toBe(false);

    // a1 continua com o próprio estado
    sessionState.userId = a1.id;
    expect((await listAll()).items.find((i) => i.id === key)?.read).toBe(true);
  });

  it("poll: fresh só traz o que é mais novo que since; unreadCount bate com a listagem", async () => {
    const admin = await makeAdmin();
    sessionState.userId = admin.id;
    const since = new Date();
    await new Promise((r) => setTimeout(r, 15));
    const { tenant } = await makeTenant("poll");

    const poll = await actions.pollPlatformNotificationsAction({ since: since.toISOString() });
    if (!poll.ok) throw new Error(poll.error.code);
    expect(poll.data.fresh.some((f) => f.id === `signup:${tenant.id}`)).toBe(true);
    expect(poll.data.fresh.length).toBeLessThanOrEqual(10);
    expect(poll.data.fresh.every((f) => new Date(f.createdAt) > since)).toBe(true);

    const list = await listAll();
    expect(poll.data.unreadCount).toBe(list.unreadCount);

    const future = await actions.pollPlatformNotificationsAction({ since: new Date(Date.now() + 60_000).toISOString() });
    expect(future).toMatchObject({ ok: true, data: { fresh: [] } });
  });

  it("paginação de 20 com cursor: sem repetir nem perder itens", async () => {
    const admin = await makeAdmin();
    sessionState.userId = admin.id;
    for (let i = 0; i < 25; i += 1) await makeTenant(`pg${i}`);

    const p1 = await actions.listPlatformNotificationsAction({});
    if (!p1.ok) throw new Error(p1.error.code);
    expect(p1.data.items).toHaveLength(20);
    expect(p1.data.nextCursor).not.toBeNull();
    const p2 = await actions.listPlatformNotificationsAction({ cursor: p1.data.nextCursor! });
    if (!p2.ok) throw new Error(p2.error.code);
    const ids = [...p1.data.items, ...p2.data.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(p2.data.items.length).toBeGreaterThan(0);
  });

  it("maintenance/tick purga leituras individuais com mais de 45 dias", async () => {
    const admin = await makeAdmin();
    await prisma.platformNotificationRead.createMany({
      data: [
        { userId: admin.id, notificationKey: "signup:antiga", readAt: addDays(new Date(), -50) },
        { userId: admin.id, notificationKey: "signup:recente", readAt: new Date() },
      ],
    });
    await runMaintenanceTick(new Date());
    const keys = (await prisma.platformNotificationRead.findMany({ where: { userId: admin.id } })).map((r) => r.notificationKey);
    expect(keys).toEqual(["signup:recente"]);
  });
});
