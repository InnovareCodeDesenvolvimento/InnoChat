import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { verifyInternalApiSecret } from "@/modules/platform/service";
import { runBillingTick } from "@/modules/billing/tick";
import { runPlatformWhatsappMaintenance } from "@/modules/platform-whatsapp/connections";

/**
 * `POST /api/internal/v1/billing/tick` (docs/contratos.md — Fase 7). Autenticado com o MESMO
 * segredo interno da API do bot (`Authorization: Bearer <INTERNAL_API_SECRET>`,
 * docs/arquitetura.md §6.1) — mas SEM o header `X-InnoChat-Instance`: este endpoint não é
 * escopado a uma instância/tenant, varre todas as assinaturas. Chamado por um cron externo
 * (n8n Schedule Trigger, fora deste repo) de hora em hora.
 *
 * Implementado no próprio `src/app/api/internal/v1/` (mesma árvore da API do bot, Fase 4) por
 * ser o contrato pedido — arquivo NOVO e isolado (`billing/tick/route.ts`), sem tocar em nenhum
 * arquivo de `messages`/`sessions` da Fase 4. Ver PENDÊNCIAS no handoff sobre essa coincidência
 * de diretório com o trabalho em paralelo.
 *
 * Resposta 200 sempre que autenticado, mesmo se nada mudou (`{ ...summary }` com contadores
 * zerados) — nunca 4xx para "não havia nada a fazer".
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
    // WhatsApp da plataforma (F4), ANTES do envio da régua: encerra QR abandonado, repete o logout de número
    // aposentado e confere o estado na Evolution (assim CHANNEL_DOWN reflete a realidade). Nunca lança.
    await runPlatformWhatsappMaintenance();
    const summary = await runBillingTick(new Date());
    return NextResponse.json(summary, { status: 200 });
  } catch (error) {
    logger.error("billing.tick.route.unexpected_error", { errorMessage: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: { code: "INTERNAL", message: "Erro ao processar o tick de cobrança." } }, { status: 500 });
  }
}
