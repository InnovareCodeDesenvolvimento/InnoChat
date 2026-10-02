import { addMinutes } from "date-fns";
import { formatDayLabelFromISO } from "@/core/bot/format";
import { desiredDateToISO } from "@/core/waitlist/match";
import { getPrisma } from "@/lib/db/prisma";
import { forTenant } from "@/lib/db/tenant-client";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { createAppointmentManual } from "@/modules/agenda/appointments";
import { toAppointmentSummary } from "@/modules/bot-api/booking-bot";
import { offerToWaitingInOpenWindow, passOfferedSlotToNext, runInBackground, type WaitlistDeps } from "./offer";

/**
 * Resposta do cliente à oferta (SIM / NÃO), vencimento por tick e limpeza. Todo avanço de estado é
 * uma troca condicional (`updateMany` com o status esperado): duas respostas ou um tick junto com o
 * cliente disputam a mesma linha e só uma vence.
 */

const OFFER_WITHDRAWN = { offeredSlotStart: null, offeredProfessionalId: null, offeredAt: null, offerExpiresAt: null } as const;
const STALE_ACCEPTED_MS = 10 * 60_000;
const EXPIRE_BATCH = 100;

type OfferedEntry = { id: string; serviceId: string; offeredProfessionalId: string | null; offeredSlotStart: Date | null };

function passToNext(tenantId: string, entry: OfferedEntry, deps?: WaitlistDeps): void {
  runInBackground("pass_to_next", tenantId, () =>
    passOfferedSlotToNext(tenantId, { entryId: entry.id, professionalId: entry.offeredProfessionalId, slotStart: entry.offeredSlotStart, serviceId: entry.serviceId }, deps),
  );
}

function offerGone(): DomainError {
  return new DomainError("OFFER_GONE", "Essa oferta já não vale mais.");
}

/**
 * O cliente disse SIM. Marca o horário conferindo de novo que ele continua livre: pode ter sido
 * ocupado por outro canal durante o prazo. Nesse caso a pessoa continua na fila e recebe 409
 * `SLOT_TAKEN`. Vencida, recusada ou de outra pessoa: 409 `OFFER_GONE`.
 */
export async function acceptWaitlistOffer(
  tenantId: string,
  params: { entryId: string; contactId: string; whatsappInstanceId?: string | null; futureLimit?: number; now?: Date },
  deps?: WaitlistDeps,
) {
  const now = params.now ?? new Date();
  const db = forTenant(tenantId);
  const entry = await db.waitlistEntry.findFirst({
    where: { id: params.entryId, contactId: params.contactId },
    include: { service: { select: { name: true } } },
  });
  if (!entry) throw offerGone();

  if (entry.status === "FULFILLED" && entry.appointmentId) {
    // Repetição do mesmo SIM: devolve o mesmo agendamento.
    return { appointment: await toAppointmentSummary(tenantId, entry.appointmentId), alreadyExisted: true };
  }
  if (entry.status !== "OFFERED" || !entry.offeredSlotStart || !entry.offeredProfessionalId || !entry.offerExpiresAt) throw offerGone();

  if (entry.offerExpiresAt.getTime() <= now.getTime()) {
    await expireOne(tenantId, entry, now, deps);
    throw offerGone();
  }

  // Quem responde primeiro leva: só uma chamada passa de OFFERED para ACCEPTED.
  const claimed = await db.waitlistEntry.updateMany({
    where: { id: entry.id, status: "OFFERED", offerExpiresAt: { gt: now } },
    data: { status: "ACCEPTED" },
  });
  if (claimed.count === 0) throw offerGone();

  const revert = () =>
    db.waitlistEntry.updateMany({ where: { id: entry.id, status: "ACCEPTED" }, data: { status: "WAITING", ...OFFER_WITHDRAWN } });

  try {
    const { appointment } = await createAppointmentManual(
      tenantId,
      {
        contactId: entry.contactId,
        serviceId: entry.serviceId,
        professionalId: entry.offeredProfessionalId,
        startsAt: entry.offeredSlotStart,
        idempotencyKey: `waitlist:${entry.id}`,
      },
      entry.contactId,
      { source: params.whatsappInstanceId ? "WHATSAPP" : "PANEL", whatsappInstanceId: params.whatsappInstanceId ?? null, authorType: "CONTACT", futureLimit: params.futureLimit ?? 0 },
    );
    const appointmentId = (appointment as { id: string }).id;
    await db.waitlistEntry.updateMany({ where: { id: entry.id, status: "ACCEPTED" }, data: { status: "FULFILLED", appointmentId } });
    logger.info("waitlist.offer_accepted", { tenantId, entryId: entry.id });
    return { appointment: await toAppointmentSummary(tenantId, appointmentId), alreadyExisted: false };
  } catch (error) {
    await revert();
    if (error instanceof DomainError && (error.code === "SLOT_TAKEN" || error.code === "RULE_VIOLATION")) {
      // O horário saiu do ar (outro canal, bloqueio, antecedência): a pessoa continua na fila.
      logger.info("waitlist.offer_slot_gone", { tenantId, entryId: entry.id, code: error.code });
      throw new DomainError("SLOT_TAKEN", "Esse horário acabou de ser ocupado.", {
        servico: entry.service.name,
        data: await waitlistDayLabel(tenantId, desiredDateToISO(entry.desiredDate)),
      });
    }
    if (error instanceof DomainError && error.code === "LIMIT_REACHED") {
      // Não pode agendar mais: sai da fila e o horário segue para o próximo.
      await db.waitlistEntry.updateMany({ where: { id: entry.id, status: "WAITING" }, data: { status: "CANCELED" } });
      passToNext(tenantId, entry, deps);
    }
    throw error;
  }
}

/** O cliente disse NÃO: sai da fila e o horário passa ao próximo. Idempotente. */
export async function declineWaitlistOffer(
  tenantId: string,
  params: { entryId: string; contactId: string },
  deps?: WaitlistDeps,
): Promise<{ declined: boolean; entry: { serviceName: string; date: string } }> {
  const db = forTenant(tenantId);
  const entry = await db.waitlistEntry.findFirst({
    where: { id: params.entryId, contactId: params.contactId },
    include: { service: { select: { name: true } } },
  });
  if (!entry) throw offerGone();
  const info = { serviceName: entry.service.name, date: desiredDateToISO(entry.desiredDate) };
  const done = await db.waitlistEntry.updateMany({ where: { id: entry.id, status: "OFFERED" }, data: { status: "CANCELED" } });
  if (done.count === 0) return { declined: false, entry: info };
  logger.info("waitlist.offer_declined", { tenantId, entryId: entry.id });
  passToNext(tenantId, entry, deps);
  return { declined: true, entry: info };
}

async function expireOne(tenantId: string, entry: OfferedEntry, now: Date, deps?: WaitlistDeps): Promise<boolean> {
  const expired = await forTenant(tenantId).waitlistEntry.updateMany({
    where: { id: entry.id, status: "OFFERED", offerExpiresAt: { lte: now } },
    data: { status: "EXPIRED" },
  });
  if (expired.count === 0) return false; // o cliente respondeu no mesmo instante
  logger.info("waitlist.offer_expired", { tenantId, entryId: entry.id });
  passToNext(tenantId, entry, deps);
  return true;
}

/** Texto do dia para as mensagens do bot (fuso da empresa). */
export async function waitlistDayLabel(tenantId: string, isoDate: string): Promise<string> {
  const tenant = await getPrisma().tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
  return formatDayLabelFromISO(isoDate, tenant.timezone);
}

export type WaitlistTickSummary = { offersExpired: number; acceptedRecovered: number; pastEntriesExpired: number; windowOffers: number };

/**
 * Tick da lista de espera (idempotente): vence ofertas passadas do prazo e passa o horário ao próximo,
 * resolve `ACCEPTED` que ficou preso (queda no meio do aceite) e dá baixa em quem queria um dia que já passou.
 * Varre todas as empresas, em lotes; o que sobrar fica para a próxima rodada.
 */
export async function runWaitlistTick(now: Date = new Date(), deps?: WaitlistDeps): Promise<WaitlistTickSummary> {
  const prisma = getPrisma();
  const summary: WaitlistTickSummary = { offersExpired: 0, acceptedRecovered: 0, pastEntriesExpired: 0, windowOffers: 0 };

  const overdue = await prisma.waitlistEntry.findMany({
    where: { status: "OFFERED", offerExpiresAt: { lte: now } },
    orderBy: { offerExpiresAt: "asc" },
    take: EXPIRE_BATCH,
    select: { id: true, tenantId: true, serviceId: true, offeredProfessionalId: true, offeredSlotStart: true },
  });
  for (const entry of overdue) {
    try {
      if (await expireOne(entry.tenantId, entry, now, deps)) summary.offersExpired += 1;
    } catch (error) {
      logger.error("waitlist.tick.expire_failed", { tenantId: entry.tenantId, entryId: entry.id, errorName: error instanceof Error ? error.name : "unknown" });
    }
  }

  // ACCEPTED sem desfecho há mais de 10 min: ou o agendamento nasceu (liga) ou volta para a fila.
  const stale = await prisma.waitlistEntry.findMany({
    where: { status: "ACCEPTED", appointmentId: null, updatedAt: { lte: new Date(now.getTime() - STALE_ACCEPTED_MS) } },
    take: EXPIRE_BATCH,
    select: { id: true, tenantId: true },
  });
  for (const entry of stale) {
    try {
      const appointment = await forTenant(entry.tenantId).appointment.findFirst({ where: { idempotencyKey: `waitlist:${entry.id}` }, select: { id: true } });
      const changed = await forTenant(entry.tenantId).waitlistEntry.updateMany({
        where: { id: entry.id, status: "ACCEPTED", appointmentId: null },
        data: appointment ? { status: "FULFILLED", appointmentId: appointment.id } : { status: "WAITING", ...OFFER_WITHDRAWN },
      });
      if (changed.count > 0) summary.acceptedRecovered += 1;
    } catch (error) {
      logger.error("waitlist.tick.recover_failed", { tenantId: entry.tenantId, entryId: entry.id, errorName: error instanceof Error ? error.name : "unknown" });
    }
  }

  // Dia já passou (com folga de um dia para qualquer fuso): sai da fila.
  const cutoff = new Date(`${addMinutes(now, -24 * 60).toISOString().slice(0, 10)}T00:00:00.000Z`);
  const past = await prisma.waitlistEntry.updateMany({
    where: { status: "WAITING", desiredDate: { lt: cutoff } },
    data: { status: "EXPIRED" },
  });
  summary.pastEntriesExpired = past.count;

  // Por último, com a janela de envio aberta (08h às 21h na empresa), oferece o que ficou esperando por causa do silêncio.
  try {
    summary.windowOffers = (await offerToWaitingInOpenWindow(now, deps)).offered;
  } catch (error) {
    logger.error("waitlist.tick.window_offers_failed", { errorName: error instanceof Error ? error.name : "unknown" });
  }

  logger.info("waitlist.tick.completed", { ...summary });
  return summary;
}
