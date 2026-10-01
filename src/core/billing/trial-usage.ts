/**
 * Uso REAL do teste grátis, para a sequência de conversão (docs/regua-de-cobranca.md §2.3.1): as
 * mensagens mostram o que o InnoChat já fez pela empresa e, se ainda não fez nada, ajudam a ligar o que
 * falta. Puro: quem consulta o banco (`src/modules/billing/dunning/context.ts`) só entrega os números.
 * Nada aqui é inventado: valor zero nunca vira frase de resultado.
 */

export type TrialUsageRaw = {
  /** Horários marcados pelo bot (agendamentos de origem WhatsApp, não cancelados) desde o início do teste. */
  appointmentsByBot: number;
  /** Clientes distintos que receberam resposta do bot desde o início do teste. */
  conversationsAnswered: number;
  /** Lembretes de véspera enviados aos clientes finais no período. */
  remindersSent: number;
  /** Clientes que marcaram mais de um horário no período. */
  returningClients: number;
  /** Clientes distintos que marcaram pelo WhatsApp (para "vão ficar sem resposta"). */
  botClients: number;
  whatsappConnected: boolean;
  hasService: boolean;
  hasProfessional: boolean;
};

/** O que ainda falta para o bot funcionar, na ordem em que a pessoa deve resolver. */
export type TrialMissingStep = "CONNECT_WHATSAPP" | "ADD_SERVICE" | "ADD_PROFESSIONAL" | "SHARE_NUMBER";

export type TrialUsage = {
  /** `RESULTS` = há valor real para mostrar. `ALMOST` = zero resultados: a mensagem ajuda a ligar o que falta. */
  variant: "RESULTS" | "ALMOST";
  appointments: number;
  conversations: number;
  reminders: number;
  returning: number;
  clients: number;
  missing: TrialMissingStep;
};

function count(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function summarizeTrialUsage(raw: TrialUsageRaw): TrialUsage {
  const appointments = count(raw.appointmentsByBot);
  const conversations = count(raw.conversationsAnswered);
  const missing: TrialMissingStep = !raw.whatsappConnected
    ? "CONNECT_WHATSAPP"
    : !raw.hasService
      ? "ADD_SERVICE"
      : !raw.hasProfessional
        ? "ADD_PROFESSIONAL"
        : "SHARE_NUMBER";
  return {
    variant: appointments > 0 || conversations > 0 ? "RESULTS" : "ALMOST",
    appointments,
    conversations,
    reminders: count(raw.remindersSent),
    returning: count(raw.returningClients),
    clients: count(raw.botClients),
    missing,
  };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function joinPt(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} e ${parts[parts.length - 1]}`;
}

/**
 * "marcou 3 horários, respondeu 12 conversas e mandou 2 lembretes" (só o que é maior que zero), ou `null`
 * quando não há nada para mostrar (variação `ALMOST`). Vem sem o sujeito: o texto escreve "o Inno" antes.
 */
export function describeTrialResults(usage: TrialUsage): string | null {
  if (usage.variant !== "RESULTS") return null;
  const parts: string[] = [];
  if (usage.appointments > 0) parts.push(`marcou ${plural(usage.appointments, "horário", "horários")}`);
  if (usage.conversations > 0) parts.push(`respondeu ${plural(usage.conversations, "conversa", "conversas")}`);
  if (usage.reminders > 0) parts.push(`mandou ${plural(usage.reminders, "lembrete", "lembretes")}`);
  if (usage.returning > 0) parts.push(usage.returning === 1 ? "fez 1 cliente voltar a marcar" : `fez ${usage.returning} clientes voltarem a marcar`);
  return parts.length > 0 ? joinPt(parts) : null;
}

/** O passo que falta, em frase (infinitivo): "conectar o número de WhatsApp da empresa". */
export function describeMissingStep(step: TrialMissingStep): string {
  switch (step) {
    case "CONNECT_WHATSAPP":
      return "conectar o número de WhatsApp da empresa";
    case "ADD_SERVICE":
      return "cadastrar o primeiro serviço";
    case "ADD_PROFESSIONAL":
      return "cadastrar quem atende";
    case "SHARE_NUMBER":
      return "avisar seus clientes do número do bot";
  }
}

/**
 * "2 clientes que marcaram pelo WhatsApp vão ficar sem resposta" (singular: "1 cliente que marcou ... vai ficar").
 * Só faz sentido com `n > 0`; use junto de uma checagem de zero (nunca inventa número).
 */
export function describeStrandedClients(n: number): string {
  return n === 1 ? "1 cliente que marcou pelo WhatsApp vai ficar sem resposta" : `${n} clientes que marcaram pelo WhatsApp vão ficar sem resposta`;
}
