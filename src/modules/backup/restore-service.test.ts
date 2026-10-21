import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  parseBackupRef,
  listRemoteBackups,
  streamRemoteBackup,
  nodeReadableToWebStream,
  probeBackup,
} from "./restore-service";
import type { BackupConfigRow } from "./service";
import {
  encryptFile,
  generateBackupKey,
  keyFingerprint,
} from "./backup-crypto";
import { encryptSecret } from "@/lib/crypto";
import { DriveFailure } from "./drive";
import { DomainError } from "@/lib/errors";

function makeConfig(overrides: Partial<BackupConfigRow> = {}): BackupConfigRow {
  return {
    id: 1,
    enabled: true,
    hourLocal: 3,
    retentionDays: 14,
    alertAfterHours: 36,
    destination: "DRIVE",
    driveMode: "OAUTH",
    s3Endpoint: null,
    s3Bucket: null,
    s3Region: null,
    s3Prefix: null,
    s3AccessKey: null,
    s3SecretKeyEnc: null,
    driveFolderId: "folder-123",
    driveClientEmail: null,
    driveServiceAccountEnc: null,
    driveOauthClientId: "client-id-123",
    driveOauthClientSecretEnc: "enc:v1:secret",
    driveOauthRefreshTokenEnc: "enc:v1:refresh",
    driveOauthEmail: "dono@example.com",
    driveOauthFolderId: "oauth-folder-xyz",
    driveOauthConnectedAt: new Date(),
    driveOauthConnectedById: "admin-1",
    encryptionKeyEnc: null,
    encryptionKeyFingerprint: "abcd1234",
    encryptionKeyCreatedAt: new Date(),
    encryptionKeyShownAt: new Date(),
    runningSince: null,
    lastSuccessAt: null,
    lastAttemptAt: null,
    lastLateAlertAt: null,
    updatedById: "admin-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as unknown as BackupConfigRow;
}

const mockDriveAccess = () => ({
  getToken: async () => "mock-token",
  folderId: "mock-folder",
});

describe("parseBackupRef", () => {
  it("aceita ref do Google Drive válida", () => {
    const parsed = parseBackupRef("drive:1AbCdEfGhIjKlMnOpQrSt/backup-innochat-2026-10-18-03h00m00s.dump.enc");
    expect(parsed).toEqual({
      source: "DRIVE",
      fileId: "1AbCdEfGhIjKlMnOpQrSt",
      fileName: "backup-innochat-2026-10-18-03h00m00s.dump.enc",
    });
  });

  it("aceita ref do S3 válida com prefixo", () => {
    const parsed = parseBackupRef("s3:backups/prod/backup-innochat-2026-10-18-03h00m00s.dump.enc");
    expect(parsed).toEqual({
      source: "S3",
      key: "backups/prod/backup-innochat-2026-10-18-03h00m00s.dump.enc",
      fileName: "backup-innochat-2026-10-18-03h00m00s.dump.enc",
    });
  });

  it("rejeita ref vazia ou sem prefixo conhecido", () => {
    expect(() => parseBackupRef("")).toThrowError(/obrigatória/);
    expect(() => parseBackupRef("ftp://arquivo.dump")).toThrowError(/não reconhecida/);
  });

  it("rejeita ref do Drive com fileId muito curto ou caracteres inválidos", () => {
    expect(() => parseBackupRef("drive:abc/backup-innochat-1.dump")).toThrowError(/Identificador/);
  });

  it("rejeita ref com nome que não é de backup do sistema", () => {
    expect(() => parseBackupRef("drive:1AbCdEfGhIjKlMnOpQrSt/foto.jpg")).toThrowError(/Nome do arquivo/);
    expect(() => parseBackupRef("s3:backups/malicioso.sh")).toThrowError(/Nome do arquivo/);
  });

  it("rejeita tentativa de path traversal na chave do S3", () => {
    expect(() => parseBackupRef("s3:../../etc/passwd/backup-1.dump")).toThrowError(/Chave/);
  });
});

describe("listRemoteBackups", () => {
  it("recusa quando não há destino ativo configurado", async () => {
    const config = makeConfig({ destination: null });
    await expect(
      listRemoteBackups({}, { configLoader: async () => config }),
    ).rejects.toThrowError(/Nenhum destino de backup ativo/);
  });

  it("lista backups do Drive ordenados do mais recente para o mais antigo com paginação", async () => {
    const config = makeConfig({ destination: "DRIVE" });
    const fakeDriveFiles = [
      { id: "id-1", name: "backup-innochat-2026-10-10-03h00m00s.dump.enc", createdAt: new Date("2026-10-10T06:00:00Z"), size: 1000 },
      { id: "id-3", name: "backup-innochat-2026-10-18-03h00m00s.dump.enc", createdAt: new Date("2026-10-18T06:00:00Z"), size: 3000 },
      { id: "id-2", name: "backup-innochat-2026-10-14-03h00m00s.dump.enc", createdAt: new Date("2026-10-14T06:00:00Z"), size: 2000 },
      { id: "id-junk", name: "outro-arquivo.txt", createdAt: new Date("2026-10-19T06:00:00Z"), size: 50 },
    ];

    const result = await listRemoteBackups(
      { page: 1, pageSize: 2 },
      {
        configLoader: async () => config,
        driveAccessGetter: mockDriveAccess,
        driveLister: async () => fakeDriveFiles,
      },
    );

    expect(result.totalItems).toBe(3);
    expect(result.totalPages).toBe(2);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(2);
    expect(result.items).toHaveLength(2);

    // O mais recente (18) deve ser o primeiro
    expect(result.items[0].ref).toBe("drive:id-3/backup-innochat-2026-10-18-03h00m00s.dump.enc");
    expect(result.items[0].source).toBe("DRIVE");
    expect(result.items[0].sizeBytes).toBe(3000);

    // O segundo deve ser o do dia 14
    expect(result.items[1].ref).toBe("drive:id-2/backup-innochat-2026-10-14-03h00m00s.dump.enc");

    // Página 2 deve trazer o do dia 10
    const page2 = await listRemoteBackups(
      { page: 2, pageSize: 2 },
      {
        configLoader: async () => config,
        driveAccessGetter: mockDriveAccess,
        driveLister: async () => fakeDriveFiles,
      },
    );
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].ref).toBe("drive:id-1/backup-innochat-2026-10-10-03h00m00s.dump.enc");
  });

  it("lista backups do S3 corretamente", async () => {
    const config = makeConfig({
      destination: "S3",
      s3Endpoint: "https://s3.example.com",
      s3Bucket: "my-bucket",
      s3AccessKey: "key",
      s3SecretKeyEnc: "enc:v1:secret",
    });

    const fakeS3Items = [
      { key: "backups/backup-innochat-2026-10-17-03h00m00s.dump.enc", at: new Date("2026-10-17T06:00:00Z"), size: 5000 },
      { key: "backups/backup-innochat-2026-10-18-03h00m00s.dump.enc", at: new Date("2026-10-18T06:00:00Z"), size: 6000 },
    ];

    const result = await listRemoteBackups(
      { page: 1, pageSize: 10 },
      {
        configLoader: async () => config,
        s3Lister: async () => fakeS3Items,
      },
    );

    expect(result.totalItems).toBe(2);
    expect(result.items[0].ref).toBe("s3:backups/backup-innochat-2026-10-18-03h00m00s.dump.enc");
    expect(result.items[0].source).toBe("S3");
    expect(result.items[0].sizeBytes).toBe(6000);
  });

  it("falha de credencial do Drive (ex.: OAuth com client secret trocado) vira DomainError, nunca escapa crua", async () => {
    // Bug real (produção, 2026-10-21): DriveFailure escapava sem converter, derrubando a tela inteira
    // (Admin > Backup) com "Algo deu errado nesta tela" em vez de mostrar o card com o motivo.
    const config = makeConfig({ destination: "DRIVE" });
    const err = await listRemoteBackups(
      {},
      {
        configLoader: async () => config,
        driveAccessGetter: mockDriveAccess,
        driveLister: async () => {
          throw new DriveFailure("O Google recusou renovar o acesso: invalid_client: The provided client secret is invalid.", "oauth_client_invalid", 401);
        },
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe("BACKUP_OAUTH_CLIENT_INVALID");
    expect((err as Error).message).toMatch(/Client ID ou o Client Secret/);
  });

  it("falha do SDK do S3 na listagem também vira DomainError, nunca escapa crua", async () => {
    const config = makeConfig({ destination: "S3", s3Endpoint: "https://s3.example.com", s3Bucket: "my-bucket", s3AccessKey: "key", s3SecretKeyEnc: "enc:v1:secret" });
    const err = await listRemoteBackups(
      {},
      {
        configLoader: async () => config,
        s3Lister: async () => {
          const e = new Error("The request signature we calculated does not match.");
          e.name = "SignatureDoesNotMatch";
          throw e;
        },
      },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect((err as DomainError).code).toBe("BACKUP_CREDENTIAL");
  });

  it("devolve lista vazia se não há arquivos no destino", async () => {
    const config = makeConfig({ destination: "DRIVE" });
    const result = await listRemoteBackups(
      {},
      {
        configLoader: async () => config,
        driveAccessGetter: mockDriveAccess,
        driveLister: async () => [],
      },
    );
    expect(result.totalItems).toBe(0);
    expect(result.items).toHaveLength(0);
    expect(result.totalPages).toBe(1);
  });
});

describe("streamRemoteBackup", () => {
  it("abre stream de backup do Drive via openDriveStream injetada", async () => {
    const config = makeConfig({ destination: "DRIVE" });
    const content = Buffer.from("INNOBKP-conteudo-do-dump");
    const fakeNodeStream = Readable.from([content]);

    const result = await streamRemoteBackup(
      "drive:1AbCdEfGhIjKlMnOpQrSt/backup-innochat-2026-10-18-03h00m00s.dump.enc",
      {
        configLoader: async () => config,
        driveAccessGetter: mockDriveAccess,
        openDriveStream: async () => ({
          stream: fakeNodeStream,
          size: content.length,
        }),
      },
    );

    expect(result.fileName).toBe("backup-innochat-2026-10-18-03h00m00s.dump.enc");
    expect(result.sizeBytes).toBe(content.length);
    expect(result.contentType).toBe("application/octet-stream");

    // Ler do ReadableStream Web API
    const reader = result.stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    const total = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    expect(total.toString()).toBe("INNOBKP-conteudo-do-dump");
  });

  it("abre stream de backup do S3 via openS3Stream injetada", async () => {
    const config = makeConfig({ destination: "S3" });
    const content = Buffer.from("DUMP-S3");
    const fakeNodeStream = Readable.from([content]);

    const result = await streamRemoteBackup(
      "s3:backups/backup-innochat-2026-10-18-03h00m00s.dump.enc",
      {
        configLoader: async () => config,
        openS3Stream: async () => ({
          stream: fakeNodeStream,
          size: content.length,
        }),
      },
    );

    expect(result.fileName).toBe("backup-innochat-2026-10-18-03h00m00s.dump.enc");
    expect(result.sizeBytes).toBe(content.length);
  });
});

describe("nodeReadableToWebStream", () => {
  it("propaga cancel para destroy do Node stream", async () => {
    let destroyed = false;
    const nodeStream = new Readable({
      read() {
        this.push(Buffer.from("bloco"));
      },
      destroy(err, cb) {
        destroyed = true;
        cb(err);
      },
    });

    const webStream = nodeReadableToWebStream(nodeStream);
    const reader = webStream.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    await reader.cancel("fechou cedo");
    expect(destroyed).toBe(true);
  });
});

describe("probeBackup (Onda 2)", () => {
  async function createEncryptedFixture(key: Buffer, plainContent: string): Promise<{ encBuffer: Buffer; dumpSize: number }> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "probe-test-"));
    const plainPath = path.join(tmpDir, "plain.dump");
    const encPath = path.join(tmpDir, "plain.dump.enc");
    try {
      await fs.writeFile(plainPath, plainContent);
      await encryptFile(plainPath, encPath, key);
      const encBuffer = await fs.readFile(encPath);
      return { encBuffer, dumpSize: Buffer.byteLength(plainContent) };
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  it("inspeciona com sucesso usando keyMode: CUSTOM (chave correta)", async () => {
    const key = generateBackupKey();
    const fp = keyFingerprint(key);
    const dumpContent = "PGDUMP_HEADER\nTABLE DATA public.Tenant\nTABLE DATA public.User\nTABLE DATA public.Appointment\n";
    const { encBuffer, dumpSize } = await createEncryptedFixture(key, dumpContent);

    const config = makeConfig({ encryptionKeyFingerprint: "other123" });
    const ref = "drive:1AbCdEfGhIjKlMnOpQrSt/backup-innochat-2026-10-18-03h00m00s.dump.enc";

    const result = await probeBackup(
      {
        ref,
        keyMode: "CUSTOM",
        customKeyHex: key.toString("hex"),
      },
      {
        configLoader: async () => config,
        streamGetter: async () => ({
          stream: nodeReadableToWebStream(Readable.from([encBuffer])),
          fileName: "backup-innochat-2026-10-18-03h00m00s.dump.enc",
          sizeBytes: encBuffer.length,
          contentType: "application/octet-stream",
        }),
        exec: async () => {
          return "123; 1234 5678 TABLE DATA public Tenant user\n124; 1234 5679 TABLE DATA public User user\n125; 1234 5680 TABLE DATA public Appointment user\n";
        },
      },
    );

    expect(result.valid).toBe(true);
    expect(result.fingerprint).toBe(fp);
    expect(result.tablesWithData).toBe(3);
    expect(result.uncompressedSizeBytes).toBe(dumpSize);
    expect(result.matchesCurrentSystemKey).toBe(false);
    expect(result.warning).toBeUndefined();
  });

  it("inspeciona com sucesso usando keyMode: SYSTEM (chave do sistema configurada)", async () => {
    const key = generateBackupKey();
    const fp = keyFingerprint(key);
    const dumpContent = "PGDUMP_HEADER\nTABLE DATA public.Tenant\n";
    const { encBuffer } = await createEncryptedFixture(key, dumpContent);

    const config = makeConfig({
      encryptionKeyEnc: encryptSecret(key.toString("hex")),
      encryptionKeyFingerprint: fp,
    });
    const ref = "s3:backups/backup-innochat-2026-10-18-03h00m00s.dump.enc";

    const result = await probeBackup(
      {
        ref,
        keyMode: "SYSTEM",
      },
      {
        configLoader: async () => config,
        streamGetter: async () => ({
          stream: nodeReadableToWebStream(Readable.from([encBuffer])),
          fileName: "backup-innochat-2026-10-18-03h00m00s.dump.enc",
          sizeBytes: encBuffer.length,
          contentType: "application/octet-stream",
        }),
        exec: async () => "1; 1 2 TABLE DATA public Tenant user\n",
      },
    );

    expect(result.valid).toBe(true);
    expect(result.fingerprint).toBe(fp);
    expect(result.tablesWithData).toBe(1);
    expect(result.matchesCurrentSystemKey).toBe(true);
  });

  it("falha com mensagem amigável quando a chave está errada (authTag / WRONG_KEY)", async () => {
    const keyOriginal = generateBackupKey();
    const wrongKey = generateBackupKey();
    const { encBuffer } = await createEncryptedFixture(keyOriginal, "CONTEUDO_DUMP");

    const config = makeConfig({});
    const ref = "drive:1AbCdEfGhIjKlMnOpQrSt/backup-innochat-2026-10-18-03h00m00s.dump.enc";

    await expect(
      probeBackup(
        {
          ref,
          keyMode: "CUSTOM",
          customKeyHex: wrongKey.toString("hex"),
        },
        {
          configLoader: async () => config,
          streamGetter: async () => ({
            stream: nodeReadableToWebStream(Readable.from([encBuffer])),
            fileName: "backup-innochat-2026-10-18-03h00m00s.dump.enc",
            sizeBytes: encBuffer.length,
            contentType: "application/octet-stream",
          }),
        },
      ),
    ).rejects.toThrowError(/A chave informada não descriptografa este backup/);
  });

  it("falha quando o arquivo foi adulterado no meio (authTag falha)", async () => {
    const key = generateBackupKey();
    const { encBuffer } = await createEncryptedFixture(key, "CONTEUDO_LONGO_PARA_TER_TAG_GCM_SUFICIENTE_NO_PROCESSO");

    // Adulterar um byte do meio (depois do cabeçalho)
    const corrupted = Buffer.from(encBuffer);
    corrupted[30] = (corrupted[30]! ^ 0xff);

    const config = makeConfig({});
    const ref = "drive:1AbCdEfGhIjKlMnOpQrSt/backup-innochat-2026-10-18-03h00m00s.dump.enc";

    await expect(
      probeBackup(
        {
          ref,
          keyMode: "CUSTOM",
          customKeyHex: key.toString("hex"),
        },
        {
          configLoader: async () => config,
          streamGetter: async () => ({
            stream: nodeReadableToWebStream(Readable.from([corrupted])),
            fileName: "backup-innochat-2026-10-18-03h00m00s.dump.enc",
            sizeBytes: corrupted.length,
            contentType: "application/octet-stream",
          }),
        },
      ),
    ).rejects.toThrowError(/Falha de autenticação AES-GCM|não descriptografa/);
  });

  it("recusa customKeyHex com formato inválido (menos de 64 hex chars)", async () => {
    const config = makeConfig({});
    await expect(
      probeBackup(
        {
          ref: "drive:1AbCdEfGhIjKlMnOpQrSt/backup-innochat-2026-10-18-03h00m00s.dump.enc",
          keyMode: "CUSTOM",
          customKeyHex: "chave-curta-demais",
        },
        { configLoader: async () => config },
      ),
    ).rejects.toThrowError(/A chave informada é inválida/);
  });

  it("recusa keyMode: SYSTEM quando o sistema não tem chave configurada", async () => {
    const config = makeConfig({ encryptionKeyEnc: null, encryptionKeyFingerprint: null });
    await expect(
      probeBackup(
        {
          ref: "drive:1AbCdEfGhIjKlMnOpQrSt/backup-innochat-2026-10-18-03h00m00s.dump.enc",
          keyMode: "SYSTEM",
        },
        { configLoader: async () => config },
      ),
    ).rejects.toThrowError(/O sistema não possui chave de criptografia/);
  });

  it("retorna aviso caso o dump não tenha tabelas com dados", async () => {
    const key = generateBackupKey();
    const { encBuffer } = await createEncryptedFixture(key, "PGDUMP_VAZIO");
    const config = makeConfig({});

    const result = await probeBackup(
      {
        ref: "drive:1AbCdEfGhIjKlMnOpQrSt/backup-innochat-2026-10-18-03h00m00s.dump.enc",
        keyMode: "CUSTOM",
        customKeyHex: key.toString("hex"),
      },
      {
        configLoader: async () => config,
        streamGetter: async () => ({
          stream: nodeReadableToWebStream(Readable.from([encBuffer])),
          fileName: "backup-innochat-2026-10-18-03h00m00s.dump.enc",
          sizeBytes: encBuffer.length,
          contentType: "application/octet-stream",
        }),
        exec: async () => "1; 0 0 SCHEMA public postgres\n",
      },
    );

    expect(result.tablesWithData).toBe(0);
    expect(result.warning).toMatch(/não contém nenhuma tabela com dados/);
  });

  it("garante que o diretório e arquivos temporários são deletados após a execução, inclusive em erro", async () => {
    const key = generateBackupKey();
    const { encBuffer } = await createEncryptedFixture(key, "TESTE_TEMPORARIO");
    const config = makeConfig({});

    const initialProbeDirs = (await fs.readdir(os.tmpdir())).filter((d) => d.startsWith("innochat-probe-"));

    // 1. Execução bem sucedida
    await probeBackup(
      {
        ref: "drive:1AbCdEfGhIjKlMnOpQrSt/backup-innochat-2026-10-18-03h00m00s.dump.enc",
        keyMode: "CUSTOM",
        customKeyHex: key.toString("hex"),
      },
      {
        configLoader: async () => config,
        streamGetter: async () => ({
          stream: nodeReadableToWebStream(Readable.from([encBuffer])),
          fileName: "backup-innochat-2026-10-18-03h00m00s.dump.enc",
          sizeBytes: encBuffer.length,
          contentType: "application/octet-stream",
        }),
        exec: async () => "TABLE DATA public Tenant user\n",
      },
    );

    const postSuccessProbeDirs = (await fs.readdir(os.tmpdir())).filter((d) => d.startsWith("innochat-probe-"));
    expect(postSuccessProbeDirs.length).toBe(initialProbeDirs.length);

    // 2. Execução com erro no exec (pg_restore falha)
    await expect(
      probeBackup(
        {
          ref: "drive:1AbCdEfGhIjKlMnOpQrSt/backup-innochat-2026-10-18-03h00m00s.dump.enc",
          keyMode: "CUSTOM",
          customKeyHex: key.toString("hex"),
        },
        {
          configLoader: async () => config,
          streamGetter: async () => ({
            stream: nodeReadableToWebStream(Readable.from([encBuffer])),
            fileName: "backup-innochat-2026-10-18-03h00m00s.dump.enc",
            sizeBytes: encBuffer.length,
            contentType: "application/octet-stream",
          }),
          exec: async () => {
            throw new Error("pg_restore simulated crash");
          },
        },
      ),
    ).rejects.toThrowError(/pg_restore não conseguiu ler/);

    const postErrorProbeDirs = (await fs.readdir(os.tmpdir())).filter((d) => d.startsWith("innochat-probe-"));
    expect(postErrorProbeDirs.length).toBe(initialProbeDirs.length);
  });
});

