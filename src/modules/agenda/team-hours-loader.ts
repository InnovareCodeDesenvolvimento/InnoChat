import { getPrisma } from "@/lib/db/prisma";
import { forTenant } from "@/lib/db/tenant-client";
import { teamOpening, type ClosedRange, type WorkingHourRule } from "@/core/agenda";

const HORIZON_DAYS = 14;

/**
 * Horário da EQUIPE (spec bot v2 §3.10, decisão P4): união dos expedientes dos profissionais
 * ATIVOS + exceções da EMPRESA (as que não pertencem a um profissional). Insumo de
 * `teamOpening` (`src/core/agenda/opening.ts`). `WorkingHour` não tem `tenantId`: o filtro passa
 * pela relação com o profissional, que carrega o tenant.
 */
export async function loadTeamOpeningInputs(
  tenantId: string,
  now: Date,
  horizonDays: number = HORIZON_DAYS,
): Promise<{ workingHours: WorkingHourRule[]; closedRanges: ClosedRange[] }> {
  const to = new Date(now.getTime() + (horizonDays + 2) * 86_400_000);
  const [hours, exceptions] = await Promise.all([
    getPrisma().workingHour.findMany({
      where: { professional: { tenantId, active: true } },
      select: { weekday: true, startTime: true, endTime: true },
    }),
    forTenant(tenantId).scheduleException.findMany({
      where: { professionalId: null, startsAt: { lt: to }, endsAt: { gt: now } },
      select: { startsAt: true, endsAt: true },
    }),
  ]);
  return {
    workingHours: hours.map((h) => ({ weekday: h.weekday, startTime: h.startTime, endTime: h.endTime })),
    closedRanges: exceptions.map((e) => ({ startsAt: e.startsAt, endsAt: e.endsAt })),
  };
}

/** Abertura da equipe agora e a próxima abertura, no fuso da empresa. */
export async function computeTenantTeamOpening(
  tenant: { id: string; timezone: string },
  now: Date,
): Promise<{ openNow: boolean; nextOpenAt: Date | null }> {
  const { workingHours, closedRanges } = await loadTeamOpeningInputs(tenant.id, now);
  return teamOpening({ timezone: tenant.timezone, workingHours, closedRanges, now, horizonDays: HORIZON_DAYS });
}
