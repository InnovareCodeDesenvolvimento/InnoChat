import { NextResponse } from "next/server";
import { handleInternalRoute } from "@/lib/api-internal/respond";
import { WaitlistLeaveRequestSchema } from "@/lib/api-internal/schemas";
import { resolveInternalRequest } from "@/modules/bot-api/internal-auth";
import { leaveWaitlistBot } from "@/modules/bot-api/waitlist-bot";

/** `POST /api/internal/v1/waitlist/{id}/leave`: o cliente sai da fila (idempotente). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleInternalRoute(req, async () => {
    const ctx = await resolveInternalRequest(req);
    const { id } = await params;
    const body = WaitlistLeaveRequestSchema.parse(await req.json());
    return NextResponse.json(await leaveWaitlistBot(ctx, id, body.contactId), { status: 200 });
  });
}
