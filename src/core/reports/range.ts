import { addDaysToLocalDate, diffLocalDates, localDateOf, startOfLocalDay } from "@/core/billing/local-time";

/**
 * Período do relatório, sempre em DIAS LOCAIS do fuso da empresa (um atendimento às 23h do dia 31 conta no
 * dia 31, não no 1º do mês seguinte em UTC). `from`/`to` são datas "AAAA-MM-DD" inclusivas; o intervalo
 * consultado no banco é [início de `from`, início do dia seguinte a `to`).
 */

export const REPORT_PRESETS = ["this_month", "last_month", "last_30_days", "custom"] as const;
export type ReportPreset = (typeof REPORT_PRESETS)[number];

export const MAX_REPORT_DAYS = 366;

export type ReportRange = {
  preset: ReportPreset;
  from: string;
  to: string;
  /** Instantes para a consulta: `gte fromInstant` e `lt toExclusiveInstant`. */
  fromInstant: Date;
  toExclusiveInstant: Date;
  days: number;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidLocalDate(value: string | undefined): value is string {
  if (!value || !DATE_RE.test(value)) return false;
  return addDaysToLocalDate(value, 0) === value;
}

export function resolveReportRange(
  input: { preset?: string; from?: string; to?: string },
  now: Date,
  timezone: string,
): ReportRange {
  const today = localDateOf(now, timezone);
  const monthStart = `${today.slice(0, 7)}-01`;
  let preset: ReportPreset = (REPORT_PRESETS as readonly string[]).includes(input.preset ?? "")
    ? (input.preset as ReportPreset)
    : "this_month";
  let from = monthStart;
  let to = today;

  if (preset === "last_month") {
    const lastMonthEnd = addDaysToLocalDate(monthStart, -1);
    from = `${lastMonthEnd.slice(0, 7)}-01`;
    to = lastMonthEnd;
  } else if (preset === "last_30_days") {
    from = addDaysToLocalDate(today, -29);
    to = today;
  } else if (preset === "custom") {
    if (isValidLocalDate(input.from) && isValidLocalDate(input.to)) {
      from = input.from;
      to = input.to;
      if (to < from) [from, to] = [to, from];
      if (diffLocalDates(from, to) + 1 > MAX_REPORT_DAYS) from = addDaysToLocalDate(to, -(MAX_REPORT_DAYS - 1));
    } else {
      preset = "this_month";
    }
  }

  return {
    preset,
    from,
    to,
    fromInstant: startOfLocalDay(from, timezone),
    toExclusiveInstant: startOfLocalDay(addDaysToLocalDate(to, 1), timezone),
    days: diffLocalDates(from, to) + 1,
  };
}
