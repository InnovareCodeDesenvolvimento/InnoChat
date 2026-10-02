import { getPrisma } from "@/lib/db/prisma";
import { forTenant } from "@/lib/db/tenant-client";
import { DomainError } from "@/lib/errors";
import type { ScheduleExceptionType } from "@/lib/db/types";
import { assertCanAddProfessional } from "@/modules/billing/plan-limits";

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type ServiceInput = {
  name: string;
  durationMin: number;
  bufferAfterMin: number;
  priceCents: number | null;
  active: boolean;
  sortOrder: number;
};

export async function listServices(tenantId: string) {
  return forTenant(tenantId).service.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
}

export async function createService(tenantId: string, input: ServiceInput) {
  // `tenantId` no `data` é só para satisfazer o tipo do Prisma Client (a extension de
  // `forTenant` SOBRESCREVE esse campo em runtime — ver src/lib/db/tenant-scope.ts —, nunca
  // confia no valor aqui).
  return forTenant(tenantId).service.create({ data: { ...input, tenantId } });
}

export async function updateService(tenantId: string, serviceId: string, input: Partial<ServiceInput>) {
  const db = forTenant(tenantId);
  const existing = await db.service.findFirst({ where: { id: serviceId } });
  if (!existing) throw new DomainError("NOT_FOUND", "Serviço não encontrado.");
  return db.service.update({ where: { id: serviceId }, data: input });
}

/**
 * `Service` tem `onDelete: Cascade` para `Appointment` (prisma/schema.prisma) — um DELETE de
 * verdade apagaria o histórico de agendamentos junto. Por isso: só permite excluir serviços
 * sem NENHUM agendamento (de qualquer status); senão, orienta a desativar (`active: false`).
 */
export async function deleteService(tenantId: string, serviceId: string) {
  const db = forTenant(tenantId);
  const existing = await db.service.findFirst({ where: { id: serviceId } });
  if (!existing) throw new DomainError("NOT_FOUND", "Serviço não encontrado.");

  const appointmentsCount = await db.appointment.count({ where: { serviceId } });
  if (appointmentsCount > 0) {
    throw new DomainError(
      "HAS_APPOINTMENTS",
      "Este serviço tem agendamentos e não pode ser excluído. Desative-o em vez de excluir.",
    );
  }

  await db.service.delete({ where: { id: serviceId } });
}

// ---------------------------------------------------------------------------
// Professional (+ serviços que realiza, + expediente)
// ---------------------------------------------------------------------------

export type ProfessionalInput = {
  name: string;
  active: boolean;
  sortOrder: number;
};

export async function listProfessionals(tenantId: string) {
  return forTenant(tenantId).professional.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { professionalServices: { select: { serviceId: true } }, workingHours: true },
  });
}

/**
 * Limite de profissionais por plano (docs/arquitetura.md §7.2, Fase 7): checado no servidor,
 * não só escondido no botão — `assertCanAddProfessional` lança `PLAN_LIMIT_REACHED` antes do
 * `create` se a empresa já está no limite (override de `Tenant` tem precedência sobre o `Plan`).
 */
export async function createProfessional(tenantId: string, input: ProfessionalInput) {
  await assertCanAddProfessional(tenantId);
  return forTenant(tenantId).professional.create({ data: { ...input, tenantId } });
}

export async function updateProfessional(tenantId: string, professionalId: string, input: Partial<ProfessionalInput>) {
  const db = forTenant(tenantId);
  const existing = await db.professional.findFirst({ where: { id: professionalId } });
  if (!existing) throw new DomainError("NOT_FOUND", "Profissional não encontrado.");
  return db.professional.update({ where: { id: professionalId }, data: input });
}

/**
 * Mesma cautela de `deleteService`: `Professional` cascade-apaga `WorkingHour`,
 * `ProfessionalService`, `ScheduleException` (própria) e `Appointment`. Bloqueia se houver
 * qualquer agendamento.
 */
export async function deleteProfessional(tenantId: string, professionalId: string) {
  const db = forTenant(tenantId);
  const existing = await db.professional.findFirst({ where: { id: professionalId } });
  if (!existing) throw new DomainError("NOT_FOUND", "Profissional não encontrado.");

  const appointmentsCount = await db.appointment.count({ where: { professionalId } });
  if (appointmentsCount > 0) {
    throw new DomainError(
      "HAS_APPOINTMENTS",
      "Este profissional tem agendamentos e não pode ser excluído. Desative-o em vez de excluir.",
    );
  }

  await db.professional.delete({ where: { id: professionalId } });
}

/**
 * `ProfessionalService` não tem `tenantId` próprio (isolamento por relação — ver
 * src/lib/db/tenant-scope.ts e a memória `forTenant-so-cobre-tenantid-direto`): carrega o
 * `Professional` via `forTenant()` primeiro para provar que ele é do tenant, e confirma que
 * TODOS os `serviceIds` recebidos também pertencem a este tenant antes de vincular — nunca
 * confia no id vindo do client.
 */
export async function setProfessionalServices(tenantId: string, professionalId: string, serviceIds: string[]) {
  const db = forTenant(tenantId);
  const professional = await db.professional.findFirst({ where: { id: professionalId } });
  if (!professional) throw new DomainError("NOT_FOUND", "Profissional não encontrado.");

  const uniqueIds = Array.from(new Set(serviceIds));
  if (uniqueIds.length > 0) {
    const validCount = await db.service.count({ where: { id: { in: uniqueIds } } });
    if (validCount !== uniqueIds.length) {
      throw new DomainError("INVALID_SERVICE_IDS", "Um ou mais serviços não pertencem a esta empresa.");
    }
  }

  // Não apaga tudo e recria: `ProfessionalService.commissionPct` (comissão por serviço) moraria nessas linhas e
  // seria zerada a cada "Salvar serviços". Remove só o que saiu da lista e cria só o que entrou.
  const prisma = getPrisma();
  await prisma.$transaction([
    prisma.professionalService.deleteMany({ where: { professionalId, serviceId: { notIn: uniqueIds } } }),
    ...(uniqueIds.length > 0
      ? [
          prisma.professionalService.createMany({
            data: uniqueIds.map((serviceId) => ({ professionalId, serviceId })),
            skipDuplicates: true,
          }),
        ]
      : []),
  ]);

  return db.professional.findFirstOrThrow({
    where: { id: professionalId },
    include: { professionalServices: { select: { serviceId: true } } },
  });
}

export type WorkingHourInput = { weekday: number; startTime: string; endTime: string };

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function assertValidWorkingHours(hours: WorkingHourInput[]) {
  for (const h of hours) {
    if (h.weekday < 0 || h.weekday > 6) {
      throw new DomainError("INVALID_WORKING_HOUR", "weekday precisa estar entre 0 e 6.");
    }
    if (!HHMM_RE.test(h.startTime) || !HHMM_RE.test(h.endTime)) {
      throw new DomainError("INVALID_WORKING_HOUR", "Horário precisa estar no formato HH:mm.");
    }
    if (h.startTime >= h.endTime) {
      throw new DomainError("INVALID_WORKING_HOUR", "O horário final precisa ser depois do inicial.");
    }
  }
}

/**
 * Substitui TODO o expediente do profissional pela lista recebida (replace-all — mais simples
 * e sem risco de sobra órfã do que um diff incremental). Mesma lógica de tenant-scope de
 * `setProfessionalServices`: valida o pai (`Professional`) via `forTenant()` antes de tocar o
 * filho sem `tenantId` próprio.
 */
export async function setProfessionalWorkingHours(tenantId: string, professionalId: string, hours: WorkingHourInput[]) {
  assertValidWorkingHours(hours);

  const db = forTenant(tenantId);
  const professional = await db.professional.findFirst({ where: { id: professionalId } });
  if (!professional) throw new DomainError("NOT_FOUND", "Profissional não encontrado.");

  const prisma = getPrisma();
  await prisma.$transaction([
    prisma.workingHour.deleteMany({ where: { professionalId } }),
    ...(hours.length > 0
      ? [prisma.workingHour.createMany({ data: hours.map((h) => ({ professionalId, ...h })) })]
      : []),
  ]);

  return prisma.workingHour.findMany({ where: { professionalId }, orderBy: [{ weekday: "asc" }, { startTime: "asc" }] });
}

// ---------------------------------------------------------------------------
// ScheduleException (bloqueios/feriados) — TEM tenantId próprio, forTenant cobre direto.
// ---------------------------------------------------------------------------

export type ScheduleExceptionInput = {
  professionalId: string | null;
  type: ScheduleExceptionType;
  startsAt: Date;
  endsAt: Date;
  reason: string | null;
};

export async function listScheduleExceptions(tenantId: string, range?: { from: Date; to: Date }) {
  const db = forTenant(tenantId);
  return db.scheduleException.findMany({
    where: range ? { startsAt: { lt: range.to }, endsAt: { gt: range.from } } : undefined,
    orderBy: { startsAt: "asc" },
  });
}

export async function createScheduleException(tenantId: string, input: ScheduleExceptionInput) {
  if (input.endsAt <= input.startsAt) {
    throw new DomainError("INVALID_RANGE", "O fim precisa ser depois do início.");
  }

  const db = forTenant(tenantId);
  if (input.professionalId) {
    const professional = await db.professional.findFirst({ where: { id: input.professionalId } });
    if (!professional) throw new DomainError("NOT_FOUND", "Profissional não encontrado.");
  }

  return db.scheduleException.create({ data: { ...input, tenantId } });
}

export async function deleteScheduleException(tenantId: string, exceptionId: string) {
  const db = forTenant(tenantId);
  const existing = await db.scheduleException.findFirst({ where: { id: exceptionId } });
  if (!existing) throw new DomainError("NOT_FOUND", "Bloqueio não encontrado.");
  await db.scheduleException.delete({ where: { id: exceptionId } });
}
