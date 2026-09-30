import { addDays, addMinutes } from "date-fns";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import type { BookingRuleViolation, BusyRange, ClosedRange, TimeWindow, WorkingHourRule } from "./types";

/**
 * Converte um horário LOCAL (data + "HH:mm") no fuso do tenant para o instante UTC
 * correspondente. Monta a string ISO "naive" (sem fuso) e deixa o `date-fns-tz` resolver
 * o offset pela IANA tz database — nunca usa `new Date(string)` puro nem depende do fuso
 * da máquina que roda o processo (docs/arquitetura.md §14).
 */
function localTimeToUtc(dateISO: string, hhmm: string, timezone: string): Date {
  return fromZonedTime(`${dateISO}T${hhmm}:00`, timezone);
}

/** Dia da semana (0=domingo) de uma data "YYYY-MM-DD", sem depender de fuso — é aritmética de calendário. */
function weekdayOf(dateISO: string): number {
  const [y, m, d] = dateISO.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Soma dias a uma data "YYYY-MM-DD" (aritmética de calendário, sem fuso). */
export function addDaysISO(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Constrói as janelas de expediente (em instante UTC) de um dia específico, a partir das
 * regras semanais, já com bloqueios/feriados (`closedRanges`) subtraídos.
 */
export function computeDayWindows(
  dateISO: string,
  timezone: string,
  workingHours: WorkingHourRule[],
  closedRanges: ClosedRange[],
): TimeWindow[] {
  const weekday = weekdayOf(dateISO);
  const raw: TimeWindow[] = workingHours
    .filter((wh) => wh.weekday === weekday)
    .map((wh) => ({
      start: localTimeToUtc(dateISO, wh.startTime, timezone),
      end: localTimeToUtc(dateISO, wh.endTime, timezone),
    }))
    .filter((w) => w.start < w.end);

  return subtractRanges(raw, closedRanges);
}

/** Subtrai uma lista de intervalos ocupados de uma lista de janelas livres. */
export function subtractRanges(
  windows: TimeWindow[],
  ranges: { startsAt: Date; endsAt: Date }[],
): TimeWindow[] {
  let result = windows;
  for (const range of ranges) {
    const next: TimeWindow[] = [];
    for (const w of result) {
      const noOverlap = range.endsAt <= w.start || range.startsAt >= w.end;
      if (noOverlap) {
        next.push(w);
        continue;
      }
      if (range.startsAt > w.start) {
        next.push({ start: w.start, end: range.startsAt < w.end ? range.startsAt : w.end });
      }
      if (range.endsAt < w.end) {
        next.push({ start: range.endsAt > w.start ? range.endsAt : w.start, end: w.end });
      }
    }
    result = next.filter((w) => w.start < w.end);
  }
  return result.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * Grade ANCORADA na meia-noite local (spec bot v2 §3.5): os candidatos de um dia são os múltiplos
 * de `stepMin` contados desde 00:00 LOCAL (09:00, 09:30, ...), nunca relativos ao início da janela
 * livre. Um serviço de 45 min às 09:00 deixa livre 10:00 (grade 30), nunca 09:45 (BUG-16).
 * Montada por relógio de parede (HH:mm), então em dia de troca de horário de verão cada candidato
 * continua sendo o "HH:mm" local, e instantes repetidos/inexistentes são deduplicados.
 */
function anchoredGrid(dateISO: string, timezone: string, stepMin: number): Date[] {
  const step = Math.max(1, Math.floor(stepMin));
  const seen = new Set<number>();
  const grid: Date[] = [];
  for (let minute = 0; minute < 24 * 60; minute += step) {
    const hh = String(Math.floor(minute / 60)).padStart(2, "0");
    const mm = String(minute % 60).padStart(2, "0");
    const instant = localTimeToUtc(dateISO, `${hh}:${mm}`, timezone);
    if (seen.has(instant.getTime())) continue;
    seen.add(instant.getTime());
    grid.push(instant);
  }
  return grid.sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Horários candidatos (instante de início) para um serviço em um dia específico, para UM
 * profissional. Candidatos = múltiplos de `slotGranularityMin` desde a meia-noite LOCAL de
 * `dateISO` (grade ancorada), dentro das janelas livres; uma janela que começa 09:10 só oferece
 * 09:30 em diante. Exige que o serviço (SEM o buffer — o buffer é intervalo administrativo, pode
 * ultrapassar o fim do expediente) termine dentro da janela.
 *
 * `professionalEligible = false` (profissional não faz o serviço) sempre devolve `[]`.
 */
export function computeAvailableSlots(params: {
  dateISO: string;
  timezone: string;
  workingHours: WorkingHourRule[];
  closedRanges: ClosedRange[];
  busy: BusyRange[];
  serviceDurationMin: number;
  slotGranularityMin: number;
  minLeadTimeMin: number;
  now: Date;
  professionalEligible?: boolean;
}): Date[] {
  if (params.professionalEligible === false) return [];

  const openWindows = computeDayWindows(params.dateISO, params.timezone, params.workingHours, params.closedRanges);
  const freeWindows = subtractRanges(
    openWindows,
    params.busy.map((b) => ({ startsAt: b.startsAt, endsAt: b.blockEndsAt })),
  );
  if (freeWindows.length === 0) return [];

  const earliestStart = addMinutes(params.now, params.minLeadTimeMin);
  const grid = anchoredGrid(params.dateISO, params.timezone, params.slotGranularityMin);
  const slots: Date[] = [];

  for (const window of freeWindows) {
    for (const candidate of grid) {
      if (candidate < window.start) continue;
      if (addMinutes(candidate, params.serviceDurationMin) > window.end) break;
      if (candidate >= earliestStart) slots.push(candidate);
    }
  }

  return slots.sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Dias com pelo menos 1 horário livre, a partir de `fromDateISO` (nunca antes de "hoje" no
 * fuso do tenant), dentro do horizonte máximo (`maxHorizonDays` a partir de "hoje"),
 * paginado por `limit`.
 */
export function computeAvailableDays(params: {
  timezone: string;
  workingHours: WorkingHourRule[];
  closedRanges: ClosedRange[];
  busy: BusyRange[];
  serviceDurationMin: number;
  slotGranularityMin: number;
  minLeadTimeMin: number;
  maxHorizonDays: number;
  now: Date;
  fromDateISO: string;
  limit: number;
  professionalEligible?: boolean;
}): { days: string[]; hasMore: boolean } {
  if (params.professionalEligible === false) return { days: [], hasMore: false };

  const todayISO = formatInTimeZone(params.now, params.timezone, "yyyy-MM-dd");
  const startISO = params.fromDateISO > todayISO ? params.fromDateISO : todayISO;
  const horizonLastISO = addDaysISO(todayISO, params.maxHorizonDays);

  const days: string[] = [];
  let cursor = startISO;
  let hasMore = false;
  // Guarda de segurança: nunca itera mais que o próprio horizonte poderia produzir.
  let safety = 0;
  const maxIterations = params.maxHorizonDays + 1;

  while (cursor < horizonLastISO && safety < maxIterations) {
    safety += 1;
    const slots = computeAvailableSlots({
      dateISO: cursor,
      timezone: params.timezone,
      workingHours: params.workingHours,
      closedRanges: params.closedRanges,
      busy: params.busy,
      serviceDurationMin: params.serviceDurationMin,
      slotGranularityMin: params.slotGranularityMin,
      minLeadTimeMin: params.minLeadTimeMin,
      now: params.now,
      professionalEligible: params.professionalEligible,
    });

    if (slots.length > 0) {
      if (days.length >= params.limit) {
        hasMore = true;
        break;
      }
      days.push(cursor);
    }
    cursor = addDaysISO(cursor, 1);
  }

  return { days, hasMore };
}

/**
 * Verifica se `[start, end)` (sem buffer) cabe dentro do expediente do dia, respeitando
 * antecedência mínima e horizonte máximo. Não considera outros agendamentos — isso é
 * `isRangeFreeOfBusy` (verificação de conflito, mapeada para 409 SLOT_TAKEN, não 422
 * RULE_VIOLATION — docs/arquitetura.md §6.5).
 */
export function checkBookingWindow(params: {
  start: Date;
  end: Date;
  timezone: string;
  workingHours: WorkingHourRule[];
  closedRanges: ClosedRange[];
  minLeadTimeMin: number;
  maxHorizonDays: number;
  now: Date;
}): BookingRuleViolation | null {
  if (params.start < addMinutes(params.now, params.minLeadTimeMin)) {
    return "LEAD_TIME";
  }
  if (params.start > addDays(params.now, params.maxHorizonDays)) {
    return "HORIZON";
  }

  const dateISO = formatInTimeZone(params.start, params.timezone, "yyyy-MM-dd");
  const windows = computeDayWindows(dateISO, params.timezone, params.workingHours, params.closedRanges);
  const fits = windows.some((w) => params.start >= w.start && params.end <= w.end);
  return fits ? null : "OUTSIDE_HOURS";
}

/** `true` se `[start, end)` NÃO colide com nenhum agendamento existente do profissional. */
export function isRangeFreeOfBusy(start: Date, end: Date, busy: BusyRange[]): boolean {
  return !busy.some((b) => start < b.blockEndsAt && end > b.startsAt);
}
