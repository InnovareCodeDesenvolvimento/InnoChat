import { NextResponse } from "next/server";
import { handleInternalRoute } from "@/lib/api-internal/respond";
import { resolveInternalRequest } from "@/modules/bot-api/internal-auth";
import { listWaitlistBot } from "@/modules/bot-api/waitlist-bot";

/** `GET /api/internal/v1/contacts/{contactId}/waitlist`: filas ativas do cliente (no máximo 10). */
export async function GET(req: Request, { params }: { params: Promise<{ contactId: string }> }) {
  return handleInternalRoute(req, async () => {
    const ctx = await resolveInternalRequest(req);
    const { contactId } = await params;
    return NextResponse.json(await listWaitlistBot(ctx, contactId), { status: 200 });
  });
}
