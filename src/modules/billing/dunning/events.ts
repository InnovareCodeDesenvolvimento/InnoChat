import { getPrisma } from "@/lib/db/prisma";
import type { Prisma, SubscriptionStatus } from "@/lib/db/types";
import { logger } from "@/lib/logger";

/**
 * `BillingEvent` (docs/regua-de-cobranca.md §3.2): linha do tempo APPEND-ONLY de assinatura e cobrança
 * (o banco bloqueia UPDATE e DELETE por trigger). Só existe `create`. Serve ao histórico da empresa e ao
 * churn (voluntário x involuntário, `metadata.cancelSource`).
 *
 * Gravar o evento NUNCA derruba a operação de negócio que o originou: erro vira log e segue.
 */

export type BillingEventType =
  | "STATUS_CHANGED"
  | "INVOICE_CREATED"
  | "PAYMENT_CONFIRMED"
  | "CANCELED"
  | "CANCEL_REQUESTED"
  | "CANCEL_UNDONE"
  | "REACTIVATION_STARTED"
  | "PLAN_CHANGED"
  | "MANUAL_PAYMENT"
  | "MANUAL_SUSPEND"
  | "MANUAL_REACTIVATE"
  | "TRIAL_EXTENDED";

export type BillingActorType = "SYSTEM" | "OWNER" | "ADMIN";

/** Origem do cancelamento (voluntário x involuntário), em `metadata.cancelSource` do evento `CANCELED`. */
export type CancelSource = "OWNER" | "AUTO_SUSPENDED" | "TRIAL_NOT_CONVERTED" | "ADMIN";

export type BillingEventInput = {
  tenantId: string;
  subscriptionId: string;
  invoiceId?: string | null;
  type: BillingEventType;
  fromStatus?: SubscriptionStatus | null;
  toStatus?: SubscriptionStatus | null;
  actorType?: BillingActorType;
  actorUserId?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
};

export async function recordBillingEvent(input: BillingEventInput): Promise<void> {
  try {
    await getPrisma().billingEvent.create({
      data: {
        tenantId: input.tenantId,
        subscriptionId: input.subscriptionId,
        invoiceId: input.invoiceId ?? null,
        type: input.type,
        fromStatus: input.fromStatus ?? null,
        toStatus: input.toStatus ?? null,
        actorType: input.actorType ?? "SYSTEM",
        actorUserId: input.actorUserId ?? null,
        metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  } catch (error) {
    logger.warn("billing.event.record_failed", { type: input.type, errorName: error instanceof Error ? error.name : "unknown" });
  }
}

/** `true` se existe `MANUAL_SUSPEND` para este ciclo (a suspensão é do admin, não atraso). */
export async function manualSuspensionPeriodEnds(subscriptionIds: string[]): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  if (subscriptionIds.length === 0) return map;
  const rows = await getPrisma().billingEvent.findMany({
    where: { type: "MANUAL_SUSPEND", subscriptionId: { in: subscriptionIds } },
    select: { subscriptionId: true, metadata: true },
  });
  for (const row of rows) {
    const periodEnd = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? (row.metadata as Record<string, unknown>).currentPeriodEnd : null;
    if (typeof periodEnd !== "string") continue;
    const set = map.get(row.subscriptionId) ?? new Set<string>();
    set.add(periodEnd);
    map.set(row.subscriptionId, set);
  }
  return map;
}
