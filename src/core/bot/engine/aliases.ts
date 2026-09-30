/**
 * Vocabulário fixo do motor (spec §2.3 e tabela de aliases da §2.4.1). NÃO é texto editável
 * pela empresa: os ids são o contrato entre o motor e o fluxo.
 */

export const STATIC_OPTION_IDS: Record<string, string[]> = {
  MAIN_MENU: ["BOOK", "MY", "HUMAN"],
  CONFIRM: ["CONFIRM", "EDIT"],
  CONFIRM_EDIT: ["SERVICE", "PROFESSIONAL", "DATETIME", "NAME"],
  CONFIRM_CANCEL: ["YES", "NO"],
  RESUME_OFFER: ["CONTINUE", "RESTART"],
  APPOINTMENT_ACTION: ["RESCHEDULE", "CANCEL", "BACK", "HUMAN"],
  POST_ACTION: ["BOOK", "MY", "FINISH"],
  NO_AVAILABILITY: ["HUMAN", "OTHER_SERVICE"],
  SELECT_DAY: ["NEXT", "MORE", "PREV"],
  NEXT_SLOTS: ["BY_DAY"],
  LIMIT_REACHED: ["HUMAN"],
};

const HUMAN_WORDS = [
  "atendente", "humano", "pessoa", "equipe", "suporte", "falar com atendente", "falar com alguem",
  "falar com humano", "falar com uma pessoa", "falar com a equipe",
];

export const STATE_ALIASES: Record<string, Record<string, string[]>> = {
  MAIN_MENU: {
    BOOK: ["agendar", "marcar", "agendamento", "horario", "reservar", "quero agendar", "quero marcar"],
    MY: ["meus", "meus agendamentos", "ver", "consultar", "remarcar", "cancelar", "desmarcar"],
    HUMAN: HUMAN_WORDS,
  },
  CONFIRM: {
    CONFIRM: ["sim", "s", "confirmar", "confirmo", "pode", "pode ser", "ok", "isso", "certo", "👍", "✅", "👌"],
    EDIT: ["corrigir", "alterar", "mudar", "trocar", "nao", "n", "❌", "👎"],
  },
  CONFIRM_EDIT: {
    SERVICE: ["servico"],
    PROFESSIONAL: ["profissional"],
    DATETIME: ["data", "horario", "data e horario", "dia"],
    NAME: ["nome"],
  },
  CONFIRM_CANCEL: {
    YES: ["sim", "s", "cancelar", "pode cancelar", "👍", "✅"],
    NO: ["nao", "n", "manter", "❌", "👎"],
  },
  RESUME_OFFER: {
    CONTINUE: ["continuar", "sim", "s", "👍"],
    RESTART: ["recomecar", "nao", "n", "novo", "comecar de novo"],
  },
  APPOINTMENT_ACTION: {
    RESCHEDULE: ["remarcar", "mudar", "trocar"],
    CANCEL: ["cancelar", "desmarcar"],
    BACK: ["voltar"],
    HUMAN: HUMAN_WORDS,
  },
  POST_ACTION: {
    BOOK: ["agendar outro", "outro", "agendar"],
    MY: ["meus agendamentos", "meus"],
    FINISH: ["encerrar", "nao", "n"],
  },
  NO_AVAILABILITY: {
    HUMAN: HUMAN_WORDS,
    OTHER_SERVICE: ["outro servico", "outro", "trocar servico"],
  },
  SELECT_DAY: {
    NEXT: ["primeiro horario livre", "primeiro livre", "primeiro horario", "proximo horario"],
  },
  NEXT_SLOTS: {
    BY_DAY: ["escolher por dia", "por dia", "outro dia"],
  },
  LIMIT_REACHED: {
    HUMAN: HUMAN_WORDS,
  },
};

/** Paginação vale em qualquer estado que tenha as opções MORE/PREV. */
export const PAGING_ALIASES: Record<string, string[]> = {
  MORE: ["mais", "ver mais", "proximos", "proximas", "mais horarios", "mais datas", "ver mais datas"],
  PREV: ["anteriores", "ver anteriores", "anterior", "voltar pagina"],
};

/** Resposta por emoji (qualquer repetição/tom) → id, por estado. */
export const YES_IDS: Record<string, string> = {
  CONFIRM: "CONFIRM",
  CONFIRM_CANCEL: "YES",
  RESUME_OFFER: "CONTINUE",
};
export const NO_IDS: Record<string, string> = {
  CONFIRM: "EDIT",
  CONFIRM_CANCEL: "NO",
  RESUME_OFFER: "RESTART",
};

/** Comandos globais (spec §2.3): a mensagem INTEIRA normalizada tem que ser um sinônimo. */
export const COMMAND_SYNONYMS = {
  MENU: ["menu", "0", "inicio", "comecar", "recomecar", "menu principal"],
  BACK: ["voltar", "volta", "anterior", "retornar", "#"],
  EXIT: ["sair", "encerrar", "finalizar", "tchau", "fim"],
  HUMAN: HUMAN_WORDS,
  HELP: ["ajuda", "help", "?", "comandos", "opcoes"],
} as const;

/** Saudação: uma ou mais palavras de saudação seguidas ("oi bom dia"). */
export const GREETING_RE = /^(?:(?:oi+|ola|opa|eai|e ai|hello|bom dia|boa tarde|boa noite)[\s,]*)+$/;

export const COURTESY = [
  "obrigado", "obrigada", "obg", "brigado", "brigada", "muito obrigado", "muito obrigada",
  "valeu", "vlw", "ok", "blz", "beleza", "👍", "🙏",
];

/** Palavras de enchimento ignoradas no casamento parcial de texto com opções. */
export const FILLER_WORDS = [
  "quero", "queria", "gostaria", "de", "do", "da", "um", "uma", "o", "a", "por", "favor",
  "pf", "pfv", "pra", "para", "eu", "vou", "fazer", "com", "no", "na",
];

/** Ids v1 → v2 por estado (mapLegacyOptions). */
export const LEGACY_ID_MAP: Record<string, Record<string, string>> = {
  MAIN_MENU: { agendar: "BOOK", meus: "MY", atendente: "HUMAN" },
  CONFIRM: { confirmar: "CONFIRM", outro: "EDIT" },
  CONFIRM_CANCEL: { sim: "YES", nao: "NO" },
  APPOINTMENT_ACTION: { remarcar: "RESCHEDULE", cancelar: "CANCEL", atendente: "HUMAN" },
};

/** A v1 chamava este estado de APPOINTMENT_ACTIONS. */
export function canonicalState(state: string): string {
  return state === "APPOINTMENT_ACTIONS" ? "APPOINTMENT_ACTION" : state;
}
