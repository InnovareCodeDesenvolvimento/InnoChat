/**
 * Monitor de cobrança (F7): `GET /api/health/billing`, itens do sino do Admin, e-mail ao admin quando vira `down` (no
 * máximo 1 a cada 6 h) e o gatilho da manutenção diária. Postgres real; SMTP dublê; relógio injetado onde a função aceita.
 * O estado global (`PlatformSettings`) é guardado e restaurado em cada teste.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const control = vi.hoisted(() => ({ healthThrows: false }));

vi.mock("@/modules/billing/health", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/modules/billing/health")>();
  return {
    ...original,
    loadBillingHealth: vi.fn(async (now?: Date) => {
      if (control.healthThrows) throw new Error("connect ECONNREFUSED postgresql://user:senha@db:5432/innochat");
      return original.loadBillingHealth(now);
    }),
  };
});

vi.mock("@/lib/email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
  const helpers = await import("./dunning.helpers");
  return { ...actual, sendMail: helpers.fakeSendMail(actual) };
});

const h = await import("./dunning.helpers");
const { GET } = await import("@/app/api/health/billing/route");
const { loadBillingHealth } = await import("@/modules/billing/health");
const { notifyAdminBillingDown, buildBillingDownEmail } = await import("@/modules/billing/health-alert");
const { listPlatformNotifications } = await import("@/modules/platform-notifications/service");
const { runMaintenanceTick } = await import("@/modules/maintenance/tick");

const { prisma } = h;
const fixtures = h.newFixtures();
const MIN = 60_000;
const ago = (minutes: number, from = new Date()) => new Date(from.getTime() - minutes * MIN);

let saved: { lastBillingTickAt: Date | null; lastBillingTickResult: unknown; lastBillingDownAlertAt: Date | null; platformWhatsappEnabled: boolean } | null = null;

async function setSettings(data: { lastBillingTickAt?: Date | null; lastBillingTickResult?: object; lastBillingDownAlertAt?: Date | null; platformWhatsappEnabled?: boolean }) {
  await prisma.platformSettings.update({ where: { id: 1 }, data });
}

beforeEach(async () => {
  h.resetMail();
  control.healthThrows = false;
  saved = await prisma.platformSettings.findUniqueOrThrow({
    where: { id: 1 },
    select: { lastBillingTickAt: true, lastBillingTickResult: true, lastBillingDownAlertAt: true, platformWhatsappEnabled: true },
  });
  await setSettings({ lastBillingTickAt: ago(10), lastBillingTickResult: { noticesSent: 3, noticesFailed: 0, emailsFailed: 0 }, lastBillingDownAlertAt: null, platformWhatsappEnabled: false });
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (saved) {
    await prisma.platformSettings.update({
      where: { id: 1 },
      data: {
        lastBillingTickAt: saved.lastBillingTickAt,
        lastBillingTickResult: (saved.lastBillingTickResult ?? undefined) as never,
        lastBillingDownAlertAt: saved.lastBillingDownAlertAt,
        platformWhatsappEnabled: saved.platformWhatsappEnabled,
      },
    });
  }
  await h.cleanup(fixtures);
  fixtures.tenantIds.length = 0;
  fixtures.userIds.length = 0;
  fixtures.planIds.length = 0;
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function makeAdmin(): Promise<{ id: string; email: string }> {
  const email = `it-monitor-admin-${randomUUID()}@example.com`;
  const user = await prisma.user.create({ data: { email, passwordHash: "x", emailVerifiedAt: new Date(), isPlatformAdmin: true, totpSecretEnc: "enc:v1:x", totpEnabledAt: new Date() } });
  fixtures.userIds.push(user.id);
  return { id: user.id, email };
}

async function makeSubscription(label: string) {
  const t = await h.makeTenant(fixtures, label, { billingWhatsappE164: null });
  const sub = await h.makePayingSubscription(fixtures, t.tenant.id, label, { currentPeriodEnd: new Date(Date.now() + 10 * 86_400_000) });
  return { ...t, sub };
}

type NoticeOver = { channel?: "EMAIL" | "WHATSAPP"; status: "PENDING" | "FAILED" | "SENT"; nextAttemptAt?: Date; attempts?: number; expiresAt?: Date; step?: string; sentAt?: Date };

async function makeNotice(sub: { id: string; tenantId: string }, over: NoticeOver) {
  const now = new Date();
  return prisma.billingNotice.create({
    data: {
      tenantId: sub.tenantId,
      subscriptionId: sub.id,
      step: over.step ?? "DUE_D1",
      channel: over.channel ?? "EMAIL",
      cycleKey: `it-monitor-${randomUUID()}`,
      status: over.status,
      attempts: over.attempts ?? 0,
      notBefore: ago(600),
      expiresAt: over.expiresAt ?? new Date(now.getTime() + 24 * 60 * MIN),
      nextAttemptAt: over.nextAttemptAt ?? now,
      sentAt: over.sentAt ?? null,
    },
  });
}

async function call() {
  const res = await GET();
  return { status: res.status, cache: res.headers.get("cache-control"), body: (await res.json()) as Record<string, unknown> };
}

describe("GET /api/health/billing: limites de status", () => {
  it("ok: 200, sem cache, com os campos do contrato", async () => {
    const { status, cache, body } = await call();
    expect(status).toBe(200);
    expect(cache).toContain("no-store");
    expect(body.status).toBe("ok");
    expect(body.minutesSinceLastTick).toBeGreaterThanOrEqual(10);
    expect(body.lastTickResult).toEqual({ sent: 3, failed: 0 });
    expect(body.platformWhatsapp).toBe("disabled");
    expect(body.emailFailing).toBe(false);
    expect(Object.keys(body)).toEqual(expect.arrayContaining(["status", "lastTickAt", "minutesSinceLastTick", "lastTickResult", "pendingOverdue", "failedLast24h", "emailFailing", "platformWhatsapp"]));
  });

  it("degraded: 200 quando a última rodada parou por tempo", async () => {
    await setSettings({ lastBillingTickResult: { noticesSent: 0, noticesFailed: 0, emailsFailed: 0, deadlineReached: true } });
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.lastTickResult).toEqual({ sent: 0, failed: 0, deadlineReached: true });
  });

  it("degraded: WhatsApp da plataforma ligado e sem número", async () => {
    const active = await prisma.platformWhatsappConnection.count({ where: { role: "ACTIVE" } });
    if (active > 0) return; // banco de teste com número ativo de outro teste: o caso não se aplica
    await setSettings({ platformWhatsappEnabled: true });
    const { status, body } = await call();
    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.platformWhatsapp).toBe("missing");
  });

  it("down: 503 quando a rodada passou de 3 h; 3 h exatas ainda é ok", async () => {
    const at = new Date();
    await setSettings({ lastBillingTickAt: ago(180, at) });
    expect((await loadBillingHealth(at)).status).toBe("ok");
    await setSettings({ lastBillingTickAt: ago(181, at) });
    const { status, body } = await call();
    expect(status).toBe(503);
    expect(body.status).toBe("down");
    expect(body.reasons).toContain("TICK_STALE");
  });

  it("down: aviso de e-mail vencido há mais de 2 h e preso; os fora do critério não contam", async () => {
    const { sub } = await makeSubscription("stuck");
    const baseline = (await loadBillingHealth()).pendingOverdue;
    await makeNotice(sub, { status: "PENDING", nextAttemptAt: ago(60) }); // vencido há 1 h: ainda normal
    await makeNotice(sub, { status: "PENDING", nextAttemptAt: new Date(Date.now() + 3 * 60 * MIN) }); // adiado para o futuro
    await makeNotice(sub, { status: "PENDING", nextAttemptAt: ago(300), expiresAt: ago(10) }); // já expirou
    await makeNotice(sub, { status: "PENDING", nextAttemptAt: ago(300), attempts: 5 }); // esgotou as tentativas
    await makeNotice(sub, { status: "SENT", nextAttemptAt: ago(300), sentAt: new Date() }); // já saiu
    expect((await loadBillingHealth()).pendingOverdue).toBe(baseline);

    await makeNotice(sub, { status: "PENDING", nextAttemptAt: ago(180) });
    const { status, body } = await call();
    expect(status).toBe(503);
    expect(body.pendingOverdue).toBe(baseline + 1);
    expect(body.reasons).toContain("NOTICES_STUCK_EMAIL");
  });

  it("WhatsApp preso entra em pendingOverdue, mas por si só é só degraded", async () => {
    const { sub } = await makeSubscription("stuck-wa");
    const before = await loadBillingHealth();
    await makeNotice(sub, { channel: "WHATSAPP", status: "PENDING", nextAttemptAt: ago(180) });
    const { status, body } = await call();
    expect(body.pendingOverdue).toBe(before.pendingOverdue + 1);
    if (before.status === "ok") {
      expect(status).toBe(200);
      expect(body.status).toBe("degraded");
    }
  });

  it("down: e-mail falhando em sequência, a menos que algum e-mail tenha saído na última janela", async () => {
    const { sub } = await makeSubscription("failing");
    await makeNotice(sub, { status: "FAILED", attempts: 3, nextAttemptAt: new Date(Date.now() + 120 * MIN), step: "DUE_D1" });
    const failing = await call();
    expect(failing.status).toBe(503);
    expect(failing.body.reasons).toContain("EMAIL_FAILING_IN_SEQUENCE");
    expect(failing.body.emailFailing).toBe(true);
    expect(failing.body.failedLast24h).toBeGreaterThanOrEqual(1);

    await makeNotice(sub, { status: "SENT", attempts: 1, sentAt: ago(30), step: "DUE_D0" });
    const recovered = await call();
    expect(recovered.body.reasons).not.toContain("EMAIL_FAILING_IN_SEQUENCE");
  });

  it("banco fora do ar: 503 genérico, sem vazar o erro", async () => {
    control.healthThrows = true;
    const { status, body } = await call();
    expect(status).toBe(503);
    expect(body.status).toBe("down");
    expect(JSON.stringify(body)).not.toMatch(/postgres|senha|ECONNREFUSED|user/);
  });

  it("a resposta não carrega e-mail, telefone nem nome de empresa", async () => {
    const { sub, email, tenant } = await makeSubscription("pii");
    await makeNotice(sub, { status: "FAILED", attempts: 3, nextAttemptAt: ago(300) });
    const { body } = await call();
    const json = JSON.stringify(body);
    expect(json).not.toContain(email);
    expect(json).not.toContain(tenant.name);
    expect(json).not.toMatch(/@|5584/);
  });
});

describe("sino do Admin", () => {
  it("BILLING_TICK_STALE (danger) com a rotina parada há mais de 3 h; some quando volta", async () => {
    const admin = await makeAdmin();
    await setSettings({ lastBillingTickAt: ago(150) });
    const warm = (await listPlatformNotifications(admin.id)).items;
    expect(warm.find((i) => i.kind === "BILLING_TICK_STALE")).toBeUndefined();

    await setSettings({ lastBillingTickAt: ago(200) });
    const stale = (await listPlatformNotifications(admin.id)).items.find((i) => i.kind === "BILLING_TICK_STALE");
    expect(stale).toBeDefined();
    expect(stale!.severity).toBe("danger");
    expect(stale!.href).toBe("/admin/saude");
    expect(stale!.id).toMatch(/^tick:billing-stale:/);

    await setSettings({ lastBillingTickAt: ago(5) });
    expect((await listPlatformNotifications(admin.id)).items.find((i) => i.kind === "BILLING_TICK_STALE")).toBeUndefined();
  });

  it("BILLING_NOTICES_STUCK (danger) com aviso preso, sem dado pessoal no texto", async () => {
    const admin = await makeAdmin();
    const { sub, email } = await makeSubscription("bell-stuck");
    await makeNotice(sub, { status: "PENDING", nextAttemptAt: ago(240) });
    const item = (await listPlatformNotifications(admin.id)).items.find((i) => i.kind === "BILLING_NOTICES_STUCK");
    expect(item).toBeDefined();
    expect(item!.severity).toBe("danger");
    expect(item!.body).not.toContain(email);
    expect(item!.body).not.toMatch(/@/);
  });
});

describe("e-mail ao admin quando vira down", () => {
  async function downReport(at: Date) {
    await setSettings({ lastBillingTickAt: ago(300, at) });
    const report = await loadBillingHealth(at);
    expect(report.status).toBe("down");
    return report;
  }

  it("não envia se não está down", async () => {
    await makeAdmin();
    const ok = await loadBillingHealth();
    expect(ok.status).not.toBe("down");
    expect(await notifyAdminBillingDown(ok)).toEqual({ sent: false, reason: "NOT_DOWN" });
    expect(h.sentEmails).toHaveLength(0);
  });

  it("envia ao admin da plataforma, 1 vez por janela de 6 h, e volta a enviar depois dela", async () => {
    const admin = await makeAdmin();
    const t0 = new Date();
    const report = await downReport(t0);

    const first = await notifyAdminBillingDown(report, t0);
    expect(first.sent).toBe(true);
    expect(h.sentEmails.filter((m) => m.to === admin.email)).toHaveLength(1);
    expect(h.sentEmails[0].subject).toBe("Cobrança do InnoChat parada");

    const repeated = await notifyAdminBillingDown(report, new Date(t0.getTime() + 5 * 60 * MIN + 59 * MIN));
    expect(repeated).toEqual({ sent: false, reason: "RATE_LIMITED" });
    const countAfterRepeat = h.sentEmails.length;

    const later = await notifyAdminBillingDown(report, new Date(t0.getTime() + 6 * 60 * MIN + 1000));
    expect(later.sent).toBe(true);
    expect(h.sentEmails.length).toBeGreaterThan(countAfterRepeat);
  });

  it("chamadas simultâneas mandam um só e-mail (reserva atômica)", async () => {
    const admin = await makeAdmin();
    const t0 = new Date();
    const report = await downReport(t0);
    const results = await Promise.all(Array.from({ length: 5 }, () => notifyAdminBillingDown(report, t0)));
    expect(results.filter((r) => r.sent)).toHaveLength(1);
    expect(h.sentEmails.filter((m) => m.to === admin.email)).toHaveLength(1);
  });

  it("falha no envio não gasta as 6 h: tenta de novo em 30 min", async () => {
    await makeAdmin();
    const t0 = new Date();
    const report = await downReport(t0);
    h.mailControl.mode = "fail";
    expect(await notifyAdminBillingDown(report, t0)).toEqual({ sent: false, reason: "SEND_FAILED" });

    h.mailControl.mode = "ok";
    expect(await notifyAdminBillingDown(report, new Date(t0.getTime() + 10 * MIN))).toEqual({ sent: false, reason: "RATE_LIMITED" });
    expect((await notifyAdminBillingDown(report, new Date(t0.getTime() + 31 * MIN))).sent).toBe(true);
  });

  it("SMTP sem configuração não derruba nada", async () => {
    await makeAdmin();
    const t0 = new Date();
    const report = await downReport(t0);
    h.mailControl.mode = "not_configured";
    expect(await notifyAdminBillingDown(report, t0)).toEqual({ sent: false, reason: "SMTP_NOT_CONFIGURED" });
  });

  it("o texto traz só motivos e números, sem dado de cliente", async () => {
    const report = await downReport(new Date());
    const mail = buildBillingDownEmail(report, "https://innochat.example/admin/saude");
    expect(mail.text).toContain("não roda há mais de 3 horas");
    expect(mail.text).toContain("https://innochat.example/admin/saude");
    expect(mail.text + mail.html).not.toMatch(/\w@\w/);
    expect(mail.text).not.toContain("—");
  });

  it("a consulta do monitor externo dispara o e-mail uma vez; a segunda consulta não repete", async () => {
    const admin = await makeAdmin();
    await setSettings({ lastBillingTickAt: ago(400) });
    expect((await call()).status).toBe(503);
    await vi.waitFor(() => expect(h.sentEmails.filter((m) => m.to === admin.email)).toHaveLength(1));
    expect((await call()).status).toBe(503);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(h.sentEmails.filter((m) => m.to === admin.email)).toHaveLength(1);
  });

  it("a manutenção diária também dispara (não depende do tick de cobrança)", async () => {
    const admin = await makeAdmin();
    await setSettings({ lastBillingTickAt: ago(400) });
    await runMaintenanceTick(new Date());
    expect(h.sentEmails.filter((m) => m.to === admin.email)).toHaveLength(1);
  });
});
