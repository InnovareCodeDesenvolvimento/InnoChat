import { NextResponse } from "next/server";
import { ZodError, z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { isDomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { platformAdminActor, recordAudit } from "@/modules/audit/record";
import { streamRemoteBackup } from "@/modules/backup/restore-service";

/**
 * GET /api/admin/backup/download?ref=...
 *
 * Faz stream direto do arquivo de backup remoto (.dump.enc ou .dump) para o navegador do admin.
 * Requer requirePlatformAdmin() com 2FA ativa.
 * Audit log: action: "backup.remote_downloaded".
 * NÃO decifra nem restaura: apenas entrega os bytes do backup tal qual estão no destino.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const querySchema = z.object({
  ref: z.string().trim().min(5, "Referência do backup é obrigatória."),
});

const HTTP_STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  TWO_FACTOR_SETUP_REQUIRED: 403,
  BACKUP_REF_INVALID: 400,
  BACKUP_DESTINATION_MISSING: 400,
  BACKUP_DOWNLOAD_FAILED: 502,
};

function problem(code: string, message: string, status: number) {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request) {
  try {
    const admin = await requirePlatformAdmin();
    const url = new URL(request.url);
    const parsed = querySchema.parse({ ref: url.searchParams.get("ref") ?? "" });

    const result = await streamRemoteBackup(parsed.ref);

    await recordAudit({
      tenantId: null,
      actor: platformAdminActor(admin.id),
      action: "backup.remote_downloaded",
      targetType: "backup",
      summary: `Baixou o arquivo de backup remoto "${result.fileName}" (${parsed.ref}).`,
    });

    const headers = new Headers({
      "Content-Type": result.contentType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${result.fileName}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });

    if (result.sizeBytes !== null && result.sizeBytes > 0) {
      headers.set("Content-Length", String(result.sizeBytes));
    }

    return new Response(result.stream, {
      status: 200,
      headers,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      const message = error.issues.map((i) => i.message).join("; ");
      return problem("BACKUP_REF_INVALID", message, 400);
    }
    if (isDomainError(error)) {
      const status = HTTP_STATUS[error.code] ?? 400;
      return problem(error.code, error.message, status);
    }
    logger.error("backup.download.route_failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return problem("INTERNAL_ERROR", "Não foi possível baixar o backup agora.", 500);
  }
}
