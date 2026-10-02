import { randomUUID } from "node:crypto";
import { addMinutes } from "date-fns";
import { checkBookingWindow, computeAvailableSlots, isRangeFreeOfBusy } from "@/core/agenda";
import { getPrisma } from "@/lib/db/prisma";
import { recordCompletionSnapshot } from "@/lib/db/appointment-snapshot";
import { forTenant } from "@/lib/db/tenant-client";
import { DomainError } from "@/lib/errors";
import { notifySlotFreed } from "@/modules/waitlist/hook";
import { loadProfessionalScheduleInputs } from "./availability-loader";

const MAX_LIST_RANGE_DAYS = 95;
const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 100;

export async function listAppointments(
  tenantId: string,
  params: { from: Date; to: Date; professionalId?: string; limit?: number },
) {
  const rangeMs = params.to.getTime() - params.from.getTime();
  if (rangeMs <= 0) {
    throw new DomainError("INVALID_RANGE", "O fim precisa ser depois do início.");
  }
  if (rangeMs > MAX_LIST_RANGE_DAYS * 24 * 60 * 60 * 1000) {
    throw new DomainError("RANGE_TOO_LARGE", `O período consultado não pode passar de ${MAX_LIST_RANGE_DAYS} dias.`);
  }

  const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  const db = forTenant(tenantId);

  return db.appointment.findMany({
    where: {
      startsAt: { gte: params.from, lt: params.to },
      ...(params.professionalId ? { professionalId: params.professionalId } : {}),
    },
    include: { contact: true, service: true, professional: true },
    orderBy: { startsAt: "asc" },
    take: limit,
  });
}

export type CreateAppointmentInput = {
  contactId?: string;
  contactName?: string;
  contactPhoneE164?: string;
  serviceId: string;
  professionalId: string | null; // null = "qualquer profissional" apto e livre
  startsAt: Date;
  idempotencyKey?: string;
};

/**
 * `true` se o erro vier da constraint `EXCLUDE` de `appointments` (docs/arquitetura.md §2
 * regra 3) — checado por assinatura (nome da classe + SQLSTATE na mensagem), não por
 * `instanceof` de `@prisma/client` (import cru proibido fora de src/lib/db/, ver
 * eslint.config.mjs). Confirmado experimentalmente contra o Postgres real: o Prisma não
 * reconhece constraints EXCLUDE com um `error.code` próprio — vira
 * `PrismaClientUnknownRequestError` com o SQLSTATE `23P01` só na mensagem.
 */
function isExclusionViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.constructor?.name === "PrismaClientUnknownRequestError" && error.message.includes("23P01");
}

async function findEligibleProfessionalIds(tenantId: string, serviceId: string): Promise<string[]> {
  const db = forTenant(tenantId);
  const links = await getPrisma().professionalService.findMany({
    where: { serviceId, professional: { tenantId, active: true } },
    select: { professionalId: true },
  });
  // Confirma tenant duas vezes de propósito: o filtro relacional acima já restringe por
  // tenantId do Professional, mas carregar via forTenant() de novo é a defesa que não depende
  // de um filtro relacional estar certo.
  const ids = links.map((l) => l.professionalId);
  if (ids.length === 0) return [];
  const validProfessionals = await db.professional.findMany({ where: { id: { in: ids } }, select: { id: true, sortOrder: true } });
  return validProfessionals.sort((a, b) => a.sortOrder - b.sortOrder).map((p) => p.id);
}

async function resolveContactId(tenantId: string, input: CreateAppointmentInput): Promise<string> {
  if (input.contactId) {
    const contact = await forTenant(tenantId).contact.findFirst({ where: { id: input.contactId } });
    if (!contact) throw new DomainError("NOT_FOUND", "Cliente não encontrado.");
    return contact.id;
  }

  if (!input.contactName) {
    throw new DomainError("INVALID_PAYLOAD", "Informe contactId ou o nome do cliente.");
  }

  // Agendamento manual sem contato de WhatsApp real (ex.: cliente que liga/aparece sem ter
  // conversado com o bot). `waJid` sintético para caber no unique (tenantId, waJid) do schema —
  // CRUD completo de clientes é escopo de outro módulo (Fase 8, arquitetura.md §13).
  const waJid = input.contactPhoneE164
    ? `${input.contactPhoneE164.replace(/\D/g, "")}@panel.local`
    : `panel-${randomUUID()}@panel.local`;

  const contact = await forTenant(tenantId).contact.upsert({
    where: { tenantId_waJid: { tenantId, waJid } },
    update: { name: input.contactName },
    create: { tenantId, waJid, name: input.contactName, phoneE164: input.contactPhoneE164 ?? null },
  });
  return contact.id;
}

type BookingPlan = {
  contactId: string;
  professionalId: string;
  startsAt: Date;
  endsAt: Date;
  blockEndsAt: Date;
};

async function planBooking(
  tenantId: string,
  input: CreateAppointmentInput,
  options?: { excludeAppointmentId?: string },
): Promise<BookingPlan> {
  const tenant = await getPrisma().tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const db = forTenant(tenantId);

  const service = await db.service.findFirst({ where: { id: input.serviceId } });
  if (!service) throw new DomainError("NOT_FOUND", "Serviço não encontrado.");
  if (!service.active) throw new DomainError("RULE_VIOLATION", "Serviço inativo.", { rule: "INACTIVE" });

  const contactId = await resolveContactId(tenantId, input);

  const now = new Date();
  const endsAt = addMinutes(input.startsAt, service.durationMin);
  const blockEndsAt = addMinutes(endsAt, service.bufferAfterMin);
  const dayRange = { from: new Date(input.startsAt.getTime() - 24 * 60 * 60 * 1000), to: new Date(blockEndsAt.getTime() + 24 * 60 * 60 * 1000) };

  const candidateProfessionalIds = input.professionalId
    ? [input.professionalId]
    : await findEligibleProfessionalIds(tenantId, input.serviceId);

  if (candidateProfessionalIds.length === 0) {
    throw new DomainError("NOT_FOUND", "Nenhum profissional disponível para este serviço.");
  }

  if (input.professionalId) {
    const professional = await db.professional.findFirst({ where: { id: input.professionalId } });
    if (!professional) throw new DomainError("NOT_FOUND", "Profissional não encontrado.");
    if (!professional.active) throw new DomainError("RULE_VIOLATION", "Profissional inativo.", { rule: "INACTIVE" });
    const canPerform = await getPrisma().professionalService.findFirst({ where: { professionalId: professional.id, serviceId: service.id } });
    if (!canPerform) {
      throw new DomainError("RULE_VIOLATION", "Este profissional não faz este serviço.", { rule: "OUTSIDE_HOURS" });
    }
  }

  let lastViolation: string | null = null;

  for (const professionalId of candidateProfessionalIds) {
    const { workingHourRules, closedRanges, busy } = await loadProfessionalScheduleInputs(
      tenantId,
      professionalId,
      dayRange,
      options,
    );

    const violation = checkBookingWindow({
      start: input.startsAt,
      end: endsAt,
      timezone: tenant.timezone,
      workingHours: workingHourRules,
      closedRanges,
      minLeadTimeMin: tenant.minLeadTimeMin,
      maxHorizonDays: tenant.maxHorizonDays,
      now,
    });

    if (violation) {
      lastViolation = violation;
      continue;
    }

    if (!isRangeFreeOfBusy(input.startsAt, blockEndsAt, busy)) {
      // Só "qualquer profissional" segue tentando o próximo candidato; um profissional
      // explícito com o horário ocupado é SLOT_TAKEN direto (ver caller).
      if (input.professionalId) {
        const alternatives = computeAvailableSlots({
          dateISO: dateISOInTimezone(input.startsAt, tenant.timezone),
          timezone: tenant.timezone,
          workingHours: workingHourRules,
          closedRanges,
          busy,
          serviceDurationMin: service.durationMin,
          slotGranularityMin: tenant.slotGranularityMin,
          minLeadTimeMin: tenant.minLeadTimeMin,
          now,
        }).slice(0, 6);
        throw new DomainError("SLOT_TAKEN", "Este horário já está ocupado.", { alternatives });
      }
      continue;
    }

    return { contactId, professionalId, startsAt: input.startsAt, endsAt, blockEndsAt };
  }

  if (lastViolation) {
    throw new DomainError("RULE_VIOLATION", "Horário fora das regras de agenda.", { rule: lastViolation });
  }
  throw new DomainError("SLOT_TAKEN", "Nenhum profissional está livre nesse horário.", { alternatives: [] });
}

function dateISOInTimezone(date: Date, timezone: string): string {
  // Só para montar alternativas de SLOT_TAKEN — reaproveita o mesmo helper de fuso do core.
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export type CreateAppointmentResult = { appointment: unknown; alreadyExisted: boolean };

/**
 * `source`/`whatsappInstanceId`/`authorType` são opcionais e por omissão preservam o
 * comportamento histórico (agendamento manual do painel: `source: "PANEL"`, autor `"USER"`).
 * A Fase 4 (`src/modules/bot-api/booking-bot.ts`) passa `{ source: "WHATSAPP", whatsappInstanceId,
 * authorType: "CONTACT" }` para agendamentos originados pelo bot — mesma função, mesma garantia
 * de idempotência/concorrência, sem duplicar a lógica de reserva.
 */
export type CreateAppointmentActorOptions = {
  source?: "PANEL" | "WHATSAPP";
  whatsappInstanceId?: string | null;
  authorType?: "USER" | "CONTACT" | "SYSTEM";
  /**
   * Nome JÁ VALIDADO (o chamador roda `validateName`) a gravar em `Contact.name` na mesma transação
   * da reserva — também quando a reserva já existia (idempotência). Nunca antes: desistir no meio
   * do funil não deixa lixo no cadastro (bot v2, spec §3.1).
   */
  contactName?: string;
  /**
   * Limite de agendamentos FUTUROS (`SCHEDULED`, `startsAt > agora`) por contato. `0`/omitido = sem
   * limite. Só o bot v2 passa (`X-InnoChat-Flow: 2`); o painel nunca é barrado. A contagem roda
   * sob trava da linha do contato, então duas reservas simultâneas não passam juntas do limite.
   */
  futureLimit?: number;
};

async function saveContactName(tenantId: string, contactId: string, name: string | undefined) {
  if (!name) return;
  await forTenant(tenantId).contact.update({ where: { id: contactId }, data: { name } });
}

export async function createAppointmentManual(
  tenantId: string,
  input: CreateAppointmentInput,
  actorId: string,
  actorOptions?: CreateAppointmentActorOptions,
): Promise<CreateAppointmentResult> {
  const db = forTenant(tenantId);
  const source = actorOptions?.source ?? "PANEL";
  const authorType = actorOptions?.authorType ?? "USER";
  const whatsappInstanceId = actorOptions?.whatsappInstanceId ?? null;

  // Idempotência (docs/arquitetura.md §2 regra 4): mesma chave → devolve o existente.
  if (input.idempotencyKey) {
    const existing = await db.appointment.findFirst({ where: { idempotencyKey: input.idempotencyKey } });
    if (existing) {
      await saveContactName(tenantId, existing.contactId, actorOptions?.contactName);
      return { appointment: existing, alreadyExisted: true };
    }
  }

  const plan = await planBooking(tenantId, input);

  // Repetição por contato+serviço+início (mesma regra do bot, §6.5): evita duplicar se o
  // idempotencyKey não foi enviado mas é claramente o mesmo pedido.
  const duplicate = await db.appointment.findFirst({
    where: { contactId: plan.contactId, serviceId: input.serviceId, startsAt: plan.startsAt, status: "SCHEDULED" },
  });
  if (duplicate) {
    await saveContactName(tenantId, plan.contactId, actorOptions?.contactName);
    return { appointment: duplicate, alreadyExisted: true };
  }

  const futureLimit = actorOptions?.futureLimit ?? 0;

  try {
    const appointment = await getPrisma().$transaction(async (tx) => {
      // Trava a linha do contato (UPDATE = lock de linha exclusivo até o fim da transação): a
      // gravação do nome e/ou a contagem do limite ficam serializadas por contato. Sem nome nem
      // limite não há o que proteger, então não trava.
      if (actorOptions?.contactName || futureLimit > 0) {
        await tx.contact.update({
          where: { id: plan.contactId },
          data: actorOptions?.contactName ? { name: actorOptions.contactName } : { updatedAt: new Date() },
        });
      }
      if (futureLimit > 0) {
        const count = await tx.appointment.count({
          where: { tenantId, contactId: plan.contactId, status: "SCHEDULED", startsAt: { gt: new Date() } },
        });
        if (count >= futureLimit) {
          throw new DomainError("LIMIT_REACHED", "O cliente já atingiu o limite de agendamentos futuros.", { max: futureLimit, count });
        }
      }
      const created = await tx.appointment.create({
        data: {
          tenantId,
          contactId: plan.contactId,
          serviceId: input.serviceId,
          professionalId: plan.professionalId,
          whatsappInstanceId,
          startsAt: plan.startsAt,
          endsAt: plan.endsAt,
          blockEndsAt: plan.blockEndsAt,
          status: "SCHEDULED",
          source,
          idempotencyKey: input.idempotencyKey,
        },
      });
      await tx.appointmentEvent.create({
        data: { appointmentId: created.id, action: "CREATED", authorType, authorId: actorId },
      });
      return created;
    });
    return { appointment, alreadyExisted: false };
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw new DomainError("SLOT_TAKEN", "Este horário acabou de ser ocupado por outro agendamento.", { alternatives: [] });
    }
    throw error;
  }
}

async function loadOwnedAppointment(tenantId: string, appointmentId: string) {
  const appointment = await forTenant(tenantId).appointment.findFirst({ where: { id: appointmentId } });
  if (!appointment) throw new DomainError("NOT_FOUND", "Agendamento não encontrado.");
  return appointment;
}

export async function cancelAppointment(
  tenantId: string,
  appointmentId: string,
  actorId: string,
  note?: string,
  authorType: "USER" | "CONTACT" | "SYSTEM" = "USER",
) {
  return (await cancelAppointmentDetailed(tenantId, appointmentId, actorId, note, authorType)).appointment;
}

/**
 * Igual a `cancelAppointment`, mas diz se ESTA chamada foi quem cancelou (`changed`). A troca de status é
 * condicional (`updateMany` com `status != CANCELED`), então dois cancelamentos simultâneos geram um
 * único evento e um único `changed: true` — base para o aviso ao cliente não sair duplicado.
 */
export async function cancelAppointmentDetailed(
  tenantId: string,
  appointmentId: string,
  actorId: string,
  note?: string,
  authorType: "USER" | "CONTACT" | "SYSTEM" = "USER",
) {
  const appointment = await loadOwnedAppointment(tenantId, appointmentId);

  if (appointment.status === "CANCELED") {
    return { appointment, changed: false }; // idempotente
  }

  const tenant = await getPrisma().tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const now = new Date();
  const tooLate = appointment.status === "SCHEDULED" && appointment.startsAt.getTime() - now.getTime() < tenant.cancelMinLeadMin * 60_000;
  if (tooLate) {
    throw new DomainError("TOO_LATE", "Já passou do prazo para cancelar este horário.");
  }

  const result = await getPrisma().$transaction(async (tx) => {
    const { count } = await tx.appointment.updateMany({
      where: { id: appointmentId, tenantId, status: { not: "CANCELED" } },
      data: { status: "CANCELED" },
    });
    const updated = await tx.appointment.findFirstOrThrow({ where: { id: appointmentId, tenantId } });
    if (count === 0) return { appointment: updated, changed: false };
    await tx.appointmentEvent.create({
      data: { appointmentId, action: "CANCELED", authorType, authorId: actorId, note: note ?? null },
    });
    return { appointment: updated, changed: true };
  });

  // Horário aberto: a lista de espera é avisada (em segundo plano, depois do commit).
  if (result.changed && appointment.status === "SCHEDULED" && appointment.blockEndsAt.getTime() > now.getTime()) {
    notifySlotFreed(tenantId, { professionalId: appointment.professionalId, from: appointment.startsAt, to: appointment.blockEndsAt });
  }
  return result;
}

export async function rescheduleAppointment(
  tenantId: string,
  appointmentId: string,
  newStartsAt: Date,
  actorId: string,
  authorType: "USER" | "CONTACT" | "SYSTEM" = "USER",
) {
  const appointment = await loadOwnedAppointment(tenantId, appointmentId);
  if (appointment.status !== "SCHEDULED") {
    throw new DomainError("INVALID_STATE", "Só é possível remarcar um agendamento em aberto.");
  }

  const tenant = await getPrisma().tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const now = new Date();
  const tooLate = appointment.startsAt.getTime() - now.getTime() < tenant.cancelMinLeadMin * 60_000;
  if (tooLate) {
    throw new DomainError("TOO_LATE", "Já passou do prazo para remarcar este horário.");
  }

  const plan = await planBooking(
    tenantId,
    { serviceId: appointment.serviceId, professionalId: appointment.professionalId, startsAt: newStartsAt, contactId: appointment.contactId },
    { excludeAppointmentId: appointmentId },
  );

  try {
    const updated = await getPrisma().$transaction(async (tx) => {
      const result = await tx.appointment.update({
        where: { id: appointmentId },
        // `reminderSentAt: null`: o horário mudou, o lembrete de véspera precisa ser reenviado para o novo horário.
        data: { startsAt: plan.startsAt, endsAt: plan.endsAt, blockEndsAt: plan.blockEndsAt, reminderSentAt: null },
      });
      await tx.appointmentEvent.create({
        data: { appointmentId, action: "RESCHEDULED", authorType, authorId: actorId },
      });
      return result;
    });
    // O horário antigo ficou livre: a lista de espera é avisada (em segundo plano, depois do commit).
    notifySlotFreed(tenantId, { professionalId: appointment.professionalId, from: appointment.startsAt, to: appointment.blockEndsAt });
    return updated;
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw new DomainError("SLOT_TAKEN", "Este horário acabou de ser ocupado por outro agendamento.", { alternatives: [] });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Encerramento do atendimento: concluir / cliente faltou / reabrir
// ---------------------------------------------------------------------------

/** O que a UI recebe de volta: a linha do agendamento (mesmo formato de cancelar/remarcar). `startsAt`/`endsAt` são Date. */
export type AppointmentView = NonNullable<Awaited<ReturnType<typeof loadOwnedAppointment>>>;

type FinishOutcome = "COMPLETED" | "NO_SHOW";

const FINISH_LABEL: Record<FinishOutcome, string> = {
  COMPLETED: "concluir",
  NO_SHOW: "marcar falta em",
};

/**
 * Conclui (`COMPLETED`) ou marca falta (`NO_SHOW`) — SÓ a partir de `SCHEDULED` e SÓ depois do
 * horário de início. A troca é uma atualização CONDICIONAL (`updateMany` com status + início na
 * cláusula WHERE) dentro da mesma transação que grava o evento: se um cancelamento/remarcação
 * ganhar a corrida, `count === 0`, nada é gravado e o erro devolvido reflete o estado real.
 * Repetir a mesma ação num agendamento que já está no estado-alvo é idempotente (duplo clique).
 */
export async function finishAppointment(tenantId: string, appointmentId: string, actorId: string, outcome: FinishOutcome) {
  const appointment = await loadOwnedAppointment(tenantId, appointmentId);
  if (appointment.status === outcome) return appointment;

  const now = new Date();
  const assertStartedAndOpen = (current: { status: string; startsAt: Date }) => {
    if (current.status !== "SCHEDULED") {
      throw new DomainError("INVALID_STATE", `Só é possível ${FINISH_LABEL[outcome]} um agendamento em aberto.`);
    }
    if (current.startsAt.getTime() > now.getTime()) {
      throw new DomainError("APPOINTMENT_NOT_STARTED", "O atendimento ainda não começou. Só dá para concluir ou marcar falta a partir do horário de início.");
    }
  };
  assertStartedAndOpen(appointment);

  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.appointment.updateMany({
      where: { id: appointmentId, tenantId, status: "SCHEDULED", startsAt: { lte: now } },
      data: { status: outcome },
    });
    if (count === 0) {
      // Perdeu a corrida (cancelado/remarcado/já finalizado entre a leitura e a escrita).
      const fresh = await tx.appointment.findFirst({ where: { id: appointmentId, tenantId } });
      if (!fresh) throw new DomainError("NOT_FOUND", "Agendamento não encontrado.");
      if (fresh.status === outcome) return fresh;
      assertStartedAndOpen(fresh);
      throw new DomainError("INVALID_STATE", "O agendamento mudou enquanto você agia. Recarregue e tente de novo.");
    }
    if (outcome === "COMPLETED") await recordCompletionSnapshot(tx, tenantId, appointmentId);
    await tx.appointmentEvent.create({ data: { appointmentId, action: outcome, authorType: "USER", authorId: actorId } });
    return tx.appointment.findFirstOrThrow({ where: { id: appointmentId, tenantId } });
  });
}

/**
 * Desfaz um engano: `COMPLETED`/`NO_SHOW` → `SCHEDULED`, com evento `REOPENED`. Se o horário foi
 * ocupado por outro agendamento do mesmo profissional nesse meio-tempo, a constraint EXCLUDE
 * recusa e vira `SLOT_TAKEN`. Já `SCHEDULED` = idempotente; `CANCELED` = `INVALID_STATE`.
 */
export async function reopenAppointment(tenantId: string, appointmentId: string, actorId: string) {
  const appointment = await loadOwnedAppointment(tenantId, appointmentId);
  if (appointment.status === "SCHEDULED") return appointment;
  if (appointment.status === "CANCELED") {
    throw new DomainError("INVALID_STATE", "Um agendamento cancelado não pode ser reaberto.");
  }

  try {
    return await getPrisma().$transaction(async (tx) => {
      const { count } = await tx.appointment.updateMany({
        where: { id: appointmentId, tenantId, status: { in: ["COMPLETED", "NO_SHOW"] } },
        // Reabrir apaga a foto de valores: ao concluir de novo, vale o preço/comissão daquele momento.
        data: { status: "SCHEDULED", priceCentsSnapshot: null, commissionPctSnapshot: null, commissionCentsSnapshot: null },
      });
      if (count === 0) {
        const fresh = await tx.appointment.findFirst({ where: { id: appointmentId, tenantId } });
        if (!fresh) throw new DomainError("NOT_FOUND", "Agendamento não encontrado.");
        if (fresh.status === "SCHEDULED") return fresh;
        throw new DomainError("INVALID_STATE", "Um agendamento cancelado não pode ser reaberto.");
      }
      await tx.appointmentEvent.create({ data: { appointmentId, action: "REOPENED", authorType: "USER", authorId: actorId } });
      return tx.appointment.findFirstOrThrow({ where: { id: appointmentId, tenantId } });
    });
  } catch (error) {
    if (isExclusionViolation(error)) {
      throw new DomainError("SLOT_TAKEN", "Outro agendamento ocupou este horário. Não dá para reabrir este atendimento.", { alternatives: [] });
    }
    throw error;
  }
}
