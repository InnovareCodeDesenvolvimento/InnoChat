import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { createSign } from "node:crypto";
import { logger } from "@/lib/logger";

/**
 * Google Drive como destino do backup (alternativa ao S3). Portado do Parque das Feiras
 * (`backend/src/lib/backupDrive.ts`), sem `googleapis`: a superfície usada é pequena (pegar
 * token, subir, listar, apagar) e a assinatura RS256 do JWT cabe em `node:crypto`.
 *
 * A RESSALVA DE SEMPRE: no Drive o acesso pode ser revogado por uma pessoa (tirar o
 * compartilhamento da pasta, apagar a chave no Google Cloud) e, sem cuidado, o backup para calado.
 * Por isso toda falha daqui sai CLASSIFICADA em uma causa que pede uma ação diferente
 * (credencial, pasta, cota, rede, conta desconectada) e carrega a frase que diz o que fazer.
 *
 * A ARMADILHA DA COTA: arquivo criado por conta de serviço pertence a ela, e ela não tem espaço
 * ("Service Accounts do not have storage quota"). O que funciona é subir para dentro de uma pasta
 * do dono, compartilhada como Editor com a conta de serviço, ou usar "Conectar com Google" (OAuth).
 */

const SCOPE = "https://www.googleapis.com/auth/drive";
const TOKEN_AUD = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/drive/v3";
const API_UPLOAD = "https://www.googleapis.com/upload/drive/v3";

/** Inatividade tolerada numa chamada de metadado. */
const JSON_TIMEOUT_MS = 30_000;
/** Inatividade tolerada no upload (o relógio zera a cada bloco enviado). */
const UPLOAD_TIMEOUT_MS = 5 * 60_000;
const MAX_BODY_CHARS = 64 * 1024;

export type FailureCategory = "credential" | "folder" | "quota" | "network" | "oauth_disconnected" | "unknown";

/** O que fazer, por causa. Vai no e-mail de alerta e no histórico da tela. */
export const ACTION_BY_CATEGORY: Record<FailureCategory, string> = {
  credential:
    "O Google recusou a chave da conta de serviço. Gere uma chave nova no Google Cloud (IAM, Contas de serviço, Chaves) e cole em Admin > Backup. Se a chave é recente, confira o relógio do servidor: alguns minutos de desvio invalidam a assinatura.",
  oauth_disconnected:
    "A conta Google conectada não autoriza mais o backup (acesso revogado, senha trocada ou app do Google Cloud de volta ao modo de teste). Abra Admin > Backup e clique em Conectar com Google de novo.",
  folder:
    "A pasta do Google Drive não está acessível. Confira se ela ainda existe e se continua compartilhada como Editor com o e-mail da conta de serviço. Tirar o compartilhamento derruba o backup e o id da pasta continua parecendo certo.",
  quota:
    "O Google não deixa conta de serviço gravar numa pasta comum do Drive, mesmo compartilhada: o arquivo pertence à conta de serviço e ela não tem espaço. Só funciona com uma unidade compartilhada do Google Workspace. Em conta Gmail pessoal, use Conectar com Google ou o destino S3. Se já está numa unidade compartilhada, o espaço acabou: libere espaço ou reduza a retenção.",
  network:
    "Falha de rede ou instabilidade do Google. O agendador tenta de novo no próximo horário. Se repetir, trate como incidente: sem isso não há cópia nova do banco.",
  unknown: "O Google Drive recusou a operação por um motivo que o sistema não sabe classificar. A mensagem do Google está acima.",
};

/**
 * Falha no destino Drive, já classificada. NUNCA carrega a credencial: a mensagem é montada com o
 * que o Google respondeu e com texto fixo.
 */
export class DriveFailure extends Error {
  constructor(
    message: string,
    readonly category: FailureCategory,
    readonly status?: number,
  ) {
    super(`${message} ${ACTION_BY_CATEGORY[category]}`);
    this.name = "DriveFailure";
  }
}

export type ServiceAccountCredential = { clientEmail: string; privateKey: string; projectId: string | null };

/**
 * Interpreta o arquivo de chave da conta de serviço. A mensagem de erro NUNCA ecoa o conteúdo,
 * nem um pedaço: um arquivo malformado ainda tem uma chave privada dentro.
 */
export function parseServiceAccountKey(raw: string): ServiceAccountCredential {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new DriveFailure('O arquivo de chave não é válido. Cole o conteúdo inteiro, do "{" ao "}".', "credential");
  }
  const type = typeof obj.type === "string" ? obj.type : "";
  const clientEmail = typeof obj.client_email === "string" ? obj.client_email.trim() : "";
  const rawKey = typeof obj.private_key === "string" ? obj.private_key : "";
  if (type !== "service_account" || !clientEmail || !rawKey) {
    throw new DriveFailure(
      'Esse arquivo não é de uma conta de serviço (faltam "type": "service_account", "client_email" ou "private_key"). Baixe a chave em IAM, Contas de serviço, Chaves, Adicionar chave.',
      "credential",
    );
  }
  // `\n` que sobreviveu escapado (acontece quando a chave passou por variável de ambiente).
  const privateKey = rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey;
  return { clientEmail, privateKey, projectId: typeof obj.project_id === "string" ? obj.project_id : null };
}

/** Aceita o id da pasta OU a URL colada do navegador. Devolve `null` se não reconhecer. */
export function normalizeFolderId(input: string | null | undefined): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;
  const fromUrl = raw.match(/\/folders\/([A-Za-z0-9_-]+)/);
  if (fromUrl) return fromUrl[1];
  const fromParam = raw.match(/[?&]id=([A-Za-z0-9_-]+)/);
  if (fromParam) return fromParam[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(raw)) return raw;
  return null;
}

function errorDetail(body: string): { reason: string; message: string } {
  try {
    const obj = JSON.parse(body) as {
      error?: { message?: string; errors?: Array<{ reason?: string; message?: string }> } | string;
      error_description?: string;
    };
    if (typeof obj.error === "string") return { reason: obj.error, message: obj.error_description ?? "" };
    const first = obj.error?.errors?.[0];
    return { reason: first?.reason ?? "", message: obj.error?.message ?? first?.message ?? "" };
  } catch {
    return { reason: "", message: body.slice(0, 300) };
  }
}

/** Traduz status + corpo do Google numa causa acionável. Pura, para testar sem rede. */
export function classifyDriveFailure(status: number, body: string): FailureCategory {
  const { reason, message } = errorDetail(body);
  const text = `${reason} ${message}`.toLowerCase();
  // Cota primeiro: também chega como 403, e confundir com permissão mandaria mexer no compartilhamento.
  if (text.includes("storagequotaexceeded") || text.includes("quotaexceeded") || text.includes("storage quota")) return "quota";
  if (
    status === 401 ||
    text.includes("invalid_grant") ||
    text.includes("invalid_client") ||
    text.includes("unauthorized_client") ||
    text.includes("invalid jwt") ||
    text.includes("invalid credentials")
  ) {
    return "credential";
  }
  if (
    status === 404 ||
    text.includes("notfound") ||
    text.includes("file not found") ||
    text.includes("insufficientfilepermissions") ||
    (status === 403 && (text.includes("permission") || text.includes("forbidden")))
  ) {
    return "folder";
  }
  if (status === 429 || status >= 500 || text.includes("ratelimit") || text.includes("backenderror")) return "network";
  return "unknown";
}

export function httpFailure(status: number, body: string, doing: string): DriveFailure {
  const category = classifyDriveFailure(status, body);
  const { reason, message } = errorDetail(body);
  const raw = [reason, message].filter(Boolean).join(": ").slice(0, 400) || `HTTP ${status}`;
  return new DriveFailure(`${doing}: o Google respondeu ${status} (${raw}).`, category, status);
}

type HttpResponse = { status: number; text: string; headers: IncomingMessage["headers"] };

function request(
  url: string,
  opts: { method: string; headers?: Record<string, string>; body?: string; timeoutMs?: number },
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: opts.method, headers: opts.headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        if (text.length < MAX_BODY_CHARS) text += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
    });
    req.setTimeout(opts.timeoutMs ?? JSON_TIMEOUT_MS, () => req.destroy(new Error("tempo esgotado esperando o Google responder")));
    req.on("error", (err) => reject(new DriveFailure(`Não foi possível falar com o Google Drive: ${err.message}.`, "network")));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/** Como as chamadas de rede pedem um token de acesso, sem saber COMO ele foi obtido (conta de serviço ou OAuth). */
export type TokenGetter = () => Promise<string>;

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/** Só para teste. */
export function clearTokenCache(): void {
  tokenCache.clear();
}

export function serviceAccountTokenGetter(cred: ServiceAccountCredential): TokenGetter {
  return () => fetchServiceAccountToken(cred);
}

async function fetchServiceAccountToken(cred: ServiceAccountCredential): Promise<string> {
  const cached = tokenCache.get(cred.clientEmail);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({ iss: cred.clientEmail, scope: SCOPE, aud: TOKEN_AUD, iat: now, exp: now + 3600 }));
  let signature: string;
  try {
    signature = base64url(createSign("RSA-SHA256").update(`${header}.${claims}`).sign(cred.privateKey));
  } catch {
    // O erro do OpenSSL pode citar trechos do material da chave: não passa daqui.
    throw new DriveFailure("A chave privada da conta de serviço não pôde ser usada para assinar (formato inválido ou corrompido).", "credential");
  }
  const form =
    "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + encodeURIComponent(`${header}.${claims}.${signature}`);
  const res = await request(TOKEN_AUD, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(Buffer.byteLength(form)) },
    body: form,
  });
  if (res.status !== 200) throw httpFailure(res.status, res.text, "Ao autenticar no Google");
  const data = JSON.parse(res.text) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new DriveFailure("O Google autenticou mas não devolveu o acesso.", "credential");
  tokenCache.set(cred.clientEmail, { token: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000 });
  return data.access_token;
}

export type DriveFile = { id: string; name: string; createdAt: Date; size: number | null };

/** Filtro que acha NOSSOS dumps na pasta. */
export function dumpsQuery(folderId: string): string {
  return `'${folderId}' in parents and trashed = false and name contains 'backup-'`;
}

/** Lista os dumps dentro da pasta (paginando até o fim). */
export async function listDriveDumps(getToken: TokenGetter, folderId: string): Promise<DriveFile[]> {
  const token = await getToken();
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const url =
      `${API}/files?q=${encodeURIComponent(dumpsQuery(folderId))}&pageSize=200&orderBy=createdTime` +
      `&fields=${encodeURIComponent("nextPageToken,files(id,name,createdTime,size)")}` +
      `&supportsAllDrives=true&includeItemsFromAllDrives=true` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const res = await request(url, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
    if (res.status !== 200) throw httpFailure(res.status, res.text, "Ao listar os backups na pasta do Drive");
    const data = JSON.parse(res.text) as {
      nextPageToken?: string;
      files?: Array<{ id: string; name: string; createdTime: string; size?: string }>;
    };
    for (const f of data.files ?? []) {
      files.push({ id: f.id, name: f.name, createdAt: new Date(f.createdTime), size: f.size ? Number(f.size) : null });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}

/** Confere que a pasta existe e aceita arquivo novo. Usado no "Testar conexão". */
export async function checkDriveFolder(getToken: TokenGetter, folderId: string): Promise<void> {
  const token = await getToken();
  const res = await request(
    `${API}/files/${encodeURIComponent(folderId)}?fields=${encodeURIComponent("id,mimeType,trashed,capabilities(canAddChildren)")}&supportsAllDrives=true`,
    { method: "GET", headers: { Authorization: `Bearer ${token}` } },
  );
  if (res.status !== 200) throw httpFailure(res.status, res.text, "Ao abrir a pasta do Drive");
  const folder = JSON.parse(res.text) as { mimeType?: string; trashed?: boolean; capabilities?: { canAddChildren?: boolean } };
  if (folder.trashed || folder.mimeType !== "application/vnd.google-apps.folder") {
    throw new DriveFailure("O id informado não é uma pasta, ou ela está na lixeira.", "folder");
  }
  if (folder.capabilities?.canAddChildren === false) {
    throw new DriveFailure("A pasta existe, mas esta conta não pode colocar arquivos nela.", "folder");
  }
}

/**
 * Sobe o dump para dentro da pasta e CONFIRMA que chegou. Upload retomável por stream (um dump de
 * vários GB não passa pela memória). A confirmação (tamanho e lixeira) é o que autoriza a poda a
 * apagar qualquer coisa depois.
 */
export async function uploadDumpToDrive(opts: {
  getToken: TokenGetter;
  folderId: string;
  file: string;
  name: string;
  size: number;
}): Promise<{ fileId: string }> {
  const token = await opts.getToken();
  const metadata = JSON.stringify({ name: opts.name, parents: [opts.folderId] });
  const start = await request(`${API_UPLOAD}/files?uploadType=resumable&supportsAllDrives=true`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "Content-Length": String(Buffer.byteLength(metadata)),
      "X-Upload-Content-Type": "application/octet-stream",
      "X-Upload-Content-Length": String(opts.size),
    },
    body: metadata,
  });
  if (start.status !== 200) throw httpFailure(start.status, start.text, "Ao abrir o envio para a pasta do Drive");
  const session = start.headers.location;
  if (typeof session !== "string" || !session) {
    throw new DriveFailure("O Google aceitou o envio mas não devolveu o endereço da sessão.", "unknown");
  }
  const sent = await streamUpload(session, opts.file, opts.size);
  if (sent.status !== 200 && sent.status !== 201) throw httpFailure(sent.status, sent.text, "Ao enviar o dump para o Drive");
  const created = JSON.parse(sent.text) as { id?: string };
  if (!created.id) throw new DriveFailure("O Drive não devolveu o id do arquivo enviado.", "unknown");
  await confirmUploaded(token, created.id, opts.size);
  return { fileId: created.id };
}

function streamUpload(url: string, file: string, size: number): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "Content-Length": String(size) } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        if (text.length < MAX_BODY_CHARS) text += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text, headers: res.headers }));
    });
    req.setTimeout(UPLOAD_TIMEOUT_MS, () => req.destroy(new Error("o envio ficou parado por tempo demais")));
    req.on("error", (err) => reject(new DriveFailure(`O envio do dump para o Drive foi interrompido: ${err.message}.`, "network")));
    const reader = createReadStream(file);
    reader.on("error", (err) => {
      req.destroy();
      reject(new DriveFailure(`Não foi possível ler o dump para enviar: ${err.message}.`, "network"));
    });
    reader.pipe(req);
  });
}

async function confirmUploaded(token: string, fileId: string, expectedSize: number): Promise<void> {
  const res = await request(`${API}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent("id,name,size,trashed")}&supportsAllDrives=true`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status !== 200) throw httpFailure(res.status, res.text, "Ao conferir o dump recém-enviado");
  const file = JSON.parse(res.text) as { size?: string; trashed?: boolean };
  if (file.trashed) throw new DriveFailure("O dump foi enviado e já está na lixeira do Drive.", "folder");
  const size = file.size ? Number(file.size) : null;
  if (size !== null && size !== expectedSize) {
    throw new DriveFailure(`O dump chegou ao Drive com ${size} bytes, mas tem ${expectedSize}. O envio ficou pela metade.`, "network");
  }
}

/** Apaga de vez (não manda para a lixeira, que continuaria ocupando espaço por 30 dias). */
export async function deleteDriveFiles(getToken: TokenGetter, fileIds: string[]): Promise<number> {
  if (fileIds.length === 0) return 0;
  const token = await getToken();
  let deleted = 0;
  for (const id of fileIds) {
    const res = await request(`${API}/files/${encodeURIComponent(id)}?supportsAllDrives=true`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    // 404 = já não existe: o objetivo (não estar lá) foi atingido.
    if (res.status === 204 || res.status === 200 || res.status === 404) {
      deleted += 1;
      continue;
    }
    // Falhar a poda não derruba um backup que já subiu e foi conferido.
    logger.warn("backup.drive.delete_failed", { status: res.status });
  }
  return deleted;
}

/**
 * Baixa um arquivo do Drive para o disco, em fluxo (o dump não passa pela memória). O arquivo de
 * destino nasce 0600. Em erro o chamador apaga o que sobrou (a pasta temporária inteira some no `finally`).
 */
export async function downloadDriveFile(getToken: TokenGetter, fileId: string, dest: string): Promise<void> {
  const token = await getToken();
  const url = `${API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
  await new Promise<void>((resolve, reject) => {
    const req = https.request(url, { method: "GET", headers: { Authorization: `Bearer ${token}` } }, (res) => {
      if (res.statusCode !== 200) {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (text.length < MAX_BODY_CHARS) text += chunk;
        });
        res.on("end", () => reject(httpFailure(res.statusCode ?? 0, text, "Ao baixar o backup do Drive")));
        return;
      }
      pipeline(res, createWriteStream(dest, { mode: 0o600 })).then(
        () => resolve(),
        (err: Error) => reject(new DriveFailure(`O download do backup foi interrompido: ${err.message}.`, "network")),
      );
    });
    req.setTimeout(UPLOAD_TIMEOUT_MS, () => req.destroy(new Error("o download ficou parado por tempo demais")));
    req.on("error", (err) => reject(new DriveFailure(`Não foi possível falar com o Google Drive: ${err.message}.`, "network")));
    req.end();
  });
}
