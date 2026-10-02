import { NextResponse } from "next/server";
import { getPrisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { verifyInternalApiSecret } from "@/modules/platform/service";
import { runBackupTick } from "@/modules/backup/service";

/**
 * `POST /api/internal/v1/backup/tick`: uma passada do agendador de backup (roda o dump se for a hora
 * em Brasília e confere o atraso). O agendador principal é o timer do próprio processo
 * (`src/instrumentation.ts`); esta rota existe para o cron externo (innochat-cron) poder chamar
 * também, como segunda via. É seguro chamar das duas formas: a trava no banco (`runningSince`) e a
 * janela de ~20 h entre tentativas impedem dois backups. Mesma autenticação do `maintenance/tick`
 * (`Authorization: Bearer <INTERNAL_API_SECRET>`, sem `X-InnoChat-Instance`).
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
    return NextResponse.json(await runBackupTick(new Date()), { status: 200 });
  } catch (error) {
    logger.error("backup.tick.route.unexpected_error", { errorName: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ error: { code: "INTERNAL", message: "Erro ao processar o backup agendado." } }, { status: 500 });
  }
}
