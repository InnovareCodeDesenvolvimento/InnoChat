/**
 * WhatsApp da plataforma (F4 da régua de cobrança, docs/regua-de-cobranca.md §2.4) contra Postgres real,
 * com a Evolution simulada (`@/modules/whatsapp/evolution-client#getEvolutionClient`). O que importa aqui é
 * a lógica real: troca atômica, queda, trava anti-loop com o bot de empresa, token do webhook e guarda de
 * admin. O banco de teste é compartilhado: cada teste zera as conexões da plataforma (a tabela é global e
 * tem no máximo 1 ACTIVE e 1 PENDING por desenho).
 *
 * Requer `TEST_DATABASE_URL` com as migrations aplicadas (.claude/agent-memory/vega/integration_tests_setup.md).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import { EvolutionApiError, type EvolutionClient } from "@/modules/whatsapp/evolution-client";

const sessionState: { userId: string | null } = { userId: null };
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => (sessionState.userId ? { user: { id: sessionState.userId } } : null)) }));

type Session = { state: "connecting" | "open" | "close"; owner: string | null };
const instances = new Map<string, Session>();
const webhooks = new Map<string, string>();
const sent: Array<{ instance: string; number: string; text: string }> = [];
const loggedOut: string[] = [];
const deleted: string[] = [];
let failLogout = false;
let webhookEnabled = true;

function makeFakeEvolution(): EvolutionClient {
  const session = (name: string) => {
    const s = instances.get(name);
    if (!s) throw new EvolutionApiError("instância não existe", 404);
    return s;
  };
  return {
    createInstance: vi.fn(async (name: string) => {
      instances.set(name, { state: "connecting", owner: null });
    }),
    setWebhook: vi.fn(async (name: string, url: string) => {
      webhooks.set(name, url);
    }),
    findWebhook: vi.fn(async (name: string) => {
      session(name);
      const url = webhooks.get(name);
      return url ? { enabled: webhookEnabled, url, events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE"] } : null;
    }),
    connect: vi.fn(async (name: string) => ({ qrCodeDataUrl: `data:image/png;base64,QR-${name}`, pairingCode: null })),
    connectionState: vi.fn(async (name: string) => session(name).state),
    fetchOwnerJid: vi.fn(async (name: string) => session(name).owner),
    logout: vi.fn(async (name: string) => {
      if (failLogout) throw new EvolutionApiError("Evolution fora do ar", 500);
      session(name).state = "close";
      loggedOut.push(name);
    }),
    deleteInstance: vi.fn(async (name: string) => {
      if (failLogout) throw new EvolutionApiError("Evolution fora do ar", 500);
      instances.delete(name);
      deleted.push(name);
    }),
    sendText: vi.fn(async (name: string, number: string, text: string) => {
      if (session(name).state !== "open") throw new EvolutionApiError("sessão fechada", 400);
      sent.push({ instance: name, number, text });
      return { messageId: `msg-${sent.length}` };
    }),
    checkWhatsappNumbers: vi.fn(async (_name: string, numbers: string[]) => numbers.map((number) => ({ number, exists: true }))),
    sendButtons: vi.fn(async () => ({ messageId: null, status: 201, body: null })),
    sendList: vi.fn(async () => ({ messageId: null, status: 201, body: null })),
    sendPoll: vi.fn(async () => ({ messageId: null, status: 201, body: null })),
  };
}

const fakeEvolution = makeFakeEvolution();
vi.mock("@/modules/whatsapp/evolution-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/modules/whatsapp/evolution-client")>();
  return { ...original, getEvolutionClient: vi.fn(async () => fakeEvolution) };
});

const prisma = getPrisma();
const actions = await import("@/modules/platform/platform-whatsapp-actions");
const connections = await import("@/modules/platform-whatsapp/connections");
const { sendPlatformWhatsapp, sendPlatformWhatsappTest } = await import("@/modules/platform-whatsapp/sender");
const { handlePlatformWhatsappWebhook } = await import("@/modules/platform-whatsapp/webhook");
const { invalidatePlatformSenderCache } = await import("@/modules/platform-whatsapp/sender-guard");
const notifications = await import("@/modules/platform-notifications/actions");
const { claimMessage } = await import("@/modules/bot-api/claim");
const { __resetRateLimitsForTests } = await import("@/lib/rate-limit");

const PHONE_A = "5584991110001";
const PHONE_B = "5584991110002";
const SUBSCRIBER = "5584991110099";
const PHONE_BOT = "5584991110003";

const userIds: string[] = [];
const tenantIds: string[] = [];
let planId: string | null = null;
let adminId = "";
let savedEnabled = false;

async function makeUser(isPlatformAdmin: boolean) {
  const u = await prisma.user.create({ data: { email: `it-pwa-${randomUUID().slice(0, 8)}@example.test`, passwordHash: "x", isPlatformAdmin, totpSecretEnc: isPlatformAdmin ? "enc:v1:x" : null, totpEnabledAt: isPlatformAdmin ? new Date() : null } });
  userIds.push(u.id);
  return u;
}

async function getPlanId() {
  if (!planId) {
    const plan = await prisma.plan.create({
      data: { code: `it-pwa-${randomUUID().slice(0, 8)}`, name: "Plano IT pwa", priceCents: 4990, maxWhatsappNumbers: 5, maxProfessionals: null, active: false, sortOrder: 999 },
    });
    planId = plan.id;
  }
  return planId;
}

async function makeTenant(extra: { billingWhatsappE164?: string } = {}) {
  const tenant = await prisma.tenant.create({
    data: { slug: `it-pwa-${randomUUID().slice(0, 8)}`, name: `PWA ${randomUUID().slice(0, 4)}`, timezone: "UTC", ...extra },
  });
  tenantIds.push(tenant.id);
  const subscription = await prisma.subscription.create({
    data: { tenantId: tenant.id, planId: await getPlanId(), status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000) },
  });
  return { tenant, subscription };
}

async function recordSentNotice(tenantId: string, subscriptionId: string, connectionId: string, senderPhone: string, sentAt = new Date()) {
  await prisma.billingNotice.create({
    data: {
      tenantId,
      subscriptionId,
      step: "DUE_D1",
      channel: "WHATSAPP",
      cycleKey: `it-pwa-${randomUUID()}`,
      status: "SENT",
      notBefore: sentAt,
      expiresAt: new Date(sentAt.getTime() + 86_400_000),
      nextAttemptAt: sentAt,
      sentAt,
      platformConnectionId: connectionId,
      senderPhoneE164: senderPhone,
    },
  });
}

async function resetPlatformState() {
  await prisma.platformWhatsappConnection.deleteMany({});
  await prisma.providerEvent.deleteMany({ where: { provider: { startsWith: "platform-whatsapp" } } });
  await prisma.platformSettings.upsert({ where: { id: 1 }, create: { id: 1, platformWhatsappEnabled: true }, update: { platformWhatsappEnabled: true } });
  instances.clear();
  webhooks.clear();
  sent.length = 0;
  loggedOut.length = 0;
  deleted.length = 0;
  failLogout = false;
  webhookEnabled = true;
  invalidatePlatformSenderCache();
  __resetRateLimitsForTests();
}

function scan(instanceName: string, phone: string) {
  instances.set(instanceName, { state: "open", owner: `${phone}@s.whatsapp.net` });
}

function tokenOf(instanceName: string): string {
  return webhooks.get(instanceName)!.split("/").pop()!;
}

/** Conecta um número do zero (ou troca) pelas actions reais, como o admin faria. */
async function connectNumber(label: string, phone: string): Promise<{ connectionId: string; instanceName: string }> {
  const started = await actions.startPlatformWhatsappConnectionAction({ label });
  if (!started.ok) throw new Error(`start falhou: ${started.error.code}`);
  const row = await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: started.data.connectionId } });
  scan(row.instanceName, phone);
  const qr = await actions.getPlatformWhatsappQrAction(row.id);
  if (!qr.ok) throw new Error(`qr falhou: ${qr.error.code}`);
  expect(qr.data.status).toBe("CONNECTED");
  return { connectionId: row.id, instanceName: row.instanceName };
}

async function activeRows() {
  return prisma.platformWhatsappConnection.findMany({ where: { role: "ACTIVE" } });
}

beforeAll(async () => {
  const settings = await prisma.platformSettings.findUnique({ where: { id: 1 }, select: { platformWhatsappEnabled: true } });
  savedEnabled = settings?.platformWhatsappEnabled ?? false;
  adminId = (await makeUser(true)).id;
});

beforeEach(async () => {
  sessionState.userId = adminId;
  await resetPlatformState();
});

afterAll(async () => {
  await prisma.platformWhatsappConnection.deleteMany({});
  await prisma.providerEvent.deleteMany({ where: { provider: { startsWith: "platform-whatsapp" } } });
  await prisma.platformSettings.update({ where: { id: 1 }, data: { platformWhatsappEnabled: savedEnabled } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  if (planId) await prisma.plan.deleteMany({ where: { id: planId } });
  await prisma.$disconnect();
});

describe("guarda de admin", () => {
  it("não-admin e anônimo são negados em TODAS as actions", async () => {
    const nonAdmin = await makeUser(false);
    for (const userId of [nonAdmin.id, null]) {
      sessionState.userId = userId;
      const results = await Promise.all([
        actions.getPlatformWhatsappAction(),
        actions.setPlatformWhatsappEnabledAction({ enabled: true }),
        actions.startPlatformWhatsappConnectionAction({ label: "X" }),
        actions.getPlatformWhatsappQrAction("abc"),
        actions.cancelPlatformWhatsappConnectionAction("abc"),
        actions.disconnectPlatformWhatsappAction({ confirm: "DESCONECTAR" }),
        actions.sendPlatformWhatsappTestAction({ toE164: "(84) 99999-8888" }),
      ]).catch((error: unknown) => {
        // anônimo: `requireSessionUser` redireciona/lança; aceitável desde que NADA tenha sido criado
        return [{ ok: false as const, error: { code: error instanceof Error ? error.message : "ERR", message: "" } }];
      });
      for (const r of results) expect(r.ok).toBe(false);
      if (userId) for (const r of results) if (!r.ok) expect(r.error.code).toBe("FORBIDDEN");
    }
    expect(await prisma.platformWhatsappConnection.count()).toBe(0);
    expect(instances.size).toBe(0);
  });
});

describe("conectar e trocar de número", () => {
  it("conecta o 1º número: webhook próprio com token só em hash e instância fora de WhatsappInstance", async () => {
    const { connectionId, instanceName } = await connectNumber("Cobrança", PHONE_A);
    expect(instanceName).toMatch(/^innochat-plataforma-[a-f0-9]{8}$/);

    const url = webhooks.get(instanceName)!;
    expect(url).toContain("/api/webhooks/platform-whatsapp/");
    const token = tokenOf(instanceName);
    const row = await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: connectionId } });
    expect(row.role).toBe("ACTIVE");
    expect(row.phoneE164).toBe(PHONE_A);
    expect(row.webhookTokenHash).not.toBe(token);
    expect(row.webhookTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(await prisma.whatsappInstance.count({ where: { instanceName } })).toBe(0);

    const state = await actions.getPlatformWhatsappAction();
    expect(state.ok && state.data.active?.phoneDisplay).toBe("+55 84 99111-0001");
  });

  it("troca SEM intervalo sem canal: a antiga segue enviando até a nova conectar; depois UMA transação troca; logout vem depois", async () => {
    const a = await connectNumber("Cobrança", PHONE_A);
    const { tenant } = await makeTenant();

    const swap = await actions.startPlatformWhatsappConnectionAction({ label: "Cobrança (chip novo)" });
    expect(swap.ok).toBe(true);
    const bId = swap.ok ? swap.data.connectionId : "";
    const b = await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: bId } });

    // Enquanto o QR do novo está aberto, a antiga continua ACTIVE e enviando.
    expect((await activeRows()).map((r) => r.id)).toEqual([a.connectionId]);
    const during = await sendPlatformWhatsapp({ toE164: SUBSCRIBER, text: "durante a troca", tenantId: tenant.id, noticeId: "n1" });
    expect(during.outcome).toBe("SENT");
    expect(sent.at(-1)!.instance).toBe(a.instanceName);

    // Segundo QR aberto é recusado (no máximo 1 PENDING).
    const again = await actions.startPlatformWhatsappConnectionAction({ label: "outro" });
    expect(again.ok).toBe(false);

    scan(b.instanceName, PHONE_B);
    const qr = await actions.getPlatformWhatsappQrAction(bId);
    expect(qr.ok && qr.data.status).toBe("CONNECTED");

    const rows = await prisma.platformWhatsappConnection.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.id, r.role, r.retiredReason])).toEqual([
      [a.connectionId, "RETIRED", "REPLACED"],
      [bId, "ACTIVE", null],
    ]);
    expect(loggedOut).toContain(a.instanceName);
    expect(loggedOut).not.toContain(b.instanceName);

    const after = await sendPlatformWhatsapp({ toE164: SUBSCRIBER, text: "depois da troca", tenantId: tenant.id, noticeId: "n2" });
    expect(after).toMatchObject({ outcome: "SENT", connectionId: bId, senderPhoneE164: PHONE_B });
    expect(sent.at(-1)!.instance).toBe(b.instanceName);
  });

  it("webhook e polling juntos na hora da troca: uma só ativa, sem erro", async () => {
    await connectNumber("Cobrança", PHONE_A);
    const swap = await actions.startPlatformWhatsappConnectionAction({ label: "Novo" });
    const bId = swap.ok ? swap.data.connectionId : "";
    const b = await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: bId } });
    scan(b.instanceName, PHONE_B);

    const outcomes = await Promise.allSettled([
      actions.getPlatformWhatsappQrAction(bId),
      handlePlatformWhatsappWebhook(tokenOf(b.instanceName), { event: "connection.update", data: { state: "open", wuid: `${PHONE_B}@s.whatsapp.net` } }),
      actions.getPlatformWhatsappQrAction(bId),
    ]);
    for (const o of outcomes) expect(o.status).toBe("fulfilled");
    const actives = await activeRows();
    expect(actives).toHaveLength(1);
    expect(actives[0]!.id).toBe(bId);
  });

  it("o banco impede dois ativos (índice único parcial)", async () => {
    const a = await connectNumber("Cobrança", PHONE_A);
    const swap = await actions.startPlatformWhatsappConnectionAction({ label: "Novo" });
    const bId = swap.ok ? swap.data.connectionId : "";
    await expect(
      prisma.platformWhatsappConnection.update({ where: { id: bId }, data: { role: "ACTIVE", phoneE164: PHONE_B, activatedAt: new Date() } }),
    ).rejects.toThrow();
    expect((await activeRows()).map((r) => r.id)).toEqual([a.connectionId]);
  });

  it("logout do antigo falha na Evolution: a troca vale e o tick repete a limpeza", async () => {
    const a = await connectNumber("Cobrança", PHONE_A);
    failLogout = true;
    const swap = await actions.startPlatformWhatsappConnectionAction({ label: "Novo" });
    const bId = swap.ok ? swap.data.connectionId : "";
    const b = await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: bId } });
    scan(b.instanceName, PHONE_B);
    const qr = await actions.getPlatformWhatsappQrAction(bId);
    expect(qr.ok && qr.data.status).toBe("CONNECTED");
    expect((await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: a.connectionId } })).role).toBe("RETIRED");
    expect(instances.has(a.instanceName)).toBe(true); // ainda não conseguiu limpar
    expect(await prisma.providerEvent.count({ where: { provider: "platform-whatsapp-cleanup", processedAt: null } })).toBeGreaterThanOrEqual(1);

    failLogout = false;
    const summary = await connections.runPlatformWhatsappMaintenance({ evolution: fakeEvolution });
    expect(summary.cleanupsDone).toBeGreaterThanOrEqual(1);
    expect(instances.has(a.instanceName)).toBe(false);
    expect(await prisma.providerEvent.count({ where: { provider: "platform-whatsapp-cleanup", processedAt: null } })).toBe(0);
  });

  it("cancelar a troca apaga a pendente e a ativa nem percebe; QR abandonado há 30 min vira histórico", async () => {
    const a = await connectNumber("Cobrança", PHONE_A);
    const swap = await actions.startPlatformWhatsappConnectionAction({ label: "Novo" });
    const bId = swap.ok ? swap.data.connectionId : "";
    const b = await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: bId } });

    const canceled = await actions.cancelPlatformWhatsappConnectionAction(bId);
    expect(canceled.ok && canceled.data.canceled).toBe(true);
    expect(await prisma.platformWhatsappConnection.findUnique({ where: { id: bId } })).toBeNull();
    expect(deleted).toContain(b.instanceName);
    expect((await activeRows()).map((r) => r.id)).toEqual([a.connectionId]);

    // cancelar a ATIVA não é permitido
    const wrong = await actions.cancelPlatformWhatsappConnectionAction(a.connectionId);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.code).toBe("INVALID_STATE");

    // abandono
    const again = await actions.startPlatformWhatsappConnectionAction({ label: "Outro" });
    const cId = again.ok ? again.data.connectionId : "";
    await prisma.platformWhatsappConnection.update({ where: { id: cId }, data: { createdAt: new Date(Date.now() - 31 * 60_000) } });
    const summary = await connections.runPlatformWhatsappMaintenance({ evolution: fakeEvolution });
    expect(summary.abandonedQr).toBe(1);
    expect(await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: cId } })).toMatchObject({ role: "RETIRED", retiredReason: "ABANDONED_QR" });
  });

  it("não aceita o WhatsApp comercial do site nem o número do bot de uma empresa", async () => {
    await prisma.platformSettings.update({ where: { id: 1 }, data: { salesWhatsappE164: "558431132584" } });
    const started = await actions.startPlatformWhatsappConnectionAction({ label: "Cobrança" });
    const row = await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: started.ok ? started.data.connectionId : "" } });
    scan(row.instanceName, "558431132584");
    const qr = await actions.getPlatformWhatsappQrAction(row.id);
    expect(qr.ok).toBe(false);
    if (!qr.ok) expect(qr.error.code).toBe("PHONE_IS_SALES_NUMBER");
    expect(await activeRows()).toHaveLength(0);
    await prisma.platformSettings.update({ where: { id: 1 }, data: { salesWhatsappE164: null } });

    const { tenant } = await makeTenant();
    await prisma.whatsappInstance.create({ data: { tenantId: tenant.id, instanceName: `it-pwa-bot-${randomUUID().slice(0, 6)}`, label: "Bot", webhookToken: randomUUID(), phoneE164: `+${PHONE_BOT}` } });
    const second = await actions.startPlatformWhatsappConnectionAction({ label: "Cobrança" });
    const row2 = await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: second.ok ? second.data.connectionId : "" } });
    scan(row2.instanceName, PHONE_BOT);
    const qr2 = await actions.getPlatformWhatsappQrAction(row2.id);
    expect(qr2.ok).toBe(false);
    if (!qr2.ok) expect(qr2.error.code).toBe("PHONE_IN_USE_BY_TENANT");
  });

  it("desconectar exige confirmação e aposenta a ativa", async () => {
    const a = await connectNumber("Cobrança", PHONE_A);
    const wrong = await actions.disconnectPlatformWhatsappAction({ confirm: "sim" });
    expect(wrong.ok).toBe(false);
    const ok = await actions.disconnectPlatformWhatsappAction({ confirm: "DESCONECTAR" });
    expect(ok.ok).toBe(true);
    expect(await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: a.connectionId } })).toMatchObject({ role: "RETIRED", retiredReason: "DISCONNECTED_BY_ADMIN" });
    expect(loggedOut).toContain(a.instanceName);
    const again = await actions.disconnectPlatformWhatsappAction({ confirm: "DESCONECTAR" });
    expect(again.ok).toBe(false);
    const state = await actions.getPlatformWhatsappAction();
    expect(state.ok && state.data.history[0]?.phoneDisplay).toBe("+55 84 9****-0001");
  });
});

describe("aviso de novo número", () => {
  it("a 1ª mensagem do número novo avisa a troca, UMA vez só; quem nunca recebeu não vê o aviso", async () => {
    const a = await connectNumber("Cobrança", PHONE_A);
    const { tenant, subscription } = await makeTenant();
    const fresh = await makeTenant();
    await recordSentNotice(tenant.id, subscription.id, a.connectionId, PHONE_A);

    const swap = await actions.startPlatformWhatsappConnectionAction({ label: "Novo" });
    const bId = swap.ok ? swap.data.connectionId : "";
    const b = await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: bId } });
    scan(b.instanceName, PHONE_B);
    await actions.getPlatformWhatsappQrAction(bId);

    const first = await sendPlatformWhatsapp({ toE164: SUBSCRIBER, text: "Sua fatura vence amanhã.", tenantId: tenant.id, noticeId: "n1" });
    const second = await sendPlatformWhatsapp({ toE164: SUBSCRIBER, text: "Segundo aviso.", tenantId: tenant.id, noticeId: "n2" });
    const never = await sendPlatformWhatsapp({ toE164: SUBSCRIBER, text: "Para quem nunca recebeu.", tenantId: fresh.tenant.id, noticeId: "n3" });
    expect([first.outcome, second.outcome, never.outcome]).toEqual(["SENT", "SENT", "SENT"]);

    const texts = sent.map((s) => s.text);
    expect(texts[0]).toBe("Este é o novo número de avisos do InnoChat. O anterior não envia mais mensagens.\n\nSua fatura vence amanhã.");
    expect(texts[1]).toBe("Segundo aviso.");
    expect(texts[2]).toBe("Para quem nunca recebeu.");
  });
});

describe("envio, queda e aquecimento", () => {
  it("chave geral desligada ou sem número: NO_PLATFORM_NUMBER; com número: SENT com os dados para o BillingNotice", async () => {
    const { tenant } = await makeTenant();
    const args = { toE164: SUBSCRIBER, text: "oi", tenantId: tenant.id, noticeId: "n1" };
    expect((await sendPlatformWhatsapp(args)).outcome).toBe("NO_PLATFORM_NUMBER");

    const a = await connectNumber("Cobrança", PHONE_A);
    await actions.setPlatformWhatsappEnabledAction({ enabled: false });
    expect((await sendPlatformWhatsapp(args)).outcome).toBe("NO_PLATFORM_NUMBER");
    await actions.setPlatformWhatsappEnabledAction({ enabled: true });

    const ok = await sendPlatformWhatsapp({ ...args, toE164: "+55 (84) 99109-9099" });
    expect(ok).toEqual({ outcome: "SENT", connectionId: a.connectionId, senderPhoneE164: PHONE_A, providerMessageId: "msg-1" });
    expect(sent[0]).toMatchObject({ number: "5584991099099" });
  });

  it("queda com resultado CHANNEL_DOWN, alerta no sino e reconexão pela mesma linha", async () => {
    const a = await connectNumber("Cobrança", PHONE_A);
    const { tenant } = await makeTenant();
    instances.get(a.instanceName)!.state = "close"; // a sessão caiu e o webhook se perdeu

    const down = await sendPlatformWhatsapp({ toE164: SUBSCRIBER, text: "oi", tenantId: tenant.id, noticeId: "n1" });
    expect(down).toMatchObject({ outcome: "CHANNEL_DOWN", connectionId: a.connectionId });
    expect((await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: a.connectionId } })).status).toBe("DISCONNECTED");
    const calls = vi.mocked(fakeEvolution.sendText).mock.calls.length;
    expect((await sendPlatformWhatsapp({ toE164: SUBSCRIBER, text: "oi", tenantId: tenant.id, noticeId: "n2" })).outcome).toBe("CHANNEL_DOWN");
    expect(vi.mocked(fakeEvolution.sendText).mock.calls.length).toBe(calls); // nem tenta enviar

    const bell = await notifications.listPlatformNotificationsAction({});
    expect(bell.ok && bell.data.items.some((i) => i.kind === "PLATFORM_WHATSAPP_DISCONNECTED" && i.id.startsWith(`pwa:down:${a.connectionId}:`))).toBe(true);

    // reconectar: o QR volta na MESMA linha; ler com o mesmo número restaura
    const qr = await actions.getPlatformWhatsappQrAction(a.connectionId);
    expect(qr.ok && qr.data).toMatchObject({ status: "DISCONNECTED", role: "ACTIVE" });
    scan(a.instanceName, PHONE_A);
    const back = await actions.getPlatformWhatsappQrAction(a.connectionId);
    expect(back.ok && back.data.status).toBe("CONNECTED");
    const rows = await prisma.platformWhatsappConnection.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: a.connectionId, role: "ACTIVE", status: "CONNECTED", disconnectedAt: null });
  });

  it("reconectar lendo o QR com OUTRO celular vale como troca: linha antiga vai ao histórico, nova ativa na mesma instância", async () => {
    const a = await connectNumber("Cobrança", PHONE_A);
    const token = tokenOf(a.instanceName);
    await handlePlatformWhatsappWebhook(token, { event: "connection.update", data: { state: "close" } });
    expect((await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: a.connectionId } })).status).toBe("DISCONNECTED");

    scan(a.instanceName, PHONE_B);
    const res = await handlePlatformWhatsappWebhook(token, { event: "connection.update", data: { state: "open", wuid: `${PHONE_B}@s.whatsapp.net` } });
    expect(res.status).toBe(200);

    const rows = await prisma.platformWhatsappConnection.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: a.connectionId, role: "RETIRED", retiredReason: "REPLACED", phoneE164: PHONE_A });
    expect(rows[1]).toMatchObject({ role: "ACTIVE", status: "CONNECTED", phoneE164: PHONE_B, instanceName: a.instanceName });
    expect(loggedOut).toHaveLength(0); // sem logout: derrubaria a sessão nova
    // o token do webhook que a Evolution usa agora pertence à linha nova
    const afterRes = await handlePlatformWhatsappWebhook(token, { event: "connection.update", data: { state: "close" } });
    expect(afterRes.status).toBe(200);
    expect((await activeRows())[0]!.status).toBe("DISCONNECTED");
  });

  it("aquecimento: número recém-conectado tem teto de 10 por hora; com mais de 3 dias, 30", async () => {
    const a = await connectNumber("Cobrança", PHONE_A);
    const { tenant, subscription } = await makeTenant();
    for (let i = 0; i < 10; i += 1) await recordSentNotice(tenant.id, subscription.id, a.connectionId, PHONE_A);

    const capped = await sendPlatformWhatsapp({ toE164: SUBSCRIBER, text: "oi", tenantId: tenant.id, noticeId: "n1" });
    expect(capped.outcome).toBe("FAILED");
    expect(sent).toHaveLength(0);
    const budget = await (await import("@/modules/platform-whatsapp/sender")).getPlatformWhatsappRoundBudget();
    expect(budget).toMatchObject({ cap: 10, used: 10, remaining: 0 });

    await prisma.platformWhatsappConnection.update({ where: { id: a.connectionId }, data: { activatedAt: new Date(Date.now() - 4 * 86_400_000) } });
    const ok = await sendPlatformWhatsapp({ toE164: SUBSCRIBER, text: "oi", tenantId: tenant.id, noticeId: "n2" });
    expect(ok.outcome).toBe("SENT");
  });

  it("falha de rede com a sessão aberta é FAILED (não derruba o canal)", async () => {
    await connectNumber("Cobrança", PHONE_A);
    const { tenant } = await makeTenant();
    vi.mocked(fakeEvolution.sendText).mockRejectedValueOnce(new EvolutionApiError("timeout"));
    const r = await sendPlatformWhatsapp({ toE164: SUBSCRIBER, text: "oi", tenantId: tenant.id, noticeId: "n1" });
    expect(r.outcome).toBe("FAILED");
    expect((await activeRows())[0]!.status).toBe("CONNECTED");
  });

  it("400 da Evolution com a sessão aberta: FAILED com reason INVALID_NUMBER (o número é que foi recusado)", async () => {
    await connectNumber("Cobrança", PHONE_A);
    const { tenant } = await makeTenant();
    vi.mocked(fakeEvolution.sendText).mockRejectedValueOnce(new EvolutionApiError("Evolution API respondeu 400", 400, undefined, '{"response":{"message":[{"exists":false}]}}'));
    const r = await sendPlatformWhatsapp({ toE164: SUBSCRIBER, text: "oi", tenantId: tenant.id, noticeId: "n1" });
    expect(r).toMatchObject({ outcome: "FAILED", reason: "INVALID_NUMBER" });
    expect((await activeRows())[0]!.status).toBe("CONNECTED");
  });

  it("checkPlatformWhatsappNumber: EXISTS, NOT_FOUND e UNKNOWN (sem número ativo, Evolution fora)", async () => {
    const { checkPlatformWhatsappNumber } = await import("@/modules/platform-whatsapp/sender");
    expect(await checkPlatformWhatsappNumber("5584999993082")).toBe("UNKNOWN"); // sem conexão ativa
    await connectNumber("Cobrança", PHONE_A);
    expect(await checkPlatformWhatsappNumber("5584999993082")).toBe("EXISTS");
    vi.mocked(fakeEvolution.checkWhatsappNumbers).mockResolvedValueOnce([{ number: "5584999993082", exists: false }, { number: "558499993082", exists: false }]);
    expect(await checkPlatformWhatsappNumber("5584999993082")).toBe("NOT_FOUND");
    vi.mocked(fakeEvolution.checkWhatsappNumbers).mockResolvedValueOnce([{ number: "5584999993082", exists: false }, { number: "558499993082", exists: true }]);
    expect(await checkPlatformWhatsappNumber("5584999993082")).toBe("EXISTS"); // existe sem o 9º dígito
    vi.mocked(fakeEvolution.checkWhatsappNumbers).mockRejectedValueOnce(new EvolutionApiError("timeout"));
    expect(await checkPlatformWhatsappNumber("5584999993082")).toBe("UNKNOWN");
  });

  it("mensagem de teste NÃO grava BillingNotice e recusa número da própria plataforma", async () => {
    await connectNumber("Cobrança", PHONE_A);
    const before = await prisma.billingNotice.count();
    const ok = await actions.sendPlatformWhatsappTestAction({ toE164: "(84) 99109-9099" });
    expect(ok.ok && ok.data.sent).toBe(true);
    expect(sent.at(-1)!.text).toContain("Teste do WhatsApp de cobrança");
    expect(await prisma.billingNotice.count()).toBe(before);

    const loop = await sendPlatformWhatsappTest({ toE164: PHONE_A, adminId });
    expect(loop).toEqual({ sent: false, errorCode: "BLOCKED_LOOP" });
    const invalid = await actions.sendPlatformWhatsappTestAction({ toE164: "12345678" });
    expect(invalid.ok && invalid.data).toEqual({ sent: false, errorCode: "INVALID_NUMBER" });
  });

  it("limita as ações de número a 10 a cada 10 minutos por admin", async () => {
    let limited = false;
    for (let i = 0; i < 12; i += 1) {
      const r = await actions.cancelPlatformWhatsappConnectionAction("nao-existe");
      if (!r.ok && r.error.code === "RATE_LIMITED") limited = true;
    }
    expect(limited).toBe(true);
  });
});

describe("trava anti-loop", () => {
  async function makeBotTenant() {
    const { tenant } = await makeTenant();
    const instance = await prisma.whatsappInstance.create({
      data: { tenantId: tenant.id, instanceName: `it-pwa-bot-${randomUUID().slice(0, 6)}`, label: "Bot", webhookToken: randomUUID() },
    });
    const ctx = { tenantId: tenant.id, instance: { id: instance.id, tenantId: tenant.id, instanceName: instance.instanceName, sandbox: false, status: instance.status } };
    return { tenant, ctx };
  }
  const payload = (jid: string) => ({
    event: "messages.upsert",
    data: { key: { remoteJid: jid, fromMe: false, id: `m-${randomUUID()}` }, pushName: "Dono", message: { conversation: "oi" }, messageTimestamp: Math.floor(Date.now() / 1000) },
  });

  it("o bot da empresa ignora mensagem de número que é (ou JÁ FOI) da plataforma, sem criar contato", async () => {
    const a = await connectNumber("Cobrança", PHONE_A);
    const { tenant, ctx } = await makeBotTenant();

    const fromActive = await claimMessage(ctx, payload(`${PHONE_A}@s.whatsapp.net`));
    expect(fromActive).toEqual({ action: "ignore", reason: "PLATFORM_SENDER" });
    // variante sem o 9º dígito (a Evolution às vezes entrega assim)
    const fromVariant = await claimMessage(ctx, payload("558491110001@s.whatsapp.net"));
    expect(fromVariant).toEqual({ action: "ignore", reason: "PLATFORM_SENDER" });
    expect(await prisma.contact.count({ where: { tenantId: tenant.id } })).toBe(0);

    // troca: o chip ANTIGO continua barrado
    const swap = await actions.startPlatformWhatsappConnectionAction({ label: "Novo" });
    const bId = swap.ok ? swap.data.connectionId : "";
    const b = await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: bId } });
    scan(b.instanceName, PHONE_B);
    await actions.getPlatformWhatsappQrAction(bId);
    expect((await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: a.connectionId } })).role).toBe("RETIRED");
    const fromRetired = await claimMessage(ctx, payload(`${PHONE_A}@s.whatsapp.net`));
    expect(fromRetired).toEqual({ action: "ignore", reason: "PLATFORM_SENDER" });
    expect(await prisma.contact.count({ where: { tenantId: tenant.id } })).toBe(0);

    // um cliente comum segue sendo atendido
    const normal = await claimMessage(ctx, payload("5584988887777@s.whatsapp.net"));
    expect(normal.action).toBe("process");
  });

  it("a plataforma nunca envia para um número que é dela (BLOCKED_LOOP)", async () => {
    await connectNumber("Cobrança", PHONE_A);
    const { tenant } = await makeTenant();
    const r = await sendPlatformWhatsapp({ toE164: PHONE_A, text: "oi", tenantId: tenant.id, noticeId: "n1" });
    expect(r.outcome).toBe("BLOCKED_LOOP");
    expect(sent).toHaveLength(0);
  });
});

describe("webhook próprio", () => {
  const msg = (jid: string, text: string, opts: { fromMe?: boolean; id?: string } = {}) => ({
    event: "messages.upsert",
    data: { key: { remoteJid: jid, fromMe: opts.fromMe ?? false, id: opts.id ?? `m-${randomUUID()}` }, pushName: "Assinante", message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000) },
  });

  it("token errado é recusado (401) e conexão aposentada recebe 410", async () => {
    const a = await connectNumber("Cobrança", PHONE_A);
    expect((await handlePlatformWhatsappWebhook("token-que-nao-existe", msg(`${SUBSCRIBER}@s.whatsapp.net`, "oi"))).status).toBe(401);
    expect((await handlePlatformWhatsappWebhook("", {})).status).toBe(401);
    // o token do bot de uma empresa também não vale aqui
    expect((await handlePlatformWhatsappWebhook(randomUUID(), {})).status).toBe(401);
    expect(sent).toHaveLength(0);

    const token = tokenOf(a.instanceName);
    expect((await handlePlatformWhatsappWebhook(token, { event: "qrcode.updated" })).status).toBe(200);
    await actions.disconnectPlatformWhatsappAction({ confirm: "DESCONECTAR" });
    expect((await handlePlatformWhatsappWebhook(token, msg(`${SUBSCRIBER}@s.whatsapp.net`, "oi"))).status).toBe(410);
  });

  it("conectou pelo webhook (sem polling): promove a pendente", async () => {
    const started = await actions.startPlatformWhatsappConnectionAction({ label: "Cobrança" });
    const row = await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: started.ok ? started.data.connectionId : "" } });
    const res = await handlePlatformWhatsappWebhook(tokenOf(row.instanceName), { event: "CONNECTION_UPDATE", data: { state: "open", wuid: `${PHONE_A}@s.whatsapp.net` } });
    expect(res.status).toBe(200);
    expect(await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ role: "ACTIVE", phoneE164: PHONE_A });
    // QR ainda esperando na PENDING: um "close" não a derruba
    const second = await actions.startPlatformWhatsappConnectionAction({ label: "Novo" });
    const pending = await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: second.ok ? second.data.connectionId : "" } });
    await handlePlatformWhatsappWebhook(tokenOf(pending.instanceName), { event: "connection.update", data: { state: "close" } });
    expect((await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: pending.id } })).role).toBe("PENDING");
  });

  it("resposta de assinante vira item no sino (sem duplicar) e a mensagem automática sai 1 vez a cada 24 h", async () => {
    const a = await connectNumber("Cobrança", PHONE_A);
    const { tenant } = await makeTenant({ billingWhatsappE164: SUBSCRIBER });
    const token = tokenOf(a.instanceName);
    const first = msg(`${SUBSCRIBER}@s.whatsapp.net`, "Quanto fica o plano?");

    await handlePlatformWhatsappWebhook(token, first);
    await handlePlatformWhatsappWebhook(token, first); // reentrega da Evolution
    await handlePlatformWhatsappWebhook(token, msg(`${SUBSCRIBER}@s.whatsapp.net`, "Alô?"));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ number: SUBSCRIBER });
    expect(sent[0]!.text).toContain("avisos de cobrança");

    const bell = await notifications.listPlatformNotificationsAction({});
    const replies = bell.ok ? bell.data.items.filter((i) => i.kind === "PLATFORM_WHATSAPP_REPLY") : [];
    expect(replies).toHaveLength(2); // a reentrega não conta
    expect(replies.some((i) => i.body.includes(tenant.name) && i.body.includes("Quanto fica o plano?"))).toBe(true);
    expect(replies.every((i) => !i.body.includes(SUBSCRIBER))).toBe(true); // telefone inteiro nunca no sino
  });

  it("SAIR desliga o WhatsApp da empresa; eco fromMe e número da própria plataforma são ignorados; bot de empresa não recebe resposta automática", async () => {
    const a = await connectNumber("Cobrança", PHONE_A);
    const { tenant } = await makeTenant({ billingWhatsappE164: SUBSCRIBER });
    const token = tokenOf(a.instanceName);

    await handlePlatformWhatsappWebhook(token, msg(`${SUBSCRIBER}@s.whatsapp.net`, "oi", { fromMe: true }));
    await handlePlatformWhatsappWebhook(token, msg(`${PHONE_A}@s.whatsapp.net`, "oi"));
    expect(sent).toHaveLength(0);
    expect(await prisma.providerEvent.count({ where: { provider: "platform-whatsapp-reply" } })).toBe(0);

    await handlePlatformWhatsappWebhook(token, msg(`${SUBSCRIBER}@s.whatsapp.net`, "  Sair! "));
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).billingWhatsappOptOutAt).not.toBeNull();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("não vai mais receber");

    // número que é o bot de uma empresa: registra a resposta, mas a plataforma não responde sozinha
    const botPhone = "5584991110055";
    const { tenant: botTenant } = await makeTenant();
    await prisma.whatsappInstance.create({ data: { tenantId: botTenant.id, instanceName: `it-pwa-bot-${randomUUID().slice(0, 6)}`, label: "Bot", webhookToken: randomUUID(), phoneE164: `+${botPhone}` } });
    await handlePlatformWhatsappWebhook(token, msg(`${botPhone}@s.whatsapp.net`, "Olá! Sou o assistente virtual."));
    expect(sent).toHaveLength(1);
  });
});

describe("sino e Saúde", () => {
  it("sem número com a chave ligada: PLATFORM_WHATSAPP_MISSING; desligada ou com número: some", async () => {
    await actions.setPlatformWhatsappEnabledAction({ enabled: false });
    await actions.setPlatformWhatsappEnabledAction({ enabled: true });
    const missing = async () => {
      const r = await notifications.listPlatformNotificationsAction({});
      return r.ok ? r.data.items.filter((i) => i.kind === "PLATFORM_WHATSAPP_MISSING") : [];
    };
    expect(await missing()).toHaveLength(1);

    const health = await (await import("@/modules/platform/health-service")).getPlatformHealth();
    expect(health.platformWhatsapp.state).toBe("NO_NUMBER");

    await connectNumber("Cobrança", PHONE_A);
    expect(await missing()).toHaveLength(0);
    const healthOk = await (await import("@/modules/platform/health-service")).getPlatformHealth();
    expect(healthOk.platformWhatsapp).toMatchObject({ state: "CONNECTED", phoneDisplay: "+55 84 99111-0001" });

    await actions.setPlatformWhatsappEnabledAction({ enabled: false });
    const healthOff = await (await import("@/modules/platform/health-service")).getPlatformHealth();
    expect(healthOff.platformWhatsapp.state).toBe("DISABLED");
  });
});

describe("revisão do Órion: confirmação de posse, hash no autoreply, retenção e orçamento da manutenção", () => {
  const msg = (jid: string, text: string) => ({
    event: "messages.upsert",
    data: { key: { remoteJid: jid, fromMe: false, id: `m-${randomUUID()}` }, pushName: "Assinante", message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000) },
  });

  it("\"SIM\" do dono do número grava billingWhatsappConfirmedAt e responde o agradecimento; outro número não confirma ninguém", async () => {
    const a = await connectNumber("Cobrança", PHONE_A);
    const { tenant } = await makeTenant({ billingWhatsappE164: SUBSCRIBER });
    const token = tokenOf(a.instanceName);
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).billingWhatsappConfirmedAt).toBeNull();

    await handlePlatformWhatsappWebhook(token, msg("5584991110077@s.whatsapp.net", "Sim")); // não é o número da empresa
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).billingWhatsappConfirmedAt).toBeNull();

    await handlePlatformWhatsappWebhook(token, msg(`${SUBSCRIBER}@s.whatsapp.net`, "  sim! "));
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).billingWhatsappConfirmedAt).not.toBeNull();
    expect(sent.at(-1)!.text).toContain("número confirmado");
  });

  it("a chave do autoreply guarda o HASH do número (nunca o telefone em claro) e a trava de 24 h continua valendo", async () => {
    const a = await connectNumber("Cobrança", PHONE_A);
    await makeTenant({ billingWhatsappE164: SUBSCRIBER });
    const token = tokenOf(a.instanceName);
    await handlePlatformWhatsappWebhook(token, msg(`${SUBSCRIBER}@s.whatsapp.net`, "oi"));
    await handlePlatformWhatsappWebhook(token, msg(`${SUBSCRIBER}@s.whatsapp.net`, "oi de novo"));
    expect(sent).toHaveLength(1); // a segunda não gerou outra resposta automática
    const rows = await prisma.providerEvent.findMany({ where: { provider: "platform-whatsapp-autoreply" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.providerEventId).not.toContain(SUBSCRIBER);
    expect(rows[0]!.providerEventId).toMatch(/^[0-9a-f]{32}:/);
  });

  it("a manutenção expurga respostas e autorrespostas com mais de 45 dias e preserva as recentes e os outros provedores", async () => {
    const old = new Date(Date.now() - 46 * 86_400_000);
    const recent = new Date(Date.now() - 10 * 86_400_000);
    const mk = (provider: string, id: string, createdAt: Date) => prisma.providerEvent.create({ data: { provider, providerEventId: id, payload: {}, processedAt: createdAt, createdAt } });
    await mk("platform-whatsapp-reply", `old-r-${randomUUID()}`, old);
    await mk("platform-whatsapp-autoreply", `old-a-${randomUUID()}`, old);
    const keepRecent = await mk("platform-whatsapp-reply", `new-r-${randomUUID()}`, recent);
    const keepOther = await mk("platform-whatsapp-cleanup", `old-c-${randomUUID()}`, old);

    const summary = await connections.runPlatformWhatsappMaintenance({ evolution: fakeEvolution });
    expect(summary.purgedEvents).toBe(2);
    expect(await prisma.providerEvent.findUnique({ where: { id: keepRecent.id } })).not.toBeNull();
    expect(await prisma.providerEvent.findUnique({ where: { id: keepOther.id } })).not.toBeNull();
  });

  it("orçamento de tempo esgotado: a manutenção não chama a Evolution e deixa a limpeza para a próxima rodada", async () => {
    await prisma.providerEvent.create({ data: { provider: connections.CLEANUP_PROVIDER, providerEventId: `it-cleanup-${randomUUID()}`, payload: { instanceName: "it-pwa-inexistente" } } });
    const stateCalls = vi.mocked(fakeEvolution.connectionState).mock.calls.length;
    const logoutCalls = vi.mocked(fakeEvolution.logout).mock.calls.length;
    const summary = await connections.runPlatformWhatsappMaintenance({ evolution: fakeEvolution, budgetMs: -1 });
    expect(summary.cleanupsPending).toBeGreaterThanOrEqual(1);
    expect(summary.stateChecked).toBe(false);
    expect(vi.mocked(fakeEvolution.connectionState).mock.calls.length).toBe(stateCalls);
    expect(vi.mocked(fakeEvolution.logout).mock.calls.length).toBe(logoutCalls);
  });
});

describe("resposta automática sempre viva (2026-10-03): LID, 10 min, teto diário, motivo no diagnóstico e webhook", () => {
  const LID = "98765432101234@lid";
  const inbound = (jid: string, text: string, extraKey: Record<string, unknown> = {}) => ({
    event: "messages.upsert",
    data: { key: { remoteJid: jid, fromMe: false, id: `m-${randomUUID()}`, ...extraKey }, pushName: "Assinante", message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000) },
  });
  const minutesLater = (min: number) => ({ now: new Date(Date.now() + min * 60_000) });
  async function diag() {
    const state = await connections.getPlatformWhatsappState();
    return state.active!.diagnostics;
  }

  it("remetente só com LID (sem telefone) recebe a resposta, enviada ao próprio @lid", async () => {
    const a = await connectNumber("Cobrança", PHONE_A);
    const token = tokenOf(a.instanceName);
    await handlePlatformWhatsappWebhook(token, inbound(LID, "oi, quem é?"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ instance: a.instanceName, number: LID });
    expect(sent[0]!.text).toContain("avisos de cobrança");
    const d = await diag();
    expect(d.lastInboundAt).not.toBeNull();
    expect(d.lastAutoreplyAt).not.toBeNull();
    expect(d.notRepliedReason).toBeNull();
    expect(d.lastInboundFrom).toBe("contato sem número");
    // a chave de deduplicação não guarda o LID em claro
    const rows = await prisma.providerEvent.findMany({ where: { provider: "platform-whatsapp-autoreply" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.providerEventId).not.toContain("98765432101234");
  });

  it("@lid COM o telefone nos campos alternativos (senderPn/remoteJidAlt): responde ao telefone, como antes", async () => {
    const a = await connectNumber("Cobrança", PHONE_A);
    const token = tokenOf(a.instanceName);
    await handlePlatformWhatsappWebhook(token, inbound(LID, "oi", { senderPn: `${SUBSCRIBER}@s.whatsapp.net` }));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.number).toBe(SUBSCRIBER);
    const d = await diag();
    expect(d.lastInboundFrom).toContain("****");
    expect(d.lastInboundFrom).not.toContain(SUBSCRIBER);
  });

  it("2ª mensagem depois de 10 min recebe; dentro de 10 min não, e o motivo aparece no diagnóstico", async () => {
    const a = await connectNumber("Cobrança", PHONE_A);
    const token = tokenOf(a.instanceName);
    const jid = `${SUBSCRIBER}@s.whatsapp.net`;
    await handlePlatformWhatsappWebhook(token, inbound(jid, "oi"));
    expect(sent).toHaveLength(1);

    await handlePlatformWhatsappWebhook(token, inbound(jid, "oi de novo"), minutesLater(3));
    expect(sent).toHaveLength(1);
    const blocked = await diag();
    expect(blocked.notRepliedReason).toMatch(/^não respondeu: já respondeu há [2-3] min$/);

    await handlePlatformWhatsappWebhook(token, inbound(jid, "e agora?"), minutesLater(11));
    expect(sent).toHaveLength(2);
    expect((await diag()).notRepliedReason).toBeNull();
  });

  it("a 7ª mensagem do dia não recebe (teto de 6 por contato) e o motivo diz isso", async () => {
    const a = await connectNumber("Cobrança", PHONE_A);
    const token = tokenOf(a.instanceName);
    const jid = `${SUBSCRIBER}@s.whatsapp.net`;
    for (let i = 0; i < 6; i += 1) await handlePlatformWhatsappWebhook(token, inbound(jid, `oi ${i}`), minutesLater(11 * (i + 1)));
    expect(sent).toHaveLength(6);
    await handlePlatformWhatsappWebhook(token, inbound(jid, "oi 7"), minutesLater(11 * 7));
    expect(sent).toHaveLength(6);
    expect((await diag()).notRepliedReason).toContain("6 vezes hoje");
  });

  it("SAIR sempre responde, mesmo dentro dos 10 min; sem cadastro, a resposta não promete que parou", async () => {
    const a = await connectNumber("Cobrança", PHONE_A);
    const token = tokenOf(a.instanceName);
    const { tenant } = await makeTenant({ billingWhatsappE164: SUBSCRIBER });
    const jid = `${SUBSCRIBER}@s.whatsapp.net`;
    await handlePlatformWhatsappWebhook(token, inbound(jid, "oi"));
    await handlePlatformWhatsappWebhook(token, inbound(jid, "SAIR"), minutesLater(1));
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toContain("não vai mais receber");
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } })).billingWhatsappOptOutAt).not.toBeNull();

    // LID sem telefone: não dá para achar a empresa
    await handlePlatformWhatsappWebhook(token, inbound(LID, "sair"));
    expect(sent).toHaveLength(3);
    expect(sent[2]!.number).toBe(LID);
    expect(sent[2]!.text).toContain("não achei este número");
    expect(sent[2]!.text).not.toContain("não vai mais receber");
  });

  it("número que é o bot de uma empresa não recebe, e o motivo fica registrado", async () => {
    const a = await connectNumber("Cobrança", PHONE_A);
    const token = tokenOf(a.instanceName);
    const botPhone = "5584991110056";
    const { tenant: botTenant } = await makeTenant();
    await prisma.whatsappInstance.create({ data: { tenantId: botTenant.id, instanceName: `it-pwa-bot-${randomUUID().slice(0, 6)}`, label: "Bot", webhookToken: randomUUID(), phoneE164: `+${botPhone}` } });
    await handlePlatformWhatsappWebhook(token, inbound(`${botPhone}@s.whatsapp.net`, "Olá! Sou o assistente virtual."));
    expect(sent).toHaveLength(0);
    expect((await diag()).notRepliedReason).toBe("não respondeu: o número é o WhatsApp de uma empresa cadastrada");
  });

  it("mensagem do próprio número da plataforma: sem resposta, motivo registrado", async () => {
    const a = await connectNumber("Cobrança", PHONE_A);
    await handlePlatformWhatsappWebhook(tokenOf(a.instanceName), inbound(`${PHONE_A}@s.whatsapp.net`, "oi"));
    expect(sent).toHaveLength(0);
    expect((await diag()).notRepliedReason).toContain("próprio WhatsApp de cobrança");
  });

  it("falha no envio não trava o contato: a reserva some, o motivo aparece e a próxima mensagem responde", async () => {
    const a = await connectNumber("Cobrança", PHONE_A);
    const token = tokenOf(a.instanceName);
    const jid = `${SUBSCRIBER}@s.whatsapp.net`;
    instances.get(a.instanceName)!.state = "close";
    await handlePlatformWhatsappWebhook(token, inbound(jid, "oi"));
    expect(sent).toHaveLength(0);
    expect(await prisma.providerEvent.count({ where: { provider: "platform-whatsapp-autoreply" } })).toBe(0);
    expect((await diag()).notRepliedReason).toContain("o envio falhou");
    instances.get(a.instanceName)!.state = "open";
    await handlePlatformWhatsappWebhook(token, inbound(jid, "oi?"));
    expect(sent).toHaveLength(1);
  });

  it("evento qualquer do webhook (até o eco) marca o último evento recebido", async () => {
    const a = await connectNumber("Cobrança", PHONE_A);
    expect((await diag()).lastEventAt).toBeNull();
    await handlePlatformWhatsappWebhook(tokenOf(a.instanceName), inbound(`${SUBSCRIBER}@s.whatsapp.net`, "eco", { fromMe: true }));
    expect((await diag()).lastEventAt).not.toBeNull();
    expect(sent).toHaveLength(0);
  });

  describe("manutenção confere e reaplica o webhook da conexão ACTIVE", () => {
    it("webhook íntegro: nada é reaplicado", async () => {
      await connectNumber("Cobrança", PHONE_A);
      const calls = vi.mocked(fakeEvolution.setWebhook).mock.calls.length;
      const summary = await connections.runPlatformWhatsappMaintenance({ evolution: fakeEvolution });
      expect(summary.webhook).toBe("OK");
      expect(vi.mocked(fakeEvolution.setWebhook).mock.calls.length).toBe(calls);
      expect((await diag()).webhookNote).toBeNull();
    });

    it("webhook desligado na Evolution: reaplica o MESMO endereço (token e hash intactos)", async () => {
      const a = await connectNumber("Cobrança", PHONE_A);
      const before = webhooks.get(a.instanceName)!;
      const rowBefore = await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: a.connectionId } });
      webhookEnabled = false;
      const summary = await connections.runPlatformWhatsappMaintenance({ evolution: fakeEvolution });
      expect(summary.webhook).toBe("REPAIRED");
      expect(webhooks.get(a.instanceName)).toBe(before);
      expect((await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: a.connectionId } })).webhookTokenHash).toBe(rowBefore.webhookTokenHash);
      expect((await diag()).webhookNote).toContain("corrigido sozinho");
    });

    it("webhook apontando para outro lugar: gira o token, a Evolution recebe o novo e o antigo deixa de valer", async () => {
      const a = await connectNumber("Cobrança", PHONE_A);
      const oldToken = tokenOf(a.instanceName);
      webhooks.set(a.instanceName, "https://n8n.example.com/webhook/innochat/evolution/outro-token");
      const summary = await connections.runPlatformWhatsappMaintenance({ evolution: fakeEvolution });
      expect(summary.webhook).toBe("REPAIRED");
      const newToken = tokenOf(a.instanceName);
      expect(newToken).not.toBe(oldToken);
      expect(webhooks.get(a.instanceName)).toContain("/api/webhooks/platform-whatsapp/");
      expect((await handlePlatformWhatsappWebhook(newToken, { event: "qrcode.updated" })).status).toBe(200);
      expect((await handlePlatformWhatsappWebhook(oldToken, { event: "qrcode.updated" })).status).toBe(401);
      // e a resposta automática volta a funcionar pelo endereço novo
      await handlePlatformWhatsappWebhook(newToken, inbound(`${SUBSCRIBER}@s.whatsapp.net`, "oi"));
      expect(sent).toHaveLength(1);
    });

    it("leitura vazia da Evolution com eventos recentes: não gira o token (o endereço atual está funcionando)", async () => {
      const a = await connectNumber("Cobrança", PHONE_A);
      const rowBefore = await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: a.connectionId } });
      const { patchDiagnostics } = await import("@/modules/platform-whatsapp/diagnostics");
      await patchDiagnostics(a.connectionId, { lastEventAt: new Date().toISOString() });
      webhooks.delete(a.instanceName);
      vi.mocked(fakeEvolution.setWebhook).mockClear();
      const result = await connections.runPlatformWhatsappMaintenance({ evolution: fakeEvolution });
      expect(result.webhook).toBe("OK");
      expect((await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: a.connectionId } })).webhookTokenHash).toBe(rowBefore.webhookTokenHash);
      expect(vi.mocked(fakeEvolution.setWebhook)).not.toHaveBeenCalledWith(a.instanceName, expect.anything());
    });

    it("sem webhook nenhum na Evolution: cria um novo; se o setWebhook falha, o hash antigo volta", async () => {
      const a = await connectNumber("Cobrança", PHONE_A);
      const rowBefore = await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: a.connectionId } });
      webhooks.delete(a.instanceName);
      vi.mocked(fakeEvolution.setWebhook).mockRejectedValueOnce(new EvolutionApiError("Evolution fora do ar", 500));
      const failed = await connections.runPlatformWhatsappMaintenance({ evolution: fakeEvolution });
      expect(failed.webhook).toBe("REPAIR_FAILED");
      expect((await prisma.platformWhatsappConnection.findUniqueOrThrow({ where: { id: a.connectionId } })).webhookTokenHash).toBe(rowBefore.webhookTokenHash);
      expect((await diag()).webhookNote).toContain("não deu para corrigir");

      const ok = await connections.runPlatformWhatsappMaintenance({ evolution: fakeEvolution });
      expect(ok.webhook).toBe("REPAIRED");
      expect(webhooks.get(a.instanceName)).toContain("/api/webhooks/platform-whatsapp/");
    });
  });
});
