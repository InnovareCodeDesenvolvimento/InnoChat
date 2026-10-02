/**
 * Melhoria 2 (backup automático) contra Postgres real: configuração com segredos cifrados e mascarados,
 * execução com `pg_dump` simulado (o dump de verdade é provado no job `backup-restore` do CI), trava,
 * histórico, agendador, alerta de atraso limitado por `lastLateAlertAt` e a defesa do OAuth.
 */
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import { DomainError } from "@/lib/errors";
import {
  BackupError,
  checkBackupLate,
  claimOAuthNonce,
  completeGoogleConnection,
  configForPanel,
  listBackupRuns,
  loadBackupConfig,
  loadBackupLateNotification,
  runBackup,
  runBackupTick,
  saveBackupConfig,
  startGoogleConnection,
  testBackupConnection,
  type CommandRunner,
} from "@/modules/backup/service";
import { signOAuthState } from "@/modules/backup/drive-oauth";

const prisma = getPrisma();
const run = randomUUID().slice(0, 8);
const userIds: string[] = [];

/** Estado de fábrica do singleton (desligado, sem destino, sem segredo). */
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
  runningSince: null,
  lastSuccessAt: null,
  lastAttemptAt: null,
  lastLateAlertAt: null,
  updatedById: null,
};

async function resetConfig() {
  await prisma.backupConfig.upsert({ where: { id: 1 }, create: { id: 1 }, update: FACTORY });
  await prisma.backupRun.deleteMany({});
  await prisma.backupDriveOauthNonce.deleteMany({});
}

async function makeAdmin(isPlatformAdmin = true) {
  const u = await prisma.user.create({ data: { email: `bkp-${run}-${randomUUID().slice(0, 6)}@example.com`, passwordHash: "x", emailVerifiedAt: new Date(), isPlatformAdmin } });
  userIds.push(u.id);
  return u;
}

/** `pg_dump`/`pg_restore` de mentira: escreve um arquivo e devolve um índice com 1 tabela de dados. */
function fakeExec(overrides: { list?: string; fail?: Error; version?: string } = {}): CommandRunner {
  return async (command, args) => {
    if (overrides.fail && command === "pg_dump" && args[0] !== "--version") throw overrides.fail;
    if (command === "pg_dump" && args[0] === "--version") return overrides.version ?? "pg_dump (PostgreSQL) 99.0\n";
    if (command === "pg_dump") {
      const file = args.find((a) => a.startsWith("--file="))!.slice("--file=".length);
      await fs.writeFile(file, "conteudo-do-dump");
      return "";
    }
    if (command === "pg_restore") return overrides.list ?? "1; 0 0 TABLE DATA public tenants x\n";
    throw new Error(`comando inesperado: ${command}`);
  };
}

async function setS3Destination(extra: Record<string, unknown> = {}) {
  await saveBackupConfig({ destination: "S3", s3Endpoint: "http://127.0.0.1:1", s3Bucket: "bkt", s3Region: "auto", s3AccessKey: "AKIA-TESTE", s3SecretKey: "segredo-do-bucket-123" }, "adm");
  if (Object.keys(extra).length > 0) await prisma.backupConfig.update({ where: { id: 1 }, data: extra });
}

beforeAll(resetConfig);
afterEach(resetConfig);
afterAll(async () => {
  await resetConfig();
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe("configuração: segredos cifrados, mascarados e que não somem sem querer", () => {
  it("cifra o segredo do bucket e a tela só vê que ele existe", async () => {
    const { config } = await saveBackupConfig({ destination: "S3", s3Endpoint: "https://x.r2.cloudflarestorage.com", s3Bucket: "b", s3AccessKey: "AK", s3SecretKey: "segredo-do-bucket-123" }, "adm");
    const row = await loadBackupConfig();
    expect(row.s3SecretKeyEnc).toMatch(/^enc:v1:/);
    expect(row.s3SecretKeyEnc).not.toContain("segredo-do-bucket-123");
    expect(config.hasS3Secret).toBe(true);
    const json = JSON.stringify(configForPanel(row));
    expect(json).not.toContain("segredo-do-bucket-123");
    expect(json).not.toContain("enc:v1:");
    expect(Object.keys(configForPanel(row)).filter((k) => /Enc$/.test(k))).toEqual([]);
    expect(config.destinationReady).toBe(true);
  });

  it("segredo em branco MANTÉM o que está salvo", async () => {
    await setS3Destination();
    const before = (await loadBackupConfig()).s3SecretKeyEnc;
    await saveBackupConfig({ retentionDays: 30, s3SecretKey: "" }, "adm");
    const after = await loadBackupConfig();
    expect(after.s3SecretKeyEnc).toBe(before);
    expect(after.retentionDays).toBe(30);
  });

  it("recusa ligar o automático sem destino completo e não grava nada", async () => {
    await expect(saveBackupConfig({ enabled: true }, "adm")).rejects.toMatchObject({ code: "BACKUP_DESTINATION_MISSING" });
    expect((await loadBackupConfig()).enabled).toBe(false);
    await expect(saveBackupConfig({ enabled: true, destination: "S3", s3Bucket: "b" }, "adm")).rejects.toBeInstanceOf(DomainError);
  });

  it("liga quando o destino está completo", async () => {
    await setS3Destination();
    const { config, wasEnabled } = await saveBackupConfig({ enabled: true }, "adm");
    expect(wasEnabled).toBe(false);
    expect(config.enabled).toBe(true);
  });

  it("aceita o link da pasta do Drive e extrai o id; recusa o que não é pasta", async () => {
    await saveBackupConfig({ driveFolderId: "https://drive.google.com/drive/folders/1AbC_dEf-GhIjKlMn?usp=sharing" }, "adm");
    expect((await loadBackupConfig()).driveFolderId).toBe("1AbC_dEf-GhIjKlMn");
    await expect(saveBackupConfig({ driveFolderId: "minha pasta" }, "adm")).rejects.toMatchObject({ code: "DRIVE_FOLDER_INVALID" });
    await saveBackupConfig({ driveFolderId: null }, "adm");
    expect((await loadBackupConfig()).driveFolderId).toBeNull();
  });

  it("valida a chave da conta de serviço antes de gravar, guarda só cifrada e sem ecoar", async () => {
    const key = JSON.stringify({ type: "service_account", client_email: "bkp@proj.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\\nABC\\n-----END PRIVATE KEY-----\\n" });
    const { config } = await saveBackupConfig({ driveServiceAccountKey: key }, "adm");
    const row = await loadBackupConfig();
    expect(row.driveServiceAccountEnc).toMatch(/^enc:v1:/);
    expect(row.driveServiceAccountEnc).not.toContain("PRIVATE KEY");
    expect(config.driveClientEmail).toBe("bkp@proj.iam.gserviceaccount.com");
    expect(config.hasDriveServiceAccount).toBe(true);
    expect(JSON.stringify(config)).not.toContain("PRIVATE KEY");
    let error: unknown;
    try {
      await saveBackupConfig({ driveServiceAccountKey: '{"private_key": "SEGREDO-XYZ"' }, "adm");
    } catch (e) {
      error = e;
    }
    expect(error).toMatchObject({ code: "DRIVE_CREDENTIAL_INVALID" });
    expect((error as Error).message).not.toContain("SEGREDO-XYZ");
  });

  it("trocar o Client ID desfaz a conexão anterior (o app mudou); só o Secret pode girar", async () => {
    await prisma.backupConfig.update({
      where: { id: 1 },
      data: { driveOauthClientId: "id-antigo", driveOauthRefreshTokenEnc: "enc:v1:x", driveOauthFolderId: "p", driveOauthConnectedAt: new Date(), driveOauthEmail: "a@b.com" },
    });
    await saveBackupConfig({ driveOauthClientSecret: "novo-secret" }, "adm");
    expect((await loadBackupConfig()).driveOauthConnectedAt).not.toBeNull();
    await saveBackupConfig({ driveOauthClientId: "id-novo" }, "adm");
    const row = await loadBackupConfig();
    expect(row.driveOauthConnectedAt).toBeNull();
    expect(row.driveOauthRefreshTokenEnc).toBeNull();
    expect(row.driveOauthFolderId).toBeNull();
    expect(row.driveOauthClientSecretEnc).toMatch(/^enc:v1:/);
  });
});

describe("runBackup", () => {
  it("manual sem destino: dumpa e confere, mas vale como teste (não avança lastSuccessAt)", async () => {
    const r = await runBackup({ trigger: "MANUAL" }, { exec: fakeExec() });
    expect(r.objectKey).toBeNull();
    expect(r.destination).toBeNull();
    expect(r.tablesWithData).toBe(1);
    expect(r.sizeBytes).toBe("conteudo-do-dump".length);
    const row = await prisma.backupRun.findUniqueOrThrow({ where: { id: r.runId } });
    expect(row.status).toBe("SUCCESS");
    expect(row.trigger).toBe("MANUAL");
    expect(row.sizeBytes).toBe(BigInt(r.sizeBytes));
    const cfg = await loadBackupConfig();
    expect(cfg.lastSuccessAt).toBeNull();
    expect(cfg.runningSince).toBeNull();
    expect(cfg.lastAttemptAt).not.toBeNull();
  });

  it("agendado sem destino se recusa a rodar (dump que fica no servidor não é backup)", async () => {
    await expect(runBackup({ trigger: "SCHEDULED" }, { exec: fakeExec() })).rejects.toMatchObject({ code: "CONFIG" });
    expect(await prisma.backupRun.count()).toBe(0);
  });

  it("falha do pg_dump: grava FAILED com a causa, libera a trava e não vaza a senha do banco", async () => {
    const url = new URL(process.env.DATABASE_URL!);
    const password = decodeURIComponent(url.password);
    const exec = fakeExec({ fail: new BackupError(`pg_dump falhou (código 1): connection failed password=${password}`, "DUMP") });
    await expect(runBackup({ trigger: "MANUAL" }, { exec })).rejects.toMatchObject({ code: "DUMP" });
    const row = await prisma.backupRun.findFirstOrThrow({});
    expect(row.status).toBe("FAILED");
    expect(row.errorCode).toBe("DUMP");
    if (password) expect(row.errorDetail).not.toContain(password);
    expect(row.finishedAt).not.toBeNull();
    expect((await loadBackupConfig()).runningSince).toBeNull();
  });

  it("dump sem nenhuma tabela com dados é reprovado", async () => {
    await expect(runBackup({ trigger: "MANUAL" }, { exec: fakeExec({ list: "1; 0 0 TABLE public x\n" }) })).rejects.toMatchObject({ code: "DUMP" });
    expect((await prisma.backupRun.findFirstOrThrow({})).status).toBe("FAILED");
  });

  it("cliente do Postgres mais velho que o servidor falha dizendo o que atualizar", async () => {
    let error: unknown;
    try {
      await runBackup({ trigger: "MANUAL" }, { exec: fakeExec({ version: "pg_dump (PostgreSQL) 9.6\n" }) });
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).toMatch(/mais antigo que o servidor/);
    expect((error as Error).message).toMatch(/Dockerfile/);
  });

  it("trava: com um backup em andamento recusa, e trava abandonada (mais de 2 h) é reassumida", async () => {
    await prisma.backupConfig.update({ where: { id: 1 }, data: { runningSince: new Date() } });
    await expect(runBackup({ trigger: "MANUAL" }, { exec: fakeExec() })).rejects.toMatchObject({ code: "BUSY" });
    expect(await prisma.backupRun.count()).toBe(0);

    await prisma.backupConfig.update({ where: { id: 1 }, data: { runningSince: new Date(Date.now() - 3 * 3_600_000) } });
    const r = await runBackup({ trigger: "MANUAL" }, { exec: fakeExec() });
    expect(r.tablesWithData).toBe(1);
  });

  it("enquanto uma execução segura a trava, a segunda é recusada; ao terminar, a trava volta", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fast = fakeExec();
    const slow: CommandRunner = async (command, args) => {
      if (command === "pg_dump" && args[0] !== "--version") await gate;
      return fast(command, args, {});
    };
    const first = runBackup({ trigger: "MANUAL" }, { exec: slow });
    // Espera a primeira assumir a trava (ela fica presa no pg_dump).
    for (let i = 0; i < 50 && !(await loadBackupConfig()).runningSince; i += 1) await new Promise((r) => setTimeout(r, 20));
    await expect(runBackup({ trigger: "MANUAL" }, { exec: fakeExec() })).rejects.toMatchObject({ code: "BUSY" });
    release();
    await first;
    expect((await loadBackupConfig()).runningSince).toBeNull();
    expect(await prisma.backupRun.count()).toBe(1);
  });
});

describe("agendador", () => {
  const dueAt = new Date("2026-10-02T06:10:00Z"); // 03:10 em Brasília

  it("fora da hora não roda", async () => {
    await setS3Destination();
    await saveBackupConfig({ enabled: true, hourLocal: 3 }, "adm");
    const summary = await runBackupTick(new Date("2026-10-02T09:10:00Z"), { exec: fakeExec() });
    expect(summary.ran).toBe(false);
    expect(await prisma.backupRun.count()).toBe(0);
  });

  it("na hora, roda como AGENDADO; o destino inalcançável vira falha registrada, sem derrubar o tick", async () => {
    await setS3Destination();
    await saveBackupConfig({ enabled: true, hourLocal: 3 }, "adm");
    const summary = await runBackupTick(dueAt, { exec: fakeExec() });
    expect(summary.ran).toBe(true);
    expect(summary.ok).toBe(false);
    const row = await prisma.backupRun.findFirstOrThrow({});
    expect(row.trigger).toBe("SCHEDULED");
    expect(row.status).toBe("FAILED");
    expect(row.destination).toBe("S3");
    expect(row.errorCode).toBeTruthy();
    expect((await loadBackupConfig()).runningSince).toBeNull();
    // Já houve tentativa: a mesma hora não repete.
    const again = await runBackupTick(new Date(dueAt.getTime() + 600_000), { exec: fakeExec() });
    expect(again.ran).toBe(false);
  }, 60_000);

  it("fecha como falha a execução que ficou RUNNING além da trava (processo morreu no meio)", async () => {
    const stale = await prisma.backupRun.create({ data: { status: "RUNNING", trigger: "SCHEDULED", startedAt: new Date(Date.now() - 3 * 3_600_000) } });
    const fresh = await prisma.backupRun.create({ data: { status: "RUNNING", trigger: "MANUAL" } });
    const summary = await runBackupTick(new Date(), { exec: fakeExec() });
    expect(summary.staleRunsClosed).toBe(1);
    expect((await prisma.backupRun.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe("FAILED");
    expect((await prisma.backupRun.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe("RUNNING");
  });
});

describe("alerta de backup atrasado", () => {
  const h = 3_600_000;

  it("em dia ou desligado: nenhum e-mail", async () => {
    const sent: string[] = [];
    const send = async (m: { to: string; subject: string }) => (sent.push(m.subject), { sent: true } as never);
    expect((await checkBackupLate(new Date(), { send })).late).toBe(false);
    await setS3Destination();
    await saveBackupConfig({ enabled: true }, "adm");
    await prisma.backupConfig.update({ where: { id: 1 }, data: { lastSuccessAt: new Date(Date.now() - 2 * h) } });
    expect((await checkBackupLate(new Date(), { send })).late).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it("atrasado: manda e-mail ao admin UMA vez a cada 12 h (reserva atômica em lastLateAlertAt)", async () => {
    await makeAdmin();
    await setS3Destination();
    await saveBackupConfig({ enabled: true }, "adm");
    await prisma.backupConfig.update({ where: { id: 1 }, data: { lastSuccessAt: new Date(Date.now() - 40 * h) } });
    const subjects: string[] = [];
    const send = async (m: { to: string; subject: string }) => (subjects.push(m.subject), { sent: true } as never);

    const first = await checkBackupLate(new Date(), { send });
    expect(first.late).toBe(true);
    expect(first.emailed).toBe(true);
    expect(subjects.length).toBeGreaterThanOrEqual(1);
    expect(subjects[0]).toMatch(/atrasado/);
    const count = subjects.length;
    expect((await loadBackupConfig()).lastLateAlertAt).not.toBeNull();

    // Segunda passada logo depois: limitada.
    const second = await checkBackupLate(new Date(), { send });
    expect(second.late).toBe(true);
    expect(second.emailed).toBe(false);
    expect(subjects).toHaveLength(count);

    // Passadas 13 h, volta a avisar.
    await prisma.backupConfig.update({ where: { id: 1 }, data: { lastLateAlertAt: new Date(Date.now() - 13 * h) } });
    expect((await checkBackupLate(new Date(), { send })).emailed).toBe(true);
  });

  it("duas passadas simultâneas mandam um e-mail só", async () => {
    await makeAdmin();
    await setS3Destination();
    await saveBackupConfig({ enabled: true }, "adm");
    await prisma.backupConfig.update({ where: { id: 1 }, data: { lastSuccessAt: new Date(Date.now() - 40 * h) } });
    let calls = 0;
    const send = async () => (calls++, { sent: true } as never);
    const results = await Promise.all([checkBackupLate(new Date(), { send }), checkBackupLate(new Date(), { send })]);
    expect(results.filter((r) => r.emailed)).toHaveLength(1);
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it("se o envio falha, a reserva não fica presa por 12 h", async () => {
    await makeAdmin();
    await setS3Destination();
    await saveBackupConfig({ enabled: true }, "adm");
    await prisma.backupConfig.update({ where: { id: 1 }, data: { lastSuccessAt: new Date(Date.now() - 40 * h) } });
    const send = async () => ({ sent: false }) as never;
    const r = await checkBackupLate(new Date(), { send });
    expect(r.emailed).toBe(false);
    const cfg = await loadBackupConfig();
    // Volta para "daqui a ~30 min", não "daqui a 12 h".
    expect(Date.now() - cfg.lastLateAlertAt!.getTime()).toBeGreaterThan(11 * h);
  });

  it("alimenta o sino do admin, com id estável por última cópia", async () => {
    expect(await loadBackupLateNotification(new Date())).toBeNull();
    await setS3Destination();
    await saveBackupConfig({ enabled: true }, "adm");
    const last = new Date(Date.now() - 40 * h);
    await prisma.backupConfig.update({ where: { id: 1 }, data: { lastSuccessAt: last } });
    const item = await loadBackupLateNotification(new Date());
    expect(item?.id).toBe(`bkp:late:${last.getTime()}`);
    expect(item?.createdAt.getTime()).toBe(last.getTime() + 36 * h);
    expect(item?.body).toContain("40 horas");
  });
});

describe("histórico paginado", () => {
  it("pagina, da mais nova para a mais velha, e BigInt vira número", async () => {
    for (let i = 0; i < 12; i += 1) {
      await prisma.backupRun.create({ data: { status: "SUCCESS", trigger: "SCHEDULED", startedAt: new Date(Date.now() - i * 60_000), sizeBytes: BigInt(1000 + i), tablesWithData: 5 } });
    }
    const p1 = await listBackupRuns({ page: 1, pageSize: 10 });
    expect(p1.items).toHaveLength(10);
    expect(p1.totalItems).toBe(12);
    expect(p1.totalPages).toBe(2);
    expect(p1.items[0].sizeBytes).toBe(1000);
    const p2 = await listBackupRuns({ page: 2, pageSize: 10 });
    expect(p2.items).toHaveLength(2);
    // página fora do intervalo cai na última
    expect((await listBackupRuns({ page: 99, pageSize: 10 })).page).toBe(2);
  });
});

describe("testar conexão e conectar com Google", () => {
  it("testar sem destino completo explica o que falta", async () => {
    await expect(testBackupConnection()).rejects.toMatchObject({ code: "BACKUP_DESTINATION_MISSING" });
  });

  it("testar um bucket inalcançável devolve erro de domínio com a causa, não o erro cru", async () => {
    await setS3Destination();
    const error = await testBackupConnection().catch((e) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toMatch(/^BACKUP_/);
    expect((error as Error).message).not.toContain("segredo-do-bucket-123");
  }, 60_000);

  it("conectar exige Client ID e Secret salvos e monta a URL com o retorno da URL pública", async () => {
    await expect(startGoogleConnection("adm")).rejects.toMatchObject({ code: "DRIVE_OAUTH_CREDENTIALS_MISSING" });
    await saveBackupConfig({ driveOauthClientId: "cid.apps.googleusercontent.com", driveOauthClientSecret: "csecret" }, "adm");
    const { url } = await startGoogleConnection("adm");
    const parsed = new URL(url);
    expect(parsed.host).toBe("accounts.google.com");
    expect(parsed.searchParams.get("client_id")).toBe("cid.apps.googleusercontent.com");
    expect(parsed.searchParams.get("redirect_uri")).toMatch(/\/api\/admin\/backup\/google\/callback$/);
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(url).not.toContain("csecret");
  });

  it("callback: sem state, state forjado, state de outra pessoa e state reapresentado são recusados do mesmo jeito", async () => {
    const admin = await makeAdmin();
    const other = await makeAdmin();
    const refuse = { ok: false, reason: "estado_invalido" };

    expect(await completeGoogleConnection({ state: null, code: "c", googleError: null, sessionUserId: admin.id })).toEqual(refuse);
    expect(await completeGoogleConnection({ state: "lixo.lixo", code: "c", googleError: null, sessionUserId: admin.id })).toEqual(refuse);

    const mine = signOAuthState(admin.id).state;
    // sem sessão, ou com a sessão de outro admin
    expect(await completeGoogleConnection({ state: mine, code: "c", googleError: null, sessionUserId: null })).toEqual(refuse);
    expect(await completeGoogleConnection({ state: mine, code: "c", googleError: null, sessionUserId: other.id })).toEqual(refuse);
    expect(await prisma.backupDriveOauthNonce.count()).toBe(0);

    // O primeiro uso vale (aqui para na falta de credenciais do app) e consome o nonce; o segundo é recusado.
    const first = await completeGoogleConnection({ state: mine, code: "c", googleError: null, sessionUserId: admin.id });
    expect(first).toEqual({ ok: false, reason: "credenciais_invalidas" });
    expect(await completeGoogleConnection({ state: mine, code: "c", googleError: null, sessionUserId: admin.id })).toEqual(refuse);
    expect((await loadBackupConfig()).driveOauthConnectedAt).toBeNull();
  });

  it("callback: quem não é mais admin da plataforma é recusado; o 'Negar' do Google vira acesso_negado", async () => {
    const demoted = await makeAdmin(false);
    expect(await completeGoogleConnection({ state: signOAuthState(demoted.id).state, code: "c", googleError: null, sessionUserId: demoted.id })).toEqual({ ok: false, reason: "estado_invalido" });
    const admin = await makeAdmin();
    expect(await completeGoogleConnection({ state: signOAuthState(admin.id).state, code: null, googleError: "access_denied", sessionUserId: admin.id })).toEqual({ ok: false, reason: "acesso_negado" });
  });

  it("o nonce é de uso único também sob corrida", async () => {
    const payload = { nonce: `n-${run}`, adminId: "adm", exp: Date.now() + 60_000 };
    const results = await Promise.all([claimOAuthNonce(payload), claimOAuthNonce(payload)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
