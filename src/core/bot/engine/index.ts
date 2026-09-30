/**
 * Motor do bot v2 (plano §3.2). TypeScript puro, sem imports fora desta pasta, sem relógio do
 * sistema, sem `Intl` de fuso, sem APIs do Node. É compilado em IIFE (`InnoEngine`) e colado
 * nos Code nodes `Interpretar` e `Montar mensagem` do n8n.
 */
export type {
  Block,
  Command,
  EngineClock,
  Intent,
  LegacyOption,
  OptionV2,
  ParsedInput,
  Period,
  Route,
  Texts,
  Vars,
} from "./types";

export { normalizeText, capInput, MAX_NORMALIZE_CHARS } from "./normalize";
export { parseInput } from "./parse-input";
export { validateName, RESERVED_NAME_WORDS } from "./name";
export { interpret } from "./interpret";
export { routeFor, isResumable } from "./route";
export { mapLegacyOptions } from "./legacy";
export { pageSlice, buildOptions, keycap } from "./options";
export { pushTrail, popTrail } from "./trail";
export { renderTemplateV2, renderMessage } from "./render";
export { STATIC_OPTION_IDS, STATE_ALIASES } from "./aliases";
