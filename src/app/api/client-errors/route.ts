import { NextResponse } from "next/server";
import { clientIp } from "@/lib/http/client-ip";
import { CLIENT_ERROR_MAX_BODY_BYTES, handleClientErrorReport, isSameOrigin, readBodyWithLimit } from "@/modules/error-monitor/client-report";

/**
 * `POST /api/client-errors`: relato de erro do navegador (error boundary, `window.onerror`, promessa rejeitada).
 * Sem login obrigatório (a tela de login também pode quebrar), mas sem aceitar lixo: mesma origem, corpo de até 16 KB,
 * formato validado, limite por IP e global. Resposta: 202 sem corpo útil; 400/413/429 com `{ error: { code, message } }`.
 * Nunca devolve detalhe interno e nunca lança: o navegador não tem o que fazer com um erro do relato.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" } as const;

async function sessionUserId(): Promise<string | null> {
  try {
    const { auth } = await import("@/lib/auth");
    const session = await auth();
    return typeof session?.user?.id === "string" ? session.user.id : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  if (!isSameOrigin(request.headers.get("origin"), request.headers.get("host"))) {
    return NextResponse.json({ error: { code: "FORBIDDEN_ORIGIN", message: "Origem não permitida." } }, { status: 403, headers: NO_STORE });
  }

  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > CLIENT_ERROR_MAX_BODY_BYTES) {
    return NextResponse.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Relato grande demais." } }, { status: 413, headers: NO_STORE });
  }
  let rawBody: string | null;
  try {
    // Com limite mesmo sem `Content-Length` (chunked): nunca bufferiza mais que o teto.
    rawBody = await readBodyWithLimit(request, CLIENT_ERROR_MAX_BODY_BYTES);
  } catch {
    return NextResponse.json({ error: { code: "INVALID_PAYLOAD", message: "Relato inválido." } }, { status: 400, headers: NO_STORE });
  }

  if (rawBody === null) {
    return NextResponse.json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Relato grande demais." } }, { status: 413, headers: NO_STORE });
  }

  const ip = await clientIp();
  const host = request.headers.get("host");
  const outcome = await handleClientErrorReport({
    rawBody,
    contentLength: Number.isFinite(declared) ? declared : null,
    ip,
    appHost: host,
    resolveUserId: sessionUserId,
  });

  if (outcome.status === 202) return new NextResponse(null, { status: 202, headers: NO_STORE });
  return NextResponse.json(
    { error: { code: outcome.code, message: outcome.message } },
    { status: outcome.status, headers: { ...NO_STORE, ...(outcome.retryAfterSeconds ? { "Retry-After": String(outcome.retryAfterSeconds) } : {}) } },
  );
}
