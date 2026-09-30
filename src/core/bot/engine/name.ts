import { COMMAND_SYNONYMS, COURTESY, STATE_ALIASES, PAGING_ALIASES } from "./aliases";
import { capInput, normalizeText } from "./normalize";

const MAX_NAME_LENGTH = 60;
const MIN_NAME_LENGTH = 2;

function collectReserved(): string[] {
  const words: string[] = [
    "sim", "nao", "s", "n", "cancelar", "cancelado", "confirmar", "voltar", "menu",
    "oi", "ola", "bom dia", "boa tarde", "boa noite", "e ai", "tchau",
  ];
  for (const list of Object.values(COMMAND_SYNONYMS)) words.push(...list);
  words.push(...COURTESY);
  for (const byId of Object.values(STATE_ALIASES)) for (const list of Object.values(byId)) words.push(...list);
  for (const list of Object.values(PAGING_ALIASES)) words.push(...list);
  const seen: Record<string, true> = {};
  const out: string[] = [];
  for (const w of words) {
    const n = normalizeText(w);
    if (n && !seen[n]) {
      seen[n] = true;
      out.push(n);
    }
  }
  return out;
}

/** Palavras que nunca valem como nome (comandos, aliases, cortesia, "sim", "não"...), normalizadas. */
export const RESERVED_NAME_WORDS: readonly string[] = collectReserved();

/** Bidi (U+202A–202E, U+2066–2069) e zero-width (U+200B–200F, U+FEFF): invisíveis que disfarçam o nome (S2). */
const INVISIBLE_CONTROLS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
/** Início de nome que uma planilha interpretaria como fórmula (CSV injection). */
const FORMULA_START = /^[=+\-@]/;

const URL_LIKE = /(https?:|www\.|:\/\/|\.(?:com|net|org|br|io)\b)/i;

/**
 * Valida o nome digitado (spec §3.1; usada também pelo painel). 2 a 60 caracteres, ao menos 2
 * letras, sem ser só número, sem `@`/URL e sem ser palavra reservada.
 */
export function validateName(
  raw: string,
): { ok: true; name: string } | { ok: false; reason: "TOO_LONG" | "INVALID" } {
  const cleaned = capInput(String(raw ?? ""))
    .replace(INVISIBLE_CONTROLS, "")
    .replace(/[\u0000-\u001F\u007F-\u009F<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const length = Array.from(cleaned).length;
  if (length > MAX_NAME_LENGTH) return { ok: false, reason: "TOO_LONG" };
  if (length < MIN_NAME_LENGTH) return { ok: false, reason: "INVALID" };
  const letters = cleaned.match(/\p{L}/gu);
  if (!letters || letters.length < 2) return { ok: false, reason: "INVALID" };
  if (FORMULA_START.test(cleaned)) return { ok: false, reason: "INVALID" };
  if (cleaned.includes("@") || URL_LIKE.test(cleaned)) return { ok: false, reason: "INVALID" };
  if (RESERVED_NAME_WORDS.includes(normalizeText(cleaned))) return { ok: false, reason: "INVALID" };
  return { ok: true, name: cleaned };
}
