import { LEGACY_ID_MAP, canonicalState } from "./aliases";
import type { LegacyOption, OptionV2 } from "./types";

const LEGACY_PAGING_IDS = ["__more_days", "__more_times", "__page_next"];

export function isLegacyOption(o: OptionV2 | LegacyOption): o is LegacyOption {
  return !("title" in o) && "label" in o;
}

function mapOne(o: LegacyOption, state: string): OptionV2 {
  const byState = LEGACY_ID_MAP[canonicalState(state)];
  let id = byState?.[o.id] ?? o.id;
  if (LEGACY_PAGING_IDS.includes(o.id)) id = "MORE";
  return { n: o.n, id, title: o.label, match: o.label, label: o.label };
}

/**
 * Sessão gravada pela v1: `{n,id,label}` com ids em português. Devolve opções v2, usando o
 * `label` como título e como `match`, e traduzindo os ids estáticos (spec §4, CA-44).
 */
export function mapLegacyOptions(options: LegacyOption[], state: string): OptionV2[] {
  return options.map((o) => mapOne(o, state));
}

/** Aceita lista mista/v2 vinda do context e devolve sempre v2. */
export function normalizeOptions(options: (OptionV2 | LegacyOption)[], state: string): OptionV2[] {
  return options.map((o) => (isLegacyOption(o) ? mapOne(o, state) : o));
}
