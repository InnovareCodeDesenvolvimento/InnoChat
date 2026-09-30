import { NextResponse } from "next/server";
import { handleInternalRoute } from "@/lib/api-internal/respond";
import { UpdateSessionV2RequestSchema } from "@/lib/api-internal/schemas-conversa";
import { resolveInternalRequest } from "@/modules/bot-api/internal-auth";
import { updateSession } from "@/modules/bot-api/session";

/** `PUT /api/internal/v1/sessions/{id}` (docs/arquitetura.md §6.3). */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleInternalRoute(req, async () => {
    const ctx = await resolveInternalRequest(req);
    const { id } = await params;
    const body = UpdateSessionV2RequestSchema.parse(await req.json());
    const result = await updateSession(ctx, id, body);
    return NextResponse.json(result, { status: 200 });
  });
}
