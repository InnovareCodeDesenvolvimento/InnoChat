"use server";

import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { runAction, type Result } from "@/lib/result";
import { pagingInputShape, type PageSize } from "@/modules/billing/paging";
import { platformAdminActor, recordAudit } from "@/modules/audit/record";
import { listRemoteBackupsCached, probeBackup } from "./restore-service";
import { shouldAuditRemoteListing } from "./restore-cache";
import type {
  ListRemoteBackupsResult,
  ProbeBackupResult,
} from "./restore-types";

export type {
  ListRemoteBackupsResult,
  ProbeBackupInput,
  ProbeBackupResult,
  ProbeKeyMode,
  RemoteBackupItem,
  RemoteBackupSource,
} from "./restore-types";

const listRemoteBackupsSchema = z.object(pagingInputShape);

const probeBackupSchema = z.object({
  ref: z.string().trim().min(5, "Referência do backup é obrigatória."),
  keyMode: z.enum(["SYSTEM", "CUSTOM"]),
  customKeyHex: z.string().trim().max(100).nullable().optional(),
});

/**
 * Server Action para listar backups remotos (Drive ou S3) disponíveis para Restore.
 * Exige requirePlatformAdmin() com 2FA ativa.
 * Registra audit log com a ação "backup.remote_listed".
 */
export async function listRemoteBackupsAction(
  input?: unknown,
  deps: Parameters<typeof listRemoteBackupsCached>[1] = {},
): Promise<Result<ListRemoteBackupsResult>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const parsed = listRemoteBackupsSchema.parse(input ?? {});

    const { result, servedFromCache } = await listRemoteBackupsCached(
      {
        page: parsed.page,
        pageSize: parsed.pageSize as PageSize | undefined,
      },
      deps,
    );

    // Cache de 30s + audit no máximo 1x/5min por admin quando repetir (F5, troca de página):
    // evita bater Drive/S3 e poluir a auditoria a cada carregamento da tela.
    if (shouldAuditRemoteListing(admin.id, servedFromCache)) {
      await recordAudit({
        tenantId: null,
        actor: platformAdminActor(admin.id),
        action: "backup.remote_listed",
        targetType: "backup",
        summary: `Listou backups remotos disponíveis: ${result.totalItems} cópia(s) encontrada(s) (página ${result.page}/${result.totalPages}).`,
      });
    }

    return result;
  });
}

/**
 * Server Action para inspecionar/validar integridade de um backup remoto (Onda 2).
 * Exige requirePlatformAdmin() com 2FA ativa.
 * NUNCA loga nem persiste a customKeyHex: apenas a fingerprint (8 hex) pode aparecer nos logs/auditoria.
 * Registra audit log com a ação "backup.remote_probed".
 */
export async function probeBackupInspectAction(
  input: unknown,
  deps: Parameters<typeof probeBackup>[1] = {},
): Promise<Result<ProbeBackupResult>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const parsed = probeBackupSchema.parse(input);

    const result = await probeBackup(
      {
        ref: parsed.ref,
        keyMode: parsed.keyMode,
        customKeyHex: parsed.customKeyHex,
      },
      deps,
    );

    await recordAudit({
      tenantId: null,
      actor: platformAdminActor(admin.id),
      action: "backup.remote_probed",
      targetType: "backup",
      summary: `Inspecionou integridade do backup "${parsed.ref}": válido=${result.valid}, fingerprint=${result.fingerprint ?? "nenhuma"}, tabelas=${result.tablesWithData}, tamanho=${result.uncompressedSizeBytes}b.`,
    });

    return result;
  });
}

