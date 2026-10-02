import { formatInTimeZone } from "date-fns-tz";
import { addDaysISO } from "@/core/agenda";
import { formatDayLabelFromISO } from "@/core/bot/format";
import {
  WAITLIST_ACTIVE_STATUSES,
  WAITLIST_MAX_ACTIVE_PER_CONTACT,
  WAITLIST_PERIODS,
  desiredDateToISO,
  isoToDesiredDate,
  type WaitlistPeriod,
} from "@/core/waitlist/match";
import { getPrisma } from "@/lib/db/prisma";
import { isUniqueViolation } from "@/lib/db/prisma-errors";
import { forTenant } from "@/lib/db/tenant-client";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { passOfferedSlotToNext, runInBackground, type WaitlistDeps } from "./offer";

/**
 * Lista de espera: entrar, listar, sair. A fila é por `createdAt` (e `id` de desempate). Os índices
 * únicos parciais do banco impedem a mesma pessoa duas vezes na mesma fila (contato + serviço + dia +
 * profissional); aqui o `P2002` vira "já estava na lista", não erro.
 */

export type CreateWaitlistInput = {
  contactId: string;
  serviceId: string;
  professionalId: string | null;
  /** Dia desejado, "YYYY-MM-DD" no fuso da empresa. */
  date: string;
  period?: WaitlistPeriod;
  windowStartMin?: number | null;
  windowEndMin?: number | null;
  source: "BOT" | "PANEL";
};

function validateWindow(start: number | null | undefined, end: number | null | undefined): { start: number | null; end: number | null } {
  const hasStart = start !== null && start !== undefined;
  const hasEnd = end !== null && end !== undefined;
  if (hasStart !== hasEnd) throw new DomainError("INVALID_PAYLOAD", "Informe o início e o fim da janela de horário, ou nenhum dos dois.");
  if (!hasStart || !hasEnd) return { start: null, end: null };
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 1440 || start >= end) {
    throw new DomainError("INVALID_PAYLOAD", "A janela de horário é inválida: o início precisa vir antes do fim, dentro do mesmo dia.");
  }
  return { start, end };
}

/**
 * Coloca o cliente na fila. Devolve a entrada e se ela já existia (fila repetida não duplica).
 * Valida contato, serviço ativo, profissional que faz o serviço e a data dentro do prazo de agendamento.
 */
export async function createWaitlistEntry(tenantId: string, input: CreateWaitlistInput) {
  const db = forTenant(tenantId);
  const period: WaitlistPeriod = input.period ?? "ANY";
  if (!(WAITLIST_PERIODS as readonly string[]).includes(period)) throw new DomainError("INVALID_PAYLOAD", "Período inválido.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new DomainError("INVALID_PAYLOAD", "Data inválida.");
  const window = validateWindow(input.windowStartMin, input.windowEndMin);

  const contact = await db.contact.findFirst({ where: { id: input.contactId }, select: { id: true } });
  if (!contact) throw new DomainError("NOT_FOUND", "Cliente não encontrado.");

  const service = await db.service.findFirst({ where: { id: input.serviceId, active: true }, select: { id: true } });
  if (!service) throw new DomainError("NOT_FOUND", "Serviço não encontrado.");

  if (input.professionalId) {
    const professional = await db.professional.findFirst({ where: { id: input.professionalId, active: true }, select: { id: true } });
    if (!professional) throw new DomainError("NOT_FOUND", "Profissional não encontrado.");
    const link = await getPrisma().professionalService.findFirst({ where: { professionalId: professional.id, serviceId: service.id }, select: { professionalId: true } });
    if (!link) throw new DomainError("RULE_VIOLATION", "Esse profissional não faz esse serviço.", { rule: "NOT_ELIGIBLE" });
  }

  const tenant = await getPrisma().tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true, maxHorizonDays: true } });
  const today = formatInTimeZone(new Date(), tenant.timezone, "yyyy-MM-dd");
  const last = addDaysISO(today, Math.max(0, tenant.maxHorizonDays - 1));
  if (input.date < today || input.date > last) {
    throw new DomainError("RULE_VIOLATION", `Só dá para entrar na lista de hoje até ${formatDayLabelFromISO(last, tenant.timezone)}.`, { rule: "HORIZON" });
  }

  const duplicateWhere = {
    contactId: input.contactId,
    serviceId: input.serviceId,
    desiredDate: isoToDesiredDate(input.date),
    professionalId: input.professionalId,
    status: { in: [...WAITLIST_ACTIVE_STATUSES] },
  };
  const existing = await db.waitlistEntry.findFirst({ where: duplicateWhere });
  if (existing) return { entry: existing, alreadyExisted: true };

  const activeCount = await db.waitlistEntry.count({ where: { contactId: input.contactId, status: { in: [...WAITLIST_ACTIVE_STATUSES] } } });
  if (activeCount >= WAITLIST_MAX_ACTIVE_PER_CONTACT) {
    throw new DomainError("LIMIT_REACHED", "Esse cliente já está em muitas listas de espera.", { max: WAITLIST_MAX_ACTIVE_PER_CONTACT });
  }

  try {
    const entry = await db.waitlistEntry.create({
      data: {
        tenantId,
        contactId: input.contactId,
        serviceId: input.serviceId,
        professionalId: input.professionalId,
        desiredDate: isoToDesiredDate(input.date),
        period,
        windowStartMin: window.start,
        windowEndMin: window.end,
        source: input.source,
      },
    });
    return { entry, alreadyExisted: false };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Corrida: outra requisição inseriu a mesma fila entre a checagem e o INSERT.
    const raced = await db.waitlistEntry.findFirst({ where: duplicateWhere });
    if (raced) return { entry: raced, alreadyExisted: true };
    throw error;
  }
}

export type WaitlistListFilter = {
  /** Um dia específico ("YYYY-MM-DD"). Sem ele, lista de hoje em diante. */
  date?: string | null;
  professionalId?: string | null;
  /** `active` (padrão): WAITING e OFFERED. `all`: tudo. Ou um status específico. */
  status?: "active" | "all" | "WAITING" | "OFFERED" | "ACCEPTED" | "EXPIRED" | "CANCELED" | "FULFILLED";
  page: number;
  pageSize: number;
};

export const WAITLIST_PAGE_SIZES = [10, 25, 50, 100] as const;

export type WaitlistListData = Awaited<ReturnType<typeof listWaitlist>>;

/** Lista para o painel, por dia e fila, paginada. A ordem é a da fila (dia, depois chegada). */
export async function listWaitlist(tenantId: string, filter: WaitlistListFilter) {
  const db = forTenant(tenantId);
  const tenant = await getPrisma().tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
  const today = formatInTimeZone(new Date(), tenant.timezone, "yyyy-MM-dd");
  const pageSize = (WAITLIST_PAGE_SIZES as readonly number[]).includes(filter.pageSize) ? filter.pageSize : 25;
  const page = Math.max(1, Math.floor(filter.page) || 1);
  const status = filter.status ?? "active";

  const where = {
    desiredDate: filter.date ? isoToDesiredDate(filter.date) : { gte: isoToDesiredDate(today) },
    ...(filter.professionalId ? { OR: [{ professionalId: filter.professionalId }, { professionalId: null }] } : {}),
    ...(status === "active" ? { status: { in: [...WAITLIST_ACTIVE_STATUSES] } } : status === "all" ? {} : { status }),
  };

  const [total, rows] = await Promise.all([
    db.waitlistEntry.count({ where }),
    db.waitlistEntry.findMany({
      where,
      orderBy: [{ desiredDate: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        contact: { select: { id: true, name: true, pushName: true, phoneE164: true, waJid: true } },
        service: { select: { id: true, name: true } },
        professional: { select: { id: true, name: true } },
        offeredProfessional: { select: { id: true, name: true } },
      },
    }),
  ]);

  return {
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    items: rows.map((r) => ({
      id: r.id,
      contactId: r.contact.id,
      contactName: r.contact.name?.trim() || r.contact.pushName?.trim() || null,
      contactPhone: r.contact.phoneE164 ?? (r.contact.waJid.endsWith("@s.whatsapp.net") ? r.contact.waJid.split("@")[0] : null),
      serviceId: r.service.id,
      serviceName: r.service.name,
      professionalId: r.professional?.id ?? null,
      professionalName: r.professional?.name ?? null,
      date: desiredDateToISO(r.desiredDate),
      period: r.period,
      windowStartMin: r.windowStartMin,
      windowEndMin: r.windowEndMin,
      status: r.status,
      source: r.source,
      offeredSlotStart: r.offeredSlotStart ? r.offeredSlotStart.toISOString() : null,
      offeredProfessionalName: r.offeredProfessional?.name ?? null,
      offerExpiresAt: r.offerExpiresAt ? r.offerExpiresAt.toISOString() : null,
      /** Prazo da oferta já passou (o tick ainda não deu baixa). */
      offerExpired: r.status === "OFFERED" && r.offerExpiresAt !== null && r.offerExpiresAt.getTime() <= Date.now(),
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

/**
 * Tira da fila (cliente pediu, ou a equipe removeu). Idempotente. Se havia uma oferta aberta, o
 * horário volta e passa ao próximo da fila.
 */
export async function removeWaitlistEntry(
  tenantId: string,
  entryId: string,
  options: { contactId?: string; deps?: WaitlistDeps } = {},
): Promise<{ removed: boolean }> {
  const db = forTenant(tenantId);
  const entry = await db.waitlistEntry.findFirst({ where: { id: entryId, ...(options.contactId ? { contactId: options.contactId } : {}) } });
  if (!entry) throw new DomainError("NOT_FOUND", "Esse pedido não está na lista de espera.");

  const result = await db.waitlistEntry.updateMany({
    where: { id: entryId, status: { in: [...WAITLIST_ACTIVE_STATUSES] } },
    data: { status: "CANCELED" },
  });
  if (result.count === 0) return { removed: false };

  if (entry.status === "OFFERED") {
    logger.info("waitlist.offer_withdrawn", { tenantId, entryId });
    runInBackground("pass_after_remove", tenantId, () =>
      passOfferedSlotToNext(tenantId, { entryId, professionalId: entry.offeredProfessionalId, slotStart: entry.offeredSlotStart, serviceId: entry.serviceId }, options.deps),
    );
  }
  return { removed: true };
}

/** Filas ativas do cliente, para ele ver e sair pelo bot. */
export async function listContactWaitlist(tenantId: string, contactId: string) {
  const db = forTenant(tenantId);
  const contact = await db.contact.findFirst({ where: { id: contactId }, select: { id: true } });
  if (!contact) throw new DomainError("NOT_FOUND", "Cliente não encontrado.");
  const tenant = await getPrisma().tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
  const rows = await db.waitlistEntry.findMany({
    where: { contactId, status: { in: [...WAITLIST_ACTIVE_STATUSES] } },
    orderBy: [{ desiredDate: "asc" }, { createdAt: "asc" }],
    take: WAITLIST_MAX_ACTIVE_PER_CONTACT,
    include: { service: { select: { name: true } }, professional: { select: { name: true } } },
  });
  return rows.map((r) => {
    const iso = desiredDateToISO(r.desiredDate);
    const data = formatDayLabelFromISO(iso, tenant.timezone);
    return {
      id: r.id,
      label: `${data} · ${r.service.name}`,
      servico: r.service.name,
      profissional: r.professional?.name ?? null,
      data,
      dateISO: iso,
    };
  });
}
