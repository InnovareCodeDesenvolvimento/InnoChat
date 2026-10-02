/**
 * Segredos da plataforma cifrados + Mercado Pago com par de PRODUÇÃO/TESTE (docs/contratos.md,
 * "Mercado Pago") contra Postgres real: migração preguiçosa do legado, troca de ambiente muda o
 * token do gateway e o segredo do webhook, remoção de credencial, fail-closed com segredo
 * corrompido e "nada devolve segredo". `requirePlatformAdmin` é mockado (sem sessão HTTP).
 */
import crypto from "node:crypto";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import { encryptSecret } from "@/lib/crypto";

let adminId = "";
vi.mock("@/lib/auth/guards", () => ({ requirePlatformAdmin: vi.fn(async () => ({ id: adminId })) }));

const actions = await import("@/modules/platform/actions");
const { getActiveMercadoPagoCredentials } = await import("@/modules/platform/mercadopago-config");
const { getPlatformSecrets, loadPlatformSettingsRow } = await import("@/modules/platform/secrets");
const { getMercadoPagoGateway } = await import("@/modules/billing/mercadopago");
const { handleMercadoPagoWebhook, WebhookAuthError } = await import("@/modules/billing/webhook");
const { getMaskedPlatformSettings, updatePlatformSettings } = await import("@/modules/platform/service");

const prisma = getPrisma();

const PROD_TOKEN = "APP_USR-prod-token-9999";
const TEST_TOKEN = "TEST-sandbox-token-8888";
const PROD_SECRET = "prod-webhook-secret-7777";
const TEST_SECRET = "test-webhook-secret-6666";
const ALL_PLAINTEXTS = [PROD_TOKEN, TEST_TOKEN, PROD_SECRET, TEST_SECRET];

const RESET = {
  evolutionApiKey: null,
  n8nApiKey: null,
  smtpPassword: null,
  mercadoPagoAccessToken: null,
  mercadoPagoWebhookSecret: null,
  mpEnvironment: "PRODUCTION" as const,
  mpEnabled: true,
  mpProdPublicKey: null,
  mpProdAccessTokenEnc: null,
  mpProdWebhookSecretEnc: null,
  mpTestPublicKey: null,
  mpTestAccessTokenEnc: null,
  mpTestWebhookSecretEnc: null,
};

async function resetSettings() {
  await prisma.platformSettings.upsert({ where: { id: 1 }, create: { id: 1, ...RESET }, update: RESET });
}

function sign(secret: string, dataId: string, requestId: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const v1 = crypto.createHmac("sha256", secret).update(`id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`).digest("hex");
  return `ts=${ts},v1=${v1}`;
}

/** Notificação de tipo irrelevante: se a assinatura passa, o webhook responde "ignored". */
function webhook(secret: string, requestId: string) {
  return handleMercadoPagoWebhook({ xSignature: sign(secret, "1", requestId), xRequestId: requestId, dataId: "1", type: "other" });
}

beforeAll(async () => {
  const admin = await prisma.user.create({
    data: { email: `it-mp-admin-${Date.now()}-${randomUUID().slice(0, 6)}@example.com`, passwordHash: "x", isPlatformAdmin: true, totpSecretEnc: "enc:v1:x", totpEnabledAt: new Date() },
  });
  adminId = admin.id;
});

beforeEach(resetSettings);

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await resetSettings();
  await prisma.user.deleteMany({ where: { id: adminId } });
  await prisma.$disconnect();
});

async function saveBothPairs() {
  const pairs = [
    ["PRODUCTION", "APP_USR-pk-prod", PROD_TOKEN, PROD_SECRET],
    ["SANDBOX", "TEST-pk-test", TEST_TOKEN, TEST_SECRET],
  ] as const;
  for (const [env, publicKey, accessToken, webhookSecret] of pairs) {
    const result = await actions.saveMercadoPagoCredentialsAction({ env, publicKey, accessToken, webhookSecret });
    expect(result.ok).toBe(true);
  }
}

describe("migração preguiçosa do legado", () => {
  it("cifra evolution/n8n/smtp e move o par legado do MP para produção (cifrado), zerando as colunas antigas", async () => {
    await prisma.platformSettings.update({
      where: { id: 1 },
      data: {
        evolutionApiKey: "evo-legacy-plain",
        n8nApiKey: "n8n-legacy-plain",
        smtpPassword: "smtp-legacy-plain",
        mercadoPagoAccessToken: "legacy-mp-token",
        mercadoPagoWebhookSecret: "legacy-mp-secret",
      },
    });

    const active = await getActiveMercadoPagoCredentials(); // 1ª leitura dispara a migração
    expect(active).toMatchObject({ environment: "PRODUCTION", accessToken: "legacy-mp-token", webhookSecret: "legacy-mp-secret" });

    const raw = await prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 } });
    expect(raw.mercadoPagoAccessToken).toBeNull();
    expect(raw.mercadoPagoWebhookSecret).toBeNull();
    for (const stored of [raw.mpProdAccessTokenEnc, raw.mpProdWebhookSecretEnc, raw.evolutionApiKey, raw.n8nApiKey, raw.smtpPassword]) {
      expect(stored?.startsWith("enc:v1:")).toBe(true);
    }
    expect(JSON.stringify(raw)).not.toMatch(/legacy/);

    await expect(getPlatformSecrets()).resolves.toEqual({
      evolutionApiKey: "evo-legacy-plain",
      n8nApiKey: "n8n-legacy-plain",
      smtpPassword: "smtp-legacy-plain",
    });
  });

  it("é idempotente e não sobrescreve o par de produção já gravado (legado velho é descartado)", async () => {
    await prisma.platformSettings.update({
      where: { id: 1 },
      data: { mercadoPagoAccessToken: "stale-legacy", mpProdAccessTokenEnc: encryptSecret("novo-token") },
    });
    await loadPlatformSettingsRow();
    await loadPlatformSettingsRow();
    const active = await getActiveMercadoPagoCredentials();
    expect(active.accessToken).toBe("novo-token");
    const raw = await prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 } });
    expect(raw.mercadoPagoAccessToken).toBeNull();
  });

  it("gravar por updatePlatformSettings cifra o segredo novo e mantém o existente quando vazio", async () => {
    await updatePlatformSettings({ evolutionApiKey: "evo-nova" }, adminId);
    const raw = await prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 } });
    expect(raw.evolutionApiKey?.startsWith("enc:v1:")).toBe(true);
    await updatePlatformSettings({ evolutionApiKey: "" }, adminId);
    expect((await getPlatformSecrets()).evolutionApiKey).toBe("evo-nova");
  });
});

describe("troca de ambiente", () => {
  it("muda o token usado pelo gateway e o segredo usado pelo webhook", async () => {
    await saveBothPairs();
    const seenAuth: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seenAuth.push(String((init.headers as Record<string, string>).Authorization));
        return new Response(JSON.stringify({ id: 1, status: "pending", date_approved: null, external_reference: null }), { status: 200 });
      }),
    );

    // Produção ativa (padrão)
    await (await getMercadoPagoGateway()).getPayment("1");
    expect(seenAuth.at(-1)).toBe(`Bearer ${PROD_TOKEN}`);
    expect((await webhook(PROD_SECRET, "r1")).status).toBe("ignored"); // passou pela assinatura
    await expect(webhook(TEST_SECRET, "r2")).rejects.toBeInstanceOf(WebhookAuthError);

    // Troca para sandbox
    const switched = await actions.setMercadoPagoEnvironmentAction({ environment: "SANDBOX" });
    expect(switched.ok && switched.data.environment).toBe("SANDBOX");
    await (await getMercadoPagoGateway()).getPayment("1");
    expect(seenAuth.at(-1)).toBe(`Bearer ${TEST_TOKEN}`);
    expect((await webhook(TEST_SECRET, "r3")).status).toBe("ignored");
    await expect(webhook(PROD_SECRET, "r4")).rejects.toBeInstanceOf(WebhookAuthError);
  });

  it("checklist 'Mercado Pago configurado' segue o par ATIVO", async () => {
    await actions.saveMercadoPagoCredentialsAction({ env: "PRODUCTION", accessToken: PROD_TOKEN, webhookSecret: PROD_SECRET });
    expect((await getMaskedPlatformSettings()).mercadoPagoReady).toBe(true);
    await actions.setMercadoPagoEnvironmentAction({ environment: "SANDBOX" }); // sandbox vazio
    expect((await getMaskedPlatformSettings()).mercadoPagoReady).toBe(false);
  });

  it("'cobrança liberada' desligada bloqueia só cobrança nova; consulta (webhook) segue", async () => {
    await saveBothPairs();
    const off = await actions.setMercadoPagoEnabledAction({ enabled: false });
    expect(off.ok && off.data.enabled).toBe(false);
    await expect(getMercadoPagoGateway({ forNewCharge: true })).rejects.toMatchObject({ code: "MERCADOPAGO_DISABLED" });
    await expect(getMercadoPagoGateway()).resolves.toBeDefined();
    expect((await webhook(PROD_SECRET, "r5")).status).toBe("ignored");
  });
});

describe("remover credencial", () => {
  it("apaga só o segredo pedido, só do ambiente pedido, e o gateway/webhook passam a falhar (fail-closed)", async () => {
    await saveBothPairs();

    const afterToken = await actions.removeMercadoPagoSecretAction({ env: "PRODUCTION", field: "accessToken" });
    expect(afterToken.ok && afterToken.data.production).toMatchObject({ accessTokenSaved: false, webhookSecretSaved: true });
    expect(afterToken.ok && afterToken.data.sandbox).toMatchObject({ accessTokenSaved: true, webhookSecretSaved: true });
    await expect(getMercadoPagoGateway()).rejects.toMatchObject({ code: "MERCADOPAGO_NOT_CONFIGURED" });

    const afterSecret = await actions.removeMercadoPagoSecretAction({ env: "PRODUCTION", field: "webhookSecret" });
    expect(afterSecret.ok && afterSecret.data.production.webhookSecretSaved).toBe(false);
    await expect(webhook(PROD_SECRET, "r6")).rejects.toBeInstanceOf(WebhookAuthError);

    const raw = await prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 } });
    expect(raw.mpProdAccessTokenEnc).toBeNull();
    expect(raw.mpTestAccessTokenEnc).not.toBeNull();
  });

  it("campo vazio mantém o valor salvo; public key em claro é atualizável", async () => {
    await saveBothPairs();
    const res = await actions.saveMercadoPagoCredentialsAction({ env: "PRODUCTION", publicKey: "APP_USR-pk-nova", accessToken: "", webhookSecret: "" });
    expect(res.ok && res.data.production).toEqual({ publicKey: "APP_USR-pk-nova", accessTokenSaved: true, webhookSecretSaved: true });
    expect((await getActiveMercadoPagoCredentials()).accessToken).toBe(PROD_TOKEN);
  });

  it("valida entrada: ambiente inválido e segredo gigante viram INVALID_PAYLOAD", async () => {
    const bad = await actions.saveMercadoPagoCredentialsAction({ env: "STAGING" });
    expect(!bad.ok && bad.error.code).toBe("INVALID_PAYLOAD");
    const huge = await actions.saveMercadoPagoCredentialsAction({ env: "PRODUCTION", accessToken: "x".repeat(501) });
    expect(!huge.ok && huge.error.code).toBe("INVALID_PAYLOAD");
  });
});

describe("fail-closed com segredo corrompido", () => {
  it("token que não decifra = ausente (gateway lança, view diz 'não salvo'); segredo corrompido rejeita o webhook", async () => {
    await saveBothPairs();
    await prisma.platformSettings.update({
      where: { id: 1 },
      data: { mpProdAccessTokenEnc: "enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", mpProdWebhookSecretEnc: "texto-puro-nao-cifrado" },
    });

    const active = await getActiveMercadoPagoCredentials();
    expect(active.accessToken).toBeNull();
    expect(active.webhookSecret).toBeNull();
    await expect(getMercadoPagoGateway()).rejects.toMatchObject({ code: "MERCADOPAGO_NOT_CONFIGURED" });
    await expect(webhook("texto-puro-nao-cifrado", "r7")).rejects.toBeInstanceOf(WebhookAuthError);

    const view = await actions.getMercadoPagoConfigAction();
    expect(view.ok && view.data.production).toMatchObject({ accessTokenSaved: false, webhookSecretSaved: false });
    // O outro ambiente não é afetado.
    expect(view.ok && view.data.sandbox).toMatchObject({ accessTokenSaved: true, webhookSecretSaved: true });
  });

  it("AUTH_SECRET trocado: tudo que estava cifrado vira ausente, sem lançar", async () => {
    await saveBothPairs();
    const original = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = "auth-secret-totalmente-diferente-123";
    try {
      const active = await getActiveMercadoPagoCredentials();
      expect(active.accessToken).toBeNull();
      expect(active.webhookSecret).toBeNull();
    } finally {
      process.env.AUTH_SECRET = original;
    }
  });
});

describe("nada devolve segredo", () => {
  it("actions e visão de settings não contêm o valor de nenhum segredo salvo", async () => {
    await saveBothPairs();
    await updatePlatformSettings({ evolutionApiKey: "evo-super-secret-1111", smtpPassword: "smtp-super-secret-2222" }, adminId);

    const outputs = [
      await actions.getMercadoPagoConfigAction(),
      await actions.saveMercadoPagoCredentialsAction({ env: "PRODUCTION", accessToken: PROD_TOKEN }),
      await actions.setMercadoPagoEnvironmentAction({ environment: "SANDBOX" }),
      await actions.setMercadoPagoEnabledAction({ enabled: true }),
      await actions.getPlatformSettingsAction(),
      await actions.updatePlatformSettingsAction({ n8nApiKey: "n8n-super-secret-3333" }),
    ];
    const json = JSON.stringify(outputs);
    for (const secret of [...ALL_PLAINTEXTS, "evo-super-secret-1111", "smtp-super-secret-2222", "n8n-super-secret-3333"]) {
      expect(json).not.toContain(secret);
    }
    expect(json).not.toContain("enc:v1:");
  });

  it("o banco nunca guarda segredo em texto puro depois de salvar pelas actions", async () => {
    await saveBothPairs();
    const raw = JSON.stringify(await prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 } }));
    for (const secret of ALL_PLAINTEXTS) expect(raw).not.toContain(secret);
  });

  it("testMercadoPagoConnectionAction usa o token salvo do ambiente pedido e devolve só {ok, detalhe}", async () => {
    await saveBothPairs();
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        seen.push(String((init.headers as Record<string, string>).Authorization));
        return new Response("{}", { status: 200 });
      }),
    );
    const sandbox = await actions.testMercadoPagoConnectionAction({ env: "SANDBOX" });
    expect(sandbox.ok && sandbox.data.ok).toBe(true);
    expect(seen.at(-1)).toBe(`Bearer ${TEST_TOKEN}`);
    expect(JSON.stringify(sandbox)).not.toContain(TEST_TOKEN);
    await actions.testMercadoPagoConnectionAction({ env: "PRODUCTION", accessToken: "digitado-agora" });
    expect(seen.at(-1)).toBe("Bearer digitado-agora");

    await actions.removeMercadoPagoSecretAction({ env: "SANDBOX", field: "accessToken" });
    const missing = await actions.testMercadoPagoConnectionAction({ env: "SANDBOX" });
    expect(!missing.ok && missing.error.code).toBe("MISSING_SECRET");
  });
});
