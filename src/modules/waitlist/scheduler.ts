import { withAdvisoryLock } from "@/lib/db/advisory-lock";
import { logger } from "@/lib/logger";
import { runWaitlistTick } from "./respond";

/** A cada quanto a fila de espera é conferida: oferta vencida passa ao próximo e a janela 8h-21h libera o que esperou. */
export const WAITLIST_TICK_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Uma passada da lista de espera no próprio processo. A trava no banco impede duas passadas ao mesmo tempo (outra
 * instância, ou a rodada do `billing/tick` e do `POST /waitlist/tick`, que continuam valendo). Nunca lança.
 */
export async function runWaitlistSchedulerPass(): Promise<void> {
  try {
    const result = await withAdvisoryLock("innochat:waitlist-tick", () => runWaitlistTick(new Date()));
    if (result.acquired) {
      const s = result.value;
      if (s.offersExpired || s.acceptedRecovered || s.pastEntriesExpired || s.windowOffers) {
        logger.info("waitlist.scheduler.pass", { ...s });
      }
    }
  } catch (error) {
    logger.warn("waitlist.scheduler.pass_failed", { errorMessage: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * Liga o timer de 5 em 5 minutos (mesmo padrão do agendador do backup). Guardado em `globalThis` para não nascer
 * duas vezes no mesmo processo. Devolve `null` se já estava ligado.
 */
export function startWaitlistScheduler(intervalMs: number = WAITLIST_TICK_INTERVAL_MS): NodeJS.Timeout | null {
  const g = globalThis as { __innochatWaitlistTimer__?: NodeJS.Timeout };
  if (g.__innochatWaitlistTimer__) return null;
  const timer = setInterval(() => void runWaitlistSchedulerPass(), intervalMs);
  timer.unref?.();
  g.__innochatWaitlistTimer__ = timer;
  return timer;
}
