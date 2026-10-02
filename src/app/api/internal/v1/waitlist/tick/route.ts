import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { verifyInternalApiSecret } from "@/modules/platform/service";
import { runWaitlistTick } from "@/modules/waitlist/respond";

/**
 * `POST /api/internal/v1/waitlist/tick`: vence as ofertas da lista de espera passadas do prazo e
 * passa o horário ao próximo da fila. Mesma autenticação dos outros ticks (`Authorization: Bearer
 * <INTERNAL_API_SECRET>`, sem `X-InnoChat-Instance`: varre todas as empresas). Idempotente. O prazo
 * da oferta é de minutos, então o ideal é chamar a cada 5 minutos; o tick de cobrança de hora em hora
 * também roda esta varredura como reserva.
 */
export async function POST(req: Request) {
  const authHeader = req.headers.get("authorization") ?? "";
  const secret = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  if (!secret) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Cabeçalho Authorization ausente ou inválido." } }, { status: 401 });
  }
  const settings = await getPrisma().platformSettings.findUnique({ where: { id: 1 }, select: { internalApiSecretHash: true } });
  if (!settings?.internalApiSecretHash || !verifyInternalApiSecret(secret, settings.internalApiSecretHash)) {
    return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Segredo inválido." } }, { status: 401 });
  }
  try {
    return NextResponse.json(await runWaitlistTick(new Date()), { status: 200 });
  } catch (error) {
    logger.error("waitlist.tick.route.unexpected_error", { errorMessage: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: { code: "INTERNAL", message: "Erro ao processar a lista de espera." } }, { status: 500 });
  }
}
