/**
 * Textos padrão do bot (docs/arquitetura.md §6.7) e o motor de template puro que os renderiza.
 * Espelha o enum `BotTextKey` do Prisma como union de string, de propósito: `src/core/` não pode
 * depender de `@prisma/client` (eslint.config.mjs) — é domínio puro.
 */
export const BOT_TEXT_KEYS = [
  "GREETING",
  "MAIN_MENU",
  "CHOOSE_SERVICE",
  "CHOOSE_PROFESSIONAL",
  "CHOOSE_DAY",
  "CHOOSE_TIME",
  "NO_SLOTS_DAY",
  "NO_AVAILABILITY",
  "ASK_NAME",
  "CONFIRM_SUMMARY",
  "BOOKED",
  "SLOT_TAKEN",
  "MY_APPOINTMENTS",
  "NO_APPOINTMENTS",
  "APPOINTMENT_ACTIONS",
  "CONFIRM_CANCEL",
  "CANCELED",
  "RESCHEDULED",
  "TOO_LATE",
  "HUMAN_HANDOFF",
  "INVALID_OPTION",
  "TOO_MANY_INVALID",
  "ONLY_TEXT",
  "SESSION_EXPIRED",
  "GOODBYE",
  "REMINDER",
  // Rótulos estruturais (docs/arquitetura.md §6.6/§6.7): usados pelo n8n para montar opções e o
  // rodapé do menu — não são mensagens completas e não aceitam `{variavel}`, mas passam pelo
  // mesmo CRUD/preview de `BotText` (edição livre, sem tratamento especial no backend).
  "LABEL_CONFIRM",
  "LABEL_OTHER_TIME",
  "LABEL_CANCEL_YES",
  "LABEL_CANCEL_NO",
  "LABEL_MORE_DAYS",
  "LABEL_MORE_TIMES",
  "LABEL_MORE",
  "LABEL_BACK_TO_MENU",
] as const;

export type BotTextKeyLiteral = (typeof BOT_TEXT_KEYS)[number];

/** Variáveis conhecidas de template (docs/arquitetura.md §6.7) — a tela de edição só aceita estas. */
export const BOT_TEXT_VARIABLES = ["nome", "empresa", "servico", "profissional", "data", "hora", "preco", "quando"] as const;

export const DEFAULT_BOT_TEXTS: Record<BotTextKeyLiteral, string> = {
  GREETING: "Olá, {nome}! Bem-vindo(a) à {empresa}. 😊",
  MAIN_MENU: "Como posso ajudar?\n1. Agendar horário\n2. Meus agendamentos\n3. Falar com atendente",
  CHOOSE_SERVICE: "Qual serviço você quer agendar?",
  CHOOSE_PROFESSIONAL: "Com quem você prefere ser atendido(a)?",
  CHOOSE_DAY: "Para qual dia?",
  CHOOSE_TIME: "Escolha um horário:",
  NO_SLOTS_DAY: "Não há horários livres neste dia. Veja outras datas:",
  NO_AVAILABILITY: "Não encontrei horários disponíveis no momento. Tente novamente mais tarde.",
  ASK_NAME: "Antes de continuar, qual é o seu nome?",
  CONFIRM_SUMMARY: "Confirma o agendamento?\n{servico} com {profissional}\n{data} às {hora}",
  BOOKED: "Agendamento confirmado! ✅\n{servico} com {profissional}\n{data} às {hora}",
  SLOT_TAKEN: "Esse horário já foi ocupado. Escolha outro:",
  MY_APPOINTMENTS: "Seus agendamentos:",
  NO_APPOINTMENTS: "Você não tem agendamentos marcados.",
  APPOINTMENT_ACTIONS: "O que deseja fazer com este agendamento?\n1. Cancelar\n2. Remarcar",
  CONFIRM_CANCEL: "Confirma o cancelamento de {servico} em {data} às {hora}?",
  CANCELED: "Agendamento cancelado.",
  RESCHEDULED: "Agendamento remarcado para {data} às {hora}.",
  TOO_LATE: "Não é mais possível fazer isso tão perto do horário marcado. Fale com a gente diretamente.",
  HUMAN_HANDOFF: "Ok! Um atendente humano vai continuar essa conversa.",
  INVALID_OPTION: "Não entendi essa opção.",
  TOO_MANY_INVALID: "Não consegui entender. Vou chamar um atendente para te ajudar.",
  ONLY_TEXT: "Por enquanto só entendo mensagens de texto.",
  SESSION_EXPIRED: "Faz um tempo que não conversamos, então recomecei o menu por aqui. ",
  GOODBYE: "Até logo! 👋",
  REMINDER:
    "Oi, {nome}! Passando pra lembrar: você tem {servico} com {profissional} {quando} às {hora}.\nSe precisar remarcar ou cancelar, responda *menu*.",
  LABEL_CONFIRM: "Confirmar",
  LABEL_OTHER_TIME: "Escolher outro horário",
  LABEL_CANCEL_YES: "Sim, cancelar",
  LABEL_CANCEL_NO: "Não, manter",
  LABEL_MORE_DAYS: "Ver mais datas",
  LABEL_MORE_TIMES: "Mais horários",
  LABEL_MORE: "Ver mais",
  LABEL_BACK_TO_MENU: "0. Menu principal",
};

/**
 * Substitui `{variavel}` pelos valores em `vars`. Variável sem valor correspondente é deixada
 * como está (nunca lança) — a validação de "só variáveis conhecidas" é responsabilidade de
 * `assertKnownVariables`, chamada separadamente na escrita (não na leitura/renderização).
 */
export function renderTemplate(text: string, vars: Record<string, string | number | null | undefined>): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = vars[key];
    return value === null || value === undefined ? match : String(value);
  });
}

/** Lança se `text` referenciar uma variável fora de `BOT_TEXT_VARIABLES` (docs/arquitetura.md §6.7). */
export function findUnknownVariables(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\{(\w+)\}/g)) {
    const name = match[1];
    if (!(BOT_TEXT_VARIABLES as readonly string[]).includes(name)) {
      found.add(name);
    }
  }
  return Array.from(found);
}
