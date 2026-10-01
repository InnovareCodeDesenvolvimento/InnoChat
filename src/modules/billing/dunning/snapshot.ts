import { subDays } from "date-fns";
import { getPrisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import type { Prisma } from "@/lib/db/types";
import { safeTimezone, usesTrialRules, type DunningInput } from "@/core/billing";
import { manualSuspensionPeriodEnds } from "./events";

/**
 * Carrega o retrato que o planejador puro (`src/core/billing/dunning.ts`) precisa. O tick, o despachante
 * (que reconfere antes de enviar) e o sino do painel montam o MESMO `DunningInput`, então "devido" quer
 * dizer a mesma coisa nos três lugares.
 */

export type DunningSubject = {
  input: DunningInput;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  planPriceCents: number;
};

/** Cancelamentos recentes ainda entram na varredura (aviso de encerramento automático e autocura). */
const RECENT_CANCEL_DAYS = 4;

type LoadedSubscription = Awaited<ReturnType<typeof loadRaw>>[number];

function loadRaw(where: Prisma.SubscriptionWhereInput, take?: number) {
  return getPrisma().subscription.findMany({
    where,
    include: {
      tenant: { select: { id: true, name: true, slug: true, timezone: true } },
      plan: { select: { priceCents: true } },
      invoices: { where: { status: "OPEN" }, orderBy: { periodStart: "desc" }, take: 1, select: { id: true, dueAt: true, createdAt: true, isTrialConversion: true } },
    },
    orderBy: { currentPeriodEnd: "asc" },
    ...(take ? { take } : {}),
  });
}

async function toSubjects(rows: LoadedSubscription[], now: Date): Promise<DunningSubject[]> {
  if (rows.length === 0) return [];
  const prisma = getPrisma();
  const suspendedIds = rows.filter((r) => r.status === "SUSPENDED" || r.status === "PAST_DUE").map((r) => r.id);
  const manual = await manualSuspensionPeriodEnds(suspendedIds);
  const trialTenantIds = rows.filter((r) => r.status !== "CANCELED" && usesTrialRules(r)).map((r) => r.tenantId);
  const connected = new Set<string>();
  if (trialTenantIds.length > 0) {
    const instances = await prisma.whatsappInstance.findMany({
      where: { tenantId: { in: trialTenantIds }, deletedAt: null, sandbox: false, status: "CONNECTED" },
      select: { tenantId: true },
    });
    for (const i of instances) connected.add(i.tenantId);
  }
  void now;
  return rows.map((r) => {
    const invoice = r.invoices[0] ?? null;
    return {
      tenantId: r.tenantId,
      tenantName: r.tenant.name,
      tenantSlug: r.tenant.slug,
      planPriceCents: r.plan.priceCents,
      input: {
        timezone: safeTimezone(r.tenant.timezone),
        subscription: {
          id: r.id,
          status: r.status,
          currentPeriodEnd: r.currentPeriodEnd,
          trialEndsAt: r.trialEndsAt,
          firstPaidAt: r.firstPaidAt,
          cancelAtPeriodEnd: r.cancelAtPeriodEnd,
          canceledAt: r.canceledAt,
          cancelRequestedAt: r.cancelRequestedAt,
          createdAt: r.createdAt,
        },
        openInvoice: invoice,
        // Coluna é o marcador robusto; o evento MANUAL_SUSPEND do mesmo ciclo cobre quem o backfill não alcançou.
        manualSuspension: r.manualSuspendedAt !== null || (manual.get(r.id)?.has(r.currentPeriodEnd.toISOString()) ?? false),
        whatsappConnected: connected.has(r.tenantId),
      },
    } satisfies DunningSubject;
  });
}

/** Todas as assinaturas que a régua acompanha: as vivas e as canceladas há pouco. */
export async function loadDunningSubjects(now: Date, take = 2000): Promise<DunningSubject[]> {
  const rows = await loadRaw({ OR: [{ status: { not: "CANCELED" } }, { status: "CANCELED", canceledAt: { gte: subDays(now, RECENT_CANCEL_DAYS) } }] }, take);
  // Bateu no teto: o resto da base ficaria sem régua em silêncio. O aviso aparece no log para alguém subir o teto.
  if (rows.length >= take) logger.warn("billing.dunning.snapshot_capped", { take });
  return toSubjects(rows, now);
}

export async function loadDunningSubject(subscriptionId: string, now: Date): Promise<DunningSubject | null> {
  const rows = await loadRaw({ id: subscriptionId });
  return (await toSubjects(rows, now))[0] ?? null;
}
