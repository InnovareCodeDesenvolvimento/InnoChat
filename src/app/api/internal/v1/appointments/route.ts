import { NextResponse } from "next/server";
import { handleInternalRoute } from "@/lib/api-internal/respond";
import { CreateAppointmentRequestSchema } from "@/lib/api-internal/schemas";
import { createAppointmentBot } from "@/modules/bot-api/booking-bot";
import { flowVersionOf } from "@/modules/bot-api/flow-version";
import { resolveInternalRequest } from "@/modules/bot-api/internal-auth";

/**
 * `POST /api/internal/v1/appointments` (docs/arquitetura.md §6.5): `201` na criação real,
 * `422 LIMIT_REACHED` só com `X-InnoChat-Flow: 2`. `200` quando é repetição (mesma `idempotencyKey`, ou mesmo contato+serviço+início já
 * `SCHEDULED` — `createAppointmentManual`, Fase 2, reaproveitado sem alteração de contrato).
 */
export async function POST(req: Request) {
  return handleInternalRoute(req, async () => {
    const ctx = await resolveInternalRequest(req);
    const body = CreateAppointmentRequestSchema.parse(await req.json());
    const { appointment, alreadyExisted } = await createAppointmentBot(ctx, { ...body, flow: flowVersionOf(req) });
    return NextResponse.json({ appointment }, { status: alreadyExisted ? 200 : 201 });
  });
}
