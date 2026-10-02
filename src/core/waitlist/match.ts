import { formatInTimeZone } from "date-fns-tz";

/**
 * Regras puras da lista de espera (melhoria 7). Sem Prisma nem Next: quem consulta o banco e envia
 * mensagem é `src/modules/waitlist/*`. Aqui só ficam as decisões que se testam sem infraestrutura.
 */

export const WAITLIST_PERIODS = ["ANY", "MORNING", "AFTERNOON", "EVENING"] as const;
export type WaitlistPeriod = (typeof WAITLIST_PERIODS)[number];

/** Prazo padrão para o cliente responder a uma oferta. Constante: a empresa ainda não tem coluna própria (ver pendência da melhoria 7). */
export const WAITLIST_OFFER_MINUTES = 30;
/** Um mesmo cliente não pode juntar filas sem fim (anti-abuso). */
export const WAITLIST_MAX_ACTIVE_PER_CONTACT = 10;
/** Quantos candidatos da fila tentamos oferecer, no máximo, por horário que abriu. */
export const WAITLIST_MAX_CANDIDATES_PER_TRIGGER = 8;

/** Estados em que a pessoa ainda ocupa um lugar na fila. */
export const WAITLIST_ACTIVE_STATUSES = ["WAITING", "OFFERED"] as const;

export type WaitlistPreference = {
  period: string;
  windowStartMin: number | null;
  windowEndMin: number | null;
};

/** Minuto do dia (0..1439) de um instante, no fuso da empresa. */
export function minuteOfDayInTimezone(instant: Date, timezone: string): number {
  const [h, m] = formatInTimeZone(instant, timezone, "HH:mm").split(":").map(Number);
  return h * 60 + m;
}

/** "Manhã" antes das 12h, "tarde" das 12h às 18h, "noite" a partir das 18h (mesma divisão do bot). */
export function periodContainsMinute(period: string, minuteOfDay: number): boolean {
  switch (period) {
    case "MORNING":
      return minuteOfDay < 12 * 60;
    case "AFTERNOON":
      return minuteOfDay >= 12 * 60 && minuteOfDay < 18 * 60;
    case "EVENING":
      return minuteOfDay >= 18 * 60;
    default:
      return true;
  }
}

/**
 * O início de um horário agrada à pessoa? A janela fina (`windowStartMin`/`windowEndMin`, os dois
 * ou nenhum) vale NO LUGAR do período: começa dentro de `[início, fim)`.
 */
export function preferenceAcceptsMinute(pref: WaitlistPreference, minuteOfDay: number): boolean {
  if (pref.windowStartMin !== null && pref.windowEndMin !== null) {
    return minuteOfDay >= pref.windowStartMin && minuteOfDay < pref.windowEndMin;
  }
  return periodContainsMinute(pref.period, minuteOfDay);
}

/**
 * Um horário que começa em `start` e dura `durationMin` toca o intervalo que acabou de abrir
 * `[freedFrom, freedTo)`? Só esses horários são "novos": os demais já estavam livres antes.
 */
export function slotTouchesFreedRange(start: Date, durationMin: number, freedFrom: Date, freedTo: Date): boolean {
  const end = start.getTime() + durationMin * 60_000;
  return start.getTime() < freedTo.getTime() && end > freedFrom.getTime();
}

/** O primeiro horário (por ordem) que cabe na preferência e, se houver, toca o intervalo liberado. */
export function pickSlotForPreference(params: {
  slots: Date[];
  pref: WaitlistPreference;
  timezone: string;
  durationMin: number;
  freed?: { from: Date; to: Date } | null;
}): Date | null {
  const sorted = [...params.slots].sort((a, b) => a.getTime() - b.getTime());
  for (const slot of sorted) {
    if (params.freed && !slotTouchesFreedRange(slot, params.durationMin, params.freed.from, params.freed.to)) continue;
    if (!preferenceAcceptsMinute(params.pref, minuteOfDayInTimezone(slot, params.timezone))) continue;
    return slot;
  }
  return null;
}

/** Dia da fila (coluna `DATE`, sempre meia-noite UTC) como "YYYY-MM-DD". */
export function desiredDateToISO(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" como valor para a coluna `DATE`. */
export function isoToDesiredDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** Texto curto do que a pessoa pediu, para o painel: "Qualquer horário", "Manhã", "14:00 às 16:00". */
export function describePreference(pref: WaitlistPreference): string {
  if (pref.windowStartMin !== null && pref.windowEndMin !== null) {
    return `${formatMinute(pref.windowStartMin)} às ${formatMinute(pref.windowEndMin)}`;
  }
  switch (pref.period) {
    case "MORNING":
      return "Manhã";
    case "AFTERNOON":
      return "Tarde";
    case "EVENING":
      return "Noite";
    default:
      return "Qualquer horário";
  }
}

export function formatMinute(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** "HH:mm" para minutos desde a meia-noite; `null` se inválido. */
export function parseMinute(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 24 || m > 59 || (h === 24 && m !== 0)) return null;
  return h * 60 + m;
}
