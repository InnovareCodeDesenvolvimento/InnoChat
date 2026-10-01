import { getPrisma } from "@/lib/db/prisma";
import type { Prisma } from "@/lib/db/types";
import { encryptSecret } from "@/lib/crypto";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { tryGetPublicBaseUrl } from "@/lib/public-url";
import { loadPlatformSettingsRow, readEncryptedSecret } from "@/modules/platform/secrets";

/**
 * Login com Google — credenciais no banco (`PlatformSettings`), nunca em env var. O Client ID é
 * texto (não é segredo); o Client Secret é cifrado (`src/lib/crypto.ts`, mesmo padrão do Mercado
 * Pago). FAIL-CLOSED: secret que não decifra (AUTH_SECRET trocado) = provedor desligado.
 * NUNCA logue nem devolva o secret — só se está salvo.
 */

/** ID de cliente OAuth do Google: `<números>-<hash>.apps.googleusercontent.com`. */
const CLIENT_ID_RE = /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/;
export function isValidGoogleClientId(value: string): boolean {
  return value.length <= 200 && CLIENT_ID_RE.test(value);
}

export const GOOGLE_CALLBACK_PATH = "/api/auth/callback/google";

export type GoogleRuntimeCredentials = { clientId: string; clientSecret: string };

// Cache curto: `NextAuth(async (req) => config)` roda a cada `auth()`/rota de auth, e isto vai ao
// banco. 30 s é o teto de atraso para outra instância enxergar uma mudança; nesta instância a
// gravação invalida na hora (`invalidateGoogleAuthCache`).
const CACHE_TTL_MS = 30_000;
let cache: { at: number; value: GoogleRuntimeCredentials | null } | null = null;

export function invalidateGoogleAuthCache(): void {
  cache = null;
}

/**
 * Credenciais para o Auth.js. `null` = provedor NÃO entra (desligado, incompleto, não decifra ou
 * banco fora do ar). Nunca lança: uma falha aqui não pode derrubar o login por senha.
 */
export async function getGoogleRuntimeCredentials(now = Date.now()): Promise<GoogleRuntimeCredentials | null> {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;
  let value: GoogleRuntimeCredentials | null = null;
  try {
    const row = await loadPlatformSettingsRow();
    if (row?.googleAuthEnabled && row.googleClientId) {
      const clientSecret = readEncryptedSecret(row.googleClientSecretEnc, "googleClientSecretEnc");
      if (clientSecret) value = { clientId: row.googleClientId, clientSecret };
    }
  } catch (error) {
    logger.error("google_auth.config.load_failed", { errorMessage: error instanceof Error ? error.message : String(error) });
    return null; // não cacheia falha: tenta de novo na próxima requisição
  }
  cache = { at: now, value };
  return value;
}

export async function isGoogleAuthAvailable(): Promise<boolean> {
  return (await getGoogleRuntimeCredentials()) !== null;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export type GoogleAuthConfigView = {
  enabled: boolean;
  clientId: string | null;
  clientSecretSaved: boolean;
  /** URI de redirecionamento a cadastrar no Google Cloud Console. */
  redirectUri: string;
  /** Origem JavaScript autorizada a cadastrar no Google Cloud Console. */
  origin: string;
};

async function buildView(): Promise<GoogleAuthConfigView> {
  const row = await loadPlatformSettingsRow();
  const base = (await tryGetPublicBaseUrl()) ?? "";
  const origin = base ? new URL(base).origin : "";
  return {
    enabled: row?.googleAuthEnabled ?? false,
    clientId: row?.googleClientId ?? null,
    // "salvo" só se DECIFRA — secret ilegível vale como ausente (o admin precisa recadastrar).
    clientSecretSaved: !!readEncryptedSecret(row?.googleClientSecretEnc, "googleClientSecretEnc"),
    redirectUri: origin ? `${origin}${GOOGLE_CALLBACK_PATH}` : "",
    origin,
  };
}

export async function getGoogleAuthConfig(): Promise<GoogleAuthConfigView> {
  return buildView();
}

export async function saveGoogleAuthConfig(
  input: { enabled?: boolean; clientId?: string; clientSecret?: string },
  updatedByUserId: string,
): Promise<GoogleAuthConfigView> {
  const current = await loadPlatformSettingsRow();
  const clientId = input.clientId?.trim();
  const clientSecret = input.clientSecret?.trim();

  if (clientId && !isValidGoogleClientId(clientId)) {
    throw new DomainError("INVALID_GOOGLE_CLIENT_ID", "O Client ID do Google termina em .apps.googleusercontent.com. Confira o valor copiado.");
  }

  const data: Prisma.PlatformSettingsUncheckedUpdateInput = {};
  if (clientId) data.googleClientId = clientId;
  if (clientSecret) data.googleClientSecretEnc = encryptSecret(clientSecret); // vazio = mantém o atual
  if (input.enabled !== undefined) data.googleAuthEnabled = input.enabled;

  if (input.enabled === true) {
    const finalClientId = clientId || current?.googleClientId;
    const secretOk = clientSecret ? true : !!readEncryptedSecret(current?.googleClientSecretEnc, "googleClientSecretEnc");
    if (!finalClientId || !secretOk) {
      throw new DomainError("GOOGLE_CONFIG_INCOMPLETE", "Informe o Client ID e o Client Secret antes de ligar o login com Google.", {
        missing: [!finalClientId ? "clientId" : null, !secretOk ? "clientSecret" : null].filter(Boolean),
      });
    }
  }

  logger.info("platform.google_auth.saved", { enabled: input.enabled ?? null, clientId: !!clientId, clientSecret: !!clientSecret });
  await getPrisma().platformSettings.upsert({
    where: { id: 1 },
    create: { id: 1, ...data, updatedByUserId } as Prisma.PlatformSettingsUncheckedCreateInput,
    update: { ...data, updatedByUserId },
  });
  invalidateGoogleAuthCache();
  return buildView();
}

/** Remove o secret e, como não dá para ficar ligado sem ele, desliga o login com Google. */
export async function removeGoogleClientSecret(updatedByUserId: string): Promise<GoogleAuthConfigView> {
  logger.info("platform.google_auth.secret_removed", {});
  await getPrisma().platformSettings.upsert({
    where: { id: 1 },
    create: { id: 1, googleClientSecretEnc: null, googleAuthEnabled: false, updatedByUserId },
    update: { googleClientSecretEnc: null, googleAuthEnabled: false, updatedByUserId },
  });
  invalidateGoogleAuthCache();
  return buildView();
}

export type GoogleAuthTestResult = { ok: boolean; detalhe: string; checks: { clientIdFormat: boolean; secretDecrypts: boolean } };

/**
 * NÃO valida contra o Google: só o Google aceita/recusa o par ID+secret, e isso só acontece no
 * fluxo OAuth real (ao clicar em "Entrar com Google"). Aqui só dá para conferir o formato do ID e
 * se o secret salvo decifra (AUTH_SECRET íntegro). A mensagem diz isso ao admin.
 */
export async function testGoogleAuthConfig(): Promise<GoogleAuthTestResult> {
  const row = await loadPlatformSettingsRow();
  const clientIdFormat = !!row?.googleClientId && isValidGoogleClientId(row.googleClientId);
  const secretDecrypts = !!readEncryptedSecret(row?.googleClientSecretEnc, "googleClientSecretEnc");
  const ok = clientIdFormat && secretDecrypts;
  const problems = [
    !row?.googleClientId ? "Client ID não informado." : !clientIdFormat ? "O Client ID não tem o formato esperado (…apps.googleusercontent.com)." : null,
    !row?.googleClientSecretEnc ? "Client Secret não informado." : !secretDecrypts ? "Não deu para ler o Client Secret salvo. Cadastre de novo." : null,
  ].filter(Boolean);
  return {
    ok,
    checks: { clientIdFormat, secretDecrypts },
    detalhe: ok
      ? "Formato do Client ID e Client Secret conferidos. Não dá para validar com o Google daqui: o teste real é entrar com o Google pela tela de login."
      : problems.join(" "),
  };
}
