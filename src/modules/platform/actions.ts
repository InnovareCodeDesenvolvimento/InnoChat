"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { checkRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { UnsafeUrlError } from "@/lib/net/safe-fetch";
import { N8nApiError } from "./n8n-client";
import { runAction, type Result } from "@/lib/result";
import { platformAdminActor, recordAudit } from "@/modules/audit/record";
import { diffChanges, type AuditChanges } from "@/modules/audit/sanitize";
import { parseSender } from "@/lib/email/sender";
import { DomainError } from "@/lib/errors";
import { ensurePublicBaseUrlFromCurrentRequest, setPublicBaseUrl } from "@/lib/public-url";
import { isValidCnpj, normalizeDocumentDigits } from "@/core/billing";
import {
  getMaskedPlatformSettings,
  getSavedIntegrationSecrets,
  regenerateInternalApiSecret,
  updatePlatformSettings,
  type PlatformSettingsView,
} from "./service";
import {
  getMercadoPagoConfig,
  getSavedMercadoPagoAccessToken,
  removeMercadoPagoSecret,
  saveMercadoPagoCredentials,
  setMercadoPagoEnabled,
  setMercadoPagoEnvironment,
  type MercadoPagoConfigView,
} from "./mercadopago-config";
import {
  testEvolutionConnection,
  testMercadoPagoConnection,
  testN8nConnection,
  testSmtpConnection,
  type ConnectionTestResult,
} from "./connection-tests";
import { sendSmtpTestEmail, type SmtpTestEmailResult } from "./smtp-test-email";
import { activateBotWorkflow, deactivateBotWorkflow, syncN8n, type N8nSyncSummary } from "./n8n-sync";
import { getPlatformLegalInfo, updatePlatformLegalInfo } from "./legal-service";
import type { PlatformLegalInfo } from "@/core/legal/placeholders";
import { getPlatformSalesWhatsapp, updatePlatformSalesWhatsapp, type SalesWhatsapp } from "./sales-contact";
import { getPlatformHealth, type PlatformHealth } from "./health-service";
import {
  getGoogleAuthConfig,
  removeGoogleClientSecret,
  saveGoogleAuthConfig,
  testGoogleAuthConfig,
  type GoogleAuthConfigView,
  type GoogleAuthTestResult,
} from "@/modules/google-auth/config";

/**
 * Server Actions do admin da plataforma (docs/contratos.md). Guardadas por
 * `requirePlatformAdmin()` — nunca confiam em nada vindo do client sobre a sessão.
 */

/** Linha de auditoria de ação da plataforma (sem empresa). Nunca recebe valor de segredo: só o fato de ter mudado. */
async function auditPlatform(adminId: string, action: string, summary: string, changes?: AuditChanges | null, target?: { type: string; id?: string }) {
  await recordAudit({
    tenantId: null,
    actor: platformAdminActor(adminId),
    action,
    targetType: target?.type ?? "platform_settings",
    targetId: target?.id ?? null,
    summary,
    changes: changes ?? null,
  });
}

const SETTINGS_PLAIN_FIELDS = ["evolutionApiUrl", "n8nWebhookBaseUrl", "n8nBaseUrl", "smtpHost", "smtpPort", "smtpSecure", "smtpUser", "smtpFrom"] as const;
// Segredos: só comparamos a versão mascarada para saber SE mudou; o valor (nem os 4 últimos dígitos) nunca vai para o histórico.
const SETTINGS_SECRET_FIELDS = [
  ["evolutionApiKey", "evolutionApiKeyMasked"],
  ["n8nApiKey", "n8nApiKeyMasked"],
  ["smtpPassword", "smtpPasswordMasked"],
] as const;

export async function getPlatformSettingsAction(): Promise<Result<PlatformSettingsView>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    return getMaskedPlatformSettings();
  });
}

const updatePlatformSettingsSchema = z.object({
  evolutionApiUrl: z.union([z.literal(""), z.string().url()]).optional(),
  evolutionApiKey: z.string().max(500).optional(),
  n8nWebhookBaseUrl: z.union([z.literal(""), z.string().url()]).optional(),
  n8nBaseUrl: z.union([z.literal(""), z.string().url()]).optional(),
  n8nApiKey: z.string().max(500).optional(),
  smtpHost: z.string().max(255).optional(),
  smtpPort: z.coerce.number().int().min(1).max(65535).optional(),
  smtpSecure: z.boolean().optional(),
  smtpUser: z.string().max(255).optional(),
  smtpPassword: z.string().max(500).optional(),
  smtpFrom: z
    .union([z.literal(""), z.string().trim().max(200).refine((v) => parseSender(v) !== null, "Use um e-mail (no-reply@dominio.com) ou nome + e-mail (InnoChat <no-reply@dominio.com>).")])
    .optional(),
});

export async function updatePlatformSettingsAction(input: unknown): Promise<Result<PlatformSettingsView>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const data = updatePlatformSettingsSchema.parse(input);
    // 1ª vez que um admin salva Configurações: grava `publicBaseUrl` a partir desta própria
    // requisição (nunca sobrescreve se já tiver um valor — ver `src/lib/public-url.ts`).
    await ensurePublicBaseUrlFromCurrentRequest();
    const before = await getMaskedPlatformSettings();
    const updated = await updatePlatformSettings(data, admin.id);
    const changes: AuditChanges = diffChanges(before, updated, SETTINGS_PLAIN_FIELDS);
    for (const [field, masked] of SETTINGS_SECRET_FIELDS) {
      if (before[masked] !== updated[masked]) changes[field] = { de: null, para: null };
    }
    if (Object.keys(changes).length > 0) {
      const secretNames = SETTINGS_SECRET_FIELDS.filter(([field]) => field in changes).map(([field]) => field);
      await auditPlatform(
        admin.id,
        "platform.settings_changed",
        `Alterou as configurações da plataforma: ${Object.keys(changes).join(", ")}${secretNames.length > 0 ? " (valores de segredo não são guardados)" : ""}.`,
        changes,
      );
    }
    return updated;
  });
}

/**
 * Troca EXPLÍCITA do endereço público do painel (links de e-mail, redirect do Google, n8n). É o
 * único caminho que altera `publicBaseUrl` depois da primeira gravação — a requisição do admin
 * sozinha não muda mais (ver `src/lib/public-url.ts`, revisão do Órion I3). Sem tela ainda: a
 * Lyra pode ligar a um campo em Admin > Configurações. Erro: `INVALID_PAYLOAD`.
 */
export async function setPublicBaseUrlAction(input: unknown): Promise<Result<{ publicBaseUrl: string }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const data = z.object({ baseUrl: z.string().trim().min(1).max(300) }).parse(input);
    const publicBaseUrl = await setPublicBaseUrl(data.baseUrl);
    logger.info("platform.public_base_url.changed", { adminId: admin.id });
    await auditPlatform(admin.id, "platform.public_base_url_changed", "Trocou o endereço público do painel.", { publicBaseUrl: { de: null, para: publicBaseUrl } });
    return { publicBaseUrl };
  });
}

/**
 * Gera e devolve o segredo da API interna EM TEXTO PURO — só nesta chamada. A tela precisa
 * mostrar isso ao dono uma única vez e nunca mais poder buscá-lo de volta.
 */
export async function regenerateInternalApiSecretAction(): Promise<Result<{ secret: string }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const generated = await regenerateInternalApiSecret(admin.id);
    await auditPlatform(admin.id, "platform.internal_secret_regenerated", "Gerou um novo segredo da API interna (o anterior deixou de valer).");
    return generated;
  });
}

// ---------------------------------------------------------------------------
// Testar conexão (docs/contratos.md) — sempre {ok, detalhe}, nunca o segredo de volta.
// ---------------------------------------------------------------------------

// Em todos os testes, segredo em branco = usa o que já está salvo (mesma regra do "Salvar": campo
// vazio mantém o valor atual). O segredo salvo é lido e usado só aqui no servidor.
function missingSecret(label: string): never {
  throw new DomainError("MISSING_SECRET", `Informe ${label} ou salve antes de testar.`);
}

const testEvolutionSchema = z.object({ evolutionApiUrl: z.string().url(), evolutionApiKey: z.string().optional() });

export async function testEvolutionConnectionAction(input: unknown): Promise<Result<ConnectionTestResult>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    const data = testEvolutionSchema.parse(input);
    const key = data.evolutionApiKey || (await getSavedIntegrationSecrets()).evolutionApiKey || missingSecret("a chave da Evolution");
    return testEvolutionConnection(data.evolutionApiUrl, key);
  });
}

// ---------------------------------------------------------------------------
// Mercado Pago (docs/contratos.md, "Mercado Pago") — par de PRODUÇÃO e par de TESTE, seletor do
// ambiente ativo. Todas devolvem `MercadoPagoConfigView`: NUNCA o valor de um segredo.
// ---------------------------------------------------------------------------

const mpEnvSchema = z.enum(["PRODUCTION", "SANDBOX"]);
const mpSecretInput = z.string().max(500).optional();

export async function getMercadoPagoConfigAction(): Promise<Result<MercadoPagoConfigView>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    return getMercadoPagoConfig();
  });
}

const saveMercadoPagoSchema = z.object({
  env: mpEnvSchema,
  publicKey: z.string().max(300).optional(),
  accessToken: mpSecretInput,
  webhookSecret: mpSecretInput,
});

/** Campo vazio/ausente = manter o valor salvo. Segredos são cifrados antes de ir ao banco. */
export async function saveMercadoPagoCredentialsAction(input: unknown): Promise<Result<MercadoPagoConfigView>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const data = saveMercadoPagoSchema.parse(input);
    const saved = await saveMercadoPagoCredentials(data, admin.id);
    const changes: AuditChanges = {};
    if (data.publicKey?.trim()) changes["publicKey"] = { de: null, para: "alterada" };
    if (data.accessToken?.trim()) changes["accessToken"] = { de: null, para: null };
    if (data.webhookSecret?.trim()) changes["webhookSecret"] = { de: null, para: null };
    if (Object.keys(changes).length > 0) {
      await auditPlatform(
        admin.id,
        "platform.mercadopago_credentials_changed",
        `Alterou as credenciais do Mercado Pago (${data.env === "PRODUCTION" ? "produção" : "teste"}): ${Object.keys(changes).join(", ")}. Valores não são guardados.`,
        changes,
      );
    }
    return saved;
  });
}

const removeMercadoPagoSecretSchema = z.object({ env: mpEnvSchema, field: z.enum(["accessToken", "webhookSecret"]) });

export async function removeMercadoPagoSecretAction(input: unknown): Promise<Result<MercadoPagoConfigView>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const data = removeMercadoPagoSecretSchema.parse(input);
    const saved = await removeMercadoPagoSecret(data, admin.id);
    await auditPlatform(
      admin.id,
      "platform.mercadopago_secret_removed",
      `Removeu ${data.field === "accessToken" ? "o access token" : "o segredo do webhook"} do Mercado Pago (${data.env === "PRODUCTION" ? "produção" : "teste"}).`,
      { [data.field]: { de: null, para: null } },
    );
    return saved;
  });
}

export async function setMercadoPagoEnvironmentAction(input: unknown): Promise<Result<MercadoPagoConfigView>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const data = z.object({ environment: mpEnvSchema }).parse(input);
    const before = await getMercadoPagoConfig();
    const saved = await setMercadoPagoEnvironment(data.environment, admin.id);
    if (before.environment !== saved.environment) {
      await auditPlatform(admin.id, "platform.mercadopago_environment_changed", `Trocou o ambiente do Mercado Pago para ${saved.environment === "PRODUCTION" ? "produção" : "teste"}.`, {
        ambiente: { de: before.environment, para: saved.environment },
      });
    }
    return saved;
  });
}

export async function setMercadoPagoEnabledAction(input: unknown): Promise<Result<MercadoPagoConfigView>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const data = z.object({ enabled: z.boolean() }).parse(input);
    const before = await getMercadoPagoConfig();
    const saved = await setMercadoPagoEnabled(data.enabled, admin.id);
    if (before.enabled !== saved.enabled) {
      await auditPlatform(admin.id, "platform.mercadopago_enabled_changed", `${saved.enabled ? "Ligou" : "Desligou"} a cobrança pelo Mercado Pago.`, { enabled: { de: before.enabled, para: saved.enabled } });
    }
    return saved;
  });
}

const testMercadoPagoSchema = z.object({ env: mpEnvSchema, accessToken: mpSecretInput });

/** Access token em branco = usa o salvo DAQUELE ambiente. Devolve `{ ok, detalhe }`, nunca o token. */
export async function testMercadoPagoConnectionAction(input: unknown): Promise<Result<ConnectionTestResult>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    const data = testMercadoPagoSchema.parse(input);
    const token = data.accessToken?.trim() || (await getSavedMercadoPagoAccessToken(data.env)) || missingSecret("o access token");
    return testMercadoPagoConnection(token);
  });
}

const testN8nSchema = z.object({ n8nBaseUrl: z.string().url(), n8nApiKey: z.string().optional() });

export async function testN8nConnectionAction(input: unknown): Promise<Result<ConnectionTestResult>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    const data = testN8nSchema.parse(input);
    const key = data.n8nApiKey || (await getSavedIntegrationSecrets()).n8nApiKey || missingSecret("a chave de API do n8n");
    return testN8nConnection(data.n8nBaseUrl, key);
  });
}

const testSmtpSchema = z.object({
  smtpHost: z.string().min(1),
  smtpPort: z.coerce.number().int().min(1).max(65535),
  smtpSecure: z.boolean().optional(),
  smtpUser: z.string().optional(),
  smtpPassword: z.string().optional(),
});

export async function testSmtpConnectionAction(input: unknown): Promise<Result<ConnectionTestResult>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    const data = testSmtpSchema.parse(input);
    return testSmtpConnection({
      host: data.smtpHost,
      port: data.smtpPort,
      secure: !!data.smtpSecure,
      user: data.smtpUser,
      password: data.smtpPassword || (await getSavedIntegrationSecrets()).smtpPassword || undefined,
    });
  });
}

const testSmtpEmailSchema = z.object({ to: z.string().trim().email("Informe um e-mail válido.").max(254) });
const SMTP_TEST_EMAIL_LIMIT = 5;
const SMTP_TEST_EMAIL_WINDOW_MS = 10 * 60_000;

/** Envia um e-mail simples de teste pelo SMTP salvo e devolve a resposta real do servidor (admin da plataforma, com limite de uso). */
export async function sendSmtpTestEmailAction(input: unknown): Promise<Result<SmtpTestEmailResult>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const data = testSmtpEmailSchema.parse(input);
    const rate = checkRateLimit(`smtp-test-email:${admin.id}`, SMTP_TEST_EMAIL_LIMIT, SMTP_TEST_EMAIL_WINDOW_MS);
    if (!rate.allowed) {
      throw new DomainError("RATE_LIMITED", "Muitos e-mails de teste seguidos. Aguarde alguns minutos.", { retryAfterMs: rate.retryAfterMs });
    }
    return sendSmtpTestEmail(data.to);
  });
}

// ---------------------------------------------------------------------------
// Sincronização do n8n (docs/contratos.md) — nunca ativa o bot sozinha.
// ---------------------------------------------------------------------------

/**
 * Falha de rede ou resposta de erro do n8n vira mensagem legível na tela, em vez de erro 500
 * (primeiro deploy real, 2026-09-29: "Sincronizar n8n" derrubava a página sem dizer o motivo).
 * O detalhe técnico completo vai para o log do servidor.
 */
async function translateN8nError<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof DomainError) throw error;
    logger.error("platform.n8n.operation_failed", {
      operation,
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof N8nApiError) {
      const hint =
        error.status === 401 || error.status === 403
          ? " Confira a chave de API do n8n (Settings → n8n API)."
          : error.status === 404
            ? " Confira a URL do n8n e se os workflows do InnoChat existem nele."
            : "";
      throw new DomainError("N8N_REQUEST_FAILED", `${error.message}${hint}`);
    }
    if (error instanceof UnsafeUrlError) {
      throw new DomainError("N8N_UNSAFE_URL", `URL do n8n recusada: ${error.message}`);
    }
    throw new DomainError(
      "N8N_UNREACHABLE",
      "Não foi possível conectar ao n8n. Confira a URL do n8n (e se ela responde a partir do servidor do painel) e tente de novo.",
    );
  }
}

export async function syncN8nAction(): Promise<Result<N8nSyncSummary>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    await ensurePublicBaseUrlFromCurrentRequest();
    const summary = await translateN8nError("sync", () => syncN8n(admin.id));
    await auditPlatform(admin.id, "platform.n8n_synced", "Sincronizou os fluxos com o n8n.", null, { type: "n8n" });
    return summary;
  });
}

export async function activateBotWorkflowAction(): Promise<Result<{ activated: true }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    await translateN8nError("activate", () => activateBotWorkflow());
    await auditPlatform(admin.id, "platform.bot_workflow_activated", "Ativou o fluxo do bot no n8n.", null, { type: "n8n" });
    return { activated: true };
  });
}

export async function deactivateBotWorkflowAction(): Promise<Result<{ activated: false }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    await translateN8nError("deactivate", () => deactivateBotWorkflow());
    await auditPlatform(admin.id, "platform.bot_workflow_deactivated", "Desativou o fluxo do bot no n8n.", null, { type: "n8n" });
    return { activated: false };
  });
}

// ---------------------------------------------------------------------------
// Dados jurídicos da empresa operadora (docs/contratos.md, "Dados jurídicos") — nenhum campo é
// segredo, tudo devolvido em claro.
// ---------------------------------------------------------------------------

export async function getPlatformLegalInfoAction(): Promise<Result<PlatformLegalInfo>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    return getPlatformLegalInfo();
  });
}

const updatePlatformLegalInfoSchema = z.object({
  companyLegalName: z.string().trim().max(160).nullable().optional(),
  companyCnpj: z.string().trim().max(30).nullable().optional(),
  companyAddress: z.string().trim().max(300).nullable().optional(),
  contactEmail: z.union([z.literal(""), z.string().trim().email()]).nullable().optional(),
  dpoName: z.string().trim().max(160).nullable().optional(),
  dpoEmail: z.union([z.literal(""), z.string().trim().email()]).nullable().optional(),
  forumCity: z.string().trim().max(120).nullable().optional(),
  hostingRegion: z.string().trim().max(120).nullable().optional(),
  backupRetentionDays: z.coerce.number().int().min(1).max(3650).nullable().optional(),
});

export async function updatePlatformLegalInfoAction(input: unknown): Promise<Result<PlatformLegalInfo>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const data = updatePlatformLegalInfoSchema.parse(input);

    if (data.companyCnpj) {
      const digits = normalizeDocumentDigits(data.companyCnpj);
      if (!isValidCnpj(digits)) {
        throw new DomainError("INVALID_CNPJ", "CNPJ inválido. Confira os dígitos.");
      }
      data.companyCnpj = digits;
    }

    const legalBefore = await getPlatformLegalInfo();
    const saved = await updatePlatformLegalInfo(data, admin.id);
    const legalChanges = diffChanges(legalBefore, saved, Object.keys(saved));
    if (Object.keys(legalChanges).length > 0) {
      await auditPlatform(admin.id, "platform.legal_info_changed", `Alterou os dados jurídicos da empresa operadora: ${Object.keys(legalChanges).join(", ")}.`, legalChanges, { type: "legal_info" });
    }
    // /termos e /privacidade são estáticas com revalidate de 60s: invalida na hora para o
    // dado novo aparecer já na próxima visita (achado da Íris, 2026-09-29).
    revalidatePath("/termos");
    revalidatePath("/privacidade");
    return saved;
  });
}

// ---------------------------------------------------------------------------
// WhatsApp comercial (botão "Tirar dúvidas" da landing) — não é segredo; vazio = botão some.
// ---------------------------------------------------------------------------

export async function getPlatformSalesWhatsappAction(): Promise<Result<SalesWhatsapp | null>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    return getPlatformSalesWhatsapp();
  });
}

const updateSalesWhatsappSchema = z.object({
  phone: z.string().trim().max(40).nullable().optional(),
});

export async function updatePlatformSalesWhatsappAction(input: unknown): Promise<Result<SalesWhatsapp | null>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const data = updateSalesWhatsappSchema.parse(input);
    const salesBefore = await getPlatformSalesWhatsapp();
    const saved = await updatePlatformSalesWhatsapp(data.phone ?? null, admin.id);
    if ((salesBefore?.e164 ?? null) !== (saved?.e164 ?? null)) {
      await auditPlatform(admin.id, "platform.sales_whatsapp_changed", "Mudou o WhatsApp comercial da landing.", { whatsapp: { de: salesBefore?.display ?? null, para: saved?.display ?? null } });
    }
    revalidatePath("/");
    return saved;
  });
}

// ---------------------------------------------------------------------------
// Admin → Saúde (docs/contratos.md, "Admin Saúde")
// ---------------------------------------------------------------------------

export async function getPlatformHealthAction(): Promise<Result<PlatformHealth>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    return getPlatformHealth();
  });
}

// ---------------------------------------------------------------------------
// Login com Google (Admin > Configurações). NUNCA devolvem o Client Secret — só `clientSecretSaved`.
// ---------------------------------------------------------------------------

export async function getGoogleAuthConfigAction(): Promise<Result<GoogleAuthConfigView>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    return getGoogleAuthConfig();
  });
}

const saveGoogleAuthConfigSchema = z.object({
  enabled: z.boolean().optional(),
  clientId: z.string().max(200).optional(),
  clientSecret: z.string().max(500).optional(),
});

/** Secret vazio mantém o atual; não deixa ligar sem Client ID e secret salvos. */
export async function saveGoogleAuthConfigAction(input: unknown): Promise<Result<GoogleAuthConfigView>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const data = saveGoogleAuthConfigSchema.parse(input);
    await ensurePublicBaseUrlFromCurrentRequest();
    const googleBefore = await getGoogleAuthConfig();
    const saved = await saveGoogleAuthConfig(data, admin.id);
    const googleChanges: AuditChanges = diffChanges(googleBefore, saved, ["enabled", "clientId"]);
    if (data.clientSecret?.trim()) googleChanges["clientSecret"] = { de: null, para: null };
    if (Object.keys(googleChanges).length > 0) {
      await auditPlatform(admin.id, "platform.google_login_changed", `Alterou o login com Google: ${Object.keys(googleChanges).join(", ")}. Valores de segredo não são guardados.`, googleChanges, { type: "google_login" });
    }
    return saved;
  });
}

/** Remove o secret e desliga o login com Google (não dá para ficar ligado sem ele). */
export async function removeGoogleClientSecretAction(): Promise<Result<GoogleAuthConfigView>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const saved = await removeGoogleClientSecret(admin.id);
    await auditPlatform(admin.id, "platform.google_secret_removed", "Removeu o Client Secret do login com Google (o login com Google foi desligado).", { clientSecret: { de: null, para: null } }, { type: "google_login" });
    return saved;
  });
}

/** Só confere formato do ID e se o secret decifra — validar contra o Google exige o fluxo OAuth real. */
export async function testGoogleAuthConfigAction(): Promise<Result<GoogleAuthTestResult>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    return testGoogleAuthConfig();
  });
}
