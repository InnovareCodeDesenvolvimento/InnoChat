import { addMinutes } from "date-fns";
import { computeAvailableSlots } from "@/core/agenda";
import type { BusyRange } from "@/core/agenda";
import { desiredDateToISO, pickSlotForPreference } from "@/core/waitlist/match";
import { getPrisma } from "@/lib/db/prisma";
import { forTenant } from "@/lib/db/tenant-client";
import { loadProfessionalScheduleInputs } from "@/modules/agenda/availability-loader";

/**
 * Descobre, para uma entrada da lista de espera, QUAL horário concreto cabe agora. É o mesmo cálculo
 * de disponibilidade da agenda (`computeAvailableSlots` sobre expediente, bloqueios e agendamentos),
 * mais as ofertas em aberto de OUTRAS pessoas, que seguram o horário durante o prazo (senão o mesmo
 * horário seria oferecido a duas pessoas, ou a uma pessoa em dois serviços ao mesmo tempo).
 */

export type TenantRules = { timezone: string; slotGranularityMin: number; minLeadTimeMin: number; maxHorizonDays: number };

export type EntryForSlot = {
  id: string;
  serviceId: string;
  professionalId: string | null;
  desiredDate: Date;
  period: string;
  windowStartMin: number | null;
  windowEndMin: number | null;
};

export type SlotChoice = { professionalId: string; startsAt: Date };

/** Profissionais que podem atender o serviço agora (ativos e com vínculo), na ordem do cadastro. */
export async function eligibleProfessionalIds(tenantId: string, serviceId: string): Promise<string[]> {
  const links = await getPrisma().professionalService.findMany({
    where: { serviceId, professional: { tenantId, active: true } },
    select: { professionalId: true },
  });
  const ids = links.map((l) => l.professionalId);
  if (ids.length === 0) return [];
  const professionals = await forTenant(tenantId).professional.findMany({
    where: { id: { in: ids }, active: true },
    select: { id: true, sortOrder: true },
  });
  return professionals.sort((a, b) => a.sortOrder - b.sortOrder).map((p) => p.id);
}

/** Ofertas ainda válidas de outras pessoas, como blocos ocupados da agenda do profissional. */
async function heldOfferRanges(tenantId: string, professionalId: string, around: { from: Date; to: Date }, exceptEntryId: string, now: Date): Promise<BusyRange[]> {
  const offers = await forTenant(tenantId).waitlistEntry.findMany({
    where: {
      status: "OFFERED",
      offeredProfessionalId: professionalId,
      offerExpiresAt: { gt: now },
      offeredSlotStart: { gte: around.from, lt: around.to },
      id: { not: exceptEntryId },
    },
    select: { offeredSlotStart: true, service: { select: { durationMin: true, bufferAfterMin: true } } },
  });
  const ranges: BusyRange[] = [];
  for (const o of offers) {
    if (!o.offeredSlotStart) continue;
    ranges.push({ startsAt: o.offeredSlotStart, blockEndsAt: addMinutes(o.offeredSlotStart, o.service.durationMin + o.service.bufferAfterMin) });
  }
  return ranges;
}

/**
 * O melhor horário para a entrada, ou `null`. `freed` limita a horários que tocam o intervalo que
 * acabou de abrir; `candidateProfessionalIds` limita a quem pode receber (o profissional do horário
 * liberado, ou os aptos no oferecimento manual). Respeita a escolha de profissional da entrada.
 */
export async function findSlotForEntry(params: {
  tenantId: string;
  tenant: TenantRules;
  entry: EntryForSlot;
  service: { durationMin: number; bufferAfterMin: number };
  candidateProfessionalIds: string[];
  freed?: { from: Date; to: Date } | null;
  now: Date;
}): Promise<SlotChoice | null> {
  const { tenantId, tenant, entry, service, now } = params;
  const dateISO = desiredDateToISO(entry.desiredDate);
  const dayFrom = new Date(`${dateISO}T00:00:00.000Z`);
  const range = { from: new Date(dayFrom.getTime() - 86_400_000), to: new Date(dayFrom.getTime() + 2 * 86_400_000) };
  const pref = { period: entry.period, windowStartMin: entry.windowStartMin, windowEndMin: entry.windowEndMin };

  let best: SlotChoice | null = null;
  for (const professionalId of params.candidateProfessionalIds) {
    if (entry.professionalId && entry.professionalId !== professionalId) continue;
    const inputs = await loadProfessionalScheduleInputs(tenantId, professionalId, range);
    const held = await heldOfferRanges(tenantId, professionalId, range, entry.id, now);
    const slots = computeAvailableSlots({
      dateISO,
      timezone: tenant.timezone,
      workingHours: inputs.workingHourRules,
      closedRanges: inputs.closedRanges,
      busy: [...inputs.busy, ...held],
      serviceDurationMin: service.durationMin,
      slotGranularityMin: tenant.slotGranularityMin,
      minLeadTimeMin: tenant.minLeadTimeMin,
      now,
    });
    const slot = pickSlotForPreference({ slots, pref, timezone: tenant.timezone, durationMin: service.durationMin, freed: params.freed });
    if (slot && (!best || slot.getTime() < best.startsAt.getTime())) best = { professionalId, startsAt: slot };
  }
  return best;
}
