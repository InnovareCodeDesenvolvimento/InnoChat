/**
 * Conexão de WhatsApp (docs/arquitetura.md §4; docs/contratos.md "WhatsApp (Fase 3)") contra
 * Postgres real. Mesma convenção do resto do projeto: a Evolution é mockada
 * (`@/modules/whatsapp/evolution-client#getEvolutionClient`), o que importa aqui é a lógica de
 * negócio real — limite de plano, e-mail verificado, isolamento entre tenants, `TrialClaim` e
 * compensação numa falha no meio do `create`.
 *
 * Requer `TEST_DATABASE_URL` com as migrations aplicadas
 * (`.claude/agent-memory/vega/integration_tests_setup.md`).
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import type { EvolutionClient } from "@/modules/whatsapp/evolution-client";

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

function createFakeEvolutionClient(overrides: Partial<EvolutionClient> = {}): EvolutionClient {
  return {
    createInstance: vi.fn(async () => {}),
    setWebhook: vi.fn(async () => {}),
    connect: vi.fn(async () => ({ qrCodeDataUrl: "data:image/png;base64,fake", pairingCode: null })),
    connectionState: vi.fn(async () => "connecting"),
    fetchOwnerJid: vi.fn(async () => null),
    logout: vi.fn(async () => {}),
    deleteInstance: vi.fn(async () => {}),
    sendText: vi.fn(async () => ({ messageId: null })),
    checkWhatsappNumbers: vi.fn(async (_name: string, numbers: string[]) => numbers.map((number) => ({ number, exists: true }))),
    sendButtons: vi.fn(async () => ({ messageId: null, status: 201, body: null })),
    sendList: vi.fn(async () => ({ messageId: null, status: 201, body: null })),
    sendPoll: vi.fn(async () => ({ messageId: null, status: 201, body: null })),
    ...overrides,
  };
}

const prisma = getPrisma();
const { auth } = await import("@/lib/auth");
const {
  createWhatsappInstanceAction,
  listWhatsappInstancesAction,
  getQrCodeAction,
} = await import("@/modules/whatsapp/actions");
const { createWhatsappInstance, getQrCode } = await import("@/modules/whatsapp/service");
const { applyConnectedNumber } = await import("@/modules/whatsapp/connection");

const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];
const createdPlanIds: string[] = [];

beforeEach(async () => {
  await prisma.platformSettings.upsert({
    where: { id: 1 },
    create: { id: 1, n8nWebhookBaseUrl: "https://n8n.example.test/webhook/innochat/evolution", evolutionApiUrl: "https://evolution.example.test", evolutionApiKey: "fake-key" },
    update: { n8nWebhookBaseUrl: "https://n8n.example.test/webhook/innochat/evolution", evolutionApiUrl: "https://evolution.example.test", evolutionApiKey: "fake-key" },
  });
});

afterEach(() => {
  vi.mocked(auth).mockReset();
});

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.plan.deleteMany({ where: { id: { in: createdPlanIds } } });
  await prisma.$disconnect();
});

/** `Plan.maxWhatsappNumbers` NÃO é nullable (prisma/schema.prisma) — só `maxProfessionals` e os `*Override` de `Tenant` têm o `null` = ilimitado. Testes que não se importam com o limite usam um valor alto. */
async function createPlan(maxWhatsappNumbers: number) {
  const plan = await prisma.plan.create({
    data: {
      code: `it-wa-${Date.now()}-${randomUUID().slice(0, 6)}`,
      name: "Plano IT WhatsApp",
      priceCents: 0,
      maxWhatsappNumbers,
      maxProfessionals: null,
      active: false,
      sortOrder: 999,
    },
  });
  createdPlanIds.push(plan.id);
  return plan;
}

async function createTenant(
  label: string,
  opts: { maxWhatsappNumbers?: number; subscriptionStatus?: "TRIALING" | "ACTIVE"; trialEndsAt?: Date } = {},
) {
  const plan = await createPlan(opts.maxWhatsappNumbers ?? 100);
  const tenant = await prisma.tenant.create({
    data: { slug: `it-wa-${label}-${Date.now()}-${randomUUID().slice(0, 6)}`, name: `WhatsApp IT ${label}`, timezone: "UTC" },
  });
  createdTenantIds.push(tenant.id);
  await prisma.subscription.create({
    data: {
      tenantId: tenant.id,
      planId: plan.id,
      status: opts.subscriptionStatus ?? "ACTIVE",
      currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000),
      trialEndsAt: opts.trialEndsAt,
    },
  });
  return tenant;
}

async function createOwner(tenantId: string, opts: { emailVerified?: boolean } = {}) {
  const user = await prisma.user.create({
    data: {
      email: `it-wa-${randomUUID()}@example.com`,
      passwordHash: "x",
      emailVerifiedAt: opts.emailVerified === false ? null : new Date(),
    },
  });
  createdUserIds.push(user.id);
  await prisma.membership.create({ data: { userId: user.id, tenantId, role: "OWNER" } });
  return user;
}

function mockSessionAs(userId: string) {
  vi.mocked(auth).mockResolvedValue({ user: { id: userId } } as never);
}

describe("createWhatsappInstance — limite de plano, guardas e compensação", () => {
  it("cria a instância com sucesso: chama create + setWebhook e grava QRCODE local", async () => {
    const tenant = await createTenant("ok");
    const evolution = createFakeEvolutionClient();

    const created = await createWhatsappInstance({ tenantId: tenant.id, tenantSlug: tenant.slug, label: "Principal", evolution });

    expect(created.status).toBe("QRCODE");
    expect(created.instanceName.startsWith("innochat-")).toBe(true);
    expect(evolution.createInstance).toHaveBeenCalledWith(created.instanceName);
    expect(evolution.setWebhook).toHaveBeenCalledWith(created.instanceName, expect.stringContaining("https://n8n.example.test"));

    const row = await prisma.whatsappInstance.findUnique({ where: { id: created.id } });
    expect(row?.status).toBe("QRCODE");
    expect(row?.webhookToken).toBeTruthy();
  });

  it("bloqueia PLAN_LIMIT_REACHED quando o tenant já atingiu o limite do plano", async () => {
    const tenant = await createTenant("limit", { maxWhatsappNumbers: 1 });
    const evolution = createFakeEvolutionClient();

    await createWhatsappInstance({ tenantId: tenant.id, tenantSlug: tenant.slug, label: "Primeiro", evolution });

    await expect(createWhatsappInstance({ tenantId: tenant.id, tenantSlug: tenant.slug, label: "Segundo", evolution })).rejects.toMatchObject({
      code: "PLAN_LIMIT_REACHED",
    });
    // Só 1 chamada de create — a 2ª nunca chegou a bater na Evolution (limite verificado antes).
    expect(evolution.createInstance).toHaveBeenCalledTimes(1);
  });

  it("compensa (deleteInstance) quando setWebhook falha no meio do create — nenhuma instância órfã local", async () => {
    const tenant = await createTenant("webhook-fail");
    const evolution = createFakeEvolutionClient({ setWebhook: vi.fn(async () => { throw new Error("webhook/set indisponível"); }) });

    await expect(createWhatsappInstance({ tenantId: tenant.id, tenantSlug: tenant.slug, label: "Falha", evolution })).rejects.toThrow();

    expect(evolution.deleteInstance).toHaveBeenCalledTimes(1);
    const rows = await prisma.whatsappInstance.findMany({ where: { tenantId: tenant.id } });
    expect(rows).toHaveLength(0);
  });

  it("N8N_NOT_CONFIGURED se n8nWebhookBaseUrl não estiver configurado — nunca chama a Evolution", async () => {
    await prisma.platformSettings.update({ where: { id: 1 }, data: { n8nWebhookBaseUrl: null } });
    const tenant = await createTenant("no-n8n");
    const evolution = createFakeEvolutionClient();

    await expect(createWhatsappInstance({ tenantId: tenant.id, tenantSlug: tenant.slug, label: "X", evolution })).rejects.toMatchObject({
      code: "N8N_NOT_CONFIGURED",
    });
    expect(evolution.createInstance).not.toHaveBeenCalled();
  });
});

describe("createWhatsappInstanceAction — guardas (e-mail verificado, cross-tenant)", () => {
  it("EMAIL_NOT_VERIFIED bloqueia antes de checar permissão de tenant", async () => {
    const tenant = await createTenant("email-not-verified");
    const owner = await createOwner(tenant.id, { emailVerified: false });
    mockSessionAs(owner.id);

    const result = await createWhatsappInstanceAction(tenant.slug, { label: "X" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("EMAIL_NOT_VERIFIED");
  });

  it("usuário sem membership no tenant recebe NOT_FOUND (nunca FORBIDDEN)", async () => {
    const tenantA = await createTenant("cross-a");
    const tenantB = await createTenant("cross-b");
    const outsider = await createOwner(tenantB.id, { emailVerified: true });
    mockSessionAs(outsider.id);

    const result = await createWhatsappInstanceAction(tenantA.slug, { label: "X" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("listWhatsappInstancesAction nunca cruza instâncias de tenants diferentes", async () => {
    const tenantA = await createTenant("list-a");
    const tenantB = await createTenant("list-b");
    const ownerA = await createOwner(tenantA.id, { emailVerified: true });
    await createWhatsappInstance({ tenantId: tenantA.id, tenantSlug: tenantA.slug, label: "A1", evolution: createFakeEvolutionClient() });
    await createWhatsappInstance({ tenantId: tenantB.id, tenantSlug: tenantB.slug, label: "B1", evolution: createFakeEvolutionClient() });

    mockSessionAs(ownerA.id);
    const result = await listWhatsappInstancesAction(tenantA.slug);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0]!.label).toBe("A1");
    }
  });

  it("getQrCodeAction com instanceId de outro tenant → NOT_FOUND", async () => {
    const tenantA = await createTenant("qr-a");
    const tenantB = await createTenant("qr-b");
    const ownerA = await createOwner(tenantA.id, { emailVerified: true });
    const instanceB = await createWhatsappInstance({ tenantId: tenantB.id, tenantSlug: tenantB.slug, label: "B", evolution: createFakeEvolutionClient() });

    mockSessionAs(ownerA.id);
    const result = await getQrCodeAction(tenantA.slug, instanceB.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });
});

describe("applyConnectedNumber — TrialClaim (anti-abuso, docs/arquitetura.md §7.3 regra 4)", () => {
  it("grava o TrialClaim na primeira conexão em trial", async () => {
    const tenant = await createTenant("trial-first", { subscriptionStatus: "TRIALING", trialEndsAt: new Date(Date.now() + 86_400_000) });
    const instance = await createWhatsappInstance({ tenantId: tenant.id, tenantSlug: tenant.slug, label: "Trial", evolution: createFakeEvolutionClient() });

    const result = await applyConnectedNumber({
      tenantId: tenant.id,
      instanceId: instance.id,
      instanceName: instance.instanceName,
      phoneE164: "+5584999990001",
    });

    expect(result.blocked).toBe(false);
    const claim = await prisma.trialClaim.findUnique({ where: { phoneE164: "+5584999990001" } });
    expect(claim?.tenantId).toBe(tenant.id);
    const row = await prisma.whatsappInstance.findUnique({ where: { id: instance.id } });
    expect(row?.status).toBe("CONNECTED");
    expect(row?.phoneE164).toBe("+5584999990001");
  });

  it("bloqueia e desconecta quando o número já teve trial em OUTRA empresa", async () => {
    const tenantA = await createTenant("trial-dup-a", { subscriptionStatus: "TRIALING", trialEndsAt: new Date(Date.now() + 86_400_000) });
    const tenantB = await createTenant("trial-dup-b", { subscriptionStatus: "TRIALING", trialEndsAt: new Date(Date.now() + 86_400_000) });
    const instanceA = await createWhatsappInstance({ tenantId: tenantA.id, tenantSlug: tenantA.slug, label: "A", evolution: createFakeEvolutionClient() });
    const evolutionB = createFakeEvolutionClient();
    const instanceB = await createWhatsappInstance({ tenantId: tenantB.id, tenantSlug: tenantB.slug, label: "B", evolution: evolutionB });

    const phone = "+5584999990002";
    await applyConnectedNumber({ tenantId: tenantA.id, instanceId: instanceA.id, instanceName: instanceA.instanceName, phoneE164: phone });

    const result = await applyConnectedNumber({
      tenantId: tenantB.id,
      instanceId: instanceB.id,
      instanceName: instanceB.instanceName,
      phoneE164: phone,
      evolution: evolutionB,
    });

    expect(result).toEqual({ blocked: true, reason: "TRIAL_PHONE_ALREADY_USED" });
    expect(evolutionB.logout).toHaveBeenCalledWith(instanceB.instanceName);
    const rowB = await prisma.whatsappInstance.findUnique({ where: { id: instanceB.id } });
    expect(rowB?.status).toBe("DISCONNECTED");
    expect(rowB?.phoneE164).toBeNull();
    // O claim continua apontando para a empresa A — B nunca "roubou" o claim.
    const claim = await prisma.trialClaim.findUnique({ where: { phoneE164: phone } });
    expect(claim?.tenantId).toBe(tenantA.id);
  });

  it("mesmo número reconectando na MESMA empresa em trial não é bloqueado (claim já é dela)", async () => {
    const tenant = await createTenant("trial-reconnect", { subscriptionStatus: "TRIALING", trialEndsAt: new Date(Date.now() + 86_400_000) });
    const instance = await createWhatsappInstance({ tenantId: tenant.id, tenantSlug: tenant.slug, label: "Reconecta", evolution: createFakeEvolutionClient() });
    const phone = "+5584999990003";

    await applyConnectedNumber({ tenantId: tenant.id, instanceId: instance.id, instanceName: instance.instanceName, phoneE164: phone });
    const second = await applyConnectedNumber({ tenantId: tenant.id, instanceId: instance.id, instanceName: instance.instanceName, phoneE164: phone });

    expect(second.blocked).toBe(false);
  });

  it("fora do trial (ACTIVE) não cria TrialClaim nenhum — só conecta", async () => {
    const tenant = await createTenant("active-connect", { subscriptionStatus: "ACTIVE" });
    const instance = await createWhatsappInstance({ tenantId: tenant.id, tenantSlug: tenant.slug, label: "Ativa", evolution: createFakeEvolutionClient() });
    const phone = "+5584999990004";

    const result = await applyConnectedNumber({ tenantId: tenant.id, instanceId: instance.id, instanceName: instance.instanceName, phoneE164: phone });

    expect(result.blocked).toBe(false);
    const claim = await prisma.trialClaim.findUnique({ where: { phoneE164: phone } });
    expect(claim).toBeNull();
  });
});

describe("getQrCode — reconciliação de estado via connectionState", () => {
  it("quando a Evolution diz 'open' e devolve o dono, conecta e aplica TrialClaim", async () => {
    const tenant = await createTenant("qr-connect", { subscriptionStatus: "ACTIVE" });
    const instance = await createWhatsappInstance({ tenantId: tenant.id, tenantSlug: tenant.slug, label: "QR", evolution: createFakeEvolutionClient() });
    const evolution = createFakeEvolutionClient({
      connectionState: vi.fn(async () => "open"),
      fetchOwnerJid: vi.fn(async () => "5584999990005@s.whatsapp.net"),
    });

    const result = await getQrCode(tenant.id, instance.id, { evolution });

    expect(result.status).toBe("CONNECTED");
    expect(result.phoneE164).toBe("+5584999990005");
    expect(result.qrCodeDataUrl).toBeNull();
  });

  it("quando ainda não conectou, busca um QR fresco a cada chamada", async () => {
    const tenant = await createTenant("qr-fresh", { subscriptionStatus: "ACTIVE" });
    const instance = await createWhatsappInstance({ tenantId: tenant.id, tenantSlug: tenant.slug, label: "Fresh", evolution: createFakeEvolutionClient() });
    const evolution = createFakeEvolutionClient({ connect: vi.fn(async () => ({ qrCodeDataUrl: "data:image/png;base64,abc", pairingCode: "PAIR-1" })) });

    const result = await getQrCode(tenant.id, instance.id, { evolution });

    expect(result.status).toBe("QRCODE");
    expect(result.qrCodeDataUrl).toBe("data:image/png;base64,abc");
    expect(result.pairingCode).toBe("PAIR-1");
    expect(evolution.connect).toHaveBeenCalledTimes(1);
  });
});
