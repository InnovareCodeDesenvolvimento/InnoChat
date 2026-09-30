import { BOT_TEXT_VARIABLES, DEFAULT_BOT_TEXTS, type BotTextKeyLiteral } from "@/core/bot/texts";
import { BOT_TEXT_ALLOWED_VARS, BOT_TEXT_CATALOG, DEFAULT_BOT_TEXTS_V2, type BotTextGroup, type BotTextKeyV2 } from "@/core/bot/texts-v2";

export type FlowVersion = 1 | 2;

export type TabId = BotTextGroup;

export const TABS: { id: TabId; label: string; hint: string }[] = [
  { id: "conversa", label: "Conversa", hint: "Saudação, ajuda e respostas quando o bot não entende." },
  { id: "agendamento", label: "Agendamento", hint: "Cada etapa até o horário ser reservado." },
  { id: "meus", label: "Meus agendamentos", hint: "Consulta, remarcação, cancelamento e lembretes." },
  { id: "atendente", label: "Atendente", hint: "Quando o cliente pede para falar com uma pessoa." },
  { id: "rotulos", label: "Rótulos", hint: "Nomes das opções numeradas. O bot põe o número na frente sozinho." },
];

export type CatalogEntry = {
  key: string;
  title: string;
  description: string;
  group: TabId;
  allowedVars: readonly string[];
  /** Texto padrão do código (para "Restaurar padrão" e para mostrar o que é o padrão). */
  defaultText: string;
};

/** Catálogo da v2, na ordem de `BOT_TEXT_CATALOG` (já agrupado e ordenado para leitura). */
export function catalogV2(): CatalogEntry[] {
  return (Object.keys(BOT_TEXT_CATALOG) as BotTextKeyV2[]).map((key) => ({
    key,
    title: BOT_TEXT_CATALOG[key].title,
    description: BOT_TEXT_CATALOG[key].description,
    group: BOT_TEXT_CATALOG[key].group,
    allowedVars: BOT_TEXT_ALLOWED_VARS[key],
    defaultText: DEFAULT_BOT_TEXTS_V2[key],
  }));
}

/** Variáveis que o lembrete v1 realmente recebe (as demais valem para o resto das mensagens). */
const V1_REMINDER_VARS = ["nome", "servico", "profissional", "data", "hora", "quando"];

const V1_DESCRIPTIONS: Record<BotTextKeyLiteral, [TabId, string]> = {
  GREETING: ["conversa", "Primeira mensagem, quando o cliente inicia a conversa."],
  MAIN_MENU: ["conversa", "Menu principal com as opções disponíveis."],
  INVALID_OPTION: ["conversa", "Resposta quando o cliente envia uma opção que o bot não entende."],
  TOO_MANY_INVALID: ["conversa", "Quando o cliente erra a opção repetidas vezes e o bot chama um atendente."],
  ONLY_TEXT: ["conversa", "Quando o cliente envia algo que não é texto (áudio, imagem, figurinha...)."],
  SESSION_EXPIRED: ["conversa", "Quando a conversa ficou parada por um tempo e o bot recomeça o menu."],
  GOODBYE: ["conversa", "Mensagem de despedida ao final da conversa."],
  CHOOSE_SERVICE: ["agendamento", "Pergunta qual serviço o cliente quer agendar."],
  CHOOSE_PROFESSIONAL: ["agendamento", "Pergunta com qual profissional o cliente prefere ser atendido."],
  CHOOSE_DAY: ["agendamento", "Pergunta em qual dia o cliente quer agendar."],
  CHOOSE_TIME: ["agendamento", "Lista os horários disponíveis no dia escolhido."],
  NO_SLOTS_DAY: ["agendamento", "Avisa que não há horário livre no dia escolhido."],
  NO_AVAILABILITY: ["agendamento", "Avisa que não há nenhum horário disponível no momento."],
  ASK_NAME: ["agendamento", "Pede o nome do cliente antes de continuar."],
  CONFIRM_SUMMARY: ["agendamento", "Resumo do agendamento para o cliente confirmar."],
  BOOKED: ["agendamento", "Confirma que o agendamento foi feito com sucesso."],
  SLOT_TAKEN: ["agendamento", "Avisa que o horário escolhido acabou de ser ocupado por outra pessoa."],
  MY_APPOINTMENTS: ["meus", "Lista os agendamentos do cliente."],
  NO_APPOINTMENTS: ["meus", "Avisa que o cliente não tem agendamentos marcados."],
  APPOINTMENT_ACTIONS: ["meus", "Pergunta o que o cliente quer fazer com o agendamento."],
  CONFIRM_CANCEL: ["meus", "Pede confirmação antes de cancelar o agendamento."],
  CANCELED: ["meus", "Confirma que o agendamento foi cancelado."],
  RESCHEDULED: ["meus", "Confirma que o agendamento foi remarcado."],
  TOO_LATE: ["meus", "Avisa que já está muito perto do horário para cancelar ou remarcar."],
  REMINDER: ["meus", "Lembrete enviado ao cliente antes do horário agendado."],
  HUMAN_HANDOFF: ["atendente", "Avisa que um atendente humano vai continuar a conversa."],
  LABEL_CONFIRM: ["rotulos", "Opção \"Confirmar\" na tela de confirmar agendamento."],
  LABEL_OTHER_TIME: ["rotulos", "Opção \"Escolher outro horário\" na tela de confirmar agendamento."],
  LABEL_CANCEL_YES: ["rotulos", "Opção \"Sim, cancelar\" na confirmação de cancelamento."],
  LABEL_CANCEL_NO: ["rotulos", "Opção \"Não, manter\" na confirmação de cancelamento."],
  LABEL_MORE_DAYS: ["rotulos", "Paginação \"Ver mais datas\" na lista de dias disponíveis."],
  LABEL_MORE_TIMES: ["rotulos", "Paginação \"Mais horários\" na lista de horários disponíveis."],
  LABEL_MORE: ["rotulos", "Paginação genérica \"Ver mais\" (menus com mais de 9 itens)."],
  LABEL_BACK_TO_MENU: ["rotulos", "Rodapé \"0. Menu principal\" que aparece nas telas do bot."],
};

/** Catálogo da v1 (comportamento de hoje): a descrição vira o título; sem subtítulo. */
export function catalogV1(): CatalogEntry[] {
  return (Object.keys(V1_DESCRIPTIONS) as BotTextKeyLiteral[]).map((key) => ({
    key,
    title: V1_DESCRIPTIONS[key][1],
    description: "",
    group: V1_DESCRIPTIONS[key][0],
    allowedVars: key === "REMINDER" ? V1_REMINDER_VARS : (BOT_TEXT_VARIABLES as readonly string[]),
    defaultText: DEFAULT_BOT_TEXTS[key],
  }));
}

/**
 * Variáveis do texto que a chave não aceita (ordem de aparição, sem repetir). Mesma regra do
 * servidor: v2 valida contra as variáveis da chave; v1 só recusa nomes desconhecidos.
 */
export function disallowedVars(entry: CatalogEntry, text: string, flowVersion: FlowVersion): string[] {
  const permitted: readonly string[] = flowVersion === 2 ? entry.allowedVars : BOT_TEXT_VARIABLES;
  const found: string[] = [];
  for (const match of text.matchAll(/\{(\w+)\}/g)) {
    if (!permitted.includes(match[1]) && !found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

/** Título curto de uma chave legada (só leitura). Cai na própria chave se não achar. */
export function legacyTitle(key: string): string {
  return (V1_DESCRIPTIONS as Record<string, [TabId, string]>)[key]?.[1] ?? key;
}
