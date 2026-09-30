import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { addDaysISO, computeAvailableDays, computeAvailableSlots, computeDayWindows } from "@/core/agenda";
import type { BusyRange, ClosedRange, WorkingHourRule } from "@/core/agenda";
import { validateName } from "@/core/bot/engine";
import {
  formatDayLabelFromISO,
  formatDurationLabel,
  formatLeadLabel,
  formatLongDayLabel,
  formatPriceLabel,
  formatRelativeDayLabel,
  formatServiceLabel,
  formatDayLabel,
  formatTimeLabel,
} from "@/core/bot/format";
import { getPrisma } from "@/lib/db/prisma";
import { forTenant } from "@/lib/db/tenant-client";
import { DomainError } from "@/lib/errors";
import { loadProfessionalScheduleInputs } from "@/modules/agenda/availability-loader";
import { cancelAppointment, createAppointmentManual, rescheduleAppointment } from "@/modules/agenda/appointments";
import type { FlowVersion } from "./flow-version";
import { notFound, type InternalApiContext } from "./internal-auth";

export type Option = { id: string; label: string };

/**
 * Catálogo e disponibilidade formatados para o bot (docs/arquitetura.md §6.4, docs/bot-v2-plano.md
 * §3.4) — reaproveita `src/core/agenda` e `src/modules/agenda/availability-loader.ts` (a mesma
 * matemática de horários usada pelo painel), só muda a FORMA da resposta: sempre `{ options: [...] }`
 * já numerável e com rótulo pronto no fuso/locale do tenant.
 */

// ─────────────────────────────── Catálogo ───────────────────────────────

/** Profissionais aptos por serviço, só ATIVOS e COM expediente (BUG-09). */
async function loadBookableProfessionalsByService(tenantId: string, serviceIds: string[]): Promise<Map<string, string[]>> {
  const links = await getPrisma().professionalService.findMany({
    where: {
      serviceId: { in: serviceIds },
      service: { tenantId, active: true },
      professional: { tenantId, active: true, workingHours: { some: {} } },
    },
    select: { serviceId: true, professionalId: true },
  });
  const byService = new Map<string, string[]>();
  for (const l of links) byService.set(l.serviceId, [...(byService.get(l.serviceId) ?? []), l.professionalId]);
  return byService;
}

export type CatalogServiceOption = Option & {
  durationMin: number;
  name: string;
  durationLabel: string;
  priceLabel: string | null;
};

export type CatalogServicesResult = {
  options: CatalogServiceOption[];
  /** Só quando `contactId` é informado. `max = 0` = sem limite. */
  limit?: { max: number; count: number; reached: boolean };
};

async function countFutureAppointments(tenantId: string, contactId: string, now: Date): Promise<number> {
  return forTenant(tenantId).appointment.count({ where: { contactId, status: "SCHEDULED", startsAt: { gt: now } } });
}

export async function listCatalogServiceOptions(tenantId: string, params?: { contactId?: string | null }): Promise<CatalogServicesResult> {
  const services = await forTenant(tenantId).service.findMany({
    where: { active: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  const bookable = await loadBookableProfessionalsByService(tenantId, services.map((s) => s.id));

  const result: CatalogServicesResult = {
    options: services
      .filter((s) => (bookable.get(s.id)?.length ?? 0) > 0)
      .map((s) => ({
        id: s.id,
        label: formatServiceLabel(s.name, s.priceCents),
        durationMin: s.durationMin,
        name: s.name,
        durationLabel: formatDurationLabel(s.durationMin),
        priceLabel: formatPriceLabel(s.priceCents),
      })),
  };

  if (params?.contactId) {
    const contact = await forTenant(tenantId).contact.findFirst({ where: { id: params.contactId } });
    if (!contact) notFound("Cliente não encontrado.");
    const tenant = await getPrisma().tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const count = await countFutureAppointments(tenantId, params.contactId, new Date());
    const max = tenant.maxFutureAppointmentsPerContact;
    result.limit = { max, count, reached: max > 0 && count >= max };
  }
  return result;
}

export async function listCatalogProfessionalOptions(
  tenantId: string,
  serviceId: string,
): Promise<{ options: Option[]; skip: boolean }> {
  const service = await forTenant(tenantId).service.findFirst({ where: { id: serviceId, active: true } });
  if (!service) notFound("Serviço não encontrado.");

  const tenant = await getPrisma().tenant.findUniqueOrThrow({ where: { id: tenantId } });

  const professionalIds = (await loadBookableProfessionalsByService(tenantId, [serviceId])).get(serviceId) ?? [];
  const professionals = await forTenant(tenantId).professional.findMany({
    where: { id: { in: Array.from(new Set(professionalIds)) } },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });

  const skip = !tenant.askProfessional || professionals.length <= 1;
  if (skip) {
    const options: Option[] = professionals.length === 1
      ? [{ id: professionals[0].id, label: professionals[0].name }]
      : [{ id: "any", label: "Qualquer profissional" }];
    return { options, skip: true };
  }

  return {
    options: [
      { id: "any", label: "Qualquer profissional" },
      ...professionals.map((p) => ({ id: p.id, label: p.name })),
    ],
    skip: false,
  };
}

// ─────────────────────────────── Disponibilidade ───────────────────────────────

async function resolveEligibleProfessionalIds(tenantId: string, serviceId: string, professionalId: string | null): Promise<string[]> {
  if (professionalId) {
    const professional = await forTenant(tenantId).professional.findFirst({ where: { id: professionalId, active: true } });
    if (!professional) notFound("Profissional não encontrado.");
    return [professionalId];
  }
  const links = await getPrisma().professionalService.findMany({
    where: { serviceId, professional: { tenantId, active: true } },
    select: { professionalId: true },
  });
  return Array.from(new Set(links.map((l) => l.professionalId)));
}

type ProfessionalInputs = { workingHourRules: WorkingHourRule[]; closedRanges: ClosedRange[]; busy: BusyRange[] };

async function loadAllInputs(tenantId: string, professionalIds: string[], range: { from: Date; to: Date }): Promise<ProfessionalInputs[]> {
  const inputs: ProfessionalInputs[] = [];
  for (const professionalId of professionalIds) inputs.push(await loadProfessionalScheduleInputs(tenantId, professionalId, range));
  return inputs;
}

type TenantRules = {
  timezone: string;
  slotGranularityMin: number;
  minLeadTimeMin: number;
  maxHorizonDays: number;
};

/** Horários livres de um dia (união de todos os profissionais aptos), ordenados, sem repetição. */
function slotsOfDay(tenant: TenantRules, inputs: ProfessionalInputs[], durationMin: number, dateISO: string, now: Date): Date[] {
  const all = new Set<number>();
  for (const input of inputs) {
    const slots = computeAvailableSlots({
      dateISO,
      timezone: tenant.timezone,
      workingHours: input.workingHourRules,
      closedRanges: input.closedRanges,
      busy: input.busy,
      serviceDurationMin: durationMin,
      slotGranularityMin: tenant.slotGranularityMin,
      minLeadTimeMin: tenant.minLeadTimeMin,
      now,
    });
    for (const s of slots) all.add(s.getTime());
  }
  return Array.from(all)
    .sort((a, b) => a - b)
    .map((t) => new Date(t));
}

function hasOpenWindow(tenant: TenantRules, inputs: ProfessionalInputs[], dateISO: string): boolean {
  return inputs.some((i) => computeDayWindows(dateISO, tenant.timezone, i.workingHourRules, i.closedRanges).length > 0);
}

/** Último dia oferecido: mesmo limite de `computeAvailableDays` (hoje + horizonte, exclusive). */
function lastBookableISO(todayISO: string, maxHorizonDays: number): string {
  return addDaysISO(todayISO, Math.max(0, maxHorizonDays - 1));
}

function formatDayIso(date: Date, timezone: string): string {
  return formatInTimeZone(date, timezone, "yyyy-MM-dd");
}

/** Instante do meio-dia LOCAL de uma data de calendário (BUG-15: nunca meio-dia UTC). */
function localNoon(iso: string, timezone: string): Date {
  return fromZonedTime(`${iso}T12:00:00`, timezone);
}

function loadRangeForHorizon(now: Date, maxHorizonDays: number): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - 86_400_000), to: new Date(now.getTime() + (maxHorizonDays + 2) * 86_400_000) };
}

export type DayOption = Option & { relativeLabel: string };

export async function listAvailabilityDayOptions(
  tenantId: string,
  params: { serviceId: string; professionalId: string | null; from: string | null; limit: number },
): Promise<{ options: DayOption[]; hasMore: boolean; nextFrom: string | null; lastBookableDate: Option }> {
  const service = await forTenant(tenantId).service.findFirst({ where: { id: params.serviceId, active: true } });
  if (!service) notFound("Serviço não encontrado.");

  const tenant = await getPrisma().tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const professionalIds = await resolveEligibleProfessionalIds(tenantId, params.serviceId, params.professionalId);

  const now = new Date();
  const todayISO = formatDayIso(now, tenant.timezone);
  const lastISO = lastBookableISO(todayISO, tenant.maxHorizonDays);
  const lastBookableDate = { id: lastISO, label: formatDayLabelFromISO(lastISO, tenant.timezone) };
  if (professionalIds.length === 0) return { options: [], hasMore: false, nextFrom: null, lastBookableDate };

  // `from` omitido = hoje no fuso do tenant (docs/contratos.md — "API interna do bot").
  const fromDateISO = params.from ?? todayISO;

  const daysWithSlot = new Set<string>();
  for (const input of await loadAllInputs(tenantId, professionalIds, loadRangeForHorizon(now, tenant.maxHorizonDays))) {
    const { days } = computeAvailableDays({
      timezone: tenant.timezone,
      workingHours: input.workingHourRules,
      closedRanges: input.closedRanges,
      busy: input.busy,
      serviceDurationMin: service.durationMin,
      slotGranularityMin: tenant.slotGranularityMin,
      minLeadTimeMin: tenant.minLeadTimeMin,
      maxHorizonDays: tenant.maxHorizonDays,
      now,
      fromDateISO,
      limit: tenant.maxHorizonDays + 1,
    });
    for (const d of days) daysWithSlot.add(d);
  }

  const sorted = Array.from(daysWithSlot).sort();
  const page = sorted.slice(0, params.limit);
  const hasMore = sorted.length > params.limit;

  return {
    options: page.map((iso) => ({
      id: iso,
      label: formatDayLabelFromISO(iso, tenant.timezone),
      relativeLabel: formatRelativeDayLabel(iso, todayISO, tenant.timezone),
    })),
    hasMore,
    // BUG-05: a próxima página começa no dia SEGUINTE ao último mostrado (antes repetia o último).
    nextFrom: hasMore ? addDaysISO(page[page.length - 1], 1) : null,
    lastBookableDate,
  };
}

export type SlotsReason = "PAST" | "BEYOND_HORIZON" | "CLOSED" | "FULL";
export type SlotsPeriod = "morning" | "afternoon" | "evening";

export type SlotsResult = {
  options: Option[];
  hasMore: boolean;
  exact?: boolean;
  dateLabel: string;
  dateRelativeLabel: string;
  dateLongLabel: string;
  reason: SlotsReason | null;
  nextDay: DayOption | null;
};

function periodOf(hour: number): SlotsPeriod {
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

function minuteOfDay(date: Date, timezone: string): number {
  const [h, m] = formatInTimeZone(date, timezone, "HH:mm").split(":").map(Number);
  return h * 60 + m;
}

/**
 * Horários de um dia. `period` filtra por hora local (<12, 12–18, ≥18). `near` ("HH:mm") ordena
 * por distância àquele horário (empate: o mais cedo) e `exact` diz se o primeiro é exatamente ele.
 * Com `options` vazio, `reason` explica o porquê e `nextDay` traz o próximo dia com vaga (dentro
 * do horizonte); se o vazio veio só do filtro de período/página, `reason` é `FULL`.
 */
export async function listAvailabilitySlotOptions(
  tenantId: string,
  params: {
    serviceId: string;
    professionalId: string | null;
    date: string;
    offset: number;
    limit: number;
    period?: SlotsPeriod | null;
    near?: string | null;
  },
): Promise<SlotsResult> {
  const service = await forTenant(tenantId).service.findFirst({ where: { id: params.serviceId, active: true } });
  if (!service) notFound("Serviço não encontrado.");

  const tenant = await getPrisma().tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const professionalIds = await resolveEligibleProfessionalIds(tenantId, params.serviceId, params.professionalId);

  const now = new Date();
  const todayISO = formatDayIso(now, tenant.timezone);
  const lastISO = lastBookableISO(todayISO, tenant.maxHorizonDays);

  const labels = {
    dateLabel: formatDayLabelFromISO(params.date, tenant.timezone),
    dateRelativeLabel: formatRelativeDayLabel(params.date, todayISO, tenant.timezone),
    dateLongLabel: formatLongDayLabel(localNoon(params.date, tenant.timezone), tenant.timezone),
  };

  const outOfRange: SlotsReason | null = params.date < todayISO ? "PAST" : params.date > lastISO ? "BEYOND_HORIZON" : null;

  let dayInputs: ProfessionalInputs[] = [];
  let allSlots: Date[] = [];
  if (!outOfRange) {
    const dayFrom = new Date(`${params.date}T00:00:00.000Z`);
    const dayTo = new Date(`${params.date}T23:59:59.999Z`);
    const loadRange = { from: new Date(dayFrom.getTime() - 86_400_000), to: new Date(dayTo.getTime() + 86_400_000) };
    dayInputs = await loadAllInputs(tenantId, professionalIds, loadRange);
    allSlots = slotsOfDay(tenant, dayInputs, service.durationMin, params.date, now);
  }

  let candidates = allSlots;
  if (params.period) {
    candidates = candidates.filter((d) => periodOf(Math.floor(minuteOfDay(d, tenant.timezone) / 60)) === params.period);
  }

  let exact: boolean | undefined;
  if (params.near) {
    const [h, m] = params.near.split(":").map(Number);
    const target = h * 60 + m;
    candidates = [...candidates].sort((a, b) => {
      const da = Math.abs(minuteOfDay(a, tenant.timezone) - target);
      const db = Math.abs(minuteOfDay(b, tenant.timezone) - target);
      return da - db || a.getTime() - b.getTime();
    });
    exact = candidates.length > 0 && minuteOfDay(candidates[0], tenant.timezone) === target;
  }

  const page = candidates.slice(params.offset, params.offset + params.limit);
  const hasMore = candidates.length > params.offset + params.limit;
  const options = page.map((d) => ({ id: d.toISOString(), label: formatTimeLabel(d, tenant.timezone) }));

  let reason: SlotsReason | null = null;
  let nextDay: DayOption | null = null;
  if (options.length === 0) {
    reason = outOfRange ?? (allSlots.length === 0 && !hasOpenWindow(tenant, dayInputs, params.date) ? "CLOSED" : "FULL");
    if (reason !== "BEYOND_HORIZON") {
      const searchFrom = params.date < todayISO ? todayISO : addDaysISO(params.date, 1);
      nextDay = await findNextFreeDay(tenantId, { durationMin: service.durationMin, tenant, professionalIds, fromISO: searchFrom, lastISO, todayISO, now });
    }
  }

  return { options, hasMore, ...(exact === undefined ? {} : { exact }), ...labels, reason, nextDay };
}

async function findNextFreeDay(
  tenantId: string,
  p: {
    durationMin: number;
    tenant: TenantRules;
    professionalIds: string[];
    fromISO: string;
    lastISO: string;
    todayISO: string;
    now: Date;
  },
): Promise<DayOption | null> {
  if (p.fromISO > p.lastISO || p.professionalIds.length === 0) return null;
  const inputs = await loadAllInputs(tenantId, p.professionalIds, loadRangeForHorizon(p.now, p.tenant.maxHorizonDays));
  for (let cursor = p.fromISO; cursor <= p.lastISO; cursor = addDaysISO(cursor, 1)) {
    if (slotsOfDay(p.tenant, inputs, p.durationMin, cursor, p.now).length > 0) {
      return {
        id: cursor,
        label: formatDayLabelFromISO(cursor, p.tenant.timezone),
        relativeLabel: formatRelativeDayLabel(cursor, p.todayISO, p.tenant.timezone),
      };
    }
  }
  return null;
}

/**
 * `GET /availability/next` — os próximos horários livres em QUALQUER dia (primeiro horário livre),
 * com rótulo "Hoje · 16:30" / "Amanhã · 09:00" / "Sex 02/10 · 09:00".
 */
export async function listNextAvailableSlots(
  tenantId: string,
  params: { serviceId: string; professionalId: string | null; limit: number },
): Promise<{ options: { id: string; label: string; date: string }[] }> {
  const service = await forTenant(tenantId).service.findFirst({ where: { id: params.serviceId, active: true } });
  if (!service) notFound("Serviço não encontrado.");

  const tenant = await getPrisma().tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const professionalIds = await resolveEligibleProfessionalIds(tenantId, params.serviceId, params.professionalId);
  if (professionalIds.length === 0) return { options: [] };

  const now = new Date();
  const todayISO = formatDayIso(now, tenant.timezone);
  const lastISO = lastBookableISO(todayISO, tenant.maxHorizonDays);
  const inputs = await loadAllInputs(tenantId, professionalIds, loadRangeForHorizon(now, tenant.maxHorizonDays));

  const options: { id: string; label: string; date: string }[] = [];
  for (let cursor = todayISO; cursor <= lastISO && options.length < params.limit; cursor = addDaysISO(cursor, 1)) {
    const relative = formatRelativeDayLabel(cursor, todayISO, tenant.timezone);
    const prefix = relative.startsWith("Hoje") ? "Hoje" : relative.startsWith("Amanhã") ? "Amanhã" : relative;
    for (const slot of slotsOfDay(tenant, inputs, service.durationMin, cursor, now)) {
      if (options.length >= params.limit) break;
      options.push({ id: slot.toISOString(), label: `${prefix} · ${formatTimeLabel(slot, tenant.timezone)}`, date: cursor });
    }
  }
  return { options };
}

export type SlotAlternatives = { date: string; dateISO: string; dateRelativeLabel: string; options: Option[] };

/**
 * Alternativas para `409 SLOT_TAKEN` (docs/arquitetura.md §2 regra 3, §6.5): até 6 horários do
 * MESMO dia do profissional pedido (ou "qualquer profissional" apto), e se não houver nenhum,
 * procura nos próximos dias com vaga dentro do horizonte — nunca devolve vazio se existir
 * QUALQUER horário possível. Traz o dia (`date` rótulo, `dateISO`, `dateRelativeLabel`) porque o
 * dia das alternativas pode não ser o do horário pedido (BUG-07).
 */
async function findAlternatives(
  tenantId: string,
  params: { serviceId: string; professionalId: string | null; startsAt: Date },
): Promise<SlotAlternatives> {
  const tenant = await getPrisma().tenant.findUniqueOrThrow({ where: { id: tenantId } });

  const todayISO = formatDayIso(new Date(), tenant.timezone);
  const startDateISO = formatDayIso(params.startsAt, tenant.timezone);
  const horizonLastISO = formatDayIso(new Date(Date.now() + tenant.maxHorizonDays * 86_400_000), tenant.timezone);
  const describe = (iso: string) => ({
    date: formatDayLabelFromISO(iso, tenant.timezone),
    dateISO: iso,
    dateRelativeLabel: formatRelativeDayLabel(iso, todayISO, tenant.timezone),
  });

  let cursor = startDateISO;
  for (let i = 0; i < tenant.maxHorizonDays + 1 && cursor <= horizonLastISO; i++) {
    const { options } = await listAvailabilitySlotOptions(tenantId, {
      serviceId: params.serviceId,
      professionalId: params.professionalId,
      date: cursor,
      offset: 0,
      limit: 6,
    });
    if (options.length > 0) return { ...describe(cursor), options };
    cursor = addDaysISO(cursor, 1);
  }

  return { ...describe(startDateISO), options: [] };
}

// ─────────────────────────────── Agendamentos ───────────────────────────────

export type CreateAppointmentBotInput = {
  contactId: string;
  serviceId: string;
  professionalId: string | null;
  startsAt: Date;
  idempotencyKey: string;
  instanceName?: string;
  /** Nome digitado nesta conversa (v2). Validado com `validateName`; inválido → 422 INVALID_NAME. */
  contactName?: string;
  /** `X-InnoChat-Flow`. O limite de agendamentos futuros só vale no v2. */
  flow?: FlowVersion;
};

/** Formata `{ id, summary }` (docs/arquitetura.md §6.5) a partir de um `Appointment` recém-criado/existente. */
export async function toAppointmentSummary(tenantId: string, appointmentId: string) {
  const tenant = await getPrisma().tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const appointment = await forTenant(tenantId).appointment.findFirstOrThrow({
    where: { id: appointmentId },
    include: { service: true, professional: true },
  });
  return {
    id: appointment.id,
    summary: {
      servico: appointment.service.name,
      profissional: appointment.professional.name,
      data: formatDayLabel(appointment.startsAt, tenant.timezone),
      hora: formatTimeLabel(appointment.startsAt, tenant.timezone),
      duracao: formatDurationLabel(appointment.service.durationMin),
      preco: formatPriceLabel(appointment.service.priceCents),
      data_longa: formatLongDayLabel(appointment.startsAt, tenant.timezone),
    },
  };
}

export async function createAppointmentBot(
  ctx: InternalApiContext,
  input: CreateAppointmentBotInput,
): Promise<{ appointment: Awaited<ReturnType<typeof toAppointmentSummary>>; alreadyExisted: boolean }> {
  if (input.instanceName && input.instanceName !== ctx.instance.instanceName) {
    throw new DomainError("INVALID_PAYLOAD", "instanceName não corresponde à instância autenticada.");
  }

  let contactName: string | undefined;
  if (input.contactName !== undefined) {
    const checked = validateName(input.contactName);
    if (!checked.ok) {
      throw new DomainError("INVALID_NAME", "O nome informado não é válido.", { reason: checked.reason });
    }
    contactName = checked.name;
  }

  const contact = await forTenant(ctx.tenantId).contact.findFirst({ where: { id: input.contactId } });
  if (!contact) notFound("Cliente não encontrado.");

  let futureLimit = 0;
  if (input.flow === 2) {
    const tenant = await getPrisma().tenant.findUniqueOrThrow({ where: { id: ctx.tenantId } });
    futureLimit = tenant.maxFutureAppointmentsPerContact;
  }

  try {
    const { appointment, alreadyExisted } = await createAppointmentManual(
      ctx.tenantId,
      {
        contactId: input.contactId,
        serviceId: input.serviceId,
        professionalId: input.professionalId,
        startsAt: input.startsAt,
        idempotencyKey: input.idempotencyKey,
      },
      contact!.id,
      { source: "WHATSAPP", whatsappInstanceId: ctx.instance.id, authorType: "CONTACT", contactName, futureLimit },
    );
    const summary = await toAppointmentSummary(ctx.tenantId, (appointment as { id: string }).id);
    return { appointment: summary, alreadyExisted };
  } catch (error) {
    if (error instanceof DomainError && error.code === "SLOT_TAKEN") {
      const alternatives = await findAlternatives(ctx.tenantId, {
        serviceId: input.serviceId,
        professionalId: input.professionalId,
        startsAt: input.startsAt,
      });
      throw new DomainError("SLOT_TAKEN", "Este horário já está ocupado.", { alternatives });
    }
    throw error;
  }
}

async function loadOwnedContactAppointment(tenantId: string, appointmentId: string, contactId: string) {
  const appointment = await forTenant(tenantId).appointment.findFirst({ where: { id: appointmentId } });
  if (!appointment || appointment.contactId !== contactId) {
    notFound("Agendamento não encontrado.");
  }
  return appointment!;
}

export async function cancelAppointmentBot(ctx: InternalApiContext, appointmentId: string, contactId: string) {
  await loadOwnedContactAppointment(ctx.tenantId, appointmentId, contactId);
  return cancelAppointment(ctx.tenantId, appointmentId, contactId, undefined, "CONTACT");
}

export async function rescheduleAppointmentBot(ctx: InternalApiContext, appointmentId: string, contactId: string, startsAt: Date) {
  const appointment = await loadOwnedContactAppointment(ctx.tenantId, appointmentId, contactId);
  try {
    return await rescheduleAppointment(ctx.tenantId, appointmentId, startsAt, contactId, "CONTACT");
  } catch (error) {
    if (error instanceof DomainError && error.code === "SLOT_TAKEN") {
      const alternatives = await findAlternatives(ctx.tenantId, {
        serviceId: appointment.serviceId,
        professionalId: appointment.professionalId,
        startsAt,
      });
      throw new DomainError("SLOT_TAKEN", "Este horário já está ocupado.", { alternatives });
    }
    throw error;
  }
}

export type AppointmentOption = Option & {
  serviceId: string;
  professionalId: string;
  servico: string;
  profissional: string;
  data: string;
  hora: string;
  startsAt: string;
  /** `startsAt - agora >= cancelMinLeadMin` (mesma regra do cancelar/remarcar). */
  canChange: boolean;
  changeDeadlineLabel: string;
  durationLabel: string;
  priceLabel: string | null;
  dataLonga: string;
  relativeLabel: string;
};

/**
 * `GET /contacts/{contactId}/appointments` (docs/arquitetura.md §6.5). Cada opção já vem com os
 * dados que o n8n precisaria extrair do `label` por regex para remarcar/cancelar (docs/contratos.md
 * — "API interna do bot"): `serviceId`/`professionalId`/`servico`/`profissional`/`data`/`hora`
 * (formatados no fuso do tenant, mesmos formatos de `core/bot/format.ts`) e `startsAt` em ISO.
 * `label` continua igual, por compatibilidade com quem já lê só ele. Bot v2: `canChange` diz se o
 * prazo de alteração ainda permite remarcar/cancelar (BUG-08), mais rótulos prontos.
 */
export async function listMyAppointmentOptions(tenantId: string, contactId: string, upcoming: boolean): Promise<{ options: AppointmentOption[] }> {
  const contact = await forTenant(tenantId).contact.findFirst({ where: { id: contactId } });
  if (!contact) notFound("Cliente não encontrado.");

  const tenant = await getPrisma().tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const now = new Date();
  const todayISO = formatDayIso(now, tenant.timezone);
  const changeDeadlineLabel = formatLeadLabel(tenant.cancelMinLeadMin);

  const appointments = await forTenant(tenantId).appointment.findMany({
    where: {
      contactId,
      status: "SCHEDULED",
      ...(upcoming ? { startsAt: { gte: now } } : {}),
    },
    include: { service: true, professional: true },
    orderBy: { startsAt: "asc" },
    take: 50,
  });

  return {
    options: appointments.map((a) => {
      const data = formatDayLabel(a.startsAt, tenant.timezone);
      const hora = formatTimeLabel(a.startsAt, tenant.timezone);
      return {
        id: a.id,
        label: `${data} ${hora} — ${a.service.name} (${a.professional.name})`,
        serviceId: a.serviceId,
        professionalId: a.professionalId,
        servico: a.service.name,
        profissional: a.professional.name,
        data,
        hora,
        startsAt: a.startsAt.toISOString(),
        canChange: a.startsAt.getTime() - now.getTime() >= tenant.cancelMinLeadMin * 60_000,
        changeDeadlineLabel,
        durationLabel: formatDurationLabel(a.service.durationMin),
        priceLabel: formatPriceLabel(a.service.priceCents),
        dataLonga: formatLongDayLabel(a.startsAt, tenant.timezone),
        relativeLabel: formatRelativeDayLabel(formatDayIso(a.startsAt, tenant.timezone), todayISO, tenant.timezone),
      };
    }),
  };
}
