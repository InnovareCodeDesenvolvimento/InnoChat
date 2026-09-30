import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { InternalApiError } from "@/modules/bot-api/internal-auth";

/**
 * Mapa de `DomainError.code` → status HTTP para a API interna (docs/arquitetura.md §6.1, §6.5).
 * Reaproveita os MESMOS códigos que `src/modules/agenda/appointments.ts`/`catalog.ts` já lançam
 * (Fase 2) — a API interna do bot não inventa um vocabulário de erro paralelo.
 */
const STATUS_BY_CODE: Record<string, number> = {
  NOT_FOUND: 404,
  LOCK_LOST: 409,
  SLOT_TAKEN: 409,
  TOO_LATE: 409,
  INVALID_STATE: 422,
  RULE_VIOLATION: 422,
  INVALID_PAYLOAD: 422,
  INVALID_NAME: 422,
  LIMIT_REACHED: 422,
  INVALID_RANGE: 422,
  HAS_APPOINTMENTS: 422,
  FORBIDDEN: 403,
  UNAUTHENTICATED: 401,
  UNAUTHORIZED: 401,
};

function domainErrorStatus(code: string): number {
  return STATUS_BY_CODE[code] ?? 422;
}

/**
 * Envelope de erro único da API interna (docs/arquitetura.md §6.1):
 * `{ "error": { "code", "message", "details"? } }`. Todo route handler de
 * `src/app/api/internal/v1/**` chama isto — nunca monta a resposta de erro à mão.
 */
export async function handleInternalRoute(req: Request, fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof InternalApiError) {
      return NextResponse.json({ error: { code: error.code, message: error.message, details: error.details } }, { status: error.status });
    }
    if (error instanceof DomainError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message, details: error.details } },
        { status: domainErrorStatus(error.code) },
      );
    }
    if (error instanceof ZodError) {
      const message = error.issues.map((issue) => `${issue.path.join(".") || "(raiz)"}: ${issue.message}`).join("; ");
      return NextResponse.json({ error: { code: "INVALID_PAYLOAD", message: message || "Dados inválidos." } }, { status: 422 });
    }

    // Bug/infra — nunca conteúdo de mensagem no log (src/lib/logger.ts já redige campos sensíveis).
    let pathname = "unknown";
    try {
      pathname = new URL(req.url).pathname;
    } catch {
      // ignore
    }
    logger.error("internal-api.unhandled_error", { path: pathname, error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: { code: "INTERNAL", message: "Erro interno." } }, { status: 500 });
  }
}
