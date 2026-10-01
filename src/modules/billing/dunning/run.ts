import { logger } from "@/lib/logger";
import { describeDbError } from "@/lib/db/prisma-errors";
import { planNotices } from "@/core/billing";
import { dispatchDueNotices, emptyDispatchSummary, type DispatchDeps, type DispatchSummary } from "./dispatcher";
import { enqueueNotices } from "./outbox";
import { loadDunningSubjects } from "./snapshot";

/**
 * Uma rodada da régua dentro do `billing/tick`: PLANEJA (planejador puro sobre o estado de cada assinatura,
 * gravação idempotente `ON CONFLICT DO NOTHING`) e DESPACHA (claim, reconferência, envio). Substitui o envio
 * legado do tick (marcas `*SentAt` e o outbox transitório em `ProviderEvent`).
 */

export type DunningRunSummary = { subjects: number; enqueued: number; dispatch: DispatchSummary };

export async function runDunning(now: Date, options: { budget?: { isOver: () => boolean }; deps?: DispatchDeps } = {}): Promise<DunningRunSummary> {
  let enqueued = 0;
  let subjects = 0;
  try {
    const loaded = await loadDunningSubjects(now);
    subjects = loaded.length;
    for (const subject of loaded) {
      if (options.budget?.isOver()) break;
      // Isolado por assinatura: um erro (consulta, gravação) nunca aborta as demais.
      try {
        enqueued += await enqueueNotices({ tenantId: subject.tenantId, subscriptionId: subject.input.subscription.id }, planNotices(subject.input, now));
      } catch (error) {
        logger.warn("billing.dunning.plan_failed", { subscriptionId: subject.input.subscription.id, ...describeDbError(error) });
      }
    }
  } catch (error) {
    logger.error("billing.dunning.load_failed", describeDbError(error));
  }

  let dispatch = emptyDispatchSummary();
  try {
    dispatch = await dispatchDueNotices(now, { budget: options.budget, deps: options.deps });
  } catch (error) {
    logger.error("billing.dunning.dispatch_failed", describeDbError(error));
  }
  return { subjects, enqueued, dispatch };
}
