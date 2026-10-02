import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { requireTenantMember } from "@/lib/auth/guards";
import { isDomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { buildReportCsv } from "@/modules/reports/csv";
import { getReport } from "@/modules/reports/service";

/**
 * GET /api/reports/csv?tenant=<slug>&periodo=this_month|last_month|last_30_days|custom&de=AAAA-MM-DD&ate=AAAA-MM-DD
 * Só o dono da empresa (STAFF recebe 403; quem não é da empresa recebe 404, como no resto do painel). O período é
 * em dias do fuso da empresa, com teto de 366 dias. Erros em JSON estruturado (`{ error: { code, message } }`).
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const querySchema = z.object({
  tenant: z.string().min(1).max(100),
  periodo: z.enum(["this_month", "last_month", "last_30_days", "custom"]).optional(),
  de: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "de deve ser AAAA-MM-DD").optional(),
  ate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ate deve ser AAAA-MM-DD").optional(),
});

const HTTP_STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INVALID_PAYLOAD: 400,
};

function problem(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  try {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    const query = querySchema.parse({
      tenant: params.tenant,
      periodo: params.periodo || undefined,
      de: params.de || undefined,
      ate: params.ate || undefined,
    });
    const { tenant, user } = await requireTenantMember(query.tenant, ["OWNER"]);
    const report = await getReport(tenant.id, tenant.timezone, { preset: query.periodo, from: query.de, to: query.ate });
    const { filename, csv, rows } = buildReportCsv(report.groups, report.range);
    logger.info("reports.csv_exported", { tenantId: tenant.id, userId: user.id, rows });
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return problem("INVALID_PAYLOAD", error.issues.map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`).join("; "), 400);
    }
    if (isDomainError(error)) return problem(error.code, error.message, HTTP_STATUS[error.code] ?? 400);
    logger.error("reports.csv_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    return problem("INTERNAL_ERROR", "Não foi possível gerar o arquivo agora.", 500);
  }
}
