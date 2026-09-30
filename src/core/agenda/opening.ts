import { formatInTimeZone } from "date-fns-tz";
import { addDaysISO, computeDayWindows } from "./availability";
import type { ClosedRange, WorkingHourRule } from "./types";

/**
 * Abertura da EQUIPE (spec bot v2 §3.10, decisão P4): união dos expedientes dos profissionais
 * ativos, no fuso do tenant, menos as exceções da empresa (feriado/fechamento).
 *
 * - `openNow`: `now` cai dentro de alguma janela de hoje (início inclusivo, fim exclusivo).
 * - `nextOpenAt`: início da próxima janela que começa ESTRITAMENTE depois de `now`, olhando de hoje
 *   até `horizonDays` dias à frente (padrão 14); `null` se não houver nenhuma (sem expediente
 *   cadastrado ou tudo fechado). Vale também quando `openNow` é true (é "a próxima abertura").
 *
 * Puro: não lê banco nem relógio; quem chama monta `workingHours`/`closedRanges`.
 */
export function teamOpening(p: {
  timezone: string;
  workingHours: WorkingHourRule[];
  closedRanges: ClosedRange[];
  now: Date;
  horizonDays?: number;
}): { openNow: boolean; nextOpenAt: Date | null } {
  const horizon = p.horizonDays ?? 14;
  const todayISO = formatInTimeZone(p.now, p.timezone, "yyyy-MM-dd");
  const nowMs = p.now.getTime();

  let openNow = false;
  let nextOpenAt: Date | null = null;

  for (let offset = 0; offset <= horizon; offset += 1) {
    const dateISO = addDaysISO(todayISO, offset);
    const windows = computeDayWindows(dateISO, p.timezone, p.workingHours, p.closedRanges);
    for (const w of windows) {
      if (offset === 0 && w.start.getTime() <= nowMs && nowMs < w.end.getTime()) openNow = true;
      if (w.start.getTime() > nowMs && (nextOpenAt === null || w.start < nextOpenAt)) nextOpenAt = w.start;
    }
    // O dia 0 já foi avaliado inteiro (openNow definido); achado o próximo início, para.
    if (nextOpenAt !== null) break;
  }

  return { openNow, nextOpenAt };
}
