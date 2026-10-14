import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { isDomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { buildRescueLeadsCsv } from "@/modules/rescue/csv";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const querySchema = z.object({
  status: z.string().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from deve ser AAAA-MM-DD").optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to deve ser AAAA-MM-DD").optional(),
  search: z.string().optional(),
});

const HTTP_STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  TWO_FACTOR_SETUP_REQUIRED: 403,
  INVALID_PAYLOAD: 400,
};

function problem(code: string, message: string, status: number) {
  return NextResponse.json({ error: { code, message } }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request) {
  try {
    const admin = await requirePlatformAdmin();
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    const query = querySchema.parse({
      status: params.status || undefined,
      from: params.from || undefined,
      to: params.to || undefined,
      search: params.search || undefined,
    });

    const { filename, csv, count } = await buildRescueLeadsCsv(query);
    logger.info("rescue.leads.csv_exported", { adminId: admin.id, count, status: query.status ?? "ALL" });

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
    logger.error("rescue.leads.csv_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    return problem("INTERNAL_ERROR", "Não foi possível gerar a planilha de leads agora.", 500);
  }
}
