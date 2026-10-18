import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import { saveBackupConfig, generateBackupEncryptionKey } from "@/modules/backup/service";
import { listRemoteBackups, streamRemoteBackup } from "@/modules/backup/restore-service";
import { listRemoteBackupsAction } from "@/modules/backup/restore-actions";
import { Readable } from "node:stream";

const sessionState: { userId: string | null } = { userId: null };
vi.mock("@/lib/auth", () => ({
  auth: vi.fn(async () => (sessionState.userId ? { user: { id: sessionState.userId } } : null)),
}));

const csvRouteModule = await import("@/app/api/admin/backup/download/route");
const downloadRoute = csvRouteModule.GET;

const prisma = getPrisma();
const run = randomUUID().slice(0, 8);
const userIds: string[] = [];

const FACTORY = {
  enabled: false,
  hourLocal: 3,
  retentionDays: 14,
  alertAfterHours: 36,
  destination: null,
  driveMode: "SERVICE_ACCOUNT",
  s3Endpoint: null,
  s3Bucket: null,
  s3Region: null,
  s3Prefix: null,
  s3AccessKey: null,
  s3SecretKeyEnc: null,
  driveFolderId: null,
  driveClientEmail: null,
  driveServiceAccountEnc: null,
  driveOauthClientId: null,
  driveOauthClientSecretEnc: null,
  driveOauthRefreshTokenEnc: null,
  driveOauthEmail: null,
  driveOauthFolderId: null,
  driveOauthConnectedAt: null,
  driveOauthConnectedById: null,
  encryptionKeyEnc: null,
  encryptionKeyFingerprint: null,
  encryptionKeyCreatedAt: null,
  encryptionKeyShownAt: null,
  runningSince: null,
  lastSuccessAt: null,
  lastAttemptAt: null,
  lastLateAlertAt: null,
  updatedById: null,
};

async function resetConfig() {
  await prisma.backupConfig.upsert({ where: { id: 1 }, create: { id: 1 }, update: FACTORY });
  await prisma.auditLog.deleteMany({ where: { action: { in: ["backup.remote_listed", "backup.remote_downloaded"] } } });
}

async function makeAdmin(opts: { isPlatformAdmin?: boolean; totp?: boolean } = {}) {
  const isPlatformAdmin = opts.isPlatformAdmin ?? true;
  const totp = opts.totp ?? true;
  const u = await prisma.user.create({
    data: {
      email: `restore-${run}-${randomUUID().slice(0, 6)}@example.com`,
      passwordHash: "x",
      emailVerifiedAt: new Date(),
      isPlatformAdmin,
      totpSecretEnc: totp ? "enc:v1:totp" : null,
      totpEnabledAt: totp ? new Date() : null,
    },
  });
  userIds.push(u.id);
  return u;
}

beforeAll(resetConfig);
afterEach(async () => {
  sessionState.userId = null;
  await resetConfig();
});
afterAll(async () => {
  await resetConfig();
  if (userIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
});

describe("Restore Onda 1 (integração): listagem de backups remotos", () => {
  it("listRemoteBackups com S3 configurado devolve itens ordenados por data decrescente", async () => {
    await saveBackupConfig(
      {
        destination: "S3",
        s3Endpoint: "https://s3.backup-teste.invalid",
        s3Bucket: "bkt-restore",
        s3AccessKey: "AKIA-RESTORE",
        s3SecretKey: "secret-123",
      },
      "adm",
    );
    await generateBackupEncryptionKey("adm", { replace: false });

    const fakeItems = [
      { key: "backup-innochat-2026-10-15-03h00m00s.dump.enc", at: new Date("2026-10-15T06:00:00Z"), size: 100 },
      { key: "backup-innochat-2026-10-18-03h00m00s.dump.enc", at: new Date("2026-10-18T06:00:00Z"), size: 300 },
      { key: "backup-innochat-2026-10-16-03h00m00s.dump.enc", at: new Date("2026-10-16T06:00:00Z"), size: 200 },
    ];

    const result = await listRemoteBackups(
      { page: 1, pageSize: 2 },
      { s3Lister: async () => fakeItems },
    );

    expect(result.totalItems).toBe(3);
    expect(result.totalPages).toBe(2);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].ref).toBe("s3:backup-innochat-2026-10-18-03h00m00s.dump.enc");
    expect(result.items[1].ref).toBe("s3:backup-innochat-2026-10-16-03h00m00s.dump.enc");
  });

  it("listRemoteBackups com Drive configurado devolve itens corretamente", async () => {
    const fakeKey = JSON.stringify({
      type: "service_account",
      client_email: "sa@example.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC3\n-----END PRIVATE KEY-----\n",
    });
    await saveBackupConfig(
      {
        destination: "DRIVE",
        driveMode: "SERVICE_ACCOUNT",
        driveFolderId: "folder-drive-123",
        driveServiceAccountKey: fakeKey,
      },
      "adm",
    );
    await generateBackupEncryptionKey("adm", { replace: false });

    const fakeDriveFiles = [
      { id: "file-1", name: "backup-innochat-2026-10-18-03h00m00s.dump.enc", createdAt: new Date("2026-10-18T06:00:00Z"), size: 4000 },
    ];

    const result = await listRemoteBackups(
      { page: 1, pageSize: 10 },
      {
        driveAccessGetter: () => ({ getToken: async () => "token", folderId: "folder-drive-123" }),
        driveLister: async () => fakeDriveFiles,
      },
    );

    expect(result.totalItems).toBe(1);
    expect(result.items[0].ref).toBe("drive:file-1/backup-innochat-2026-10-18-03h00m00s.dump.enc");
    expect(result.items[0].source).toBe("DRIVE");
    expect(result.items[0].sizeBytes).toBe(4000);
  });
});

describe("Restore Onda 1 (integração): streaming de download", () => {
  it("streamRemoteBackup abre stream com nome, tamanho e contentType corretos", async () => {
    await saveBackupConfig(
      {
        destination: "S3",
        s3Endpoint: "https://s3.backup-teste.invalid",
        s3Bucket: "bkt-restore",
        s3AccessKey: "AKIA-RESTORE",
        s3SecretKey: "secret-123",
      },
      "adm",
    );

    const content = Buffer.from("DADOS-DO-BACKUP-CIFRADO");
    const result = await streamRemoteBackup(
      "s3:backups/backup-innochat-2026-10-18-03h00m00s.dump.enc",
      {
        openS3Stream: async () => ({
          stream: Readable.from([content]),
          size: content.length,
        }),
      },
    );

    expect(result.fileName).toBe("backup-innochat-2026-10-18-03h00m00s.dump.enc");
    expect(result.sizeBytes).toBe(content.length);
    expect(result.contentType).toBe("application/octet-stream");

    const reader = result.stream.getReader();
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(Buffer.from(value!).toString()).toBe("DADOS-DO-BACKUP-CIFRADO");
  });
});

describe("Restore Onda 1 (integração): autenticação e audit log", () => {
  it("listRemoteBackupsAction recusa sem sessão (401/UNAUTHENTICATED)", async () => {
    sessionState.userId = null;
    const res = await listRemoteBackupsAction();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("UNAUTHENTICATED");
  });

  it("listRemoteBackupsAction recusa usuário que não é platform admin (FORBIDDEN)", async () => {
    const regularUser = await makeAdmin({ isPlatformAdmin: false, totp: false });
    sessionState.userId = regularUser.id;
    const res = await listRemoteBackupsAction();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("FORBIDDEN");
  });

  it("listRemoteBackupsAction recusa platform admin sem 2FA (TWO_FACTOR_SETUP_REQUIRED)", async () => {
    const noTotpAdmin = await makeAdmin({ isPlatformAdmin: true, totp: false });
    sessionState.userId = noTotpAdmin.id;
    const res = await listRemoteBackupsAction();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("TWO_FACTOR_SETUP_REQUIRED");
  });

  it("listRemoteBackupsAction com platform admin e 2FA registra audit log backup.remote_listed", async () => {
    await saveBackupConfig(
      {
        destination: "S3",
        s3Endpoint: "https://s3.backup-teste.invalid",
        s3Bucket: "bkt-restore",
        s3AccessKey: "AKIA-RESTORE",
        s3SecretKey: "secret-123",
      },
      "adm",
    );
    await generateBackupEncryptionKey("adm", { replace: false });

    const admin = await makeAdmin({ isPlatformAdmin: true, totp: true });
    sessionState.userId = admin.id;

    const res = await listRemoteBackupsAction(
      { page: 1, pageSize: 10 },
      { s3Lister: async () => [{ key: "backup-innochat-2026-10-18-03h00m00s.dump.enc", at: new Date(), size: 100 }] },
    );
    expect(res.ok).toBe(true);

    const audit = await prisma.auditLog.findFirst({
      where: { action: "backup.remote_listed", actorUserId: admin.id },
    });
    expect(audit).not.toBeNull();
    expect(audit?.summary).toContain("Listou backups remotos disponíveis");
  });

  it("GET /api/admin/backup/download recusa sem sessão (401)", async () => {
    sessionState.userId = null;
    const req = new Request("http://localhost/api/admin/backup/download?ref=s3:backup-1.dump.enc");
    const res = await downloadRoute(req);
    expect(res.status).toBe(401);
  });

  it("GET /api/admin/backup/download recusa ref inválida com 400", async () => {
    const admin = await makeAdmin({ isPlatformAdmin: true, totp: true });
    sessionState.userId = admin.id;
    const req = new Request("http://localhost/api/admin/backup/download?ref=invalido");
    const res = await downloadRoute(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BACKUP_REF_INVALID");
  });
});
