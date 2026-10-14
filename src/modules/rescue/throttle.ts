import { getPrisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

/**
 * Atualiza `User.lastSeenAt` com throttle de 15 minutos.
 *
 * Se o usuário foi visto há menos de 15 minutos, a operação é noop (sem UPDATE no banco).
 * Se passou >= 15 min ou se lastSeenAt era nulo, atualiza o timestamp e marca a conversão
 * de qualquer RescueLead pendente/em envio para CONVERTED.
 */
export async function touchUserLastSeen(userId: string, now: Date = new Date()): Promise<boolean> {
  if (!userId) return false;

  const prisma = getPrisma();
  const threshold = new Date(now.getTime() - FIFTEEN_MINUTES_MS);

  try {
    // UPDATE condicional atômico: só atualiza se lastSeenAt IS NULL ou <= threshold
    const res = await prisma.user.updateMany({
      where: {
        id: userId,
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lte: threshold } }],
      },
      data: {
        lastSeenAt: now,
      },
    });

    if (res.count > 0) {
      // Se era nulo antes ou se estava em régua de resgate, avança RescueLead para CONVERTED
      await prisma.rescueLead.updateMany({
        where: {
          userId,
          status: { in: ["PENDING", "MESSAGE_1_SENDING", "MESSAGE_1_SENT", "MESSAGE_2_SENDING", "MESSAGE_2_SENT"] },
        },
        data: {
          status: "CONVERTED",
          convertedAt: now,
          nextRunAt: null,
        },
      }).catch((err) => {
        logger.warn("rescue.mark_converted_after_last_seen_failed", {
          userId,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      });

      return true;
    }

    return false;
  } catch (error) {
    logger.warn("rescue.touch_last_seen_failed", {
      userId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
