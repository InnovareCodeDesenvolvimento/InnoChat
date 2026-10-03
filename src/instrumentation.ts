/**
 * Hook de instrumentação do Next.js — `register()` roda uma vez no boot do servidor, antes de
 * qualquer requisição. Usado só para o bootstrap do primeiro admin da plataforma
 * (docs/contratos.md — "Configuração pela plataforma"): se não houver admin, gera e imprime o
 * código de instalação (`src/modules/platform/install.ts`).
 *
 * Guardado por `NEXT_RUNTIME === "nodejs"`: o Next também chama `register()` no runtime Edge
 * (middleware), onde não há Prisma/Node APIs — sem isso, o boot Edge tentaria importar Prisma e
 * quebraria. Não há migration nem query de escrita pesada aqui (docs/arquitetura.md §14:
 * "migration... nunca no boot") — só leitura de `User` e, na ausência de admin, um `create`
 * pequeno em `PlatformInstallCode`.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { bootstrapInstallCodeIfNeeded } = await import("@/modules/platform/install");
  const { logger, setErrorSink } = await import("@/lib/logger");

  // Monitor de erros (Melhoria 1): todo `logger.error` também vira ocorrência agrupada em Admin > Erros.
  // Fire-and-forget: a captura nunca derruba nem atrasa quem logou.
  try {
    const { captureLoggedError } = await import("@/modules/error-monitor/capture");
    setErrorSink(captureLoggedError);
  } catch {
    // Sem o monitor o app segue normal.
  }

  try {
    await bootstrapInstallCodeIfNeeded();
  } catch (error) {
    // Nunca derruba o boot do servidor por causa disto — sem código de instalação impresso, o
    // operador ainda pode investigar o log e reiniciar o container para tentar de novo.
    logger.error("platform.install.bootstrap_failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }

  // Agendador do backup do banco (Admin > Backup): timer do próprio processo, uma passada a cada
  // 10 min que decide na hora (hora de Brasília + janela de ~20 h entre tentativas). Desligado por
  // padrão: sem o automático ligado na tela, a passada só confere o atraso. Fora de teste de unidade.
  if (!process.env.VITEST) {
    try {
      const { startBackupScheduler } = await import("@/modules/backup/service");
      startBackupScheduler();
    } catch (error) {
      logger.error("backup.scheduler.start_failed", { errorMessage: error instanceof Error ? error.message : String(error) });
    }

    // Lista de espera: de 5 em 5 minutos, oferta vencida passa ao próximo da fila e, ao abrir a janela das 8h, sai o que
    // esperou a noite. Antes dependia da rodada horária da cobrança.
    try {
      const { startWaitlistScheduler } = await import("@/modules/waitlist/scheduler");
      startWaitlistScheduler();
    } catch (error) {
      logger.error("waitlist.scheduler.start_failed", { errorMessage: error instanceof Error ? error.message : String(error) });
    }
  }
}

/**
 * Hook do Next para erro de requisição no servidor (render, rota, Server Action). Entrega ao monitor de erros sem
 * esperar e sem nunca lançar: o próprio Next já está respondendo o erro ao usuário.
 */
export async function onRequestError(
  error: unknown,
  request: { path: string; method: string },
  context: { routePath: string; routeType: string },
) {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { captureRequestError } = await import("@/modules/error-monitor/capture");
    captureRequestError(error, request, context);
  } catch {
    // O monitor jamais pode quebrar a resposta.
  }
}
