import https from "node:https";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { DomainError } from "@/lib/errors";
import { pageInfoOf, resolvePage, type PageSize } from "@/modules/billing/paging";
import {
  asBackupError,
  driveAccess,
  loadBackupConfig,
  s3Client,
  s3Failure,
  s3Prefix,
  runCommand,
  type BackupConfigRow,
  type CommandRunner,
} from "./service";
import {
  activeDestination,
  countTablesWithData,
  isBackupFileName,
} from "./policy";
import {
  decryptFile,
  keyFingerprint,
  parseBackupKey,
  readBackupFileFingerprint,
  BackupCryptoError,
} from "./backup-crypto";
import { readEncryptedSecret } from "@/modules/platform/secrets";
import { listDriveDumps, type TokenGetter } from "./drive";
import { getCachedRemoteList, remoteListCacheKey, setCachedRemoteList } from "./restore-cache";
import type {
  ListRemoteBackupsResult,
  ProbeBackupInput,
  ProbeBackupResult,
  RemoteBackupItem,
} from "./restore-types";

/**
 * Serviço de Restore — Onda 1: listar e fazer download em stream de backups remotos.
 *
 * Suporta Google Drive (pasta "Backups InnoChat" via OAuth ou Conta de Serviço) e S3 (bucket/prefixo).
 * Paginação numerada no mesmo padrão do painel (10, 25, 50, 100 itens por página).
 * Ordenação sempre decrescente por data de criação (mais recentes primeiro).
 *
 * Ref formats:
 * - Drive: `drive:<fileId>/<name>`
 * - S3:    `s3:<key>`
 */

export type ParsedBackupRef =
  | { source: "DRIVE"; fileId: string; fileName: string }
  | { source: "S3"; key: string; fileName: string };

/**
 * Interpreta uma referência remota de forma estrita.
 * Rejeita referências malformadas, vazias ou com path traversal.
 */
export function parseBackupRef(ref: string): ParsedBackupRef {
  const trimmed = (ref ?? "").trim();
  if (!trimmed) {
    throw new DomainError("BACKUP_REF_INVALID", "Referência do backup é obrigatória.");
  }

  if (trimmed.startsWith("drive:")) {
    const rest = trimmed.slice("drive:".length);
    const slashIndex = rest.indexOf("/");
    if (slashIndex <= 0 || slashIndex === rest.length - 1) {
      throw new DomainError(
        "BACKUP_REF_INVALID",
        "Referência do Google Drive inválida. Formato esperado: drive:<id>/<nome>.",
      );
    }
    const fileId = rest.slice(0, slashIndex).trim();
    const fileName = rest.slice(slashIndex + 1).trim();
    if (!/^[A-Za-z0-9_-]{10,}$/.test(fileId)) {
      throw new DomainError("BACKUP_REF_INVALID", "Identificador do arquivo no Google Drive inválido.");
    }
    if (!isBackupFileName(fileName) || fileName.includes("/") || fileName.includes("\\")) {
      throw new DomainError("BACKUP_REF_INVALID", "Nome do arquivo no Google Drive inválido.");
    }
    return { source: "DRIVE", fileId, fileName };
  }

  if (trimmed.startsWith("s3:")) {
    const key = trimmed.slice("s3:".length).trim();
    if (!key || key.includes("..")) {
      throw new DomainError("BACKUP_REF_INVALID", "Chave do arquivo no S3 inválida.");
    }
    const fileName = key.split("/").pop() ?? "";
    if (!isBackupFileName(fileName)) {
      throw new DomainError("BACKUP_REF_INVALID", "Nome do arquivo no S3 inválido.");
    }
    return { source: "S3", key, fileName };
  }

  throw new DomainError(
    "BACKUP_REF_INVALID",
    "Referência do backup não reconhecida. Deve começar com 'drive:' ou 's3:'.",
  );
}

/**
 * Falha ao falar com o Google Drive durante a listagem vira `DomainError` sempre: a tela de
 * Restore/Backup não pode cair por uma credencial vencida, só mostrar o card remoto com o problema.
 */
function driveListingFailure(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  const backupError = asBackupError(error);
  return new DomainError(`BACKUP_${backupError.code}`, backupError.message);
}

/** Mesma ideia, para o S3: o SDK lança erros próprios que `s3Failure` já sabe classificar. */
function s3ListingFailure(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  const backupError = s3Failure(error, "Ao listar os backups no bucket");
  return new DomainError(`BACKUP_${backupError.code}`, backupError.message);
}

export type ListRemoteDeps = {
  configLoader?: () => Promise<BackupConfigRow>;
  driveAccessGetter?: (config: BackupConfigRow) => { getToken: TokenGetter; folderId: string };
  driveLister?: (getToken: TokenGetter, folderId: string) => Promise<Array<{ id: string; name: string; createdAt: Date; size: number | null }>>;
  s3Lister?: (config: BackupConfigRow) => Promise<Array<{ key: string; at: Date; size: number | null }>>;
};

/**
 * Lista todos os backups disponíveis no destino ativo (Drive ou S3), paginados.
 * Retorna lista vazia com totalItems = 0 caso o destino ainda não tenha dumps.
 */
export async function listRemoteBackups(
  opts: { page?: number; pageSize?: number } = {},
  deps: ListRemoteDeps = {},
): Promise<ListRemoteBackupsResult> {
  const config = await (deps.configLoader ?? loadBackupConfig)();
  const destination = activeDestination(config);
  if (!destination) {
    throw new DomainError(
      "BACKUP_DESTINATION_MISSING",
      "Nenhum destino de backup ativo configurado. Configure Google Drive ou S3 em Admin > Backup.",
    );
  }

  const requestedSize = (opts.pageSize ?? 25) as PageSize;
  const allItems: RemoteBackupItem[] = [];

  if (destination === "DRIVE") {
    let files: Array<{ id: string; name: string; createdAt: Date; size: number | null }>;
    try {
      const { getToken, folderId } = (deps.driveAccessGetter ?? driveAccess)(config);
      const lister = deps.driveLister ?? listDriveDumps;
      files = await lister(getToken, folderId);
    } catch (error) {
      throw driveListingFailure(error);
    }
    for (const f of files) {
      if (!isBackupFileName(f.name)) continue;
      allItems.push({
        ref: `drive:${f.id}/${f.name}`,
        name: f.name,
        sizeBytes: f.size,
        createdAt: f.createdAt.toISOString(),
        keyFingerprint: null,
        source: "DRIVE",
      });
    }
  } else if (destination === "S3") {
    try {
      if (deps.s3Lister) {
        const items = await deps.s3Lister(config);
        for (const item of items) {
          const name = item.key.split("/").pop() ?? item.key;
          if (!isBackupFileName(name)) continue;
          allItems.push({
            ref: `s3:${item.key}`,
            name,
            sizeBytes: item.size,
            createdAt: item.at.toISOString(),
            keyFingerprint: null,
            source: "S3",
          });
        }
      } else {
        const s3 = await s3Client(config);
        const prefix = s3Prefix(config);
        let token: string | undefined;
        do {
          const page = await s3.send(
            new ListObjectsV2Command({
              Bucket: config.s3Bucket!,
              Prefix: prefix ? `${prefix}/` : undefined,
              ContinuationToken: token,
            }),
          );
          for (const o of page.Contents ?? []) {
            if (!o.Key || !o.LastModified) continue;
            const name = o.Key.split("/").pop() ?? o.Key;
            if (!isBackupFileName(name)) continue;
            allItems.push({
              ref: `s3:${o.Key}`,
              name,
              sizeBytes: o.Size ?? null,
              createdAt: o.LastModified.toISOString(),
              keyFingerprint: null,
              source: "S3",
            });
          }
          token = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (token);
      }
    } catch (error) {
      throw s3ListingFailure(error);
    }
  }

  // Ordenação decrescente: mais recentes primeiro
  allItems.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const paged = resolvePage(opts.page, requestedSize, allItems.length);
  const items = allItems.slice(paged.skip, paged.skip + paged.pageSize);

  return {
    items,
    ...pageInfoOf(paged),
  };
}

/**
 * Mesma listagem de `listRemoteBackups`, mas com cache em memória de 30s (chave: destino+página+tamanho)
 * para não bater no Drive/S3 a cada F5/paginação da tela de Restore. Usada pela Server Action;
 * `listRemoteBackups` em si continua sem cache (é o que os testes unitários exercitam direto).
 */
export async function listRemoteBackupsCached(
  opts: { page?: number; pageSize?: number } = {},
  deps: ListRemoteDeps = {},
  now: number = Date.now(),
): Promise<{ result: ListRemoteBackupsResult; servedFromCache: boolean }> {
  const config = await (deps.configLoader ?? loadBackupConfig)();
  const destination = activeDestination(config);
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 25;

  if (destination) {
    const key = remoteListCacheKey(destination, page, pageSize);
    const cached = getCachedRemoteList(key, now);
    if (cached) return { result: cached, servedFromCache: true };

    const result = await listRemoteBackups(opts, { ...deps, configLoader: async () => config });
    setCachedRemoteList(key, result, now);
    return { result, servedFromCache: false };
  }

  // Sem destino ativo: listRemoteBackups vai lançar o erro de configuração; nada para cachear.
  const result = await listRemoteBackups(opts, { ...deps, configLoader: async () => config });
  return { result, servedFromCache: false };
}

export type RemoteStreamResult = {
  stream: ReadableStream<Uint8Array>;
  fileName: string;
  sizeBytes: number | null;
  contentType: string;
};

export type StreamRemoteDeps = {
  configLoader?: () => Promise<BackupConfigRow>;
  driveAccessGetter?: (config: BackupConfigRow) => { getToken: TokenGetter; folderId?: string };
  openDriveStream?: (getToken: TokenGetter, fileId: string) => Promise<{ stream: Readable; size: number | null }>;
  openS3Stream?: (config: BackupConfigRow, key: string) => Promise<{ stream: Readable; size: number | null }>;
};

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/**
 * Abre stream do arquivo remoto (Drive ou S3) para repasse direto ao client HTTP.
 * Não carrega o arquivo inteiro em memória.
 */
export async function streamRemoteBackup(
  ref: string,
  deps: StreamRemoteDeps = {},
): Promise<RemoteStreamResult> {
  const parsed = parseBackupRef(ref);
  const config = await (deps.configLoader ?? loadBackupConfig)();

  if (parsed.source === "DRIVE") {
    const { getToken } = (deps.driveAccessGetter ?? driveAccess)(config);

    if (deps.openDriveStream) {
      const { stream, size } = await deps.openDriveStream(getToken, parsed.fileId);
      return {
        stream: nodeReadableToWebStream(stream),
        fileName: parsed.fileName,
        sizeBytes: size,
        contentType: "application/octet-stream",
      };
    }

    const token = await getToken();
    const url = `${DRIVE_API}/files/${encodeURIComponent(parsed.fileId)}?alt=media&supportsAllDrives=true`;

    const { stream, size } = await new Promise<{ stream: IncomingMessage; size: number | null }>(
      (resolve, reject) => {
        const req = https.request(
          url,
          { method: "GET", headers: { Authorization: `Bearer ${token}` } },
          (res) => {
            if (res.statusCode !== 200) {
              let text = "";
              res.setEncoding("utf8");
              res.on("data", (chunk: string) => {
                if (text.length < 4096) text += chunk;
              });
              res.on("end", () => {
                reject(
                  new DomainError(
                    "BACKUP_DOWNLOAD_FAILED",
                    `O Google Drive recusou o download (HTTP ${res.statusCode ?? 0}): ${text.slice(0, 300) || "Erro desconhecido"}.`,
                  ),
                );
              });
              return;
            }
            const contentLength = res.headers["content-length"];
            const parsedSize = contentLength ? Number(contentLength) : null;
            resolve({ stream: res, size: Number.isFinite(parsedSize) ? parsedSize : null });
          },
        );
        req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
          req.destroy(new Error("tempo esgotado ao baixar do Google Drive"));
        });
        req.on("error", (err) => {
          reject(
            new DomainError(
              "BACKUP_DOWNLOAD_FAILED",
              `Não foi possível falar com o Google Drive para download: ${err.message}.`,
            ),
          );
        });
        req.end();
      },
    );

    return {
      stream: nodeReadableToWebStream(stream),
      fileName: parsed.fileName,
      sizeBytes: size,
      contentType: "application/octet-stream",
    };
  }

  // S3
  if (deps.openS3Stream) {
    const { stream, size } = await deps.openS3Stream(config, parsed.key);
    return {
      stream: nodeReadableToWebStream(stream),
      fileName: parsed.fileName,
      sizeBytes: size,
      contentType: "application/octet-stream",
    };
  }

  const s3 = await s3Client(config);
  try {
    const res = await s3.send(
      new GetObjectCommand({
        Bucket: config.s3Bucket!,
        Key: parsed.key,
      }),
    );
    if (!res.Body) {
      throw new DomainError("BACKUP_DOWNLOAD_FAILED", "O bucket respondeu sem corpo de arquivo.");
    }
    return {
      stream: nodeReadableToWebStream(res.Body as Readable),
      fileName: parsed.fileName,
      sizeBytes: res.ContentLength ?? null,
      contentType: "application/octet-stream",
    };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      "BACKUP_DOWNLOAD_FAILED",
      `Falha ao baixar do bucket: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}

/**
 * Converte um Readable do Node.js em ReadableStream da Web API.
 * Usa Readable.toWeb se disponível (Node 17+), ou conversão com cancelamento via destroy.
 */
export function nodeReadableToWebStream(nodeStream: Readable): ReadableStream<Uint8Array> {
  if (typeof (Readable as unknown as { toWeb?: (s: Readable) => ReadableStream<Uint8Array> }).toWeb === "function") {
    return (Readable as unknown as { toWeb: (s: Readable) => ReadableStream<Uint8Array> }).toWeb(nodeStream);
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on("data", (chunk: Buffer | Uint8Array) => {
        try {
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        } catch {
          nodeStream.destroy();
        }
      });
      nodeStream.on("end", () => {
        try {
          controller.close();
        } catch {
          // Já fechado
        }
      });
      nodeStream.on("error", (err) => {
        try {
          controller.error(err);
        } catch {
          // Já errou
        }
      });
    },
    cancel(reason) {
      nodeStream.destroy(reason instanceof Error ? reason : new Error(String(reason ?? "cancelled")));
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Probe / Integridade (Onda 2)
// ---------------------------------------------------------------------------------------------

export type ProbeRemoteDeps = {
  configLoader?: () => Promise<BackupConfigRow>;
  streamGetter?: (ref: string, deps?: StreamRemoteDeps) => Promise<RemoteStreamResult>;
  exec?: CommandRunner;
};

/**
 * Converte um ReadableStream da Web API (ou Readable do Node) e salva em disco com mode 0600.
 */
async function saveWebStreamToFile(webStream: ReadableStream<Uint8Array>, filePath: string): Promise<number> {
  const nodeStream = Readable.fromWeb(webStream as import("node:stream/web").ReadableStream);
  const writeStream = createWriteStream(filePath, { mode: 0o600 });
  await pipeline(nodeStream, writeStream);
  const stat = await fs.stat(filePath);
  return stat.size;
}

/**
 * Lê a chave do sistema de BackupConfig ou lança erro explicativo.
 */
function resolveSystemBackupKey(config: BackupConfigRow): { key: Buffer; fingerprint: string } {
  if (!config.encryptionKeyEnc || !config.encryptionKeyFingerprint) {
    throw new DomainError(
      "BACKUP_KEY_MISSING",
      "O sistema não possui chave de criptografia configurada. Gere uma chave em Admin > Backup ou utilize uma chave customizada.",
    );
  }
  const hex = readEncryptedSecret(config.encryptionKeyEnc, "backup.encryptionKey");
  const key = hex ? parseBackupKey(hex) : null;
  if (!key || keyFingerprint(key) !== config.encryptionKeyFingerprint) {
    throw new DomainError(
      "BACKUP_KEY_CORRUPTED",
      "Não foi possível ler a chave de criptografia do sistema. Se o AUTH_SECRET foi alterado, informe a chave salva manualmente.",
    );
  }
  return { key, fingerprint: config.encryptionKeyFingerprint };
}

/**
 * Resolve a chave de descriptografia para o Probe, garantindo que customKeyHex nunca seja logada ou persistida.
 */
function resolveProbeKey(
  input: ProbeBackupInput,
  config: BackupConfigRow,
): { key: Buffer; keyFingerprintHex: string } {
  if (input.keyMode === "SYSTEM") {
    const { key, fingerprint } = resolveSystemBackupKey(config);
    return { key, keyFingerprintHex: fingerprint };
  }

  // CUSTOM
  const rawCustom = input.customKeyHex ?? "";
  const key = parseBackupKey(rawCustom);
  if (!key) {
    throw new DomainError(
      "BACKUP_KEY_INVALID",
      "A chave informada é inválida. A chave precisa ter 32 bytes (64 caracteres hexadecimais), com ou sem hífens.",
    );
  }
  return { key, keyFingerprintHex: keyFingerprint(key) };
}

/**
 * Inspeciona um backup remoto (Drive ou S3) em memória/disco temporário seguro:
 * 1. Baixa o arquivo para /tmp em pasta isolada 0700 e arquivo 0600.
 * 2. Valida o cabeçalho do arquivo (marca INNOBKP e extrai fingerprint do dump).
 * 3. Descriptografa com AES-256-GCM validando a authTag.
 * 4. Executa pg_restore --list no dump em claro e conta tabelas com dados.
 * 5. Remove todos os arquivos temporários imediatamente no bloco finally.
 * 6. NUNCA loga nem persiste customKeyHex.
 */
export async function probeBackup(
  input: ProbeBackupInput,
  deps: ProbeRemoteDeps = {},
): Promise<ProbeBackupResult> {
  const config = await (deps.configLoader ?? loadBackupConfig)();
  const exec = deps.exec ?? runCommand;

  const { key, keyFingerprintHex } = resolveProbeKey(input, config);
  const systemKeyFingerprint = config.encryptionKeyFingerprint ?? null;

  let workDir: string | null = null;
  try {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), "innochat-probe-"));
    await fs.chmod(workDir, 0o700);

    const encPath = path.join(workDir, `${randomUUID()}.dump.enc`);
    const dumpPath = path.join(workDir, `${randomUUID()}.dump`);

    // 1. Download do stream remoto
    const streamer = deps.streamGetter ?? streamRemoteBackup;
    const remote = await streamer(input.ref);
    const downloadedBytes = await saveWebStreamToFile(remote.stream, encPath);
    if (downloadedBytes === 0) {
      throw new DomainError("BACKUP_EMPTY", `O arquivo remoto "${remote.fileName}" está vazio.`);
    }

    // 2. Extrai a fingerprint do cabeçalho
    const fileFingerprint = await readBackupFileFingerprint(encPath);
    if (!fileFingerprint) {
      throw new DomainError(
        "BACKUP_NOT_ENCRYPTED",
        "Este arquivo não é um backup criptografado do InnoChat (cabeçalho INNOBKP v1 ausente).",
      );
    }

    // 3. Descriptografia com conferência de chave e authTag GCM
    try {
      await decryptFile(encPath, dumpPath, key);
    } catch (cryptoErr) {
      if (cryptoErr instanceof BackupCryptoError) {
        if (cryptoErr.code === "WRONG_KEY") {
          throw new DomainError(
            "BACKUP_WRONG_KEY",
            `A chave informada não descriptografa este backup. O arquivo foi cifrado com a chave de impressão digital ${cryptoErr.fileFingerprint ?? fileFingerprint}, e a chave utilizada possui impressão ${keyFingerprintHex}. Confira se é a chave certa.`,
          );
        }
        if (cryptoErr.code === "AUTH_FAILED") {
          throw new DomainError(
            "BACKUP_AUTH_FAILED",
            "A chave informada não descriptografa este backup. Confira se é a chave certa. (Falha de autenticação AES-GCM: arquivo adulterado, incompleto ou chave incorreta).",
          );
        }
        if (cryptoErr.code === "TRUNCATED") {
          throw new DomainError("BACKUP_TRUNCATED", "O arquivo de backup está truncado ou incompleto.");
        }
        if (cryptoErr.code === "UNSUPPORTED_VERSION") {
          throw new DomainError("BACKUP_UNSUPPORTED_VERSION", cryptoErr.message);
        }
      }
      throw new DomainError(
        "BACKUP_DECRYPT_FAILED",
        `Falha ao descriptografar o backup: ${cryptoErr instanceof Error ? cryptoErr.message : String(cryptoErr)}`,
      );
    }

    // 4. Mede o dump descomprimido
    const dumpStat = await fs.stat(dumpPath);
    const uncompressedSizeBytes = dumpStat.size;

    // 5. pg_restore --list
    let restoreList = "";
    try {
      restoreList = await exec("pg_restore", ["--list", dumpPath], {});
    } catch (execErr) {
      throw new DomainError(
        "BACKUP_RESTORE_LIST_FAILED",
        `O pg_restore não conseguiu ler o índice do dump: ${execErr instanceof Error ? execErr.message : String(execErr)}`,
      );
    }

    const tablesWithData = countTablesWithData(restoreList);
    let warning: string | undefined;
    if (tablesWithData === 0) {
      warning = "O dump abriu corretamente, mas não contém nenhuma tabela com dados.";
    }

    const matchesCurrentSystemKey = Boolean(
      systemKeyFingerprint && fileFingerprint === systemKeyFingerprint,
    );

    return {
      valid: true,
      fingerprint: fileFingerprint,
      tablesWithData,
      uncompressedSizeBytes,
      matchesCurrentSystemKey,
      warning,
    };
  } finally {
    // 6. Limpeza garantida dos arquivos temporários
    if (workDir) {
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
    // A chave (do sistema ou customizada) só vive nesta função; zera o Buffer para não deixar
    // os bytes da chave na memória do processo depois que o probe termina.
    key.fill(0);
  }
}

