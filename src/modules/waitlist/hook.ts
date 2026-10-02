import { logger } from "@/lib/logger";

/**
 * Ponte leve entre a agenda e a lista de espera. `appointments.ts` importa SÓ este arquivo; o motor
 * de oferta (`offer.ts`, que puxa envio de WhatsApp, textos e assinatura) entra por `import()`
 * dinâmico, no momento em que um horário abre. Assim a agenda não carrega o módulo de mensagens
 * (que, por outro caminho, já importa a agenda) e não nasce ciclo de módulos.
 */

export type FreedRange = { professionalId: string; from: Date; to: Date };

const pending = new Set<Promise<unknown>>();

/** Um horário abriu (cancelamento ou remarcação). Roda em segundo plano e nunca lança. */
export function notifySlotFreed(tenantId: string, freed: FreedRange): void {
  const task = import("./offer")
    .then((m) => {
      m.scheduleOfferForFreedSlot(tenantId, freed);
      return m.drainWaitlistTriggers();
    })
    .catch((error) => {
      logger.error("waitlist.hook_failed", { tenantId, errorName: error instanceof Error ? error.name : "unknown" });
    });
  pending.add(task);
  void task.finally(() => pending.delete(task));
}

/** Para testes: espera os gatilhos em andamento terminarem. */
export async function drainWaitlistHook(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled(Array.from(pending));
}
