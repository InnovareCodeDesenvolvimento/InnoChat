import { NextResponse } from "next/server";
import { handleInternalRoute } from "@/lib/api-internal/respond";
import { WaitlistJoinRequestSchema } from "@/lib/api-internal/schemas";
import { resolveInternalRequest } from "@/modules/bot-api/internal-auth";
import { joinWaitlistBot } from "@/modules/bot-api/waitlist-bot";

/**
 * `POST /api/internal/v1/waitlist`: coloca o cliente na lista de espera (melhoria 7). Idempotente: a
 * mesma fila (contato + serviço + dia + profissional) devolve 200 com `alreadyExisted: true`; nova, 201.
 */
export async function POST(req: Request) {
  return handleInternalRoute(req, async () => {
    const ctx = await resolveInternalRequest(req);
    const body = WaitlistJoinRequestSchema.parse(await req.json());
    const result = await joinWaitlistBot(ctx, body);
    return NextResponse.json(result, { status: result.entry.alreadyExisted ? 200 : 201 });
  });
}
