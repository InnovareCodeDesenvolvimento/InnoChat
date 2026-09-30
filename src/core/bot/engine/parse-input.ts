import { normalizeText } from "./normalize";
import type { EngineClock, ParsedInput, Period } from "./types";

/**
 * Extração de número, data, hora e período do texto do cliente (spec §2.4.1 regras 7-8).
 * Datas são calculadas só com `Date.UTC(...)` sobre o `clock.today` recebido: o motor nunca
 * lê o relógio do sistema.
 */

const MONTHS: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6,
  julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};
const WEEKDAYS: Record<string, number> = {
  domingo: 0, dom: 0, segunda: 1, seg: 1, terca: 2, ter: 2, quarta: 3, qua: 3,
  quinta: 4, qui: 4, sexta: 5, sex: 5, sabado: 6, sab: 6,
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function splitISO(iso: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return [1970, 1, 1];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isoOf(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`;
}

/** Data válida no calendário (rejeita 31/02). */
function validISO(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return isoOf(y, m, d);
}

export function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = splitISO(iso);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return isoOf(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function weekdayOf(iso: string): number {
  const [y, m, d] = splitISO(iso);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function fullYear(y: number): number {
  return y < 100 ? 2000 + y : y;
}

type DateHit = { date: string | null; rest: string };

/** Acha a data e devolve o texto sem o trecho consumido (para a hora não colidir). */
function extractDate(norm: string, today: string): DateHit {
  const [ty, tm, td] = splitISO(today);

  // dd/mm, dd/mm/aa, dd/mm/aaaa, dd-mm
  const numeric = /(?<![\d/])(\d{1,2})[/-](\d{1,2})(?:[/-](\d{4}|\d{2}))?(?!\d)/.exec(norm);
  if (numeric) {
    const rest = norm.replace(numeric[0], " ");
    const d = Number(numeric[1]);
    const m = Number(numeric[2]);
    if (numeric[3] !== undefined) return { date: validISO(fullYear(Number(numeric[3])), m, d), rest };
    let date = validISO(ty, m, d);
    if (date && date < today) date = validISO(ty + 1, m, d);
    return { date, rest };
  }

  // "15 de outubro" (com ano opcional)
  const named = /(?<!\d)(\d{1,2})\s+de\s+(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?:\s+de\s+(\d{4}))?/.exec(norm);
  if (named) {
    const rest = norm.replace(named[0], " ");
    const d = Number(named[1]);
    const m = MONTHS[named[2]];
    if (named[3] !== undefined) return { date: validISO(Number(named[3]), m, d), rest };
    let date = validISO(ty, m, d);
    if (date && date < today) date = validISO(ty + 1, m, d);
    return { date, rest };
  }

  // "dia 15": deste mês, ou do próximo se já passou
  const dayOnly = /\bdia\s+(\d{1,2})(?![\d/:h])/.exec(norm);
  if (dayOnly) {
    const rest = norm.replace(dayOnly[0], " ");
    const d = Number(dayOnly[1]);
    let date = validISO(ty, tm, d);
    if (date && d < td) {
      const nextMonth = tm === 12 ? validISO(ty + 1, 1, d) : validISO(ty, tm + 1, d);
      date = nextMonth;
    }
    return { date, rest };
  }

  const relative: [RegExp, number][] = [
    [/\bdepois de amanha\b/, 2],
    [/\bamanha\b/, 1],
    [/\bhoje\b/, 0],
  ];
  for (const [re, offset] of relative) {
    const hit = re.exec(norm);
    if (hit) return { date: addDaysISO(today, offset), rest: norm.replace(hit[0], " ") };
  }

  // dia da semana. Abreviações ("sex") só em frases curtas, para não confundir com verbos.
  const words = norm.split(" ").filter(Boolean);
  const full = /\b(segunda|terca|quarta|quinta|sexta)(?:[- ]feira)?\b|\b(sabado|domingo)\b/.exec(norm);
  const abbr = words.length <= 3 ? /\b(seg|ter|qua|qui|sex|sab|dom)\b/.exec(norm) : null;
  const hit = full ?? abbr;
  if (hit) {
    const target = WEEKDAYS[hit[1] ?? hit[2] ?? hit[0]];
    const forceNext = /\b(que vem|proxima|proximo|prox)\b/.test(norm);
    let delta = (target - weekdayOf(today) + 7) % 7;
    if (delta === 0 && forceNext) delta = 7;
    let rest = norm.replace(hit[0], " ").replace(/\b(que vem|proxima|proximo|prox)\b/, " ");
    rest = rest.replace(/\s+/g, " ");
    return { date: addDaysISO(today, delta), rest };
  }

  return { date: null, rest: norm };
}

function hhmm(h: number, m: number): string | null {
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${pad2(h)}:${pad2(m)}`;
}

function extractTime(text: string): string | null {
  let m = /(?<![\d:.])([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)/.exec(text);
  if (m) return hhmm(Number(m[1]), Number(m[2]));

  m = /(?<!\d)([01]?\d|2[0-3])\s*(?:horas?|hrs|hr|hs|h)(?:\s*([0-5]\d))?(?![a-z0-9])/.exec(text);
  if (m) return hhmm(Number(m[1]), m[2] ? Number(m[2]) : 0);

  m = /(?<!\d)(\d{1,2})(\s*e\s*meia)?\s+da\s+(manha|tarde|noite|madrugada)/.exec(text);
  if (m) {
    let h = Number(m[1]);
    if (h < 1 || h > 12) return null;
    if ((m[3] === "tarde" || m[3] === "noite") && h < 12) h += 12;
    if (m[3] === "noite" && h === 12) h = 0;
    return hhmm(h, m[2] ? 30 : 0);
  }

  if (/\bmeio[- ]?dia\b/.test(text)) return "12:00";
  if (/\bmeia[- ]noite\b/.test(text)) return "00:00";

  m = /\bas\s+(\d{1,2})(?![\d:h.])/.exec(text);
  if (m) return hhmm(Number(m[1]), 0);

  return null;
}

function extractPeriod(text: string): Period | null {
  const t = text.replace(/\b(boa tarde|boa noite|bom dia)\b/g, " ");
  if (/\b(manha|madrugada)\b/.test(t)) return "morning";
  if (/\btarde\b/.test(t)) return "afternoon";
  if (/\bnoite\b/.test(t)) return "evening";
  return null;
}

const YES_ONLY = /^(?:[\u{1F44D}✅\u{1F44C}]\s*)+$/u;
const NO_ONLY = /^(?:[❌\u{1F44E}]\s*)+$/u;
const NUMBER_RE = /^(?:(?:opcao|opc|numero|num|n[o°º]?\.?|#)\s*)?0*(\d{1,2})\s*[.)\-:]?$/;

export function parseInput(raw: string, clock: EngineClock): ParsedInput {
  const text = String(raw ?? "");
  const norm = normalizeText(text);

  const numMatch = NUMBER_RE.exec(norm);
  const numeric = numMatch ? Number(numMatch[1]) : 0;
  const number = numeric >= 1 ? numeric : null;

  const { date, rest } = extractDate(norm, clock.today);
  const time = extractTime(rest);
  const period = extractPeriod(rest);

  return {
    raw: text,
    norm,
    number,
    date,
    time,
    period,
    yes: YES_ONLY.test(norm),
    no: NO_ONLY.test(norm),
  };
}
