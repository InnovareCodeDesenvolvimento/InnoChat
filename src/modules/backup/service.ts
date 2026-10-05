import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DeleteObjectsCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getPrisma } from "@/lib/db/prisma";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { sendMail } from "@/lib/email";
import { tryGetPublicBaseUrl } from "@/lib/public-url";
import { encryptSecret } from "@/lib/crypto";
import { readEncryptedSecret } from "@/modules/platform/secrets";
import { checkS3EndpointResolved, checkS3EndpointShape, createGuardedLookup } from "./s3-endpoint";
import { pageInfoOf, resolvePage, type PageInfo, type PageSize } from "@/modules/billing/paging";
import {
  DriveFailure,
  checkDriveFolder,
  deleteDriveFiles,
  downloadDriveFile,
  listDriveDumps,
  normalizeFolderId,
  parseServiceAccountKey,
  serviceAccountTokenGetter,
  uploadDumpToDrive,
  type FailureCategory,
  type TokenGetter,
} from "./drive";
import { createBackupFolder, exchangeCodeForTokens, fetchAccountEmail, oauthTokenGetter, redirectUriFor, revokeGoogleToken, verifyOAuthState, signOAuthState, buildAuthorizationUrl } from "./drive-oauth";
import {
  BackupCryptoError,
  backupKeyFileText,
  decryptFile,
  encryptFile,
  formatBackupKey,
  generateBackupKey,
  keyFingerprint,
  parseBackupKey,
  readBackupFileFingerprint,
} from "./backup-crypto";
import {
  LATE_ALERT_INTERVAL_MS,
  LOCK_EXPIRES_MS,
  VERIFY_STALE_MS,
  activeDestination,
  backupFileName,
  backupKeyChangedMail,
  encryptedBackupFileName,
  countTablesWithData,
  decidePrune,
  failureMail,
  googleConnectedMail,
  googleDisconnectedMail,
  isBackupFileName,
  isDue,
  isVerifyDue,
  lateMail,
  lateStatus,
  parsePgDumpMajor,
  pgEnvFromUrl,
  pgVersionProblem,
  verifyFailureMail,
  type AlertMail,
  type BackupDestination,
  type BackupErrorCode,
  type LateStatus,
} from "./policy";

/**
 * Backup do banco: agendado, com destino FORA do servidor e barulhento quando falta.
 * Portado do Parque das Feiras (docs/BACKUP.md daquele projeto). Cadastro 100% na tela Admin > Backup
 * (nenhuma variável de ambiente nova); segredos cifrados com `src/lib/crypto.ts`.
 *
 * A FRAQUEZA DESTE DESENHO, DITA EM VOZ ALTA: o agendador roda dentro do próprio processo. Se ele
 * estiver fora do ar ou reiniciando em laço, nenhum dump acontece, justamente quando se vai querer
 * um. Não há como consertar isso de dentro; o que dá é não deixar passar em branco: o alerta de
 * "backup atrasado" (sino do Admin + e-mail) avisa quando nenhuma cópia entrou dentro do limite. O
 * mesmo `runBackupTick` também pode ser chamado pelo cron externo (POST /api/internal/v1/backup/tick).
 *
 * CIFRA: tudo que sai do servidor sai cifrado (AES-256-GCM em fluxo, `backup-crypto.ts`, arquivo `.dump.enc`)
 * com uma chave PRÓPRIA do backup, gerada na tela e mostrada ao dono uma única vez. O sistema guarda a
 * chave cifrada com o AUTH_SECRET só para o agendador conseguir cifrar de madrugada; o dono guarda a
 * dele fora do servidor, e é ela que abre os arquivos se o servidor se perder. "Conferir backup"
 * (`verifyLatestBackup`) baixa a cópia mais recente, decifra e lê o índice, sem escrever em banco algum.
 *
 * O QUE NÃO FAZ, DE PROPÓSITO: restaurar. Um botão que apaga o banco a um clique é risco
 * desproporcional. Restaurar exige linha de comando, destino escrito à mão e `--confirmar`
 * (scripts/restore-db.sh, docs/runbook.md).
 */

export class BackupError extends Error {
  constructor(
    message: string,
    readonly code: BackupErrorCode,
  ) {
    super(message);
    this.name = "BackupError";
  }
}

const CATEGORY_TO_CODE: Record<FailureCategory, BackupErrorCode> = {
  credential: "CREDENTIAL",
  folder: "FOLDER",
  quota: "QUOTA",
  network: "NETWORK",
  oauth_disconnected: "OAUTH_DISCONNECTED",
  unknown: "UNKNOWN",
};

function asBackupError(error: unknown): BackupError {
  if (error instanceof BackupError) return error;
  if (error instanceof DriveFailure) return new BackupError(error.message, CATEGORY_TO_CODE[error.category]);
  return new BackupError(error instanceof Error ? error.message : String(error), "UNKNOWN");
}

// ---------------------------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------------------------

/** Lê o singleton (id 1), criando-o desligado se a migration ainda não semeou. */
export async function loadBackupConfig() {
  const prisma = getPrisma();
  const existing = await prisma.backupConfig.findUnique({ where: { id: 1 } });
  if (existing) return existing;
  return prisma.backupConfig.upsert({ where: { id: 1 }, create: { id: 1 }, update: {} });
}

export type BackupConfigRow = Awaited<ReturnType<typeof loadBackupConfig>>;

/**
 * O que a tela pode ver. Lista EXPLÍCITA: um segredo que escapa para a resposta não dá erro em
 * lugar nenhum, some no meio de um objeto que "funciona". NUNCA devolva `s3SecretKeyEnc`,
 * `driveServiceAccountEnc`, `driveOauthClientSecretEnc`, `driveOauthRefreshTokenEnc` nem `encryptionKeyEnc`.
 */
export function configForPanel(config: BackupConfigRow) {
  return {
    enabled: config.enabled,
    hourLocal: config.hourLocal,
    retentionDays: config.retentionDays,
    alertAfterHours: config.alertAfterHours,
    destination: config.destination as BackupDestination | null,
    driveMode: config.driveMode as "SERVICE_ACCOUNT" | "OAUTH",
    destinationReady: activeDestination(config) !== null,
    s3Endpoint: config.s3Endpoint,
    s3Bucket: config.s3Bucket,
    s3Region: config.s3Region,
    s3Prefix: config.s3Prefix,
    s3AccessKey: config.s3AccessKey,
    /** O segredo nunca sai daqui, só a informação de que existe. */
    hasS3Secret: Boolean(config.s3SecretKeyEnc),
    driveFolderId: config.driveFolderId,
    /** Não é segredo: é o e-mail com quem a pasta precisa estar compartilhada. */
    driveClientEmail: config.driveClientEmail,
    hasDriveServiceAccount: Boolean(config.driveServiceAccountEnc),
    driveOauthClientId: config.driveOauthClientId,
    hasDriveOauthClientSecret: Boolean(config.driveOauthClientSecretEnc),
    /** Client ID preenchido NÃO é conectado: só isto prova que o fluxo terminou. */
    driveOauthConnected: Boolean(config.driveOauthConnectedAt),
    driveOauthConnectedAt: config.driveOauthConnectedAt?.toISOString() ?? null,
    driveOauthEmail: config.driveOauthEmail,
    /** A chave em si NUNCA sai daqui: só que existe, a impressão digital (8 hex) e quando foi gerada e mostrada. */
    hasEncryptionKey: Boolean(config.encryptionKeyEnc),
    encryptionKeyFingerprint: config.encryptionKeyFingerprint,
    encryptionKeyCreatedAt: config.encryptionKeyCreatedAt?.toISOString() ?? null,
    encryptionKeyShownAt: config.encryptionKeyShownAt?.toISOString() ?? null,
    updatedAt: config.updatedAt.toISOString(),
  };
}

export type BackupConfigView = ReturnType<typeof configForPanel>;

export type BackupConfigInput = {
  enabled?: boolean;
  hourLocal?: number;
  retentionDays?: number;
  alertAfterHours?: number;
  destination?: BackupDestination | null;
  driveMode?: "SERVICE_ACCOUNT" | "OAUTH";
  s3Endpoint?: string | null;
  s3Bucket?: string | null;
  s3Region?: string | null;
  s3Prefix?: string | null;
  s3AccessKey?: string | null;
  /** Vazio ou ausente MANTÉM o que está salvo (senão salvar outro campo apagaria a chave sem ninguém notar). */
  s3SecretKey?: string;
  driveFolderId?: string | null;
  /** Conteúdo inteiro do arquivo de chave. Vazio ou ausente mantém. */
  driveServiceAccountKey?: string;
  driveOauthClientId?: string | null;
  driveOauthClientSecret?: string;
};

type ConfigUpdate = Record<string, unknown>;

/** Salva a configuração. Valida o estado FUTURO antes de gravar: ligar o automático sem destino completo é recusado. */
export async function saveBackupConfig(input: BackupConfigInput, adminId: string): Promise<{ config: BackupConfigView; wasEnabled: boolean }> {
  const current = await loadBackupConfig();
  const data: ConfigUpdate = { updatedById: adminId };

  for (const key of ["enabled", "hourLocal", "retentionDays", "alertAfterHours", "destination", "driveMode", "s3Endpoint", "s3Bucket", "s3Region", "s3Prefix", "s3AccessKey"] as const) {
    if (input[key] !== undefined) data[key] = input[key];
  }
  if (input.s3SecretKey) data.s3SecretKeyEnc = encryptSecret(input.s3SecretKey);
  // Endereço do bucket: https, sem IP privado/loopback/link-local (o DNS é conferido na hora de testar e de copiar).
  if (typeof input.s3Endpoint === "string" && input.s3Endpoint.trim() !== "") {
    const shape = checkS3EndpointShape(input.s3Endpoint);
    if (!shape.ok) throw new DomainError("BACKUP_S3_ENDPOINT_INVALID", shape.message);
  }

  // Pasta do Drive: aceita id ou URL. Recusar aqui é o único momento em que dá para avisar; um id
  // errado só apareceria de madrugada, como "pasta inacessível".
  let futureFolder = current.driveFolderId;
  if (input.driveFolderId !== undefined) {
    if (input.driveFolderId === null || input.driveFolderId.trim() === "") {
      data.driveFolderId = null;
      futureFolder = null;
    } else {
      const id = normalizeFolderId(input.driveFolderId);
      if (!id) {
        throw new DomainError("DRIVE_FOLDER_INVALID", "Não reconheci a pasta do Google Drive. Cole o id da pasta ou o link dela (https://drive.google.com/drive/folders/...).");
      }
      data.driveFolderId = id;
      futureFolder = id;
    }
  }

  // A chave da conta de serviço é validada ANTES de gravar e nunca é ecoada em erro.
  let futureServiceAccount = current.driveServiceAccountEnc;
  if (input.driveServiceAccountKey) {
    try {
      const cred = parseServiceAccountKey(input.driveServiceAccountKey);
      data.driveServiceAccountEnc = encryptSecret(input.driveServiceAccountKey);
      data.driveClientEmail = cred.clientEmail;
      futureServiceAccount = "preenchido";
    } catch (error) {
      if (error instanceof DriveFailure) throw new DomainError("DRIVE_CREDENTIAL_INVALID", error.message);
      throw error;
    }
  }

  // Trocar o Client ID invalida a conexão anterior: o escopo `drive.file` só enxerga o que o app que
  // criou o arquivo vê, e "app" aqui é o projeto do Google Cloud. Só o Secret pode girar sozinho.
  let futureOauthConnectedAt = current.driveOauthConnectedAt;
  let futureOauthFolder = current.driveOauthFolderId;
  let futureOauthRefresh = current.driveOauthRefreshTokenEnc;
  if (input.driveOauthClientId !== undefined) {
    const clientId = input.driveOauthClientId?.trim() ? input.driveOauthClientId.trim() : null;
    if (clientId !== current.driveOauthClientId) {
      Object.assign(data, { driveOauthRefreshTokenEnc: null, driveOauthConnectedAt: null, driveOauthEmail: null, driveOauthFolderId: null, driveOauthConnectedById: null });
      futureOauthConnectedAt = null;
      futureOauthFolder = null;
      futureOauthRefresh = null;
    }
    data.driveOauthClientId = clientId;
  }
  if (input.driveOauthClientSecret) data.driveOauthClientSecretEnc = encryptSecret(input.driveOauthClientSecret);

  const future = {
    ...current,
    ...(data as Partial<BackupConfigRow>),
    s3SecretKeyEnc: input.s3SecretKey ? "preenchido" : current.s3SecretKeyEnc,
    driveFolderId: futureFolder,
    driveServiceAccountEnc: futureServiceAccount,
    driveOauthConnectedAt: futureOauthConnectedAt,
    driveOauthFolderId: futureOauthFolder,
    driveOauthRefreshTokenEnc: futureOauthRefresh,
  };
  if (future.enabled && !activeDestination(future)) {
    throw new DomainError(
      "BACKUP_DESTINATION_MISSING",
      "Escolha o destino e complete os dados antes de ligar o backup automático. S3: endereço, bucket, chave de acesso e segredo. Google Drive: a chave da conta de serviço e a pasta, ou então Conectar com Google. Uma cópia que fica no mesmo servidor do banco morre junto com ele.",
    );
  }

  // Backup que sai do servidor sai cifrado, e cifrar exige a chave que o dono guardou. Ligar sem ela
  // faria o primeiro backup agendado falhar de madrugada.
  if (future.enabled && !current.encryptionKeyEnc) {
    throw new DomainError("BACKUP_KEY_MISSING", "Gere a chave de criptografia antes de ligar o backup automático. Sem ela as cópias não saem do servidor, e é ela que você guarda para conseguir abri-las depois.");
  }

  const saved = await getPrisma().backupConfig.update({ where: { id: 1 }, data });
  return { config: configForPanel(saved), wasEnabled: current.enabled };
}

// ---------------------------------------------------------------------------------------------
// Chave de criptografia do backup
// ---------------------------------------------------------------------------------------------

export type GeneratedBackupKey = {
  /** A chave inteira, no formato de 8 grupos. É a ÚNICA vez em que ela sai do servidor. */
  key: string;
  fingerprint: string;
  fileName: string;
  fileText: string;
  replaced: boolean;
};

/**
 * Gera a chave própria do backup (32 bytes aleatórios, independente do AUTH_SECRET), guarda-a cifrada
 * com `src/lib/crypto.ts` e a devolve UMA vez para a tela mostrar. Trocar uma chave que já existe
 * exige `replace: true` (a tela pede confirmação forte): as cópias antigas continuam precisando da
 * chave antiga, e o sistema NÃO guarda a antiga, então perdê-la é perder aquelas cópias.
 */
export async function generateBackupEncryptionKey(adminId: string, opts: { replace: boolean }): Promise<GeneratedBackupKey> {
  const prisma = getPrisma();
  const current = await loadBackupConfig();
  if (current.encryptionKeyEnc && !opts.replace) {
    throw new DomainError("BACKUP_KEY_EXISTS", "Já existe uma chave de backup. Para trocar, use Gerar nova chave e confirme.");
  }
  const key = generateBackupKey();
  const fingerprint = keyFingerprint(key);
  const now = new Date();
  // Só troca se ninguém trocou no meio: dois cliques ou duas pessoas não geram duas chaves e mostram só uma.
  const claimed = await prisma.backupConfig.updateMany({
    where: { id: 1, encryptionKeyFingerprint: current.encryptionKeyFingerprint },
    data: {
      encryptionKeyEnc: encryptSecret(key.toString("hex")),
      encryptionKeyFingerprint: fingerprint,
      encryptionKeyCreatedAt: now,
      encryptionKeyShownAt: now,
      updatedById: adminId,
    },
  });
  if (claimed.count !== 1) throw new DomainError("BACKUP_KEY_CHANGED", "A chave acabou de ser gerada por outra pessoa. Recarregue a tela para ver a impressão digital atual.");

  const replaced = Boolean(current.encryptionKeyEnc);
  logger.info("backup.key.generated", { adminId, replaced });
  const admin = await prisma.user.findUnique({ where: { id: adminId }, select: { name: true, email: true } });
  const adminUrl = await tryGetPublicBaseUrl().catch(() => null);
  await sendAdminMail(backupKeyChangedMail({ adminName: admin?.name ?? "Um administrador", adminEmail: admin?.email ?? "desconhecido", fingerprint, replaced, adminUrl }));
  return { key: formatBackupKey(key), fingerprint, fileName: `chave-backup-innochat-${fingerprint}.txt`, fileText: backupKeyFileText({ key, createdAt: now }), replaced };
}

/** A chave do backup, decifrada do banco. Lança com a causa clara se não existe ou não decifra (AUTH_SECRET trocado). */
function requireBackupKey(config: BackupConfigRow): { key: Buffer; fingerprint: string } {
  if (!config.encryptionKeyEnc || !config.encryptionKeyFingerprint) {
    throw new BackupError("Falta a chave de criptografia do backup. Abra Admin > Backup, gere a chave e guarde-a fora do servidor. Backup que sai sem cifrar não é aceito.", "KEY");
  }
  const hex = readEncryptedSecret(config.encryptionKeyEnc, "backup.encryptionKey");
  const key = hex ? parseBackupKey(hex) : null;
  if (!key || keyFingerprint(key) !== config.encryptionKeyFingerprint) {
    throw new BackupError(
      "Não consegui ler a chave de criptografia do backup. Se o AUTH_SECRET do ambiente mudou, a chave guardada no sistema não abre mais: use a cópia que você guardou e gere uma nova chave em Admin > Backup.",
      "KEY",
    );
  }
  return { key, fingerprint: config.encryptionKeyFingerprint };
}

// ---------------------------------------------------------------------------------------------
// Segredos e clientes de destino
// ---------------------------------------------------------------------------------------------

function secretOrThrow(enc: string | null, field: string, what: string, code: BackupErrorCode): string {
  const value = readEncryptedSecret(enc, field);
  if (!value) {
    throw new BackupError(`Não consegui ler ${what}. Se o AUTH_SECRET do ambiente mudou, cadastre de novo em Admin > Backup.`, code);
  }
  return value;
}

/** Token getter + pasta do modo ativo do Drive. */
function driveAccess(config: BackupConfigRow): { getToken: TokenGetter; folderId: string } {
  if (config.driveMode === "OAUTH") {
    if (!config.driveOauthRefreshTokenEnc || !config.driveOauthFolderId || !config.driveOauthClientId) {
      throw new BackupError("Não há conta Google conectada. Conecte em Admin > Backup.", "OAUTH_DISCONNECTED");
    }
    const clientSecret = secretOrThrow(config.driveOauthClientSecretEnc, "backup.driveOauthClientSecret", "o segredo do app do Google", "OAUTH_DISCONNECTED");
    const refreshToken = secretOrThrow(config.driveOauthRefreshTokenEnc, "backup.driveOauthRefreshToken", "o acesso da conta Google", "OAUTH_DISCONNECTED");
    return { getToken: oauthTokenGetter({ clientId: config.driveOauthClientId, clientSecret, refreshToken }), folderId: config.driveOauthFolderId };
  }
  if (!config.driveFolderId) throw new BackupError("Não há pasta do Google Drive configurada.", "FOLDER");
  const key = secretOrThrow(config.driveServiceAccountEnc, "backup.driveServiceAccount", "a chave da conta de serviço", "CREDENTIAL");
  return { getToken: serviceAccountTokenGetter(parseServiceAccountKey(key)), folderId: config.driveFolderId };
}

/** Cliente do S3, só depois de conferir o endereço (https, fora de rede interna) com o DNS de agora. */
async function s3Client(config: BackupConfigRow): Promise<S3Client> {
  const refusal = await checkS3EndpointResolved(config.s3Endpoint ?? "");
  if (refusal) throw new BackupError(`Endereço do bucket recusado. ${refusal}`, "CONFIG");
  const secretAccessKey = secretOrThrow(config.s3SecretKeyEnc, "backup.s3SecretKey", "o segredo do bucket", "CREDENTIAL");
  return new S3Client({
    region: config.s3Region || "auto",
    endpoint: config.s3Endpoint!,
    credentials: { accessKeyId: config.s3AccessKey!, secretAccessKey },
    forcePathStyle: true,
    // O lookup validado fecha o DNS rebinding: o IP é conferido na resolução que abre a conexão.
    requestHandler: { httpsAgent: new https.Agent({ keepAlive: true, lookup: createGuardedLookup() as never }) },
  });
}

function s3Prefix(config: BackupConfigRow): string {
  return (config.s3Prefix || "").replace(/^\/+|\/+$/g, "");
}

function s3Key(config: BackupConfigRow, fileName: string): string {
  const prefix = s3Prefix(config);
  return prefix ? `${prefix}/${fileName}` : fileName;
}

/** Traduz o erro do SDK do S3 numa causa que a pessoa consegue agir. */
function s3Failure(error: unknown, doing: string): BackupError {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  // O detalhe cru do SDK fica só no log: ele pode trazer pedaços da resposta do servidor de destino (e, num endereço
  // malicioso, virar canal de leitura de uma rede interna). A tela recebe uma mensagem amigável.
  logger.warn("backup.s3.failed", { doing, errorName: name || "unknown", errorMessage: message.slice(0, 300) });
  if (["InvalidAccessKeyId", "SignatureDoesNotMatch", "AccessDenied", "InvalidToken", "ExpiredToken"].includes(name)) {
    return new BackupError(`${doing}: o bucket recusou a chave (${name}). Confira a chave de acesso, o segredo e se a chave tem permissão de gravar e apagar neste bucket.`, "CREDENTIAL");
  }
  if (name === "NoSuchBucket") return new BackupError(`${doing}: o bucket não existe nesse endereço. Confira o nome do bucket e o endereço.`, "FOLDER");
  return new BackupError(`${doing}: não deu para concluir. Confira o endereço e a região. Se estiver certo, pode ser instabilidade de rede; o detalhe técnico está no log do servidor.`, "NETWORK");
}

async function pruneS3(config: BackupConfigRow, s3: S3Client, keep: string): Promise<number> {
  const prefix = s3Prefix(config);
  const items: Array<{ id: string; createdAt: Date }> = [];
  let token: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: config.s3Bucket!, Prefix: prefix ? `${prefix}/` : undefined, ContinuationToken: token }));
    for (const object of page.Contents ?? []) {
      if (object.Key && object.LastModified && isBackupFileName(object.Key.split("/").pop() ?? "")) items.push({ id: object.Key, createdAt: object.LastModified });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  const victims = decidePrune(items, { retentionDays: config.retentionDays, keep });
  for (let i = 0; i < victims.length; i += 1000) {
    await s3.send(new DeleteObjectsCommand({ Bucket: config.s3Bucket!, Delete: { Objects: victims.slice(i, i + 1000).map((Key) => ({ Key })) } }));
  }
  return victims.length;
}

/** Uma cópia no destino, pronta para baixar. */
export type RemoteBackup = { name: string; createdAt: Date; size: number | null; ref: string; download: (dest: string) => Promise<void> };

/** A cópia mais recente do destino ativo (S3 ou Drive). Lança NO_BACKUP se o destino está vazio. */
async function fetchLatestRemoteBackup(config: BackupConfigRow): Promise<RemoteBackup> {
  const destination = activeDestination(config);
  if (!destination) throw new BackupError("Não há destino completo configurado: não há onde procurar a cópia.", "CONFIG");
  const none = () => new BackupError("O destino ainda não tem nenhuma cópia do backup. Use Fazer backup agora e confira de novo.", "NO_BACKUP");

  if (destination === "S3") {
    const s3 = await s3Client(config);
    const prefix = s3Prefix(config);
    let latest: { key: string; at: Date; size: number | null } | null = null;
    try {
      let token: string | undefined;
      do {
        const page = await s3.send(new ListObjectsV2Command({ Bucket: config.s3Bucket!, Prefix: prefix ? `${prefix}/` : undefined, ContinuationToken: token }));
        for (const o of page.Contents ?? []) {
          if (!o.Key || !o.LastModified || !isBackupFileName(o.Key.split("/").pop() ?? "")) continue;
          if (!latest || o.LastModified > latest.at) latest = { key: o.Key, at: o.LastModified, size: o.Size ?? null };
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    } catch (error) {
      throw s3Failure(error, "Ao procurar a cópia mais recente no bucket");
    }
    if (!latest) throw none();
    const found = latest;
    return {
      name: found.key.split("/").pop() ?? found.key,
      createdAt: found.at,
      size: found.size,
      ref: found.key,
      download: async (dest) => {
        try {
          const res = await s3.send(new GetObjectCommand({ Bucket: config.s3Bucket!, Key: found.key }));
          if (!res.Body) throw new Error("resposta sem corpo");
          await pipeline(res.Body as Readable, createWriteStream(dest, { mode: 0o600 }));
        } catch (error) {
          throw s3Failure(error, "Ao baixar a cópia do bucket");
        }
      },
    };
  }

  const { getToken, folderId } = driveAccess(config);
  const files = (await listDriveDumps(getToken, folderId)).filter((f) => isBackupFileName(f.name));
  if (files.length === 0) throw none();
  const newest = files.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  return { name: newest.name, createdAt: newest.createdAt, size: newest.size, ref: `drive:${newest.id}/${newest.name}`, download: (dest) => downloadDriveFile(getToken, newest.id, dest) };
}

/**
 * Sobe para o Drive e poda o que venceu, NESSA ORDEM: o antigo só é apagado depois que o novo subiu
 * e foi conferido (tamanho e lixeira). A poda que falha não derruba um backup que já está lá.
 */
async function sendToDrive(config: BackupConfigRow, file: string, name: string, size: number): Promise<string> {
  const { getToken, folderId } = driveAccess(config);
  const { fileId } = await uploadDumpToDrive({ getToken, folderId, file, name, size });
  try {
    const existing = await listDriveDumps(getToken, folderId);
    const victims = decidePrune(
      existing.map((f) => ({ id: f.id, createdAt: f.createdAt })),
      { retentionDays: config.retentionDays, keep: fileId },
    );
    const deleted = await deleteDriveFiles(getToken, victims);
    if (deleted > 0) logger.info("backup.drive.pruned", { deleted, retentionDays: config.retentionDays });
  } catch (error) {
    logger.warn("backup.drive.prune_failed", { errorMessage: error instanceof Error ? error.message : String(error) });
  }
  return `drive:${fileId}/${name}`;
}

// ---------------------------------------------------------------------------------------------
// Dump
// ---------------------------------------------------------------------------------------------

export type CommandRunner = (command: string, args: string[], env: Record<string, string>) => Promise<string>;

/** `shell: false`: nada que venha da configuração vira comando. Erro inclui o stderr, onde o Postgres explica. */
const runCommand: CommandRunner = (command, args, env) =>
  new Promise((resolve, reject) => {
    const proc = spawn(command, args, { env: { ...process.env, ...env } });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", (e) => reject(new BackupError(`Não consegui executar ${command}: ${e.message}. A imagem do sistema precisa do cliente do PostgreSQL instalado.`, "DUMP")));
    proc.on("close", (code) => (code === 0 ? resolve(out) : reject(new BackupError(`${command} falhou (código ${code}): ${err.trim().slice(0, 800)}`, "DUMP"))));
  });

async function assertPgClientCompatible(exec: CommandRunner, env: Record<string, string>): Promise<void> {
  const [clientOut, serverRows] = await Promise.all([
    exec("pg_dump", ["--version"], env),
    getPrisma().$queryRaw<Array<{ v: string }>>`SELECT current_setting('server_version_num') AS v`,
  ]);
  const client = parsePgDumpMajor(clientOut);
  if (client === null) throw new BackupError(`Não consegui ler a versão do pg_dump: "${clientOut.trim().slice(0, 100)}".`, "DUMP");
  const server = Math.floor(Number(serverRows[0]?.v ?? 0) / 10000);
  const problem = pgVersionProblem(client, server);
  if (problem) throw new BackupError(problem, "DUMP");
}

// ---------------------------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------------------------

export type BackupTrigger = "SCHEDULED" | "MANUAL";

export type BackupResult = {
  runId: string;
  sizeBytes: number;
  tablesWithData: number;
  /** Chave no destino, ou `null` se o dump não saiu do servidor (vale como teste, não como backup). */
  objectKey: string | null;
  destination: BackupDestination | null;
};

export type RunBackupDeps = {
  exec?: CommandRunner;
  now?: () => Date;
  /** Só para teste: troca o envio ao destino (S3/Drive) e devolve a chave do objeto. Recebe o arquivo JÁ cifrado. */
  send?: (item: { file: string; name: string; size: number }) => Promise<string>;
  /** Só para teste: troca a busca da cópia mais recente, usada pela conferência semanal do agendador. */
  fetchLatest?: VerifyDeps["fetchLatest"];
};

/** Trava por UPDATE condicional: quem muda a linha é o dono da execução. Trava velha é considerada abandonada. */
async function acquireLock(now: Date): Promise<boolean> {
  const expired = new Date(now.getTime() - LOCK_EXPIRES_MS);
  const result = await getPrisma().backupConfig.updateMany({
    where: { id: 1, OR: [{ runningSince: null }, { runningSince: { lt: expired } }] },
    data: { runningSince: now, lastAttemptAt: now },
  });
  return result.count === 1;
}

async function releaseLock(): Promise<void> {
  await getPrisma()
    .backupConfig.update({ where: { id: 1 }, data: { runningSince: null } })
    .catch((error) => logger.error("backup.release_lock_failed", { errorMessage: error instanceof Error ? error.message : String(error) }));
}

/** Apaga qualquer pedaço da DATABASE_URL (usuário e senha) de uma mensagem antes de guardar ou mostrar. */
function scrub(message: string, databaseUrl: string): string {
  let out = message;
  try {
    const url = new URL(databaseUrl);
    for (const secret of [url.password, decodeURIComponent(url.password)]) if (secret) out = out.split(secret).join("[senha]");
  } catch {
    // URL inválida já foi recusada antes.
  }
  return out.slice(0, 2000);
}

/**
 * Faz o backup: dumpa, confere, envia ao destino e poda o que venceu. Em qualquer desfecho a linha
 * de `BackupRun` fica gravada: o histórico existe para mostrar o que falhou, não só o que deu certo.
 *
 * Sem destino configurado a execução MANUAL ainda vale: dumpa, confere e descarta (prova que o
 * `pg_dump` funciona). O AGENDADOR se recusa a rodar sem destino: dump que fica no container morre
 * no próximo deploy, e é a falsa segurança que este módulo existe para evitar.
 */
export async function runBackup(opts: { trigger: BackupTrigger; createdById?: string | null }, deps: RunBackupDeps = {}): Promise<BackupResult> {
  const exec = deps.exec ?? runCommand;
  const now = (deps.now ?? (() => new Date()))();
  const config = await loadBackupConfig();
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new BackupError("DATABASE_URL não está definida: não há o que copiar.", "CONFIG");

  const destination = activeDestination(config);
  if (opts.trigger === "SCHEDULED" && !destination) {
    throw new BackupError("Backup agendado sem destino completo. Uma cópia que fica no servidor não é backup.", "CONFIG");
  }
  if (!(await acquireLock(now))) throw new BackupError("Já existe um backup em andamento.", "BUSY");

  const prisma = getPrisma();
  const run = await prisma.backupRun.create({
    data: { trigger: opts.trigger, status: "RUNNING", destination, startedAt: now, createdById: opts.createdById ?? null },
  });

  const fileName = backupFileName(now);
  // Dump com tudo da plataforma: pasta própria 0700 e arquivo 0600 (em /tmp o padrão seria legível por outros usuários).
  // A pasta inteira some no `finally`. (Em Windows o modo é ignorado; produção é Linux.)
  let workDir: string | null = null;
  let file = "";

  try {
    // Cópia que sai do servidor sai CIFRADA: sem a chave, nem começa (a falha fica no histórico e avisa por e-mail).
    const encryption = destination ? requireBackupKey(config) : null;
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "innochat-backup-"));
    await fs.chmod(workDir, 0o700);
    file = path.join(workDir, `${randomUUID()}-${fileName}`);
    await fs.writeFile(file, "", { mode: 0o600 });
    const env = pgEnvFromUrl(databaseUrl);
    await assertPgClientCompatible(exec, env);

    // --no-owner/--no-privileges: o dump precisa voltar num banco novo, com outro usuário dono; sem
    // isso a restauração de emergência falha por causa de um papel que não existe lá.
    // Formato custom (-Fc): já comprimido e permite restaurar UMA tabela.
    await exec("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", `--file=${file}`], env);

    // Um dump truncado (disco cheio, conexão caída) existe, tem tamanho e não serve para nada.
    // Ler o índice custa um segundo e evita descobrir isso durante um incidente.
    const tables = countTablesWithData(await exec("pg_restore", ["--list", file], env));
    if (tables === 0) throw new BackupError("O dump não tem nenhuma tabela com dados. Confira se a DATABASE_URL aponta para o banco certo.", "DUMP");
    const dumpSize = (await fs.stat(file)).size;

    // O que sobe é o arquivo cifrado (AES-256-GCM em fluxo, `backup-crypto.ts`); o dump em claro some junto com a pasta temporária.
    let sendFile = file;
    let sendName = fileName;
    let size = dumpSize;
    if (encryption) {
      sendFile = `${file}.enc`;
      sendName = encryptedBackupFileName(fileName);
      await encryptFile(file, sendFile, encryption.key);
      size = (await fs.stat(sendFile)).size;
    }

    let objectKey: string | null = null;
    if (destination && deps.send) {
      objectKey = await deps.send({ file: sendFile, name: sendName, size });
    } else if (destination === "S3") {
      const s3 = await s3Client(config);
      objectKey = s3Key(config, sendName);
      try {
        // Stream, não Buffer: um dump de 2 GB na memória derruba o container.
        await s3.send(new PutObjectCommand({ Bucket: config.s3Bucket!, Key: objectKey, Body: createReadStream(sendFile), ContentLength: size, ContentType: "application/octet-stream" }));
      } catch (error) {
        throw s3Failure(error, "Ao enviar o dump para o bucket");
      }
      try {
        const deleted = await pruneS3(config, s3, objectKey);
        if (deleted > 0) logger.info("backup.s3.pruned", { deleted, retentionDays: config.retentionDays });
      } catch (error) {
        // Sobrar dump velho é problema de espaço; marcar a execução inteira como falha esconderia um backup íntegro.
        logger.warn("backup.s3.prune_failed", { errorMessage: error instanceof Error ? error.message : String(error) });
      }
    } else if (destination === "DRIVE") {
      objectKey = await sendToDrive(config, sendFile, sendName, size);
    }

    await prisma.$transaction([
      prisma.backupRun.update({
        where: { id: run.id },
        data: { status: "SUCCESS", finishedAt: new Date(), sizeBytes: BigInt(size), tablesWithData: tables, objectKey, encryptionKeyFingerprint: encryption?.fingerprint ?? null },
      }),
      // `lastSuccessAt` só avança quando o dump SAIU do servidor: o alerta de atraso depende dele, e
      // um teste manual sem destino não pode calar o alerta.
      ...(objectKey ? [prisma.backupConfig.update({ where: { id: 1 }, data: { lastSuccessAt: new Date() } })] : []),
    ]);
    logger.info("backup.completed", { runId: run.id, bytes: size, tables, destination, encrypted: encryption !== null });
    return { runId: run.id, sizeBytes: size, tablesWithData: tables, objectKey, destination };
  } catch (raw) {
    const error = asBackupError(raw);
    const detail = scrub(error.message, databaseUrl);
    await prisma.backupRun
      .update({ where: { id: run.id }, data: { status: "FAILED", finishedAt: new Date(), errorCode: error.code, errorDetail: detail } })
      .catch((e) => logger.error("backup.record_failure_failed", { errorMessage: e instanceof Error ? e.message : String(e) }));
    logger.error("backup.failed", { runId: run.id, code: error.code });
    // Backup agendado que falha é exatamente o caso em que ninguém está olhando.
    if (opts.trigger === "SCHEDULED") {
      const adminUrl = await tryGetPublicBaseUrl().catch(() => null);
      await sendAdminMail(failureMail({ code: error.code, detail, destination, adminUrl }));
    }
    throw new BackupError(detail, error.code);
  } finally {
    // Sempre: a trava presa impediria todo backup seguinte, e o arquivo temporário enche o disco do container.
    await releaseLock();
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Conferir backup
// ---------------------------------------------------------------------------------------------

export type VerifyDeps = {
  exec?: CommandRunner;
  now?: () => Date;
  /** Para teste: troca a busca da cópia no destino (S3/Drive). */
  fetchLatest?: (config: BackupConfigRow) => Promise<RemoteBackup>;
};

export type VerifyResult = {
  runId: string;
  fileName: string;
  fileCreatedAt: string;
  encrypted: boolean;
  keyFingerprint: string | null;
  sizeBytes: number;
  tablesWithData: number;
};

/** Traduz a falha de cifra em erro de backup com a causa que a pessoa consegue agir. */
function cryptoToBackupError(error: unknown): BackupError {
  if (error instanceof BackupCryptoError) {
    if (error.code === "WRONG_KEY" || error.code === "BAD_KEY") return new BackupError(error.message, "KEY");
    return new BackupError(error.message, "VERIFY");
  }
  return asBackupError(error);
}

/**
 * Prova que a cópia MAIS RECENTE do destino abre: baixa, decifra em fluxo (a tag de autenticação só
 * confere no fim, e o resultado só vale depois disso) e roda `pg_restore --list` no dump. NÃO escreve
 * em banco nenhum: o que a conferência garante é que o arquivo é íntegro e legível com a chave que o
 * sistema tem; que ele restaura num banco novo é o que o job `backup-restore` do CI prova a cada push.
 * Fica no histórico como `VERIFY` (não conta como backup: não mexe em `lastSuccessAt`).
 */
export async function verifyLatestBackup(opts: { trigger: "MANUAL" | "SCHEDULED"; createdById?: string | null }, deps: VerifyDeps = {}): Promise<VerifyResult> {
  const exec = deps.exec ?? runCommand;
  const now = (deps.now ?? (() => new Date()))();
  const prisma = getPrisma();
  const config = await loadBackupConfig();
  const destination = activeDestination(config);
  if (!destination) throw new BackupError("Escolha e complete o destino antes de conferir: é lá que a cópia está.", "CONFIG");

  const running = await prisma.backupRun.findFirst({ where: { trigger: "VERIFY", status: "RUNNING", startedAt: { gt: new Date(now.getTime() - VERIFY_STALE_MS) } }, select: { id: true } });
  if (running) throw new BackupError("Já existe uma conferência em andamento.", "BUSY");

  const run = await prisma.backupRun.create({ data: { trigger: "VERIFY", status: "RUNNING", destination, startedAt: now, createdById: opts.createdById ?? null } });
  let workDir: string | null = null;
  try {
    const remote = await (deps.fetchLatest ?? fetchLatestRemoteBackup)(config);
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "innochat-verify-"));
    await fs.chmod(workDir, 0o700);
    const downloaded = path.join(workDir, `${randomUUID()}.download`);
    await remote.download(downloaded);
    const size = (await fs.stat(downloaded)).size;
    if (size === 0) throw new BackupError(`A cópia "${remote.name}" chegou vazia do destino.`, "VERIFY");

    // Cifrada ou não é decidido pelo CABEÇALHO do arquivo, não pelo nome: backups de antes da cifra continuam conferíveis.
    const fileFingerprint = await readBackupFileFingerprint(downloaded);
    let dump = downloaded;
    let usedFingerprint: string | null = null;
    if (fileFingerprint !== null) {
      const { key, fingerprint } = requireBackupKey(config);
      if (fileFingerprint !== fingerprint) {
        throw new BackupError(
          `A cópia "${remote.name}" foi cifrada com a chave de impressão digital ${fileFingerprint}, mas a chave atual do sistema é a ${fingerprint}. Se você gerou uma chave nova depois dessa cópia, ela só abre com a chave antiga. Faça um backup novo e confira de novo.`,
          "KEY",
        );
      }
      dump = path.join(workDir, `${randomUUID()}.dump`);
      try {
        await decryptFile(downloaded, dump, key);
      } catch (error) {
        throw cryptoToBackupError(error);
      }
      usedFingerprint = fingerprint;
    } else if (remote.name.endsWith(".enc")) {
      throw new BackupError(`A cópia "${remote.name}" deveria estar cifrada, mas não tem a marca do formato. Ela está corrompida ou foi trocada.`, "VERIFY");
    } else if (config.encryptionKeyEnc) {
      // Já existe chave: toda cópia nova nasce cifrada. Uma cópia mais recente SEM a marca pode ser um arquivo trocado no destino
      // (um dump forjado executa SQL no restore), então não passa como "cópia antiga".
      throw new BackupError(
        `A cópia "${remote.name}" não está cifrada, mas o backup deste sistema já usa chave. Pode ser um arquivo trocado no destino. Não restaure essa cópia: faça um backup novo agora e confira de novo.`,
        "VERIFY",
      );
    }

    const tables = countTablesWithData(await exec("pg_restore", ["--list", dump], {}));
    if (tables === 0) throw new BackupError("O dump abriu, mas o índice dele não lista nenhuma tabela com dados. Esta cópia não serve.", "VERIFY");

    await prisma.backupRun.update({
      where: { id: run.id },
      data: { status: "SUCCESS", finishedAt: new Date(), sizeBytes: BigInt(size), tablesWithData: tables, objectKey: remote.ref, encryptionKeyFingerprint: usedFingerprint },
    });
    logger.info("backup.verify.ok", { runId: run.id, bytes: size, tables, encrypted: usedFingerprint !== null });
    return { runId: run.id, fileName: remote.name, fileCreatedAt: remote.createdAt.toISOString(), encrypted: usedFingerprint !== null, keyFingerprint: usedFingerprint, sizeBytes: size, tablesWithData: tables };
  } catch (raw) {
    const error = asBackupError(raw);
    const detail = scrub(error.message, process.env.DATABASE_URL ?? "");
    await prisma.backupRun
      .update({ where: { id: run.id }, data: { status: "FAILED", finishedAt: new Date(), errorCode: error.code, errorDetail: detail } })
      .catch((e) => logger.error("backup.verify.record_failure_failed", { errorMessage: e instanceof Error ? e.message : String(e) }));
    logger.error("backup.verify.failed", { runId: run.id, code: error.code });
    if (opts.trigger === "SCHEDULED") {
      const adminUrl = await tryGetPublicBaseUrl().catch(() => null);
      await sendAdminMail(verifyFailureMail({ detail, adminUrl }));
    }
    throw new BackupError(detail, error.code);
  } finally {
    if (workDir) await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Alertas
// ---------------------------------------------------------------------------------------------

/** Admins da plataforma; sem nenhum, o e-mail de contato dos Dados da empresa. */
async function adminRecipients(): Promise<string[]> {
  const prisma = getPrisma();
  const admins = await prisma.user.findMany({ where: { isPlatformAdmin: true }, orderBy: { createdAt: "asc" }, take: 5, select: { email: true } });
  const emails = admins.map((a) => a.email).filter((e): e is string => typeof e === "string" && e.includes("@"));
  if (emails.length > 0) return [...new Set(emails)];
  const settings = await prisma.platformSettings.findUnique({ where: { id: 1 }, select: { contactEmail: true } });
  return settings?.contactEmail?.includes("@") ? [settings.contactEmail] : [];
}

/** Nunca lança: aviso que falha não pode derrubar o backup nem o tick. Devolve quantos e-mails saíram. */
export async function sendAdminMail(mail: AlertMail, deps: { send?: typeof sendMail } = {}): Promise<number> {
  try {
    const recipients = await adminRecipients();
    if (recipients.length === 0) {
      logger.warn("backup.alert.no_recipient", {});
      return 0;
    }
    const send = deps.send ?? sendMail;
    let delivered = 0;
    for (const to of recipients) {
      try {
        const result = await send({ to, ...mail });
        if (result.sent) delivered += 1;
      } catch (error) {
        logger.warn("backup.alert.send_failed", { errorName: error instanceof Error ? error.name : "unknown" });
      }
    }
    return delivered;
  } catch (error) {
    logger.warn("backup.alert.error", { errorName: error instanceof Error ? error.name : "unknown" });
    return 0;
  }
}

export type LateCheck = LateStatus & { emailed: boolean };

/**
 * Confere se o backup está atrasado e, se estiver, manda e-mail ao admin, no máximo 1 a cada 12 h
 * (`lastLateAlertAt`, reserva atômica no banco: dois disparos simultâneos nunca mandam dois e-mails).
 * Se o envio falhar, a reserva é devolvida para tentar de novo na próxima passada.
 */
export async function checkBackupLate(now: Date = new Date(), deps: { send?: typeof sendMail } = {}): Promise<LateCheck> {
  const config = await loadBackupConfig();
  const status = lateStatus(config, now, config.updatedAt);
  if (!status.late) return { ...status, emailed: false };

  const prisma = getPrisma();
  const cutoff = new Date(now.getTime() - LATE_ALERT_INTERVAL_MS);
  const claimed = await prisma.backupConfig.updateMany({
    where: { id: 1, OR: [{ lastLateAlertAt: null }, { lastLateAlertAt: { lt: cutoff } }] },
    data: { lastLateAlertAt: now },
  });
  if (claimed.count !== 1) return { ...status, emailed: false };

  const adminUrl = await tryGetPublicBaseUrl().catch(() => null);
  const delivered = await sendAdminMail(lateMail({ status, alertAfterHours: config.alertAfterHours, adminUrl }), deps);
  if (delivered === 0) {
    await prisma.backupConfig.updateMany({ where: { id: 1, lastLateAlertAt: now }, data: { lastLateAlertAt: new Date(now.getTime() - LATE_ALERT_INTERVAL_MS + 30 * 60_000) } });
  }
  return { ...status, emailed: delivered > 0 };
}

// ---------------------------------------------------------------------------------------------
// Agendador
// ---------------------------------------------------------------------------------------------

export type BackupTickSummary = { ran: boolean; ok: boolean | null; late: boolean; staleRunsClosed: number; verified: boolean | null };

/** Fecha como FALHA as execuções que ficaram RUNNING além da trava (o processo morreu no meio do dump). */
async function closeStaleRuns(now: Date): Promise<number> {
  const result = await getPrisma().backupRun.updateMany({
    where: { status: "RUNNING", startedAt: { lt: new Date(now.getTime() - LOCK_EXPIRES_MS) } },
    data: { status: "FAILED", finishedAt: now, errorCode: "UNKNOWN", errorDetail: "A execução foi interrompida (o sistema reiniciou ou parou no meio da cópia)." },
  });
  return result.count;
}

/**
 * Uma passada do agendador: roda o backup se for a hora (Brasília) e ainda não houve tentativa nas
 * últimas ~20 h, e confere o atraso. Chamada de 10 em 10 minutos pelo timer do processo e, se o cron
 * externo quiser, por `POST /api/internal/v1/backup/tick`. Nunca lança.
 */
export async function runBackupTick(now: Date = new Date(), deps: RunBackupDeps = {}): Promise<BackupTickSummary> {
  const summary: BackupTickSummary = { ran: false, ok: null, late: false, staleRunsClosed: 0, verified: null };
  try {
    summary.staleRunsClosed = await closeStaleRuns(now);
    const config = await loadBackupConfig();
    const lastScheduled = await getPrisma().backupRun.findFirst({ where: { trigger: "SCHEDULED" }, orderBy: { startedAt: "desc" }, select: { startedAt: true } });
    if (isDue(config, now, lastScheduled?.startedAt ?? null)) {
      summary.ran = true;
      try {
        await runBackup({ trigger: "SCHEDULED" }, { ...deps, now: () => now });
        summary.ok = true;
      } catch (error) {
        // `runBackup` já gravou o histórico e avisou; aqui só impedimos a exceção de matar o timer.
        summary.ok = false;
        logger.error("backup.tick.run_failed", { code: error instanceof BackupError ? error.code : "UNKNOWN" });
      }
    }
    summary.late = (await checkBackupLate(now)).late;

    // Conferência semanal da cópia mais recente: baixa, decifra e lê o índice. Só com o automático
    // ligado, destino completo, chave e pelo menos uma cópia já enviada, e nunca na mesma passada do backup.
    if (!summary.ran && config.enabled && config.lastSuccessAt && config.encryptionKeyEnc && activeDestination(config)) {
      const last = await getPrisma().backupRun.findFirst({ where: { trigger: "VERIFY" }, orderBy: { startedAt: "desc" }, select: { startedAt: true } });
      if (isVerifyDue(last?.startedAt ?? null, now)) {
        try {
          await verifyLatestBackup({ trigger: "SCHEDULED" }, { exec: deps.exec, now: () => now, fetchLatest: deps.fetchLatest });
          summary.verified = true;
        } catch (error) {
          // `verifyLatestBackup` já gravou o histórico e avisou.
          summary.verified = false;
          logger.error("backup.tick.verify_failed", { code: error instanceof BackupError ? error.code : "UNKNOWN" });
        }
      }
    }
  } catch (error) {
    logger.error("backup.tick.error", { errorMessage: error instanceof Error ? error.message : String(error) });
  }
  return summary;
}

export const BACKUP_TICK_INTERVAL_MS = 10 * 60 * 1000;

/** Inicia o timer do processo (uma vez, mesmo com hot reload). `unref` para não segurar o desligamento. */
export function startBackupScheduler(intervalMs: number = BACKUP_TICK_INTERVAL_MS): NodeJS.Timeout | null {
  const g = globalThis as { __innochatBackupTimer__?: NodeJS.Timeout };
  if (g.__innochatBackupTimer__) return null;
  const timer = setInterval(() => void runBackupTick(), intervalMs);
  timer.unref?.();
  g.__innochatBackupTimer__ = timer;
  return timer;
}

// ---------------------------------------------------------------------------------------------
// Testar conexão
// ---------------------------------------------------------------------------------------------

export type ConnectionTestResult = { ok: true; message: string };

/**
 * Prova o destino sem mexer nos backups: no S3 grava e apaga um arquivinho de teste (prova gravar E
 * apagar, que é o que a retenção precisa); no Drive pede acesso e abre a pasta. Falha vira erro de
 * domínio com a causa e o que fazer.
 */
export async function testBackupConnection(): Promise<ConnectionTestResult> {
  const config = await loadBackupConfig();
  const destination = activeDestination(config);
  if (!destination) {
    throw new DomainError("BACKUP_DESTINATION_MISSING", "Escolha o destino e preencha os dados dele antes de testar. Salve a configuração e teste de novo.");
  }
  try {
    if (destination === "S3") {
      const s3 = await s3Client(config);
      const key = s3Key(config, `.teste-conexao-${randomUUID().slice(0, 8)}.tmp`);
      try {
        await s3.send(new PutObjectCommand({ Bucket: config.s3Bucket!, Key: key, Body: "teste de conexão do InnoChat", ContentType: "text/plain" }));
        await s3.send(new DeleteObjectCommand({ Bucket: config.s3Bucket!, Key: key }));
      } catch (error) {
        throw s3Failure(error, "Ao testar o bucket");
      }
      return { ok: true, message: `O bucket "${config.s3Bucket}" aceitou gravar e apagar um arquivo de teste.` };
    }
    const { getToken, folderId } = driveAccess(config);
    await checkDriveFolder(getToken, folderId);
    return { ok: true, message: "O Google aceitou o acesso e a pasta está pronta para receber os backups." };
  } catch (error) {
    const failure = asBackupError(error);
    throw new DomainError(`BACKUP_${failure.code}`, failure.message);
  }
}

// ---------------------------------------------------------------------------------------------
// Histórico e painel
// ---------------------------------------------------------------------------------------------

export type BackupRunView = {
  id: string;
  status: "RUNNING" | "SUCCESS" | "FAILED";
  trigger: "SCHEDULED" | "MANUAL" | "VERIFY";
  destination: BackupDestination | null;
  startedAt: string;
  finishedAt: string | null;
  sizeBytes: number | null;
  tablesWithData: number | null;
  objectKey: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  /** Impressão digital da chave da cópia (nulo = não cifrada). */
  keyFingerprint: string | null;
};

export async function listBackupRuns(input: { page?: number; pageSize?: PageSize } = {}): Promise<{ items: BackupRunView[] } & PageInfo> {
  const prisma = getPrisma();
  const pageSize = input.pageSize ?? 10;
  const total = await prisma.backupRun.count();
  const paging = resolvePage(input.page, pageSize, total);
  const rows = await prisma.backupRun.findMany({ orderBy: { startedAt: "desc" }, skip: paging.skip, take: pageSize });
  return {
    items: rows.map((r) => ({
      id: r.id,
      status: r.status as BackupRunView["status"],
      trigger: r.trigger as BackupRunView["trigger"],
      destination: r.destination as BackupDestination | null,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      sizeBytes: r.sizeBytes === null ? null : Number(r.sizeBytes),
      tablesWithData: r.tablesWithData,
      objectKey: r.objectKey,
      errorCode: r.errorCode,
      errorDetail: r.errorDetail,
      keyFingerprint: r.encryptionKeyFingerprint,
    })),
    ...pageInfoOf(paging),
  };
}

export type BackupStatusView = {
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  running: boolean;
  late: boolean;
  never: boolean;
  ageHours: number | null;
  /** Próxima execução agendada (Brasília), ISO. `null` com o automático desligado. */
  nextRunAt: string | null;
};

/** Próximo instante em que `hourLocal` (Brasília) acontece depois de `now`. */
export function nextScheduledRun(hourLocal: number, now: Date): Date {
  const targetUtcHour = (hourLocal + 3) % 24;
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), targetUtcHour, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

export async function getBackupStatus(now: Date = new Date()): Promise<BackupStatusView> {
  const config = await loadBackupConfig();
  const status = lateStatus(config, now, config.updatedAt);
  return {
    lastSuccessAt: config.lastSuccessAt?.toISOString() ?? null,
    lastAttemptAt: config.lastAttemptAt?.toISOString() ?? null,
    running: Boolean(config.runningSince && now.getTime() - config.runningSince.getTime() < LOCK_EXPIRES_MS),
    late: status.late,
    never: status.never && config.enabled,
    ageHours: status.ageHours,
    nextRunAt: config.enabled ? nextScheduledRun(config.hourLocal, now).toISOString() : null,
  };
}

/** Item do sino do Admin (derivado do estado, sem tabela). `null` se não há atraso. */
export async function loadBackupLateNotification(now: Date): Promise<{ id: string; createdAt: Date; body: string } | null> {
  const config = await loadBackupConfig();
  const status = lateStatus(config, now, config.updatedAt);
  if (!status.late || !status.lateSince) return null;
  return {
    id: `bkp:late:${config.lastSuccessAt ? config.lastSuccessAt.getTime() : "never"}`,
    createdAt: status.lateSince,
    body: status.never
      ? `O backup automático está ligado e ainda não enviou nenhuma cópia para fora do servidor. O limite é de ${config.alertAfterHours} horas.`
      : `Faz ${status.ageHours} horas desde a última cópia do banco, e o limite é de ${config.alertAfterHours} horas. Confira o destino na tela de backup.`,
  };
}

// ---------------------------------------------------------------------------------------------
// Conectar com Google (OAuth)
// ---------------------------------------------------------------------------------------------

export async function startGoogleConnection(adminId: string): Promise<{ url: string }> {
  const config = await loadBackupConfig();
  if (!config.driveOauthClientId || !config.driveOauthClientSecretEnc) {
    throw new DomainError("DRIVE_OAUTH_CREDENTIALS_MISSING", "Salve o Client ID e o Client Secret do app do Google antes de conectar.");
  }
  const base = await tryGetPublicBaseUrl();
  if (!base) throw new DomainError("PUBLIC_URL_UNKNOWN", "A URL pública do sistema ainda não está salva. Abra Admin > Configurações uma vez e volte.");
  const { state } = signOAuthState(adminId);
  return { url: buildAuthorizationUrl({ clientId: config.driveOauthClientId, redirectUri: redirectUriFor(base), state }) };
}

/** Reivindica o nonce do `state` (uso único): INSERT único no banco, quem perde a corrida é recusado. */
export async function claimOAuthNonce(state: { nonce: string; adminId: string; exp: number }): Promise<boolean> {
  const prisma = getPrisma();
  await prisma.backupDriveOauthNonce.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  try {
    await prisma.backupDriveOauthNonce.create({ data: { nonce: state.nonce, adminId: state.adminId, expiresAt: new Date(state.exp) } });
    return true;
  } catch {
    return false;
  }
}

export type GoogleCallbackOutcome = { ok: true } | { ok: false; reason: string };

/**
 * Volta do consentimento do Google. `sessionUserId` é o admin logado no navegador (o callback chega
 * por navegação, com o cookie de sessão): o `state` assinado, de uso único, tem de ser dele. Sempre
 * devolve um desfecho (a rota redireciona); os motivos são códigos curtos que a tela traduz, e
 * nunca carregam mensagem crua do Google, código ou token.
 */
export async function completeGoogleConnection(opts: { state: string | null; code: string | null; googleError: string | null; sessionUserId: string | null }): Promise<GoogleCallbackOutcome> {
  const state = opts.state ? verifyOAuthState(opts.state) : null;
  // Ausente, forjado, expirado, de outra pessoa ou reapresentado: o mesmo código para todos, sem pistas a quem forja.
  if (!state || !opts.sessionUserId || state.adminId !== opts.sessionUserId) return { ok: false, reason: "estado_invalido" };
  if (!(await claimOAuthNonce(state))) return { ok: false, reason: "estado_invalido" };

  const prisma = getPrisma();
  const admin = await prisma.user.findUnique({ where: { id: state.adminId }, select: { id: true, name: true, email: true, isPlatformAdmin: true } });
  if (!admin?.isPlatformAdmin) return { ok: false, reason: "estado_invalido" };

  if (opts.googleError) return { ok: false, reason: opts.googleError === "access_denied" ? "acesso_negado" : "recusado_pelo_google" };
  if (!opts.code) return { ok: false, reason: "sem_codigo" };

  const config = await loadBackupConfig();
  if (!config.driveOauthClientId || !config.driveOauthClientSecretEnc) return { ok: false, reason: "credenciais_invalidas" };
  const clientSecret = readEncryptedSecret(config.driveOauthClientSecretEnc, "backup.driveOauthClientSecret");
  if (!clientSecret) return { ok: false, reason: "credenciais_invalidas" };
  const base = await tryGetPublicBaseUrl();
  if (!base) return { ok: false, reason: "url_publica" };

  let tokens;
  try {
    tokens = await exchangeCodeForTokens({ clientId: config.driveOauthClientId, clientSecret, code: opts.code, redirectUri: redirectUriFor(base) });
  } catch (error) {
    const category = error instanceof DriveFailure ? error.category : null;
    logger.error("backup.oauth.exchange_failed", { category });
    return { ok: false, reason: category === "credential" ? "credenciais_invalidas" : (category ?? "desconhecido") };
  }
  // Sem refresh token a conexão morre em uma hora. Melhor recusar do que salvar uma conexão inútil.
  if (!tokens.refreshToken) return { ok: false, reason: "sem_refresh_token" };

  let email: string;
  try {
    email = await fetchAccountEmail(tokens.accessToken);
  } catch {
    return { ok: false, reason: "falha_ao_confirmar_conta" };
  }
  // A pasta é criada uma vez: reconectar reaproveita o id salvo (trocar o Client ID já o zerou).
  let folderId = config.driveOauthFolderId;
  if (!folderId) {
    try {
      folderId = await createBackupFolder(tokens.accessToken);
    } catch {
      return { ok: false, reason: "falha_ao_criar_pasta" };
    }
  }
  await prisma.backupConfig.update({
    where: { id: 1 },
    data: {
      driveOauthRefreshTokenEnc: encryptSecret(tokens.refreshToken),
      driveOauthEmail: email,
      driveOauthFolderId: folderId,
      driveOauthConnectedAt: new Date(),
      driveOauthConnectedById: admin.id,
      updatedById: admin.id,
    },
  });
  logger.info("backup.oauth.connected", { adminId: admin.id });
  // Canal contínuo e silencioso do banco inteiro para o Drive de quem clicou: merece aviso.
  const adminUrl = await tryGetPublicBaseUrl().catch(() => null);
  await sendAdminMail(googleConnectedMail({ adminName: admin.name ?? admin.email, adminEmail: admin.email, previousEmail: config.driveOauthEmail, newEmail: email, adminUrl }));
  return { ok: true };
}

/** Revoga no Google (melhor esforço) e limpa a conexão local. Client ID e Secret ficam, para reconectar sem digitar tudo. */
export async function disconnectGoogle(adminId: string): Promise<void> {
  const config = await loadBackupConfig();
  if (config.driveOauthRefreshTokenEnc) {
    const token = readEncryptedSecret(config.driveOauthRefreshTokenEnc, "backup.driveOauthRefreshToken");
    if (token) await revokeGoogleToken(token);
  }
  await getPrisma().backupConfig.update({
    where: { id: 1 },
    data: { driveOauthRefreshTokenEnc: null, driveOauthEmail: null, driveOauthFolderId: null, driveOauthConnectedAt: null, driveOauthConnectedById: null, updatedById: adminId },
  });
  // Só avisa se havia o que desconectar (clique repetido não manda e-mail à toa).
  if (config.driveOauthEmail) {
    const admin = await getPrisma().user.findUnique({ where: { id: adminId }, select: { name: true, email: true } });
    const adminUrl = await tryGetPublicBaseUrl().catch(() => null);
    await sendAdminMail(googleDisconnectedMail({ adminName: admin?.name ?? "Um administrador", adminEmail: admin?.email ?? "desconhecido", account: config.driveOauthEmail, adminUrl }));
  }
}
