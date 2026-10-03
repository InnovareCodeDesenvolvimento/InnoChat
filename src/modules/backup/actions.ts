"use server";

import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { runAction, type Result } from "@/lib/result";
import { DomainError } from "@/lib/errors";
import { pagingInputShape, type PageInfo } from "@/modules/billing/paging";
import { platformAdminActor, recordAudit } from "@/modules/audit/record";
import { diffChanges, type AuditChanges } from "@/modules/audit/sanitize";
import { requireProof } from "@/modules/two-factor/service";
import { REPLACE_KEY_CONFIRMATION } from "./policy";
import type { GeneratedBackupKey, VerifyResult } from "./service";
import {
  BackupError,
  configForPanel,
  disconnectGoogle,
  generateBackupEncryptionKey,
  getBackupStatus,
  listBackupRuns,
  loadBackupConfig,
  runBackup,
  saveBackupConfig,
  startGoogleConnection,
  testBackupConnection,
  verifyLatestBackup,
  type BackupConfigView,
  type BackupRunView,
  type BackupStatusView,
} from "./service";

/**
 * Server Actions da tela Admin > Backup. TODAS atrás de `requirePlatformAdmin()`. Nenhuma devolve
 * segredo: só o que `configForPanel` lista. Restaurar NÃO existe aqui, de propósito (docs/runbook.md).
 */

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

const saveSchema = z.object({
  enabled: z.boolean().optional(),
  hourLocal: z.number().int().min(0).max(23).optional(),
  retentionDays: z.number().int().min(1).max(365).optional(),
  // Mínimo de 6 h: limite curto transforma o alerta em barulho diário, e alerta barulhento é silenciado.
  alertAfterHours: z.number().int().min(6).max(720).optional(),
  destination: z.enum(["S3", "DRIVE"]).nullable().optional(),
  driveMode: z.enum(["SERVICE_ACCOUNT", "OAUTH"]).optional(),
  s3Endpoint: z.string().trim().url("O endereço do bucket precisa começar com https://").startsWith("https://", "O endereço do bucket precisa começar com https://").max(255).nullable().optional().or(z.literal("")),
  s3Bucket: optionalText(255),
  s3Region: optionalText(60),
  s3Prefix: optionalText(120),
  s3AccessKey: optionalText(255),
  s3SecretKey: z.string().trim().max(500).optional(),
  driveFolderId: optionalText(300),
  driveServiceAccountKey: z.string().max(20_000).optional(),
  driveOauthClientId: optionalText(255),
  driveOauthClientSecret: z.string().trim().max(500).optional(),
});

/** Campo de texto vazio vira `null` (apagar), exceto os segredos, em que vazio significa "manter". */
function emptyToNull<T extends Record<string, unknown>>(data: T, keys: string[]): T {
  const out: Record<string, unknown> = { ...data };
  for (const key of keys) if (out[key] === "") out[key] = null;
  return out as T;
}

export type BackupPanelData = {
  config: BackupConfigView;
  status: BackupStatusView;
  runs: { items: BackupRunView[] } & PageInfo;
};

export async function getBackupPanelAction(input?: unknown): Promise<Result<BackupPanelData>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    const paging = z.object(pagingInputShape).parse(input ?? {});
    const [config, status, runs] = await Promise.all([loadBackupConfig(), getBackupStatus(), listBackupRuns(paging)]);
    return { config: configForPanel(config), status, runs };
  });
}

export async function listBackupRunsAction(input?: unknown): Promise<Result<{ items: BackupRunView[] } & PageInfo>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    return listBackupRuns(z.object(pagingInputShape).parse(input ?? {}));
  });
}

export async function saveBackupConfigAction(input: unknown): Promise<Result<{ config: BackupConfigView }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const parsed = saveSchema.parse(input);
    const data = emptyToNull(parsed, ["s3Endpoint", "s3Bucket", "s3Region", "s3Prefix", "s3AccessKey", "driveFolderId", "driveOauthClientId"]);
    const before = configForPanel(await loadBackupConfig());
    const { config } = await saveBackupConfig(data as Parameters<typeof saveBackupConfig>[0], admin.id);
    const changes: AuditChanges = diffChanges(before, config, ["enabled", "hourLocal", "retentionDays", "alertAfterHours", "destination", "driveMode", "s3Endpoint", "s3Bucket", "s3Region", "s3Prefix", "driveFolderId", "driveOauthClientId"]);
    // Segredos: só o fato de terem sido trocados (o histórico redige o valor de qualquer campo com esse tipo de nome).
    for (const secret of ["s3AccessKey", "s3SecretKey", "driveServiceAccountKey", "driveOauthClientSecret"] as const) {
      const sent = data[secret];
      if (typeof sent === "string" && sent.trim() !== "") changes[secret] = { de: null, para: null };
    }
    if (Object.keys(changes).length > 0) {
      await recordAudit({
        tenantId: null,
        actor: platformAdminActor(admin.id),
        action: "backup.config_changed",
        targetType: "backup",
        summary: `Alterou a configuração do backup: ${Object.keys(changes).join(", ")}. Valores de segredo não são guardados.`,
        changes,
      });
    }
    return { config };
  });
}

export async function testBackupConnectionAction(): Promise<Result<{ message: string }>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    return testBackupConnection();
  });
}

export type RunBackupNowResult = { sizeBytes: number; tablesWithData: number; sentToDestination: boolean; message: string };

/**
 * "Fazer backup agora": prova o caminho inteiro antes de confiar no agendamento. Sem destino ele
 * ainda dumpa e confere, mas vale como teste, não como backup, e a resposta diz isso.
 */
export async function runBackupNowAction(): Promise<Result<RunBackupNowResult>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    try {
      const r = await runBackup({ trigger: "MANUAL", createdById: admin.id });
      const sent = r.objectKey !== null;
      await recordAudit({
        tenantId: null,
        actor: platformAdminActor(admin.id),
        action: "backup.run_manual",
        targetType: "backup",
        summary: sent ? "Fez um backup agora e enviou ao destino." : "Fez um backup de teste agora (sem destino configurado, não foi enviado).",
      });
      return {
        sizeBytes: r.sizeBytes,
        tablesWithData: r.tablesWithData,
        sentToDestination: sent,
        message: sent
          ? "Backup feito e enviado ao destino."
          : "A cópia foi gerada e conferida, mas NÃO foi enviada para lugar nenhum porque falta configurar o destino. Vale como teste, não como backup.",
      };
    } catch (error) {
      // Erro de backup é operacional e a mensagem é feita para uma pessoa ler.
      if (error instanceof BackupError) throw new DomainError(`BACKUP_${error.code}`, error.message);
      throw error;
    }
  });
}

export async function startGoogleConnectionAction(): Promise<Result<{ url: string }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    return startGoogleConnection(admin.id);
  });
}

export async function disconnectGoogleAction(): Promise<Result<{ ok: true }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    await disconnectGoogle(admin.id);
    await recordAudit({ tenantId: null, actor: platformAdminActor(admin.id), action: "backup.google_disconnected", targetType: "backup", summary: "Desconectou a conta do Google Drive do backup." });
    return { ok: true as const };
  });
}

const generateKeySchema = z.object({ replace: z.boolean().optional(), confirmation: z.string().max(100).optional(),
  // Prova de que é o dono da conta (só para trocar a chave): a senha OU um código da verificação em 2 etapas.
  password: z.string().max(200).optional(),
  code: z.string().max(50).optional(),
});

/**
 * Gera a chave de criptografia do backup. A chave inteira volta NESTA resposta e em nenhuma outra: a
 * tela mostra uma vez, com cópia e download, e depois só a impressão digital. A resposta não pode ser
 * guardada em cache nem logada.
 */
export async function generateBackupKeyAction(input?: unknown): Promise<Result<GeneratedBackupKey>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const parsed = generateKeySchema.parse(input ?? {});
    const replace = parsed.replace === true;
    if (replace && parsed.confirmation?.trim() !== REPLACE_KEY_CONFIRMATION) {
      throw new DomainError("BACKUP_KEY_CONFIRMATION", `Para trocar a chave, digite ${REPLACE_KEY_CONFIRMATION} no campo de confirmação.`);
    }
    // Sessão sequestrada não troca a chave sozinha: pede a senha ou o código de novo (limite de tentativas incluso).
    if (replace) await requireProof(admin.id, { password: parsed.password, code: parsed.code });
    const generated = await generateBackupEncryptionKey(admin.id, { replace });
    // Só a impressão digital (que a própria tela mostra); a chave inteira nunca passa por aqui.
    await recordAudit({
      tenantId: null,
      actor: platformAdminActor(admin.id),
      action: "backup.key_generated",
      targetType: "backup",
      summary: generated.replaced ? "Trocou a chave de criptografia do backup." : "Gerou a chave de criptografia do backup.",
      changes: { impressaoDigital: { de: null, para: generated.fingerprint } },
    });
    return generated;
  });
}

/** "Conferir backup": baixa a cópia mais recente, decifra e lê o índice do dump. Não escreve em banco nenhum. */
export async function verifyBackupAction(): Promise<Result<VerifyResult>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    try {
      return await verifyLatestBackup({ trigger: "MANUAL", createdById: admin.id });
    } catch (error) {
      if (error instanceof BackupError) throw new DomainError(`BACKUP_${error.code}`, error.message);
      throw error;
    }
  });
}
