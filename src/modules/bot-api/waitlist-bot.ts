import { getPrisma } from "@/lib/db/prisma";
import { forTenant } from "@/lib/db/tenant-client";
import { formatDayLabelFromISO } from "@/core/bot/format";
import { desiredDateToISO, type WaitlistPeriod } from "@/core/waitlist/match";
import { acceptWaitlistOffer, declineWaitlistOffer } from "@/modules/waitlist/respond";
import { createWaitlistEntry, listContactWaitlist, removeWaitlistEntry } from "@/modules/waitlist/service";
import type { FlowVersion } from "./flow-version";
import type { InternalApiContext } from "./internal-auth";

/**
 * Lista de espera pelo bot (v2). Camada fina sobre `src/modules/waitlist`: resolve o tenant pela
 * instância autenticada, converte o período do bot (`morning`...) e devolve rótulos prontos para o
 * n8n não formatar nada.
 */

const PERIOD_BY_BOT: Record<string, WaitlistPeriod> = { morning: "MORNING", afternoon: "AFTERNOON", evening: "EVENING" };

export async function joinWaitlistBot(
  ctx: InternalApiContext,
  input: { contactId: string; serviceId: string; professionalId?: string | null; date: string; period?: string | null },
) {
  const professionalId = !input.professionalId || input.professionalId === "any" ? null : input.professionalId;
  const { entry, alreadyExisted } = await createWaitlistEntry(ctx.tenantId, {
    contactId: input.contactId,
    serviceId: input.serviceId,
    professionalId,
    date: input.date,
    period: input.period ? PERIOD_BY_BOT[input.period] : "ANY",
    source: "BOT",
  });
  const [service, tenant, professional] = await Promise.all([
    forTenant(ctx.tenantId).service.findFirstOrThrow({ where: { id: entry.serviceId }, select: { name: true } }),
    getPrisma().tenant.findUniqueOrThrow({ where: { id: ctx.tenantId }, select: { timezone: true } }),
    entry.professionalId ? forTenant(ctx.tenantId).professional.findFirst({ where: { id: entry.professionalId }, select: { name: true } }) : null,
  ]);
  const iso = desiredDateToISO(entry.desiredDate);
  return {
    entry: {
      id: entry.id,
      alreadyExisted,
      servico: service.name,
      profissional: professional?.name ?? null,
      data: formatDayLabelFromISO(iso, tenant.timezone),
      dateISO: iso,
    },
  };
}

export async function listWaitlistBot(ctx: InternalApiContext, contactId: string) {
  const options = await listContactWaitlist(ctx.tenantId, contactId);
  return { options };
}

export async function leaveWaitlistBot(ctx: InternalApiContext, entryId: string, contactId: string) {
  const entry = await forTenant(ctx.tenantId).waitlistEntry.findFirst({
    where: { id: entryId, contactId },
    include: { service: { select: { name: true } } },
  });
  const result = await removeWaitlistEntry(ctx.tenantId, entryId, { contactId });
  const tenant = await getPrisma().tenant.findUniqueOrThrow({ where: { id: ctx.tenantId }, select: { timezone: true } });
  return {
    left: result.removed,
    servico: entry?.service.name ?? "",
    data: entry ? formatDayLabelFromISO(desiredDateToISO(entry.desiredDate), tenant.timezone) : "",
  };
}

/** SIM/NÃO do cliente à oferta. SIM devolve o agendamento no formato do bot; NÃO devolve os rótulos da fila. */
export async function respondWaitlistBot(
  ctx: InternalApiContext,
  entryId: string,
  input: { contactId: string; accept: boolean },
  flow: FlowVersion,
) {
  const tenant = await getPrisma().tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } });
  if (input.accept) {
    const { appointment, alreadyExisted } = await acceptWaitlistOffer(ctx.tenantId, {
      entryId,
      contactId: input.contactId,
      whatsappInstanceId: ctx.instance.id,
      futureLimit: flow === 2 ? tenant.maxFutureAppointmentsPerContact : 0,
    });
    return { accepted: true as const, alreadyExisted, appointment };
  }
  const { declined, entry } = await declineWaitlistOffer(ctx.tenantId, { entryId, contactId: input.contactId });
  return {
    accepted: false as const,
    declined,
    servico: entry.serviceName,
    data: formatDayLabelFromISO(entry.date, tenant.timezone),
  };
}
