import { NextResponse } from "next/server";
import { handleInternalRoute } from "@/lib/api-internal/respond";
import { ClaimRequestSchema } from "@/lib/api-internal/schemas";
import { claimMessage } from "@/modules/bot-api/claim";
import { flowVersionOf } from "@/modules/bot-api/flow-version";
import { resolveInternalRequest } from "@/modules/bot-api/internal-auth";

/**
 * `POST /api/internal/v1/messages/claim` (docs/arquitetura.md §6.2). Primeira chamada de toda
 * execução do workflow `innochat-bot`. Nunca devolve 5xx para um payload irreconhecível — isso é
 * garantido dentro de `claimMessage`/`normalizeEvolutionMessage`, não aqui.
 */
export async function POST(req: Request) {
  return handleInternalRoute(req, async () => {
    const ctx = await resolveInternalRequest(req);
    const body = ClaimRequestSchema.parse(await req.json().catch(() => ({})));
    const result = await claimMessage(ctx, body.payload, { flow: flowVersionOf(req) });
    return NextResponse.json(result, { status: 200 });
  });
}
