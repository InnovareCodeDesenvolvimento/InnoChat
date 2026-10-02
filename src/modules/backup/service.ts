import { spawn } from "node:child_process";
import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DeleteObjectsCommand, DeleteObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getPrisma } from "@/lib/db/prisma";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { sendMail } from "@/lib/email";
import { tryGetPublicBaseUrl } from "@/lib/public-url";
import { encryptSecret } from "@/lib/crypto";
import { readEncryptedSecret } from "@/modules/platform/secrets";
import { pageInfoOf, resolvePage, type PageInfo, type PageSize } from "@/modules/billing/paging";
import {
  DriveFailure,
  checkDriveFolder,
  deleteDriveFiles,
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
  LATE_ALERT_INTERVAL_MS,
  LOCK_EXPIRES_MS,
  activeDestination,
  backupFileName,
  countTablesWithData,
  decidePrune,
  failureMail,
  googleConnectedMail,
  googleDisconnectedMail,
  isBackupFileName,
  isDue,
  lateMail,
  lateStatus,
  parsePgDumpMajor,
  pgEnvFromUrl,
  pgVersionProblem,
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
 * `driveServiceAccountEnc`, `driveOauthClientSecretEnc` nem `driveOauthRefreshTokenEnc`.
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

  const saved = await getPrisma().backupConfig.update({ where: { id: 1 }, data });
  return { config: configForPanel(saved), wasEnabled: current.enabled };
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

function s3Client(config: BackupConfigRow): S3Client {
  const secretAccessKey = secretOrThrow(config.s3SecretKeyEnc, "backup.s3SecretKey", "o segredo do bucket", "CREDENTIAL");
  return new S3Client({
    region: config.s3Region || "auto",
    endpoint: config.s3Endpoint!,
    credentials: { accessKeyId: config.s3AccessKey!, secretAccessKey },
    forcePathStyle: true,
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
  if (["InvalidAccessKeyId", "SignatureDoesNotMatch", "AccessDenied", "InvalidToken", "ExpiredToken"].includes(name)) {
    return new BackupError(`${doing}: o bucket recusou a chave (${name}). Confira a chave de acesso, o segredo e se a chave tem permissão de gravar e apagar neste bucket.`, "CREDENTIAL");
  }
  if (name === "NoSuchBucket") return new BackupError(`${doing}: o bucket não existe nesse endereço. Confira o nome do bucket e o endereço.`, "FOLDER");
  return new BackupError(`${doing}: ${message.slice(0, 300)}. Confira o endereço e a região. Se estiver certo, pode ser instabilidade de rede.`, "NETWORK");
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

export type RunBackupDeps = { exec?: CommandRunner; now?: () => Date };

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
  const file = path.join(os.tmpdir(), `${randomUUID()}-${fileName}`);

  try {
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
    const { size } = await fs.stat(file);

    let objectKey: string | null = null;
    if (destination === "S3") {
      const s3 = s3Client(config);
      objectKey = s3Key(config, fileName);
      try {
        // Stream, não Buffer: um dump de 2 GB na memória derruba o container.
        await s3.send(new PutObjectCommand({ Bucket: config.s3Bucket!, Key: objectKey, Body: createReadStream(file), ContentLength: size, ContentType: "application/octet-stream" }));
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
      objectKey = await sendToDrive(config, file, fileName, size);
    }

    await prisma.$transaction([
      prisma.backupRun.update({
        where: { id: run.id },
        data: { status: "SUCCESS", finishedAt: new Date(), sizeBytes: BigInt(size), tablesWithData: tables, objectKey },
      }),
      // `lastSuccessAt` só avança quando o dump SAIU do servidor: o alerta de atraso depende dele, e
      // um teste manual sem destino não pode calar o alerta.
      ...(objectKey ? [prisma.backupConfig.update({ where: { id: 1 }, data: { lastSuccessAt: new Date() } })] : []),
    ]);
    logger.info("backup.completed", { runId: run.id, bytes: size, tables, destination });
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
    await fs.unlink(file).catch(() => undefined);
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

export type BackupTickSummary = { ran: boolean; ok: boolean | null; late: boolean; staleRunsClosed: number };

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
  const summary: BackupTickSummary = { ran: false, ok: null, late: false, staleRunsClosed: 0 };
  try {
    summary.staleRunsClosed = await closeStaleRuns(now);
    const config = await loadBackupConfig();
    if (isDue(config, now)) {
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
      const s3 = s3Client(config);
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
  trigger: "SCHEDULED" | "MANUAL";
  destination: BackupDestination | null;
  startedAt: string;
  finishedAt: string | null;
  sizeBytes: number | null;
  tablesWithData: number | null;
  objectKey: string | null;
  errorCode: string | null;
  errorDetail: string | null;
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
