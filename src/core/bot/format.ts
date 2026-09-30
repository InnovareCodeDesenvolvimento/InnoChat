import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import { addDaysISO } from "../agenda/availability";

/**
 * Rótulos formatados no fuso/locale do tenant (docs/arquitetura.md §3, §6.4 — "o painel já
 * devolve os rótulos formatados"). Puro: só formatação, sem I/O.
 */

const WEEKDAY_ABBR_PT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

/** "Ter 30/09" — dia da semana abreviado + dd/MM, no fuso do tenant. */
export function formatDayLabel(date: Date, timezone: string): string {
  const weekday = Number(formatInTimeZone(date, timezone, "i")); // 1 (segunda) .. 7 (domingo), ISO
  const abbr = WEEKDAY_ABBR_PT[weekday % 7];
  return `${abbr} ${formatInTimeZone(date, timezone, "dd/MM")}`;
}

/** "14:30" — HH:mm no fuso do tenant. */
export function formatTimeLabel(date: Date, timezone: string): string {
  return formatInTimeZone(date, timezone, "HH:mm");
}

/** "R$ 80,00" — `priceCents` nulo/undefined devolve `null` (serviço sem preço, §3: "sem preço, só o nome"). */
export function formatPriceLabel(priceCents: number | null | undefined): string | null {
  if (priceCents === null || priceCents === undefined) return null;
  // `Intl.NumberFormat` devolve NBSP (U+00A0) entre "R$" e o valor — troca por espaço normal:
  // texto vai para o WhatsApp via texto puro, e um NBSP nesse canal é só risco de exibição
  // estranha em algum cliente, sem nenhum ganho.
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(priceCents / 100).replace(/ /g, " ");
}

/** "Corte feminino — R$ 80,00" ou "Corte feminino" (sem preço). */
export function formatServiceLabel(name: string, priceCents: number | null | undefined): string {
  const price = formatPriceLabel(priceCents);
  return price ? `${name} — ${price}` : name;
}

// ─────────────────────────── Bot v2 (docs/bot-v2-plano.md §3.3) ───────────────────────────

const WEEKDAY_LONG_PT = [
  "domingo",
  "segunda-feira",
  "terça-feira",
  "quarta-feira",
  "quinta-feira",
  "sexta-feira",
  "sábado",
];

/** "40 min", "1h", "1h30", "2h05" — duração de serviço em minutos. */
export function formatDurationLabel(min: number): string {
  const total = Math.max(0, Math.round(min));
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, "0")}`;
}

/** "sexta-feira, 02/10" — dia da semana por extenso + dd/MM, no fuso do tenant. */
export function formatLongDayLabel(date: Date, timezone: string): string {
  const weekday = Number(formatInTimeZone(date, timezone, "i")); // 1 (segunda) .. 7 (domingo)
  return `${WEEKDAY_LONG_PT[weekday % 7]}, ${formatInTimeZone(date, timezone, "dd/MM")}`;
}

/**
 * "Sex 02/10" a partir de uma data de calendário "YYYY-MM-DD". Ancora no MEIO-DIA LOCAL do tenant
 * (não em 00:00 UTC): em fusos com offset grande (ex.: Pacific/Kiritimati, +14) a meia-noite UTC
 * cairia no dia errado (BUG-15).
 */
export function formatDayLabelFromISO(iso: string, timezone: string): string {
  return formatDayLabel(fromZonedTime(`${iso}T12:00:00`, timezone), timezone);
}

/** "Hoje · Qua 30/09" | "Amanhã · Qui 01/10" | "Sex 02/10". `todayISO` = hoje no fuso do tenant. */
export function formatRelativeDayLabel(iso: string, todayISO: string, timezone: string): string {
  const base = formatDayLabelFromISO(iso, timezone);
  if (iso === todayISO) return `Hoje · ${base}`;
  if (iso === addDaysISO(todayISO, 1)) return `Amanhã · ${base}`;
  return base;
}

/** Antecedência/prazo por extenso: 30→"30 minutos", 60→"1 hora", 90→"1h30", 120→"2 horas", 1440→"24 horas". */
export function formatLeadLabel(min: number): string {
  const total = Math.max(0, Math.round(min));
  if (total < 60) return `${total} ${total === 1 ? "minuto" : "minutos"}`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (m === 0) return `${h} ${h === 1 ? "hora" : "horas"}`;
  return `${h}h${String(m).padStart(2, "0")}`;
}

/** "hoje às 14:00" | "amanhã às 09:00" | "Seg 05/10 às 09:00" — `at` relativo a `now`, no fuso do tenant. */
export function formatWhenLabel(at: Date, now: Date, timezone: string): string {
  const time = formatTimeLabel(at, timezone);
  const atISO = formatInTimeZone(at, timezone, "yyyy-MM-dd");
  const todayISO = formatInTimeZone(now, timezone, "yyyy-MM-dd");
  if (atISO === todayISO) return `hoje às ${time}`;
  if (atISO === addDaysISO(todayISO, 1)) return `amanhã às ${time}`;
  return `${formatDayLabel(at, timezone)} às ${time}`;
}

function usableFirstName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const token = raw.replace(/^[^\p{L}]+/u, "").split(/\s+/)[0] ?? "";
  // Tira pontuação/emoji das pontas ("Maria," / "*Ana*"), preservando apóstrofo e hífen internos.
  const cleaned = token.replace(/^[^\p{L}]+/u, "").replace(/[^\p{L}]+$/u, "");
  const letters = cleaned.match(/\p{L}/gu)?.length ?? 0;
  return letters >= 2 ? cleaned : null;
}

/** Primeiro nome para a saudação: de `name`, senão de `pushName`; só com pelo menos 2 letras (BUG-10). */
export function firstNameForGreeting(name: string | null, pushName: string | null): string | null {
  return usableFirstName(name) ?? usableFirstName(pushName);
}
