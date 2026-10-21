import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { classifyDriveFailure, DriveFailure, type TokenGetter } from "./drive";

/**
 * "Conectar com Google": backup no Drive autenticado em nome do DONO, não de uma conta de serviço.
 * Portado do Parque das Feiras (`backupDriveOAuth.ts`). Existe porque conta de serviço não tem espaço
 * próprio, e quem usa Gmail pessoal não tem unidade compartilhada. Com OAuth o arquivo pertence ao dono.
 *
 * ESCOPO `drive.file` (não sensível, sem aviso de "app não verificado"): o app só enxerga o que ele
 * mesmo criou. Por isso a pasta de destino é SEMPRE criada por este código, nunca uma que o dono colou.
 *
 * REFRESH TOKEN: app do Google Cloud em "Testing" emite refresh token que expira em 7 dias; só em
 * "In production" ele dura. É configuração do lado do Google, fora do alcance daqui (a tela avisa).
 * `access_type=offline&prompt=consent` são obrigatórios na URL: sem eles o Google pode nem devolver
 * refresh token.
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const ABOUT_URL = "https://www.googleapis.com/drive/v3/about";
const FILES_URL = "https://www.googleapis.com/drive/v3/files";

export const OAUTH_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
/** Nome fixo da pasta que o app cria no Drive do dono na primeira conexão. */
export const OAUTH_FOLDER_NAME = "Backups InnoChat";
const TIMEOUT_MS = 30_000;

/** Caminho do callback, relativo à URL pública do sistema (que vem das configurações da plataforma). */
export const OAUTH_CALLBACK_PATH = "/api/admin/backup/google/callback";

export function redirectUriFor(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}${OAUTH_CALLBACK_PATH}`;
}

function rawTokenError(body: string): { error: string; description: string } {
  try {
    const obj = JSON.parse(body) as { error?: string; error_description?: string };
    return { error: obj.error ?? "", description: obj.error_description ?? "" };
  } catch {
    return { error: "", description: body.slice(0, 300) };
  }
}

export function buildAuthorizationUrl(opts: { clientId: string; redirectUri: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: OAUTH_DRIVE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state: opts.state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function postForm(url: string, form: Record<string, string>, doing: string): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { ok: resp.ok, status: resp.status, text: await resp.text().catch(() => "") };
  } catch (err) {
    throw new DriveFailure(`Não foi possível falar com o Google para ${doing}: ${err instanceof Error ? err.message : String(err)}.`, "network");
  }
}

export type GoogleTokens = { accessToken: string; refreshToken: string | null; expiresIn: number };

/** Troca o `code` do callback pelos tokens. Erro sempre classificado. */
export async function exchangeCodeForTokens(opts: { clientId: string; clientSecret: string; code: string; redirectUri: string }): Promise<GoogleTokens> {
  const res = await postForm(
    TOKEN_URL,
    { grant_type: "authorization_code", code: opts.code, client_id: opts.clientId, client_secret: opts.clientSecret, redirect_uri: opts.redirectUri },
    "conectar a conta",
  );
  if (!res.ok) {
    const { error, description } = rawTokenError(res.text);
    const raw = [error, description].filter(Boolean).join(": ").slice(0, 400) || `HTTP ${res.status}`;
    if (error === "invalid_client") {
      throw new DriveFailure(`O Google recusou a conexão: ${raw}.`, "oauth_client_invalid", res.status);
    }
    throw new DriveFailure(`O Google recusou a conexão: ${raw}.`, classifyDriveFailure(res.status, res.text), res.status);
  }
  let data: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    data = JSON.parse(res.text);
  } catch {
    throw new DriveFailure("O Google aceitou a conexão mas devolveu uma resposta ilegível.", "unknown");
  }
  if (!data.access_token) throw new DriveFailure("O Google não devolveu o acesso.", "unknown");
  return { accessToken: data.access_token, refreshToken: data.refresh_token ?? null, expiresIn: data.expires_in ?? 3600 };
}

/**
 * Renova o acesso a partir do refresh token salvo. `invalid_grant` é um caso à parte: não é "chave
 * digitada errada", é "a permissão foi retirada". A única ação possível é reconectar.
 */
export async function refreshAccessToken(opts: { clientId: string; clientSecret: string; refreshToken: string }): Promise<{ accessToken: string; expiresIn: number }> {
  const res = await postForm(
    TOKEN_URL,
    { grant_type: "refresh_token", refresh_token: opts.refreshToken, client_id: opts.clientId, client_secret: opts.clientSecret },
    "renovar o acesso",
  );
  if (!res.ok) {
    const { error, description } = rawTokenError(res.text);
    if (error === "invalid_grant") {
      throw new DriveFailure(
        "O Google recusou renovar o acesso: a conta foi desconectada (revogada, senha trocada ou app do Google Cloud de volta ao modo de teste).",
        "oauth_disconnected",
        res.status,
      );
    }
    const raw = [error, description].filter(Boolean).join(": ").slice(0, 400) || `HTTP ${res.status}`;
    // invalid_client aqui é o Client ID/Secret do app OAuth, não a chave de conta de serviço: mensagem própria.
    if (error === "invalid_client") {
      throw new DriveFailure(`O Google recusou renovar o acesso: ${raw}.`, "oauth_client_invalid", res.status);
    }
    throw new DriveFailure(`O Google recusou renovar o acesso: ${raw}.`, classifyDriveFailure(res.status, res.text), res.status);
  }
  let data: { access_token?: string; expires_in?: number };
  try {
    data = JSON.parse(res.text);
  } catch {
    throw new DriveFailure("O Google aceitou renovar o acesso mas devolveu uma resposta ilegível.", "unknown");
  }
  if (!data.access_token) throw new DriveFailure("O Google não devolveu o acesso ao renovar.", "unknown");
  return { accessToken: data.access_token, expiresIn: data.expires_in ?? 3600 };
}

/** Cache por execução: o backup chama isto uma vez e reaproveita no upload, na listagem e na poda. */
export function oauthTokenGetter(opts: { clientId: string; clientSecret: string; refreshToken: string }): TokenGetter {
  let cache: { token: string; expiresAt: number } | null = null;
  return async () => {
    if (cache && cache.expiresAt > Date.now() + 60_000) return cache.token;
    const { accessToken, expiresIn } = await refreshAccessToken(opts);
    cache = { token: accessToken, expiresAt: Date.now() + expiresIn * 1000 };
    return accessToken;
  };
}

/** Melhor esforço: falha aqui (rede, token já revogado) não impede o Desconectar de limpar o que é local. */
export async function revokeGoogleToken(token: string): Promise<void> {
  try {
    await fetch(`${REVOKE_URL}?${new URLSearchParams({ token }).toString()}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Não acionável: o chamador apaga o token local de qualquer forma.
  }
}

/** E-mail da conta conectada, para o dono confirmar que é a conta dele. */
export async function fetchAccountEmail(accessToken: string): Promise<string> {
  let resp: Response;
  try {
    resp = await fetch(`${ABOUT_URL}?fields=${encodeURIComponent("user(emailAddress)")}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new DriveFailure(`Não foi possível confirmar a conta conectada: ${err instanceof Error ? err.message : String(err)}.`, "network");
  }
  const text = await resp.text().catch(() => "");
  if (!resp.ok) throw new DriveFailure(`O Google recusou confirmar a conta conectada (${resp.status}).`, classifyDriveFailure(resp.status, text), resp.status);
  const data = JSON.parse(text) as { user?: { emailAddress?: string } };
  if (!data.user?.emailAddress) throw new DriveFailure("O Google não informou o e-mail da conta conectada.", "unknown");
  return data.user.emailAddress;
}

/** Cria a pasta de backups no Drive do dono. Só quando ainda não existe uma: reconectar não cria outra. */
export async function createBackupFolder(accessToken: string): Promise<string> {
  let resp: Response;
  try {
    resp = await fetch(FILES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: OAUTH_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new DriveFailure(`Não foi possível criar a pasta de backups no Drive: ${err instanceof Error ? err.message : String(err)}.`, "network");
  }
  const text = await resp.text().catch(() => "");
  if (!resp.ok) throw new DriveFailure(`O Google recusou criar a pasta de backups (${resp.status}).`, classifyDriveFailure(resp.status, text), resp.status);
  const data = JSON.parse(text) as { id?: string };
  if (!data.id) throw new DriveFailure("O Google criou a pasta mas não devolveu o id dela.", "unknown");
  return data.id;
}

// ---------------------------------------------------------------------------------------------
// `state` do fluxo: assinado, com prazo curto e nonce de uso único (BackupDriveOauthNonce).
// O callback chega pelo navegador, redirecionado pelo Google. Sem `state` válido NADA é gravado:
// um link forjado não pode conectar a conta Google de um atacante ao backup (o próximo dump, com
// dado pessoal de todos os clientes, iria para o Drive dele).
// ---------------------------------------------------------------------------------------------

const STATE_CONTEXT = "innochat:backup:drive-oauth-state:v1";
const STATE_TTL_MS = 10 * 60 * 1000;

export type OAuthState = { adminId: string; nonce: string; iat: number; exp: number };

function stateKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) throw new Error("AUTH_SECRET ausente ou curto demais para assinar o estado do OAuth.");
  return createHash("sha256").update(`${STATE_CONTEXT}:${secret}`).digest();
}

export function signOAuthState(adminId: string, now: number = Date.now()): { state: string; nonce: string; expiresAt: Date } {
  const nonce = randomBytes(16).toString("hex");
  const payload: OAuthState = { adminId, nonce, iat: now, exp: now + STATE_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", stateKey()).update(body).digest("base64url");
  return { state: `${body}.${signature}`, nonce, expiresAt: new Date(payload.exp) };
}

/** Nunca lança: `state` inválido é o caminho normal de um ataque. Não checa o nonce (isso é do banco). */
export function verifyOAuthState(state: string, now: number = Date.now()): OAuthState | null {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  let expected: Buffer;
  try {
    expected = createHmac("sha256", stateKey()).update(body).digest();
  } catch {
    return null;
  }
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  let payload: OAuthState;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.adminId !== "string" || !payload.adminId || typeof payload.nonce !== "string" || !payload.nonce || typeof payload.exp !== "number") return null;
  if (payload.exp < now) return null;
  return payload;
}
