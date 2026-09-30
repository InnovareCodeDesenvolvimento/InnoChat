import { NextResponse } from "next/server";
import { handleInternalRoute } from "@/lib/api-internal/respond";
import { AvailabilitySlotsQuerySchema } from "@/lib/api-internal/schemas";
import { listAvailabilitySlotOptions } from "@/modules/bot-api/booking-bot";
import { flowVersionOf } from "@/modules/bot-api/flow-version";
import { resolveInternalRequest } from "@/modules/bot-api/internal-auth";

/**
 * `GET /api/internal/v1/availability/slots` (docs/arquitetura.md §6.4). Página padrão: 3 com
 * `near`; senão 7 no v2 e 8 no v1.
 */
export async function GET(req: Request) {
  return handleInternalRoute(req, async () => {
    const ctx = await resolveInternalRequest(req);
    const url = new URL(req.url);
    const query = AvailabilitySlotsQuerySchema.parse(Object.fromEntries(url.searchParams));
    const defaultLimit = query.near ? 3 : flowVersionOf(req) === 2 ? 7 : 8;
    const result = await listAvailabilitySlotOptions(ctx.tenantId, {
      serviceId: query.serviceId,
      professionalId: query.professionalId ?? null,
      date: query.date,
      offset: query.offset,
      limit: query.limit ?? defaultLimit,
      period: query.period ?? null,
      near: query.near ?? null,
    });
    return NextResponse.json(result, { status: 200 });
  });
}
