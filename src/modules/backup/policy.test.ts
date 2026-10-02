import { describe, expect, it } from "vitest";
import {
  activeDestination,
  backupFileName,
  countTablesWithData,
  decidePrune,
  failureMail,
  googleConnectedMail,
  isBackupFileName,
  isDue,
  lateMail,
  lateStatus,
  parsePgDumpMajor,
  pgEnvFromUrl,
  pgVersionProblem,
  type BackupConfigFields,
} from "./policy";

const base: BackupConfigFields = {
  enabled: true,
  hourLocal: 3,
  retentionDays: 14,
  alertAfterHours: 36,
  destination: null,
  driveMode: "SERVICE_ACCOUNT",
  s3Endpoint: null,
  s3Bucket: null,
  s3AccessKey: null,
  s3SecretKeyEnc: null,
  driveFolderId: null,
  driveServiceAccountEnc: null,
  driveOauthClientId: null,
  driveOauthClientSecretEnc: null,
  driveOauthRefreshTokenEnc: null,
  driveOauthFolderId: null,
  driveOauthConnectedAt: null,
  lastSuccessAt: null,
  lastAttemptAt: null,
};

describe("activeDestination: o destino escolhido manda, e só vale completo", () => {
  it("sem escolha, nada vale (mesmo com campos preenchidos)", () => {
    expect(activeDestination({ ...base, s3Endpoint: "https://x", s3Bucket: "b", s3AccessKey: "k", s3SecretKeyEnc: "enc:v1:x" })).toBeNull();
  });
  it("S3 completo vale; falta o segredo, não", () => {
    const s3 = { ...base, destination: "S3", s3Endpoint: "https://x", s3Bucket: "b", s3AccessKey: "k", s3SecretKeyEnc: "enc:v1:x" };
    expect(activeDestination(s3)).toBe("S3");
    expect(activeDestination({ ...s3, s3SecretKeyEnc: null })).toBeNull();
  });
  it("com os dois preenchidos, vale o escolhido", () => {
    const both = { ...base, s3Endpoint: "https://x", s3Bucket: "b", s3AccessKey: "k", s3SecretKeyEnc: "enc:v1:x", driveFolderId: "f", driveServiceAccountEnc: "enc:v1:y" };
    expect(activeDestination({ ...both, destination: "DRIVE" })).toBe("DRIVE");
    expect(activeDestination({ ...both, destination: "S3" })).toBe("S3");
  });
  it("Drive por conta de serviço exige pasta e chave", () => {
    expect(activeDestination({ ...base, destination: "DRIVE", driveFolderId: "f" })).toBeNull();
    expect(activeDestination({ ...base, destination: "DRIVE", driveFolderId: "f", driveServiceAccountEnc: "enc:v1:y" })).toBe("DRIVE");
  });
  it("Drive por OAuth: Client ID preenchido NÃO é conectado", () => {
    const oauth = { ...base, destination: "DRIVE", driveMode: "OAUTH", driveOauthClientId: "id", driveOauthClientSecretEnc: "enc:v1:s" };
    expect(activeDestination(oauth)).toBeNull();
    expect(activeDestination({ ...oauth, driveOauthConnectedAt: new Date(), driveOauthRefreshTokenEnc: "enc:v1:r", driveOauthFolderId: "pasta" })).toBe("DRIVE");
  });
});

describe("backupFileName", () => {
  it("usa a hora de Brasília, com segundos", () => {
    // 12:24:40 UTC = 09:24:40 em Brasília
    expect(backupFileName(new Date("2026-09-22T12:24:40Z"))).toBe("backup-innochat-2026-09-22-09h24m40s.dump");
  });
  it("vira o dia pelo fuso: 01:30 UTC ainda é a noite anterior em Brasília", () => {
    expect(backupFileName(new Date("2026-10-02T01:30:05Z"))).toBe("backup-innochat-2026-10-01-22h30m05s.dump");
  });
  it("isBackupFileName só reconhece o nosso formato", () => {
    expect(isBackupFileName("backup-innochat-2026-09-22-09h24m40s.dump")).toBe(true);
    expect(isBackupFileName("foto-do-cliente.jpg")).toBe(false);
    expect(isBackupFileName(".teste-conexao-ab12.tmp")).toBe(false);
  });
});

describe("isDue", () => {
  const cfg = { enabled: true, hourLocal: 3, lastAttemptAt: null as Date | null };
  it("só na hora marcada (3h de Brasília = 6h UTC)", () => {
    expect(isDue(cfg, new Date("2026-10-02T06:10:00Z"))).toBe(true);
    expect(isDue(cfg, new Date("2026-10-02T07:10:00Z"))).toBe(false);
  });
  it("não repete se já houve tentativa nas últimas 20 h", () => {
    expect(isDue({ ...cfg, lastAttemptAt: new Date("2026-10-02T06:00:00Z") }, new Date("2026-10-02T06:50:00Z"))).toBe(false);
    expect(isDue({ ...cfg, lastAttemptAt: new Date("2026-10-01T06:00:00Z") }, new Date("2026-10-02T06:10:00Z"))).toBe(true);
  });
  it("desligado nunca roda", () => {
    expect(isDue({ ...cfg, enabled: false }, new Date("2026-10-02T06:10:00Z"))).toBe(false);
  });
  it("hora 22 em Brasília cai na 1h UTC do dia seguinte", () => {
    expect(isDue({ ...cfg, hourLocal: 22 }, new Date("2026-10-03T01:05:00Z"))).toBe(true);
  });
});

describe("decidePrune: duas guardas valem mais que a poda", () => {
  const now = new Date("2026-10-02T00:00:00Z");
  const day = 86_400_000;
  const item = (id: string, daysAgo: number) => ({ id, createdAt: new Date(now.getTime() - daysAgo * day) });
  it("apaga só o que passou da retenção", () => {
    expect(decidePrune([item("novo", 0), item("a", 5), item("b", 20), item("c", 30)], { retentionDays: 14, keep: "novo", now })).toEqual(["b", "c"]);
  });
  it("nunca apaga o arquivo recém-enviado, mesmo com data velha (relógio errado)", () => {
    expect(decidePrune([item("novo", 99), item("b", 20), item("ok", 1)], { retentionDays: 14, keep: "novo", now })).toEqual(["b"]);
  });
  it("não apaga nada se deixaria o destino sem nenhum backup", () => {
    expect(decidePrune([item("b", 20), item("c", 30)], { retentionDays: 14, keep: "inexistente", now })).toEqual([]);
  });
  it("sem confirmação do novo (keep nulo), não apaga nada", () => {
    expect(decidePrune([item("a", 1), item("b", 40)], { retentionDays: 14, keep: null, now })).toEqual([]);
  });
});

describe("pg", () => {
  it("a senha vai em variável de ambiente, decodificada, e o sslmode acompanha", () => {
    const env = pgEnvFromUrl("postgresql://us%40er:p%40ss%2Fw@db.exemplo:5433/innochat?sslmode=require&schema=public");
    expect(env).toEqual({ PGHOST: "db.exemplo", PGPORT: "5433", PGDATABASE: "innochat", PGUSER: "us@er", PGPASSWORD: "p@ss/w", PGSSLMODE: "require" });
  });
  it("URL inválida lança sem ecoar o conteúdo", () => {
    expect(() => pgEnvFromUrl("isto não é url com senha123")).toThrow(/inválida/);
    try {
      pgEnvFromUrl("isto não é url com senha123");
    } catch (e) {
      expect(String(e)).not.toContain("senha123");
    }
  });
  it("lê a versão do pg_dump e acusa cliente mais velho que o servidor", () => {
    expect(parsePgDumpMajor("pg_dump (PostgreSQL) 18.1")).toBe(18);
    expect(parsePgDumpMajor("pg_dump (PostgreSQL) 17.6")).toBe(17);
    expect(pgVersionProblem(17, 18)).toMatch(/versão 17.*versão 18/);
    expect(pgVersionProblem(18, 17)).toBeNull();
    expect(pgVersionProblem(18, 18)).toBeNull();
  });
  it("conta tabelas com dados no índice do dump", () => {
    expect(countTablesWithData("1; 0 0 TABLE public a\n2; 0 0 TABLE DATA public a x\n3; 0 0 TABLE DATA public b x")).toBe(2);
    expect(countTablesWithData("1; 0 0 TABLE public a")).toBe(0);
  });
});

describe("lateStatus", () => {
  const now = new Date("2026-10-02T12:00:00Z");
  const h = 3_600_000;
  const cfg = { enabled: true, alertAfterHours: 36, lastSuccessAt: null as Date | null };
  it("desligado nunca atrasa", () => {
    expect(lateStatus({ ...cfg, enabled: false }, now, null).late).toBe(false);
  });
  it("dentro do limite está em dia; passou, atrasa a partir de lastSuccess + limite", () => {
    expect(lateStatus({ ...cfg, lastSuccessAt: new Date(now.getTime() - 35 * h) }, now, null).late).toBe(false);
    const late = lateStatus({ ...cfg, lastSuccessAt: new Date(now.getTime() - 40 * h) }, now, null);
    expect(late.late).toBe(true);
    expect(late.ageHours).toBe(40);
    expect(late.lateSince?.getTime()).toBe(now.getTime() - 40 * h + 36 * h);
  });
  it("nunca rodou: só atrasa depois do limite desde a última alteração da configuração", () => {
    expect(lateStatus(cfg, now, new Date(now.getTime() - 2 * h)).late).toBe(false);
    const never = lateStatus(cfg, now, new Date(now.getTime() - 50 * h));
    expect(never.late).toBe(true);
    expect(never.never).toBe(true);
  });
});

describe("e-mails: voz humana e nada de segredo", () => {
  const all = [
    failureMail({ code: "FOLDER", detail: "A pasta do Google Drive não está acessível.", destination: "DRIVE", adminUrl: "https://app.exemplo.com" }),
    failureMail({ code: "DUMP", detail: "pg_dump falhou.", destination: null, adminUrl: null }),
    lateMail({ status: { late: true, never: false, ageHours: 40, lateSince: new Date() }, alertAfterHours: 36, adminUrl: "https://app.exemplo.com/" }),
    lateMail({ status: { late: true, never: true, ageHours: null, lateSince: new Date() }, alertAfterHours: 36, adminUrl: null }),
    googleConnectedMail({ adminName: "Ana", adminEmail: "ana@x.com", previousEmail: null, newEmail: "dono@gmail.com", adminUrl: null }),
  ];
  it("sem travessão (guia de voz)", () => {
    for (const m of all) {
      expect(m.subject).not.toContain("—");
      expect(m.text).not.toContain("—");
    }
  });
  it("a causa vai no assunto e o link da tela no corpo, sem barra dupla", () => {
    expect(all[0].subject).toMatch(/pasta do Google Drive/);
    expect(all[0].text).toContain("https://app.exemplo.com/admin/backup");
    expect(all[2].text).toContain("https://app.exemplo.com/admin/backup");
    expect(all[2].text).not.toContain("com//admin");
  });
  it("o html escapa o texto", () => {
    const m = failureMail({ code: "DUMP", detail: "<script>alert(1)</script>", destination: null, adminUrl: null });
    expect(m.html).not.toContain("<script>");
  });
  it("atrasado diz quantas horas, e nunca rodou diz que nunca rodou", () => {
    expect(all[2].text).toContain("40 horas");
    expect(all[3].subject).toContain("nunca rodou");
  });
});
