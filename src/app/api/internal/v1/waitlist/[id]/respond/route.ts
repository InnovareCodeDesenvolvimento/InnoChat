import { NextResponse } from "next/server";
import { handleInternalRoute } from "@/lib/api-internal/respond";
import { WaitlistRespondRequestSchema } from "@/lib/api-internal/schemas";
import { flowVersionOf } from "@/modules/bot-api/flow-version";
import { resolveInternalRequest } from "@/modules/bot-api/internal-auth";
import { respondWaitlistBot } from "@/modules/bot-api/waitlist-bot";

/**
 * `POST /api/internal/v1/waitlist/{id}/respond`: SIM/NÃO do cliente à oferta de horário.
 * `accept: true` marca o horário (409 `SLOT_TAKEN` se outro canal ocupou; o cliente segue na fila) e
 * `accept: false` sai da fila e passa o horário ao próximo. 409 `OFFER_GONE` = vencida ou já resolvida.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleInternalRoute(req, async () => {
    const ctx = await resolveInternalRequest(req);
    const { id } = await params;
    const body = WaitlistRespondRequestSchema.parse(await req.json());
    return NextResponse.json(await respondWaitlistBot(ctx, id, body, flowVersionOf(req)), { status: 200 });
  });
}
