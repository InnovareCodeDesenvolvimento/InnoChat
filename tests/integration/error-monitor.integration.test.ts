/**
 * Monitor de erros (Melhoria 1): gravação agrupada por assinatura (upsert atômico), reabertura, IGNORED só conta, redação de dado
 * pessoal no banco, e-mail de erro novo com janela de 15 min, item do sino, listagem paginada, ações de status, retenção de 30
 * dias e a rota do navegador. Postgres real; SMTP dublê. As tabelas error_groups/error_events são exclusivas deste monitor,
 * então cada teste começa e termina com elas vazias.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
  const helpers = await import("./dunning.helpers");
  return { ...actual, sendMail: helpers.fakeSendMail(actual) };
});
const control = vi.hoisted(() => ({ autoFlush: false }));
vi.mock("@/modules/error-monitor/alert", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/modules/error-monitor/alert")>();
  // O disparo automático da captura é fire-and-forget e usa o relógio real: nos testes de janela ele é desligado.
  return { ...original, scheduleErrorAlertFlush: () => (control.autoFlush ? original.scheduleErrorAlertFlush() : undefined) };
});
vi.mock("@/lib/http/client-ip", () => ({ clientIp: async () => "203.0.113.77" }));

const h = await import("./dunning.helpers");
const { recordError, __resetCaptureThrottleForTests, captureLoggedError } = await import("@/modules/error-monitor/capture");
const { flushErrorAlerts, __resetAlertTimerForTests, ERROR_ALERT_INTERVAL_MINUTES } = await import("@/modules/error-monitor/alert");
const { listErrorGroups, getErrorGroupDetail, setErrorGroupStatus, purgeOldErrorEvents } = await import("@/modules/error-monitor/service");
const { upsertErrorGroup } = await import("@/lib/db/error-queries");
const { listPlatformNotifications } = await import("@/modules/platform-notifications/service");
const { __resetRateLimitsForTests } = await import("@/lib/rate-limit");
const { POST } = await import("@/app/api/client-errors/route");

const { prisma } = h;
const fixtures = h.newFixtures();
const MIN = 60_000;

async function wipe() {
  await prisma.errorGroup.deleteMany({});
  await prisma.providerEvent.deleteMany({ where: { provider: "error-alert" } });
}

async function makeAdmin(): Promise<{ id: string; email: string }> {
  const email = `it-errors-admin-${randomUUID()}@example.com`;
  const user = await prisma.user.create({ data: { email, passwordHash: "x", emailVerifiedAt: new Date(), isPlatformAdmin: true, totpSecretEnc: "enc:v1:x", totpEnabledAt: new Date() } });
  fixtures.userIds.push(user.id);
  return { id: user.id, email };
}

beforeEach(async () => {
  h.resetMail();
  control.autoFlush = false;
  __resetCaptureThrottleForTests();
  __resetAlertTimerForTests();
  __resetRateLimitsForTests();
  await wipe();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await wipe();
  await h.cleanup(fixtures);
  fixtures.tenantIds.length = 0;
  fixtures.userIds.length = 0;
  fixtures.planIds.length = 0;
});
afterAll(async () => {
  await prisma.$disconnect();
});

const boom = (msg = "Contato 123 não achado") => Object.assign(new Error(msg), { stack: `TypeError: ${msg}\n    at carregar (/app/src/svc.ts:10:5)` });
const asType = (e: Error) => Object.assign(e, { name: "TypeError" });

describe("gravação agrupada", () => {
  it("mesma assinatura soma no grupo e guarda cada ocorrência", async () => {
    const t0 = new Date("2026-10-02T12:00:00Z");
    await recordError({ source: "SERVER", error: asType(boom("Contato 123 não achado")), route: "/api/x" }, t0);
    __resetCaptureThrottleForTests();
    await recordError({ source: "SERVER", error: asType(boom("Contato 98765 não achado")), route: "/api/x" }, new Date(t0.getTime() + MIN));

    const groups = await prisma.errorGroup.findMany({});
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ count: 2, status: "OPEN", source: "SERVER", type: "TypeError", route: "/api/x", alertedAt: null });
    expect(groups[0]!.firstSeenAt.toISOString()).toBe(t0.toISOString());
    expect(groups[0]!.lastSeenAt.getTime()).toBe(t0.getTime() + MIN);
    expect(await prisma.errorEvent.count({ where: { groupId: groups[0]!.id } })).toBe(2);
  });

  it("não grava e-mail, telefone nem senha, nem na mensagem, nem na stack, nem no contexto", async () => {
    await recordError({
      source: "SERVER",
      error: Object.assign(new Error("falhou para ana@exemplo.com fone 11987654321"), { stack: "Error: falhou para ana@exemplo.com\n    at f (/app/a.ts:1:1)" }),
      context: { password: "hunter2", obs: "token=abc123 ligar 11987654321" },
    });
    const everything = JSON.stringify([await prisma.errorGroup.findMany({}), await prisma.errorEvent.findMany({})]);
    expect(everything).not.toMatch(/ana@exemplo|11987654321|hunter2|abc123/);
  });

  it("upserts simultâneos da mesma assinatura criam UM grupo e contam todos", async () => {
    const fingerprint = `it-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 12 }, () => upsertErrorGroup({ fingerprint, message: "m", type: "Error", source: "SERVER", route: null, version: "1.0.0", now: new Date() })),
    );
    expect(results.filter((r) => r.inserted)).toHaveLength(1);
    expect(await prisma.errorGroup.count({ where: { fingerprint } })).toBe(1);
    expect((await prisma.errorGroup.findUniqueOrThrow({ where: { fingerprint } })).count).toBe(12);
  });

  it("RESOLVED que repete reabre, limpa a marca e volta a ser 'novo' para o alerta", async () => {
    const admin = await makeAdmin();
    const first = await recordError({ source: "SERVER", error: asType(boom("x")) });
    if (!first.recorded) throw new Error("não gravou");
    await prisma.errorGroup.update({ where: { id: first.groupId }, data: { alertedAt: new Date() } });
    await setErrorGroupStatus(first.groupId, "RESOLVED", admin.id);
    expect(await prisma.errorGroup.findUniqueOrThrow({ where: { id: first.groupId } })).toMatchObject({ status: "RESOLVED", resolvedByUserId: admin.id });

    __resetCaptureThrottleForTests();
    const again = await recordError({ source: "SERVER", error: asType(boom("x")) });
    expect(again).toMatchObject({ recorded: true, status: "OPEN" });
    expect(await prisma.errorGroup.findUniqueOrThrow({ where: { id: first.groupId } })).toMatchObject({ status: "OPEN", resolvedAt: null, resolvedByUserId: null, alertedAt: null, count: 2 });
  });

  it("IGNORED só conta: não reabre e não guarda ocorrência nova", async () => {
    const admin = await makeAdmin();
    const first = await recordError({ source: "SERVER", error: asType(boom("ruído")) });
    if (!first.recorded) throw new Error("não gravou");
    await setErrorGroupStatus(first.groupId, "IGNORED", admin.id);
    const eventsBefore = await prisma.errorEvent.count({ where: { groupId: first.groupId } });

    __resetCaptureThrottleForTests();
    await recordError({ source: "SERVER", error: asType(boom("ruído")) });
    const g = await prisma.errorGroup.findUniqueOrThrow({ where: { id: first.groupId } });
    expect(g).toMatchObject({ status: "IGNORED", count: 2 });
    expect(await prisma.errorEvent.count({ where: { groupId: first.groupId } })).toBe(eventsBefore);
  });

  it("a mesma assinatura em sequência rápida é contida (sem metralhar o banco)", async () => {
    await recordError({ source: "SERVER", error: asType(boom("loop")) });
    const second = await recordError({ source: "SERVER", error: asType(boom("loop")) });
    expect(second).toEqual({ recorded: false, reason: "THROTTLED" });
  });

  it("logger.error vira ocorrência LoggedError sem lançar", async () => {
    captureLoggedError("billing.tick.falhou", { errorMessage: "SMTP fora", token: "[redacted]" });
    await vi.waitFor(async () => expect(await prisma.errorGroup.count()).toBe(1));
    expect(await prisma.errorGroup.findFirstOrThrow({})).toMatchObject({ type: "LoggedError", message: "billing.tick.falhou: SMTP fora" });
  });
});

describe("alerta de erro novo", () => {
  it("manda um e-mail ao admin, marca alertedAt e respeita a janela de 15 min (agrupando o resto)", async () => {
    const admin = await makeAdmin();
    const t0 = new Date("2026-10-02T12:03:00Z");
    await recordError({ source: "SERVER", error: asType(boom("primeiro erro")) }, t0);

    const sent = await flushErrorAlerts(t0);
    expect(sent).toMatchObject({ sent: true, groups: 1 });
    expect(h.sentEmails.some((m) => m.to === admin.email && /Erro novo/.test(m.subject) && m.text.includes("primeiro erro"))).toBe(true);
    expect(h.sentEmails.every((m) => !/primeiro erro.*@/.test(m.text))).toBe(true);

    // Dois erros novos dentro da mesma janela: ninguém manda e-mail, ficam pendentes.
    __resetCaptureThrottleForTests();
    await recordError({ source: "CLIENT", type: "TypeError", message: "segundo", stack: "TypeError: segundo\n    at a (/x.js:1:1)" }, new Date(t0.getTime() + MIN));
    await recordError({ source: "SERVER", error: asType(boom("terceiro erro diferente")) }, new Date(t0.getTime() + 2 * MIN));
    const mailsBefore = h.sentEmails.length;
    h.mailControl.mode = "ok";
    expect(await flushErrorAlerts(new Date(t0.getTime() + 5 * MIN))).toEqual({ sent: false, reason: "RATE_LIMITED" });
    expect(h.sentEmails.length).toBe(mailsBefore);
    expect(await prisma.errorGroup.count({ where: { status: "OPEN", alertedAt: null } })).toBeGreaterThanOrEqual(2);

    // Janela seguinte: um e-mail só, com os dois.
    const next = await flushErrorAlerts(new Date(t0.getTime() + (ERROR_ALERT_INTERVAL_MINUTES + 1) * MIN));
    expect(next).toMatchObject({ sent: true, groups: 2 });
    expect(await prisma.errorGroup.count({ where: { status: "OPEN", alertedAt: null } })).toBe(0);
    const grouped = h.sentEmails.filter((m) => m.to === admin.email).at(-1)!;
    expect(grouped.subject).toBe("2 erros novos no InnoChat");
  });

  it("a captura de um erro novo dispara o e-mail sozinha, sem ninguém chamar o alerta", async () => {
    const admin = await makeAdmin();
    control.autoFlush = true;
    await recordError({ source: "SERVER", error: asType(boom("erro que dispara sozinho")) });
    await vi.waitFor(() => expect(h.sentEmails.some((m) => m.to === admin.email && m.text.includes("erro que dispara sozinho"))).toBe(true));
    await vi.waitFor(async () => expect(await prisma.errorGroup.count({ where: { alertedAt: { not: null } } })).toBe(1));
  });

  it("falha de envio desfaz a marca (o erro continua novo) e a janela não é martelada", async () => {
    await makeAdmin();
    const t0 = new Date("2026-10-02T15:00:00Z");
    h.mailControl.mode = "fail";
    // Desliga o disparo automático da captura para controlar a ordem.
    await prisma.errorGroup.deleteMany({});
    await prisma.errorGroup.create({ data: { fingerprint: `it-${randomUUID()}`, message: "m", type: "Error", source: "SERVER" } });

    expect(await flushErrorAlerts(t0)).toEqual({ sent: false, reason: "SEND_FAILED" });
    expect(await prisma.errorGroup.count({ where: { alertedAt: null } })).toBe(1);
    expect(await flushErrorAlerts(new Date(t0.getTime() + MIN))).toEqual({ sent: false, reason: "RATE_LIMITED" });

    h.mailControl.mode = "ok";
    expect(await flushErrorAlerts(new Date(t0.getTime() + 16 * MIN))).toMatchObject({ sent: true });
  });

  it("SMTP não configurado: não perde o alerta", async () => {
    await makeAdmin();
    h.mailControl.mode = "not_configured";
    await prisma.errorGroup.create({ data: { fingerprint: `it-${randomUUID()}`, message: "m", type: "Error", source: "SERVER" } });
    expect(await flushErrorAlerts(new Date("2026-10-02T18:00:00Z"))).toEqual({ sent: false, reason: "SMTP_NOT_CONFIGURED" });
    expect(await prisma.errorGroup.count({ where: { alertedAt: null } })).toBe(1);
  });

  it("dois envios simultâneos na mesma janela mandam UM e-mail por destinatário", async () => {
    await makeAdmin();
    await prisma.errorGroup.create({ data: { fingerprint: `it-${randomUUID()}`, message: "m", type: "Error", source: "SERVER" } });
    const now = new Date("2026-10-02T20:00:00Z");
    const [a, b] = await Promise.all([flushErrorAlerts(now), flushErrorAlerts(now)]);
    expect([a.sent, b.sent].filter(Boolean)).toHaveLength(1);
  });

  it("IGNORED e RESOLVED não alertam", async () => {
    await makeAdmin();
    await prisma.errorGroup.create({ data: { fingerprint: `it-${randomUUID()}`, message: "m", type: "Error", source: "SERVER", status: "IGNORED" } });
    await prisma.errorGroup.create({ data: { fingerprint: `it-${randomUUID()}`, message: "m", type: "Error", source: "SERVER", status: "RESOLVED" } });
    expect(await flushErrorAlerts(new Date())).toEqual({ sent: false, reason: "NOTHING_PENDING" });
  });
});

describe("sino do admin", () => {
  it("erro novo aberto aparece no sino e some quando é resolvido", async () => {
    const admin = await makeAdmin();
    const g = await prisma.errorGroup.create({ data: { fingerprint: `it-${randomUUID()}`, message: "Falha de teste", type: "TypeError", source: "CLIENT" } });
    const bell = (await listPlatformNotifications(admin.id)).items.find((i) => i.id === `err:${g.id}`);
    expect(bell).toMatchObject({ kind: "NEW_ERROR", severity: "danger", href: "/admin/erros", title: "Erro novo no navegador" });
    expect(bell?.body).toContain("Falha de teste");

    await setErrorGroupStatus(g.id, "RESOLVED", admin.id);
    expect((await listPlatformNotifications(admin.id)).items.some((i) => i.id === `err:${g.id}`)).toBe(false);
  });
});

describe("listagem e ações (Admin → Erros)", () => {
  it("pagina, filtra por situação e origem e conta os totais", async () => {
    const base = new Date("2026-10-01T10:00:00Z").getTime();
    for (let i = 0; i < 12; i += 1) {
      await prisma.errorGroup.create({
        data: {
          fingerprint: `it-${randomUUID()}`,
          message: `erro ${i}`,
          type: "Error",
          source: i % 3 === 0 ? "CLIENT" : "SERVER",
          status: i < 8 ? "OPEN" : i < 10 ? "RESOLVED" : "IGNORED",
          lastSeenAt: new Date(base + i * MIN),
        },
      });
    }
    const first = await listErrorGroups({ pageSize: 10, page: 1 });
    expect(first).toMatchObject({ totalItems: 12, totalPages: 2, page: 1, totals: { open: 8, resolved: 2, ignored: 2 } });
    expect(first.items).toHaveLength(10);
    expect(first.items[0]!.message).toBe("erro 11");
    expect((await listErrorGroups({ pageSize: 10, page: 2 })).items).toHaveLength(2);
    expect((await listErrorGroups({ pageSize: 10, page: 99 })).page).toBe(2);

    const openClient = await listErrorGroups({ status: "OPEN", source: "CLIENT", pageSize: 25 });
    expect(openClient.items.every((i) => i.status === "OPEN" && i.source === "CLIENT")).toBe(true);
    expect(openClient.totalItems).toBe(3);
    expect(openClient.totals.open).toBe(3);
  });

  it("detalhe traz as últimas ocorrências sem expor ids de usuário/empresa; status muda e erro inexistente é domínio", async () => {
    const admin = await makeAdmin();
    const rec = await recordError({ source: "SERVER", error: asType(boom("detalhe")), userId: admin.id });
    if (!rec.recorded) throw new Error("não gravou");
    const detail = await getErrorGroupDetail(rec.groupId);
    expect(detail.events[0]).toMatchObject({ hasUser: true, hasTenant: false });
    expect(JSON.stringify(detail)).not.toContain(admin.id);

    const reopened = await setErrorGroupStatus(rec.groupId, "OPEN", admin.id);
    expect(reopened.status).toBe("OPEN");
    await expect(setErrorGroupStatus("nao-existe", "RESOLVED", admin.id)).rejects.toMatchObject({ code: "ERROR_GROUP_NOT_FOUND" });
    await expect(getErrorGroupDetail("nao-existe")).rejects.toMatchObject({ code: "ERROR_GROUP_NOT_FOUND" });
  });
});

describe("retenção", () => {
  it("apaga ocorrência com mais de 30 dias e mantém o grupo e o contador", async () => {
    const now = new Date("2026-10-02T12:00:00Z");
    const g = await prisma.errorGroup.create({ data: { fingerprint: `it-${randomUUID()}`, message: "m", type: "Error", source: "SERVER", count: 5 } });
    await prisma.errorEvent.create({ data: { groupId: g.id, occurredAt: new Date(now.getTime() - 31 * 86_400_000) } });
    await prisma.errorEvent.create({ data: { groupId: g.id, occurredAt: new Date(now.getTime() - 29 * 86_400_000) } });
    await prisma.providerEvent.create({ data: { provider: "error-alert", providerEventId: `old-${randomUUID()}`, payload: {}, createdAt: new Date(now.getTime() - 3 * 86_400_000) } });

    expect(await purgeOldErrorEvents(now)).toBe(1);
    expect(await prisma.errorEvent.count({ where: { groupId: g.id } })).toBe(1);
    expect((await prisma.errorGroup.findUniqueOrThrow({ where: { id: g.id } })).count).toBe(5);
    expect(await prisma.providerEvent.count({ where: { provider: "error-alert" } })).toBe(0);
  });
});

describe("POST /api/client-errors", () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    POST(new Request("http://localhost/api/client-errors", { method: "POST", headers: { "content-type": "application/json", host: "localhost", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) }));

  it("aceita o relato e grava como CLIENT", async () => {
    const res = await post({ type: "TypeError", message: "x is undefined em joao@x.com", stack: "TypeError: x\n    at a (/_next/static/chunks/abc12345.js:1:1)", route: "/login?token=1", version: "1.7.0", kind: "window-error" });
    expect(res.status).toBe(202);
    const g = await prisma.errorGroup.findFirstOrThrow({});
    expect(g).toMatchObject({ source: "CLIENT", type: "TypeError", route: "/login", lastVersion: "1.7.0" });
    expect(g.message).not.toContain("joao@x.com");
  });

  it("recusa origem de outro site, JSON inválido e corpo grande", async () => {
    expect((await post({ message: "x" }, { origin: "https://malvado.com" })).status).toBe(403);
    expect((await post("{lixo")).status).toBe(400);
    expect((await post({ message: "x".repeat(20_000) })).status).toBe(413);
    expect(await prisma.errorGroup.count()).toBe(0);
  });
});
