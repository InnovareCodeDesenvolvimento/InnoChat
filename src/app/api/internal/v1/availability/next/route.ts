import { NextResponse } from "next/server";
import { handleInternalRoute } from "@/lib/api-internal/respond";
import { AvailabilityNextQuerySchema } from "@/lib/api-internal/schemas";
import { listNextAvailableSlots } from "@/modules/bot-api/booking-bot";
import { resolveInternalRequest } from "@/modules/bot-api/internal-auth";

/** `GET /api/internal/v1/availability/next` — próximos horários livres em qualquer dia (bot v2 §3.6). */
export async function GET(req: Request) {
  return handleInternalRoute(req, async () => {
    const ctx = await resolveInternalRequest(req);
    const query = AvailabilityNextQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
    const result = await listNextAvailableSlots(ctx.tenantId, {
      serviceId: query.serviceId,
      professionalId: query.professionalId ?? null,
      limit: query.limit,
    });
    return NextResponse.json(result, { status: 200 });
  });
}
