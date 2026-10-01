import { fromZonedTime, formatInTimeZone } from "date-fns-tz";

/**
 * Datas e horas no fuso da empresa, puras (sem I/O, sem relógio próprio). A régua de cobrança pensa em
 * DIAS LOCAIS ("vence amanhã", "D+2"), e um dia local não tem sempre 24 h (horário de verão): por isso a
 * conta de dias é feita sobre a data "yyyy-MM-dd" e só a ponta vira instante, com `fromZonedTime`.
 *
 * O produto só suporta `America/Sao_Paulo` na v1 (docs/arquitetura.md §14); o fuso entra por parâmetro
 * mesmo assim, para os testes cobrirem virada de dia e horário de verão de verdade.
 */

export const DEFAULT_BILLING_TIMEZONE = "America/Sao_Paulo";

const validCache = new Map<string, boolean>();

/** Fuso IANA válido ou o padrão. Nunca lança (um fuso corrompido no banco não pode derrubar o tick). */
export function safeTimezone(timezone: string | null | undefined): string {
  if (!timezone) return DEFAULT_BILLING_TIMEZONE;
  let ok = validCache.get(timezone);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat("pt-BR", { timeZone: timezone });
      ok = true;
    } catch {
      ok = false;
    }
    validCache.set(timezone, ok);
  }
  return ok ? timezone : DEFAULT_BILLING_TIMEZONE;
}

/** "yyyy-MM-dd" do instante no fuso. */
export function localDateOf(instant: Date, timezone: string): string {
  return formatInTimeZone(instant, safeTimezone(timezone), "yyyy-MM-dd");
}

/** Soma `days` (pode ser negativo) a uma data "yyyy-MM-dd". Aritmética de calendário, imune a horário de verão. */
export function addDaysToLocalDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const moved = new Date(Date.UTC(y, m - 1, d + days));
  return `${moved.getUTCFullYear()}-${String(moved.getUTCMonth() + 1).padStart(2, "0")}-${String(moved.getUTCDate()).padStart(2, "0")}`;
}

/** Diferença `b - a` em dias de calendário entre duas datas "yyyy-MM-dd". */
export function diffLocalDates(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** Dia da semana da data local: 0 = domingo ... 6 = sábado. */
export function weekdayOfLocalDate(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
}

/** Instante em que o relógio da parede do fuso marca `date` + `time` ("HH:mm" ou "HH:mm:ss.SSS"). */
export function localDateTimeToInstant(date: string, time: string, timezone: string): Date {
  const normalized = /^\d{2}:\d{2}$/.test(time) ? `${time}:00.000` : time;
  return fromZonedTime(`${date}T${normalized}`, safeTimezone(timezone));
}

/** Primeiro instante do dia local. */
export function startOfLocalDay(date: string, timezone: string): Date {
  let start = localDateTimeToInstant(date, "00:00:00.000", timezone);
  // Fuso cuja troca de horário come a meia-noite (00:00 não existe): a biblioteca devolve um instante que
  // ainda pertence ao dia anterior. Anda para frente até cair no dia certo (no máximo 2 h).
  for (let i = 0; i < 3 && localDateOf(start, timezone) !== date; i += 1) start = new Date(start.getTime() + 3_600_000);
  return start;
}

/** Último instante (23:59:59.999) do dia local. Existe em todo fuso, inclusive em dia de troca de horário. */
export function endOfLocalDay(date: string, timezone: string): Date {
  return localDateTimeToInstant(date, "23:59:59.999", timezone);
}

/** "HH:mm" do instante no fuso (texto de "termina hoje às 15:00"). */
export function localTimeLabel(instant: Date, timezone: string): string {
  return formatInTimeZone(instant, safeTimezone(timezone), "HH:mm");
}

/** Hora cheia local (0 a 23) do instante. */
export function localHourOf(instant: Date, timezone: string): number {
  return Number(formatInTimeZone(instant, safeTimezone(timezone), "H"));
}
