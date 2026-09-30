import { renderMessage, type Block } from "@/core/bot/engine";
import { renderTemplate } from "@/core/bot/texts";

/** Valores de exemplo da prévia — espelham os do servidor (`previewBotText`), com `preco` opcional. */
export const SAMPLE_VARS_V2: Record<string, string | number> = {
  nome: "Maria",
  empresa: "Studio Bela",
  servico: "Corte feminino",
  profissional: "Ana",
  data: "Ter 30/09",
  hora: "14:30",
  preco: "R$ 80,00",
  quando: "amanhã",
  duracao: "45 min",
  data_longa: "terça-feira, 30/09",
  prazo: "2 horas",
  retorno: "11:30",
  proximo: "Qua 01/10",
  anterior: "Seg 29/09 às 10:00",
  limite: 3,
};

export const SAMPLE_VARS_V1: Record<string, string> = {
  nome: "Maria",
  empresa: "Studio Bela",
  servico: "Corte feminino",
  profissional: "Ana",
  data: "Ter 30/09",
  hora: "14:30",
  preco: "R$ 80,00",
  quando: "amanhã",
};

type Texts = Record<string, string>;
type Item = [title: string, detail?: string];
type Context = { options: (t: Texts) => Item[]; footer?: "MENU_HINT" | "FOOTER_HINT" };

const SERVICES: Item[] = [
  ["Corte feminino", "R$ 80,00 · 45 min"],
  ["Escova", "R$ 60,00 · 40 min"],
  ["Coloração", "R$ 180,00 · 1h30"],
];
const DAYS: Item[] = [["Hoje · Ter 30/09"], ["Amanhã · Qua 01/10"], ["Qui 02/10"]];
const TIMES: Item[] = [["14:30"], ["15:00"], ["15:30"]];
const APPOINTMENTS: Item[] = [
  ["Corte feminino", "Amanhã às 14:30"],
  ["Escova", "Sex 03/10 às 10:00"],
];

/** Como cada mensagem aparece de verdade: as opções de exemplo que o motor numera embaixo dela. */
const CONTEXTS: Record<string, Context> = {
  MENU_PROMPT: { options: (t) => [[t.LABEL_MENU_BOOK], [t.LABEL_MENU_MY], [t.LABEL_MENU_HUMAN]], footer: "MENU_HINT" },
  INVALID_OPTION: { options: (t) => [[t.LABEL_MENU_BOOK], [t.LABEL_MENU_MY], [t.LABEL_MENU_HUMAN]] },
  ONLY_TEXT: { options: (t) => [[t.LABEL_MENU_BOOK], [t.LABEL_MENU_MY], [t.LABEL_MENU_HUMAN]] },
  AMBIGUOUS_OPTION: { options: () => [["Corte feminino"], ["Corte masculino"]], footer: "FOOTER_HINT" },
  NO_SERVICES: { options: (t) => [[t.LABEL_MENU_HUMAN]] },
  CHOOSE_SERVICE: { options: () => SERVICES, footer: "FOOTER_HINT" },
  CHOOSE_PROFESSIONAL: { options: (t) => [[t.LABEL_ANY_PROFESSIONAL], ["Ana"], ["Bruno"]], footer: "FOOTER_HINT" },
  CHOOSE_DAY: { options: (t) => [[t.LABEL_NEXT_AVAILABLE], ...DAYS, [t.LABEL_MORE_DAYS]], footer: "FOOTER_HINT" },
  NEXT_AVAILABLE: { options: () => [["Hoje · Ter 30/09 às 15:00"], ["Amanhã · Qua 01/10 às 09:00"], ["Qua 01/10 às 09:30"]], footer: "FOOTER_HINT" },
  CHOOSE_TIME: { options: (t) => [...TIMES, [t.LABEL_MORE_TIMES], [t.LABEL_PREVIOUS], [t.LABEL_BY_DAY]], footer: "FOOTER_HINT" },
  NO_SLOTS_DAY: { options: () => DAYS, footer: "FOOTER_HINT" },
  DATE_OUT_OF_RANGE: { options: () => DAYS, footer: "FOOTER_HINT" },
  TIME_NOT_AVAILABLE: { options: () => TIMES, footer: "FOOTER_HINT" },
  SLOT_TAKEN: { options: () => TIMES, footer: "FOOTER_HINT" },
  NO_AVAILABILITY: { options: (t) => [[t.LABEL_OTHER_SERVICE], [t.LABEL_MENU_HUMAN]], footer: "FOOTER_HINT" },
  APPOINTMENT_LIMIT: { options: (t) => [[t.LABEL_MENU_MY], [t.LABEL_MENU_HUMAN]] },
  CONFIRM_SUMMARY: { options: (t) => [[t.LABEL_CONFIRM], [t.LABEL_EDIT], [t.LABEL_BACK]], footer: "FOOTER_HINT" },
  CONFIRM_RESCHEDULE: { options: (t) => [[t.LABEL_CONFIRM], [t.LABEL_BACK]], footer: "FOOTER_HINT" },
  CONFIRM_EDIT: { options: (t) => [[t.LABEL_EDIT_SERVICE], [t.LABEL_EDIT_PROFESSIONAL], [t.LABEL_EDIT_DATETIME], [t.LABEL_EDIT_NAME]], footer: "FOOTER_HINT" },
  POST_ACTION_MENU: { options: (t) => [[t.LABEL_BOOK_ANOTHER], [t.LABEL_MENU_MY], [t.LABEL_FINISH]] },
  MY_APPOINTMENTS: { options: () => APPOINTMENTS, footer: "FOOTER_HINT" },
  APPOINTMENT_DETAIL: { options: (t) => [[t.LABEL_RESCHEDULE], [t.LABEL_CANCEL_APPOINTMENT], [t.LABEL_BACK]], footer: "FOOTER_HINT" },
  APPOINTMENT_LOCKED: { options: (t) => [[t.LABEL_MENU_HUMAN], [t.LABEL_BACK]], footer: "FOOTER_HINT" },
  CONFIRM_CANCEL: { options: (t) => [[t.LABEL_CANCEL_YES], [t.LABEL_CANCEL_NO]] },
  RESUME_OFFER: { options: (t) => [[t.LABEL_CONTINUE], [t.LABEL_START_OVER]] },
  TOO_LATE: { options: (t) => [[t.LABEL_MENU_HUMAN]] },
};

/** Qual mensagem "hospeda" cada rótulo/rodapé na prévia (a que o cliente vê com aquela opção). */
const HOST: Record<string, string> = {
  MENU_HINT: "MENU_PROMPT",
  FOOTER_HINT: "CHOOSE_SERVICE",
  LABEL_MENU_BOOK: "MENU_PROMPT",
  LABEL_MENU_MY: "MENU_PROMPT",
  LABEL_MENU_HUMAN: "MENU_PROMPT",
  LABEL_ANY_PROFESSIONAL: "CHOOSE_PROFESSIONAL",
  LABEL_NEXT_AVAILABLE: "CHOOSE_DAY",
  LABEL_MORE_DAYS: "CHOOSE_DAY",
  LABEL_BY_DAY: "CHOOSE_TIME",
  LABEL_PREVIOUS: "CHOOSE_TIME",
  LABEL_MORE_TIMES: "CHOOSE_TIME",
  LABEL_MORE: "CHOOSE_SERVICE",
  LABEL_CONFIRM: "CONFIRM_SUMMARY",
  LABEL_EDIT: "CONFIRM_SUMMARY",
  LABEL_BACK: "CONFIRM_SUMMARY",
  LABEL_EDIT_SERVICE: "CONFIRM_EDIT",
  LABEL_EDIT_PROFESSIONAL: "CONFIRM_EDIT",
  LABEL_EDIT_DATETIME: "CONFIRM_EDIT",
  LABEL_EDIT_NAME: "CONFIRM_EDIT",
  LABEL_RESCHEDULE: "APPOINTMENT_DETAIL",
  LABEL_CANCEL_APPOINTMENT: "APPOINTMENT_DETAIL",
  LABEL_CANCEL_YES: "CONFIRM_CANCEL",
  LABEL_CANCEL_NO: "CONFIRM_CANCEL",
  LABEL_BOOK_ANOTHER: "POST_ACTION_MENU",
  LABEL_FINISH: "POST_ACTION_MENU",
  LABEL_CONTINUE: "RESUME_OFFER",
  LABEL_START_OVER: "RESUME_OFFER",
  LABEL_OTHER_SERVICE: "NO_AVAILABILITY",
};

/** Mensagem que serve de moldura da prévia de `key` (a própria, ou a que exibe o rótulo/rodapé). */
export function previewHostKey(key: string): string {
  return HOST[key] ?? key;
}

function blockFor(host: string, texts: Texts, vars: Record<string, string | number>): Block {
  const ctx = CONTEXTS[host];
  if (!ctx) return { key: host, vars };
  const options = ctx.options(texts).map(([title, detail], i) => ({ n: i + 1, id: `p${i + 1}`, title, detail }));
  return { key: host, vars, options, footer: ctx.footer };
}

/**
 * Prévia v2: usa o MESMO `renderMessage` do motor, então numeração com keycap, rodapé e a regra
 * "linha sem valor some" (ex.: `*Valor:*` sem preço) saem exatamente como o cliente recebe.
 * `texts` = textos vigentes da empresa, já com a edição em andamento aplicada.
 */
export function renderPreviewV2(key: string, texts: Texts, options: { withPrice?: boolean } = {}): string {
  const vars = { ...SAMPLE_VARS_V2 };
  if (options.withPrice === false) delete vars.preco;
  const host = previewHostKey(key);
  const blocks: Block[] = key === "GREETING" ? [{ key: "GREETING", vars }, blockFor("MENU_PROMPT", texts, vars)] : [blockFor(host, texts, vars)];
  try {
    return renderMessage(blocks, texts);
  } catch {
    return "";
  }
}

export function renderPreviewV1(text: string): string {
  return renderTemplate(text, SAMPLE_VARS_V1);
}
