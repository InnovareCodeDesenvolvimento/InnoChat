import { addDays } from "date-fns";
import { getPrisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { dispatchDueNotices, type DispatchDeps } from "./dispatcher";

/**
 * "Pagamento confirmado": sai na hora, por e-mail e WhatsApp, fora da janela de horário (é resposta a uma
 * ação do cliente). As linhas entram no mesmo outbox da régua (chave `invoiceId + PAYMENT_CONFIRMED +
 * canal`), então o webhook reentregue, a conciliação e a baixa manual concorrentes nunca mandam duas vezes,
 * e se o envio imediato falhar o tick reenvia.
 *
 * Teto de tempo no envio imediato: o webhook do Mercado Pago espera resposta rápida.
 */

export const PAYMENT_NOTICE_SEND_TIMEOUT_MS = 10_000;

export async function enqueuePaymentConfirmed(args: { tenantId: string; subscriptionId: string; invoiceId: string; now: Date }): Promise<string[]> {
  const prisma = getPrisma();
  const expiresAt = addDays(args.now, 3);
  await prisma.billingNotice.createMany({
    data: (["EMAIL", "WHATSAPP"] as const).map((channel) => ({
      tenantId: args.tenantId,
      subscriptionId: args.subscriptionId,
      invoiceId: args.invoiceId,
      step: "PAYMENT_CONFIRMED",
      channel,
      cycleKey: args.invoiceId,
      status: "PENDING",
      notBefore: args.now,
      expiresAt,
      nextAttemptAt: args.now,
    })),
    skipDuplicates: true,
  });
  const rows = await prisma.billingNotice.findMany({
    where: { cycleKey: args.invoiceId, step: "PAYMENT_CONFIRMED", status: "PENDING" },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Enfileira e tenta enviar agora (com teto de tempo). Nunca lança: e-mail e WhatsApp não desfazem pagamento. */
export async function notifyPaymentConfirmed(args: { tenantId: string; subscriptionId: string; invoiceId: string; now?: Date; deps?: DispatchDeps }): Promise<void> {
  const now = args.now ?? new Date();
  try {
    const ids = await enqueuePaymentConfirmed({ tenantId: args.tenantId, subscriptionId: args.subscriptionId, invoiceId: args.invoiceId, now });
    if (ids.length === 0) return;
    await Promise.race([
      dispatchDueNotices(now, { onlyIds: ids, deps: args.deps }),
      new Promise((resolve) => setTimeout(resolve, PAYMENT_NOTICE_SEND_TIMEOUT_MS).unref?.()),
    ]);
  } catch (error) {
    logger.error("billing.notice.payment_confirmed_failed", { errorName: error instanceof Error ? error.name : "unknown" });
  }
}
