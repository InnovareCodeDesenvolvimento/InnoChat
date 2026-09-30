import { NextResponse } from "next/server";
import { handleInternalRoute } from "@/lib/api-internal/respond";
import { ReleaseSessionV2RequestSchema } from "@/lib/api-internal/schemas-conversa";
import { resolveInternalRequest } from "@/modules/bot-api/internal-auth";
import { releaseSession } from "@/modules/bot-api/session";

/** `POST /api/internal/v1/sessions/{id}/release` (docs/arquitetura.md §6.3) — sempre idempotente. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return handleInternalRoute(req, async () => {
    const ctx = await resolveInternalRequest(req);
    const { id } = await params;
    const body = ReleaseSessionV2RequestSchema.parse(await req.json());
    const result = await releaseSession(ctx, id, body.lockToken, { notify: body.notify });
    return NextResponse.json(result, { status: 200 });
  });
}
