import {
  COMMAND_SYNONYMS,
  COURTESY,
  FILLER_WORDS,
  GREETING_RE,
  NO_IDS,
  PAGING_ALIASES,
  STATE_ALIASES,
  YES_IDS,
  canonicalState,
} from "./aliases";
import { normalizeOptions } from "./legacy";
import { validateName } from "./name";
import { normalizeText } from "./normalize";
import { parseInput } from "./parse-input";
import type { Command, EngineClock, Intent, LegacyOption, OptionV2 } from "./types";

function commandOf(norm: string): Command | null {
  const order: (keyof typeof COMMAND_SYNONYMS)[] = ["MENU", "BACK", "EXIT", "HUMAN", "HELP"];
  for (const command of order) {
    if ((COMMAND_SYNONYMS[command] as readonly string[]).includes(norm)) return command;
  }
  if (GREETING_RE.test(norm)) return "GREETING";
  return null;
}

function isCourtesy(norm: string, yes: boolean): boolean {
  return yes || COURTESY.includes(norm);
}

function renumber(list: OptionV2[]): OptionV2[] {
  return list.map((o, i) => ({ ...o, n: i + 1 }));
}

function staticAliasMatch(state: string, norm: string, yes: boolean, no: boolean, options: OptionV2[]): OptionV2 | null {
  const has = (id: string) => options.find((o) => o.id === id) ?? null;
  const byState = STATE_ALIASES[state] ?? {};
  for (const id of Object.keys(byState)) {
    const option = has(id);
    if (option && byState[id].some((a) => normalizeText(a) === norm)) return option;
  }
  for (const id of Object.keys(PAGING_ALIASES)) {
    const option = has(id);
    if (option && PAGING_ALIASES[id].includes(norm)) return option;
  }
  if (yes && YES_IDS[state]) return has(YES_IDS[state]);
  if (no && NO_IDS[state]) return has(NO_IDS[state]);
  return null;
}

function tokens(norm: string): string[] {
  return norm.split(/[^a-z0-9]+/).filter(Boolean);
}

type TextMatch = { kind: "none" } | { kind: "one"; option: OptionV2; via: "alias" | "text" } | { kind: "many"; options: OptionV2[] };

/** Regra 9: igual → escolhe; todas as palavras digitadas contidas em UMA opção → escolhe; várias → ambígua. */
function textMatch(norm: string, options: OptionV2[]): TextMatch {
  const exact: { option: OptionV2; via: "alias" | "text" }[] = [];
  for (const o of options) {
    const own = [normalizeText(o.match ?? o.title), normalizeText(o.title)];
    if (own.includes(norm)) exact.push({ option: o, via: "text" });
    else if ((o.aliases ?? []).some((a) => normalizeText(a) === norm)) exact.push({ option: o, via: "alias" });
  }
  if (exact.length === 1) return { kind: "one", option: exact[0].option, via: exact[0].via };
  if (exact.length > 1) return { kind: "many", options: exact.map((e) => e.option) };

  const typed = tokens(norm).filter((t) => !FILLER_WORDS.includes(t));
  if (typed.length === 0) return { kind: "none" };
  const partial = options.filter((o) => {
    const words = new Set<string>();
    for (const source of [o.match ?? o.title, o.title, ...(o.aliases ?? [])]) {
      for (const w of tokens(normalizeText(source))) words.add(w);
    }
    const list = Array.from(words);
    return typed.every((t) => list.some((w) => w === t || (t.length >= 3 && w.startsWith(t))));
  });
  if (partial.length === 1) return { kind: "one", option: partial[0], via: "text" };
  if (partial.length > 1) return { kind: "many", options: partial };
  return { kind: "none" };
}

/**
 * Interpreta a mensagem do cliente no estado atual (spec §2.4.1, regras 3-10; a regra 2,
 * sessão nova/expirada, é do `routeFor`: o chamador interpreta contra `MAIN_MENU`).
 * `text = null` é mídia. Opções no formato da v1 são aceitas e traduzidas.
 */
export function interpret(input: {
  state: string;
  text: string | null;
  options: (OptionV2 | LegacyOption)[];
  clock: EngineClock;
}): Intent {
  if (input.text === null || input.text === undefined) return { kind: "media" };

  const state = canonicalState(input.state);
  const options = normalizeOptions(input.options ?? [], state);
  const parsed = parseInput(input.text, input.clock);
  const { norm } = parsed;

  // 3. Comandos de navegação (mensagem inteira).
  const command = commandOf(norm);
  if (command) return { kind: "command", command };

  // 4. Aliases do estado (antes da cortesia: "ok" em CONFIRM confirma).
  const aliasHit = staticAliasMatch(state, norm, parsed.yes, parsed.no, options);
  if (aliasHit) return { kind: "option", option: aliasHit, via: "alias" };

  // 5. Cortesia.
  if (isCourtesy(norm, parsed.yes)) return { kind: "command", command: "THANKS" };

  // 6. Nome.
  if (state === "ASK_NAME") {
    const v = validateName(input.text);
    return v.ok ? { kind: "name", name: v.name } : { kind: "name_invalid", reason: v.reason };
  }

  // 7. Número.
  if (parsed.number !== null) {
    const byNumber = options.find((o) => o.n === parsed.number);
    if (byNumber) return { kind: "option", option: byNumber, via: "number" };
  }

  // 8. Datas e horas, conforme o estado.
  if (state === "SELECT_DAY" || state === "NEXT_SLOTS") {
    if (parsed.date) return { kind: "date", date: parsed.date, time: parsed.time };
  } else if (state === "SELECT_TIME") {
    if (parsed.date) return { kind: "date", date: parsed.date, time: parsed.time };
    if (parsed.time) return { kind: "time", time: parsed.time };
    if (parsed.period) return { kind: "period", period: parsed.period };
  }

  // 9. Texto contra as opções.
  const match = textMatch(norm, options);
  if (match.kind === "one") return { kind: "option", option: match.option, via: match.via };
  if (match.kind === "many") return { kind: "ambiguous", candidates: renumber(match.options) };

  // 10. Nada casou.
  return { kind: "invalid" };
}
