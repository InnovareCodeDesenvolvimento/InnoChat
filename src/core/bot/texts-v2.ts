/**
 * Textos do bot v2 (docs/bot-v2-especificacao.md §5; contrato em docs/bot-v2-plano.md §3.3).
 * `texts.ts` (v1) fica CONGELADO: o fluxo v1 continua lendo aquele catálogo até o "Publicar fluxo".
 * Puro (sem Prisma/Next): as chaves espelham o enum `BotTextKey` como union de string.
 *
 * Regra de ouro dos textos v2: o texto editável NUNCA contém número de opção — o renderizador do
 * motor numera com keycaps (BUG-11). Por isso `MAIN_MENU`/`APPOINTMENT_ACTIONS` saem (legadas).
 */

/** Chaves da v1 que a v2 não usa mais (mudaram de significado — spec §5.2 item 5 e §8). */
export const LEGACY_V1_KEYS = ["MAIN_MENU", "APPOINTMENT_ACTIONS", "TOO_MANY_INVALID", "LABEL_BACK_TO_MENU", "LABEL_OTHER_TIME"] as const;

/** Chaves da v1 que continuam valendo na v2 (= `BOT_TEXT_KEYS` de texts.ts menos as legadas). */
const KEPT_V1_KEYS = [
  "GREETING",
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
  "CONFIRM_CANCEL",
  "CANCELED",
  "RESCHEDULED",
  "TOO_LATE",
  "HUMAN_HANDOFF",
  "INVALID_OPTION",
  "ONLY_TEXT",
  "SESSION_EXPIRED",
  "GOODBYE",
  "REMINDER",
  "LABEL_CONFIRM",
  "LABEL_CANCEL_YES",
  "LABEL_CANCEL_NO",
  "LABEL_MORE_DAYS",
  "LABEL_MORE_TIMES",
  "LABEL_MORE",
] as const;

/** As 46 chaves novas (26 mensagens + 20 rótulos) — plano §3.1. */
const NEW_V2_KEYS = [
  "MENU_PROMPT",
  "MENU_HINT",
  "FOOTER_HINT",
  "CONTINUE_PROMPT",
  "HELP",
  "NO_SERVICES",
  "NEXT_AVAILABLE",
  "DATE_OUT_OF_RANGE",
  "TIME_NOT_AVAILABLE",
  "ITEM_UNAVAILABLE",
  "APPOINTMENT_LIMIT",
  "NAME_INVALID",
  "NAME_TOO_LONG",
  "CONFIRM_RESCHEDULE",
  "CONFIRM_EDIT",
  "POST_ACTION_MENU",
  "APPOINTMENT_DETAIL",
  "APPOINTMENT_LOCKED",
  "CANCEL_KEPT",
  "HUMAN_HANDOFF_OFF_HOURS",
  "BOT_RESUMED",
  "INVALID_BACK_TO_MENU",
  "AMBIGUOUS_OPTION",
  "RESUME_OFFER",
  "THANKS_REPLY",
  "TECH_ERROR",
  "LABEL_MENU_BOOK",
  "LABEL_MENU_MY",
  "LABEL_MENU_HUMAN",
  "LABEL_ANY_PROFESSIONAL",
  "LABEL_NEXT_AVAILABLE",
  "LABEL_BY_DAY",
  "LABEL_EDIT",
  "LABEL_EDIT_SERVICE",
  "LABEL_EDIT_PROFESSIONAL",
  "LABEL_EDIT_DATETIME",
  "LABEL_EDIT_NAME",
  "LABEL_RESCHEDULE",
  "LABEL_CANCEL_APPOINTMENT",
  "LABEL_BOOK_ANOTHER",
  "LABEL_FINISH",
  "LABEL_CONTINUE",
  "LABEL_START_OVER",
  "LABEL_BACK",
  "LABEL_OTHER_SERVICE",
  "LABEL_PREVIOUS",
] as const;

export const BOT_TEXT_KEYS_V2 = [...KEPT_V1_KEYS, ...NEW_V2_KEYS] as const;
export type BotTextKeyV2 = (typeof BOT_TEXT_KEYS_V2)[number];

/** 8 variáveis da v1 + 7 novas (spec §5.3). */
export const BOT_TEXT_VARIABLES_V2 = [
  "nome",
  "empresa",
  "servico",
  "profissional",
  "data",
  "hora",
  "preco",
  "quando",
  "duracao",
  "data_longa",
  "prazo",
  "retorno",
  "proximo",
  "anterior",
  "limite",
] as const;

/** Literal da spec §5.3 (mensagens) e da tabela de rótulos. REMINDER e os rótulos v1 não mudam. */
export const DEFAULT_BOT_TEXTS_V2: Record<BotTextKeyV2, string> = {
  // ── Navegação ─────────────────────────────────────────────
  GREETING: "Olá, {nome}! 👋\nBoas-vindas à *{empresa}*.",
  MENU_PROMPT: "Como posso ajudar você hoje?",
  MENU_HINT: "_Responda com o número ou o nome da opção._",
  FOOTER_HINT: "_Digite *0* para o menu ou *voltar* para a etapa anterior._",
  CONTINUE_PROMPT: "Continuando de onde paramos:",
  HELP:
    "*Como funciona este atendimento*\n\n" +
    "• Responda com o *número* da opção ou com o nome dela\n" +
    "• *voltar* — etapa anterior\n" +
    "• *menu* — menu principal\n" +
    "• *atendente* — falar com um atendente\n" +
    "• *sair* — encerrar\n\n" +
    "Você também pode digitar datas (_amanhã_, _sexta_, _15/10_) e horários (_15h_, _15:30_).",

  // ── Agendamento ──────────────────────────────────────────
  CHOOSE_SERVICE: "*Qual serviço você deseja agendar?*",
  NO_SERVICES: "No momento não há serviços disponíveis para agendar por aqui. Quer falar com um atendente?",
  CHOOSE_PROFESSIONAL: "*Com quem você prefere ser atendido(a)?*\n_{servico}_",
  CHOOSE_DAY:
    "*Para qual dia?*\n_{servico} · {profissional}_\n\n" +
    "Escolha uma opção ou digite a data (ex.: _amanhã_, _sexta_, _15/10_).",
  NEXT_AVAILABLE: "*Próximos horários livres*\n_{servico} · {profissional}_",
  CHOOSE_TIME:
    "*Horários livres em {data}*\n_{servico} · {profissional}_\n\n" +
    "Escolha uma opção ou digite o horário (ex.: _15h_, _15:30_, _tarde_).",
  NO_SLOTS_DAY: "Não temos horários livres em *{data}*.\nO próximo dia com vaga é *{proximo}*. Veja as datas disponíveis:",
  DATE_OUT_OF_RANGE: "Consigo agendar de hoje até *{data}*. Escolha uma data dentro desse período:",
  TIME_NOT_AVAILABLE: "Às *{hora}* não temos vaga em {data}. Os horários mais próximos são:",
  NO_AVAILABILITY:
    "No momento não há horários livres para *{servico}* nos próximos dias. 😕\n" +
    "Quer falar com um atendente ou escolher outro serviço?",
  ITEM_UNAVAILABLE: "Essa opção não está mais disponível. Vamos escolher de novo:",
  APPOINTMENT_LIMIT:
    "Você já tem *{limite}* agendamentos marcados, o máximo por aqui.\n" +
    "Para marcar outro, remarque ou cancele um deles, ou fale com um atendente:",
  ASK_NAME: "Para finalizar, *qual é o seu nome?*\n_Digite como prefere ser chamado(a)._",
  NAME_INVALID: "Não consegui registrar esse nome. Digite apenas o seu nome, por favor.",
  NAME_TOO_LONG: "Esse nome ficou um pouco longo. Pode abreviar? _(até 60 letras)_",
  CONFIRM_SUMMARY:
    "*Confira os dados do agendamento*\n\n" +
    "*Serviço:* {servico}\n" +
    "*Profissional:* {profissional}\n" +
    "*Data:* {data_longa}\n" +
    "*Horário:* {hora} _(duração de {duracao})_\n" +
    "*Valor:* {preco}\n" +
    "*Nome:* {nome}\n\n" +
    "Está tudo certo?",
  CONFIRM_RESCHEDULE:
    "*Confira a remarcação*\n\n" +
    "*Serviço:* {servico} com {profissional}\n" +
    "*De:* ~{anterior}~\n" +
    "*Para:* {data_longa} às {hora}\n\n" +
    "Posso confirmar?",
  CONFIRM_EDIT: "*O que você quer corrigir?*",
  BOOKED:
    "✅ *Agendamento confirmado!*\n\n" +
    "*{servico}* com {profissional}\n" +
    "{data_longa} às *{hora}*\n\n" +
    "_Precisa remarcar ou cancelar? Mande *menu* e escolha Meus agendamentos (até {prazo} antes do horário)._",
  SLOT_TAKEN: "Poxa, o horário das *{hora}* acabou de ser reservado por outra pessoa. 😕\nHorários livres em *{data}*:",
  POST_ACTION_MENU: "Posso ajudar em algo mais?",

  // ── Meus agendamentos ───────────────────────────────────
  MY_APPOINTMENTS: "*Seus próximos agendamentos*\nEscolha um para ver as opções:",
  NO_APPOINTMENTS: "Você não tem agendamentos futuros por aqui.",
  APPOINTMENT_DETAIL: "*{servico}* com {profissional}\n{data_longa} às *{hora}*\n\nO que você deseja fazer?",
  APPOINTMENT_LOCKED:
    "*{servico}* com {profissional}\n{data_longa} às *{hora}*\n\n" +
    "Alterações pelo WhatsApp são aceitas até *{prazo}* antes do horário. Para este agendamento, fale com um atendente.",
  CONFIRM_CANCEL: "Tem certeza de que deseja *cancelar* {servico} com {profissional} em *{data}* às *{hora}*?",
  CANCELED: "Pronto: o agendamento de *{servico}* em {data} às {hora} foi *cancelado*.",
  CANCEL_KEPT: "Tudo certo: seu agendamento continua marcado.",
  RESCHEDULED: "✅ *Agendamento remarcado!*\n\n*{servico}* com {profissional}\n{data_longa} às *{hora}*",
  TOO_LATE:
    "Este agendamento não pode mais ser alterado por aqui: mudanças são aceitas até *{prazo}* antes do horário.\n" +
    "Um atendente pode ajudar você.",

  // ── Atendente e controle da conversa ───────────────────
  HUMAN_HANDOFF:
    "Certo! Já avisei a nossa equipe e um atendente vai continuar esta conversa por aqui.\n\n" +
    "_Se ninguém responder até {retorno}, eu volto a atender. Para voltar ao menu agora, digite *menu*._",
  HUMAN_HANDOFF_OFF_HOURS:
    "Certo! Deixei sua mensagem com a nossa equipe.\n" +
    "Estamos fora do horário de atendimento agora; retornamos *{proximo}*.\n\n" +
    "_Enquanto isso, se quiser agendar por aqui, digite *menu*._",
  BOT_RESUMED: "Certo, o atendimento automático está de volta.",
  INVALID_OPTION: "Não entendi sua resposta. Escolha uma das opções abaixo respondendo com o *número*:",
  INVALID_BACK_TO_MENU:
    "Acho que não estou conseguindo entender. Vamos recomeçar pelo menu; se preferir, escolha *Falar com atendente*.",
  AMBIGUOUS_OPTION: "Encontrei mais de uma opção parecida. Qual delas você quis dizer?",
  ONLY_TEXT: "Por aqui eu entendo apenas mensagens de texto. Responda digitando uma das opções:",
  SESSION_EXPIRED: "Como faz um tempinho desde a nossa última conversa, recomecei o atendimento.",
  RESUME_OFFER: "Que bom ter você de volta! Você estava agendando *{servico}*.\nQuer continuar de onde parou?",
  THANKS_REPLY: "Por nada, {nome}! Quando precisar, é só mandar uma mensagem. 👋",
  GOODBYE: "Atendimento encerrado. Obrigado pelo contato, {nome}! 👋\n_Quando precisar, é só mandar uma mensagem._",
  TECH_ERROR: "Tive um problema técnico para concluir isso agora. Tente de novo em instantes ou digite *atendente*.",
  // Enviado pelo tick de lembretes, fora do fluxo. Não muda em relação à v1.
  REMINDER:
    "Olá, {nome}! Lembrete: você tem {servico} com {profissional} {quando} às {hora}.\nPara remarcar ou cancelar, responda *menu*.",

  // ── Rótulos de opção (sem variáveis) ───────────────────
  LABEL_MENU_BOOK: "Agendar horário",
  LABEL_MENU_MY: "Meus agendamentos",
  LABEL_MENU_HUMAN: "Falar com atendente",
  LABEL_ANY_PROFESSIONAL: "Qualquer profissional",
  LABEL_NEXT_AVAILABLE: "Primeiro horário livre",
  LABEL_BY_DAY: "Escolher por dia",
  LABEL_CONFIRM: "Confirmar",
  LABEL_EDIT: "Corrigir dados",
  LABEL_EDIT_SERVICE: "Serviço",
  LABEL_EDIT_PROFESSIONAL: "Profissional",
  LABEL_EDIT_DATETIME: "Data e horário",
  LABEL_EDIT_NAME: "Nome",
  LABEL_RESCHEDULE: "Remarcar",
  LABEL_CANCEL_APPOINTMENT: "Cancelar agendamento",
  LABEL_CANCEL_YES: "Sim, cancelar",
  LABEL_CANCEL_NO: "Não, manter",
  LABEL_BOOK_ANOTHER: "Agendar outro",
  LABEL_FINISH: "Encerrar atendimento",
  LABEL_CONTINUE: "Continuar",
  LABEL_START_OVER: "Começar de novo",
  LABEL_BACK: "Voltar",
  LABEL_OTHER_SERVICE: "Outro serviço",
  LABEL_PREVIOUS: "Ver anteriores",
  LABEL_MORE_DAYS: "Ver mais datas",
  LABEL_MORE_TIMES: "Mais horários",
  LABEL_MORE: "Ver mais",
};

const VARS_ROLE = ["servico", "profissional"] as const;
const VARS_TIME = ["servico", "profissional", "data", "hora", "proximo"] as const;
const VARS_APPOINTMENT = ["servico", "profissional", "data", "data_longa", "hora", "duracao", "preco", "prazo", "anterior"] as const;
const VARS_HANDOFF = ["retorno", "proximo"] as const;

function buildAllowedVars(): Record<BotTextKeyV2, readonly string[]> {
  const extra: Partial<Record<BotTextKeyV2, readonly string[]>> = {};
  const set = (keys: BotTextKeyV2[], vars: readonly string[]) => {
    for (const k of keys) extra[k] = vars;
  };
  set(["CHOOSE_PROFESSIONAL", "NEXT_AVAILABLE", "CHOOSE_DAY", "NO_AVAILABILITY", "RESUME_OFFER"], VARS_ROLE);
  set(["CHOOSE_TIME", "NO_SLOTS_DAY", "DATE_OUT_OF_RANGE", "TIME_NOT_AVAILABLE", "SLOT_TAKEN"], VARS_TIME);
  set(
    [
      "CONFIRM_SUMMARY",
      "CONFIRM_RESCHEDULE",
      "BOOKED",
      "RESCHEDULED",
      "APPOINTMENT_DETAIL",
      "APPOINTMENT_LOCKED",
      "CONFIRM_CANCEL",
      "CANCELED",
      "TOO_LATE",
    ],
    VARS_APPOINTMENT,
  );
  set(["HUMAN_HANDOFF", "HUMAN_HANDOFF_OFF_HOURS"], VARS_HANDOFF);
  set(["APPOINTMENT_LIMIT"], ["limite"]);
  set(["REMINDER"], ["servico", "profissional", "hora", "quando"]);

  const result = {} as Record<BotTextKeyV2, readonly string[]>;
  for (const key of BOT_TEXT_KEYS_V2) {
    result[key] = key.startsWith("LABEL_") ? [] : ["nome", "empresa", ...(extra[key] ?? [])];
  }
  return result;
}

/**
 * Variáveis que o editor aceita por chave (spec §5.3, tabela). `nome` e `empresa` valem em toda
 * mensagem; rótulos (`LABEL_*`) não aceitam nenhuma. Corrige BUG-12 (variável fora do contexto
 * ficava literal na mensagem).
 */
export const BOT_TEXT_ALLOWED_VARS: Record<BotTextKeyV2, readonly string[]> = buildAllowedVars();

export type BotTextGroup = "conversa" | "agendamento" | "meus" | "atendente" | "rotulos";

/** Metadados para a tela "Mensagens do bot": grupo, título e descrição em português. */
export const BOT_TEXT_CATALOG: Record<BotTextKeyV2, { group: BotTextGroup; title: string; description: string }> = {
  // conversa
  GREETING: { group: "conversa", title: "Saudação", description: "Primeira mensagem quando o cliente começa a conversa." },
  MENU_PROMPT: { group: "conversa", title: "Pergunta do menu", description: "Frase que antecede as opções do menu principal. As opções são numeradas automaticamente." },
  MENU_HINT: { group: "conversa", title: "Dica do menu", description: "Linha final do menu explicando como responder." },
  FOOTER_HINT: { group: "conversa", title: "Dica de navegação", description: "Rodapé das etapas do agendamento: como voltar ao menu ou à etapa anterior." },
  CONTINUE_PROMPT: { group: "conversa", title: "Retomada da conversa", description: "Aviso antes de repetir a última pergunta quando o cliente escolhe continuar." },
  HELP: { group: "conversa", title: "Ajuda", description: "Explica como usar o atendimento quando o cliente digita \"ajuda\"." },
  INVALID_OPTION: { group: "conversa", title: "Resposta não entendida", description: "Quando o cliente responde algo que não corresponde a nenhuma opção." },
  INVALID_BACK_TO_MENU: { group: "conversa", title: "Voltando ao menu após erros", description: "Depois de duas respostas não entendidas seguidas, o bot recomeça pelo menu." },
  AMBIGUOUS_OPTION: { group: "conversa", title: "Opção ambígua", description: "Quando o texto do cliente combina com mais de uma opção." },
  ONLY_TEXT: { group: "conversa", title: "Só texto", description: "Quando o cliente manda áudio, imagem ou outro tipo de mídia." },
  SESSION_EXPIRED: { group: "conversa", title: "Conversa expirada", description: "Aviso de que o atendimento recomeçou depois de um tempo sem conversa." },
  RESUME_OFFER: { group: "conversa", title: "Oferta de retomada", description: "Pergunta se o cliente quer continuar o agendamento que deixou pela metade." },
  THANKS_REPLY: { group: "conversa", title: "Resposta a agradecimento", description: "Quando o cliente agradece ao final." },
  GOODBYE: { group: "conversa", title: "Despedida", description: "Quando o cliente encerra o atendimento." },
  TECH_ERROR: { group: "conversa", title: "Problema técnico", description: "Quando algo falha do nosso lado durante a conversa." },
  // agendamento
  CHOOSE_SERVICE: { group: "agendamento", title: "Escolha do serviço", description: "Título da lista de serviços." },
  NO_SERVICES: { group: "agendamento", title: "Sem serviços", description: "Quando nenhum serviço está disponível para agendar pelo WhatsApp." },
  CHOOSE_PROFESSIONAL: { group: "agendamento", title: "Escolha do profissional", description: "Título da lista de profissionais." },
  CHOOSE_DAY: { group: "agendamento", title: "Escolha do dia", description: "Título da lista de datas." },
  NEXT_AVAILABLE: { group: "agendamento", title: "Próximos horários livres", description: "Título da lista dos primeiros horários livres, em qualquer dia." },
  CHOOSE_TIME: { group: "agendamento", title: "Escolha do horário", description: "Título da lista de horários do dia escolhido." },
  NO_SLOTS_DAY: { group: "agendamento", title: "Dia sem horários", description: "Quando o dia escolhido não tem vaga; mostra o próximo dia livre." },
  DATE_OUT_OF_RANGE: { group: "agendamento", title: "Data fora do período", description: "Quando a data digitada passou ou está além do prazo máximo de agendamento." },
  TIME_NOT_AVAILABLE: { group: "agendamento", title: "Horário indisponível", description: "Quando o horário digitado não existe; oferece os mais próximos." },
  NO_AVAILABILITY: { group: "agendamento", title: "Sem disponibilidade", description: "Quando o serviço não tem nenhum horário livre nos próximos dias." },
  ITEM_UNAVAILABLE: { group: "agendamento", title: "Opção não disponível", description: "Quando o item escolhido deixou de existir no meio da conversa." },
  APPOINTMENT_LIMIT: { group: "agendamento", title: "Limite de agendamentos", description: "Quando o cliente já atingiu o máximo de agendamentos futuros." },
  ASK_NAME: { group: "agendamento", title: "Pedido do nome", description: "Pedido do nome do cliente, feito só uma vez e só na hora de reservar." },
  NAME_INVALID: { group: "agendamento", title: "Nome inválido", description: "Quando o nome digitado não pode ser usado." },
  NAME_TOO_LONG: { group: "agendamento", title: "Nome muito longo", description: "Quando o nome digitado passa do limite de 60 letras." },
  CONFIRM_SUMMARY: { group: "agendamento", title: "Resumo para confirmar", description: "Dados do agendamento antes de confirmar." },
  CONFIRM_RESCHEDULE: { group: "agendamento", title: "Resumo da remarcação", description: "Compara o horário antigo e o novo antes de confirmar a remarcação." },
  CONFIRM_EDIT: { group: "agendamento", title: "O que corrigir", description: "Pergunta qual dado o cliente quer corrigir na confirmação." },
  BOOKED: { group: "agendamento", title: "Agendamento confirmado", description: "Mensagem enviada quando a reserva é feita." },
  SLOT_TAKEN: { group: "agendamento", title: "Horário ocupado", description: "Quando outra pessoa reservou o horário primeiro." },
  POST_ACTION_MENU: { group: "agendamento", title: "Posso ajudar em algo mais?", description: "Pergunta ao final de uma reserva, remarcação ou cancelamento." },
  // meus agendamentos
  MY_APPOINTMENTS: { group: "meus", title: "Lista de agendamentos", description: "Título da lista de agendamentos futuros do cliente." },
  NO_APPOINTMENTS: { group: "meus", title: "Sem agendamentos", description: "Quando o cliente não tem agendamentos futuros." },
  APPOINTMENT_DETAIL: { group: "meus", title: "Detalhe do agendamento", description: "Dados do agendamento escolhido e pergunta do que fazer." },
  APPOINTMENT_LOCKED: { group: "meus", title: "Agendamento fora do prazo de alteração", description: "Quando faltam menos horas do que o mínimo para remarcar ou cancelar." },
  CONFIRM_CANCEL: { group: "meus", title: "Confirmar cancelamento", description: "Pergunta antes de cancelar." },
  CANCELED: { group: "meus", title: "Agendamento cancelado", description: "Confirmação do cancelamento." },
  CANCEL_KEPT: { group: "meus", title: "Cancelamento desfeito", description: "Quando o cliente desiste de cancelar." },
  RESCHEDULED: { group: "meus", title: "Agendamento remarcado", description: "Confirmação da remarcação." },
  TOO_LATE: { group: "meus", title: "Tarde demais para alterar", description: "Quando o prazo de alteração venceu durante a conversa." },
  REMINDER: { group: "meus", title: "Lembrete", description: "Mensagem enviada automaticamente antes do horário marcado." },
  // atendente
  HUMAN_HANDOFF: { group: "atendente", title: "Chamando atendente", description: "Resposta quando o cliente pede atendente dentro do horário da equipe." },
  HUMAN_HANDOFF_OFF_HOURS: { group: "atendente", title: "Atendente fora do horário", description: "Resposta quando o cliente pede atendente com a equipe fora do expediente." },
  BOT_RESUMED: { group: "atendente", title: "Atendimento automático de volta", description: "Aviso quando o bot volta a responder depois de um atendente." },
  // rótulos
  LABEL_MENU_BOOK: { group: "rotulos", title: "Menu: agendar", description: "Opção do menu principal." },
  LABEL_MENU_MY: { group: "rotulos", title: "Menu: meus agendamentos", description: "Opção do menu principal." },
  LABEL_MENU_HUMAN: { group: "rotulos", title: "Menu: falar com atendente", description: "Opção do menu principal e das telas de ajuda." },
  LABEL_ANY_PROFESSIONAL: { group: "rotulos", title: "Qualquer profissional", description: "Opção que escolhe o primeiro profissional livre." },
  LABEL_NEXT_AVAILABLE: { group: "rotulos", title: "Primeiro horário livre", description: "Opção da lista de dias." },
  LABEL_BY_DAY: { group: "rotulos", title: "Escolher por dia", description: "Opção que volta à lista de dias." },
  LABEL_CONFIRM: { group: "rotulos", title: "Confirmar", description: "Opção de confirmação do agendamento." },
  LABEL_EDIT: { group: "rotulos", title: "Corrigir dados", description: "Opção da confirmação para corrigir algo." },
  LABEL_EDIT_SERVICE: { group: "rotulos", title: "Corrigir: serviço", description: "Opção da lista de correções." },
  LABEL_EDIT_PROFESSIONAL: { group: "rotulos", title: "Corrigir: profissional", description: "Opção da lista de correções." },
  LABEL_EDIT_DATETIME: { group: "rotulos", title: "Corrigir: data e horário", description: "Opção da lista de correções." },
  LABEL_EDIT_NAME: { group: "rotulos", title: "Corrigir: nome", description: "Opção da lista de correções." },
  LABEL_RESCHEDULE: { group: "rotulos", title: "Remarcar", description: "Opção do detalhe do agendamento." },
  LABEL_CANCEL_APPOINTMENT: { group: "rotulos", title: "Cancelar agendamento", description: "Opção do detalhe do agendamento." },
  LABEL_CANCEL_YES: { group: "rotulos", title: "Cancelar: sim", description: "Opção da confirmação de cancelamento." },
  LABEL_CANCEL_NO: { group: "rotulos", title: "Cancelar: não", description: "Opção da confirmação de cancelamento." },
  LABEL_BOOK_ANOTHER: { group: "rotulos", title: "Agendar outro", description: "Opção ao final de um atendimento." },
  LABEL_FINISH: { group: "rotulos", title: "Encerrar atendimento", description: "Opção ao final de um atendimento." },
  LABEL_CONTINUE: { group: "rotulos", title: "Continuar", description: "Opção da oferta de retomada." },
  LABEL_START_OVER: { group: "rotulos", title: "Começar de novo", description: "Opção da oferta de retomada." },
  LABEL_BACK: { group: "rotulos", title: "Voltar", description: "Opção para voltar à etapa anterior." },
  LABEL_OTHER_SERVICE: { group: "rotulos", title: "Outro serviço", description: "Opção quando não há horários para o serviço escolhido." },
  LABEL_PREVIOUS: { group: "rotulos", title: "Ver anteriores", description: "Opção de paginação para a página anterior." },
  LABEL_MORE_DAYS: { group: "rotulos", title: "Ver mais datas", description: "Opção de paginação da lista de dias." },
  LABEL_MORE_TIMES: { group: "rotulos", title: "Mais horários", description: "Opção de paginação da lista de horários." },
  LABEL_MORE: { group: "rotulos", title: "Ver mais", description: "Opção de paginação genérica." },
};

/**
 * Variáveis de `text` que a chave NÃO aceita (ordem de aparição, sem repetir). Vazio = texto válido.
 * Inclui variáveis desconhecidas e conhecidas fora do contexto da chave (ex.: `{preco}` em GREETING).
 */
export function findDisallowedVariables(key: BotTextKeyV2, text: string): string[] {
  const allowed = BOT_TEXT_ALLOWED_VARS[key];
  const found: string[] = [];
  for (const match of text.matchAll(/\{(\w+)\}/g)) {
    const name = match[1];
    if (!allowed.includes(name) && !found.includes(name)) found.push(name);
  }
  return found;
}
