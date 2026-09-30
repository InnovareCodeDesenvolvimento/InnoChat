import { NextResponse } from "next/server";
import { handleInternalRoute } from "@/lib/api-internal/respond";
import { CatalogServicesQuerySchema } from "@/lib/api-internal/schemas";
import { listCatalogServiceOptions } from "@/modules/bot-api/booking-bot";
import { resolveInternalRequest } from "@/modules/bot-api/internal-auth";

/**
 * `GET /api/internal/v1/catalog/services[?contactId]` (docs/arquitetura.md §6.4, bot v2 §3.4).
 * Só serviços agendáveis (profissional ativo com expediente). Com `contactId`, devolve também
 * `limit` (agendamentos futuros); contato de outro tenant → 404.
 */
export async function GET(req: Request) {
  return handleInternalRoute(req, async () => {
    const ctx = await resolveInternalRequest(req);
    const query = CatalogServicesQuerySchema.parse(Object.fromEntries(new URL(req.url).searchParams));
    const result = await listCatalogServiceOptions(ctx.tenantId, { contactId: query.contactId ?? null });
    return NextResponse.json(result, { status: 200 });
  });
}
