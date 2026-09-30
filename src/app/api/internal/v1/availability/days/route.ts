import { NextResponse } from "next/server";
import { handleInternalRoute } from "@/lib/api-internal/respond";
import { AvailabilityDaysQuerySchema } from "@/lib/api-internal/schemas";
import { listAvailabilityDayOptions } from "@/modules/bot-api/booking-bot";
import { flowVersionOf } from "@/modules/bot-api/flow-version";
import { resolveInternalRequest } from "@/modules/bot-api/internal-auth";

/** `GET /api/internal/v1/availability/days` (docs/arquitetura.md §6.4). Página padrão: 6 dias no v2, 7 no v1. */
export async function GET(req: Request) {
  return handleInternalRoute(req, async () => {
    const ctx = await resolveInternalRequest(req);
    const url = new URL(req.url);
    const query = AvailabilityDaysQuerySchema.parse(Object.fromEntries(url.searchParams));
    const result = await listAvailabilityDayOptions(ctx.tenantId, {
      serviceId: query.serviceId,
      professionalId: query.professionalId ?? null,
      from: query.from ?? null,
      limit: query.limit ?? (flowVersionOf(req) === 2 ? 6 : 7),
    });
    return NextResponse.json(result, { status: 200 });
  });
}
