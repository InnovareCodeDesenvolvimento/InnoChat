/**
 * Templates e formatações de mensagens da régua de Resgate de Leads (Meta Ads / Abandono de Funil).
 *
 * Tom de voz humanizado (docs/guia-de-voz.md), sem cara de bot, sem travessões.
 * Sempre oferece o comando claro de opt-out (SAIR).
 */

export function humanizeSince(date: Date, now: Date): string {
  const diffMs = Math.max(0, now.getTime() - date.getTime());
  const diffHours = Math.floor(diffMs / (60 * 60 * 1000));
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));

  if (diffHours < 24) {
    if (diffHours <= 1) return "há pouco";
    return `há ${diffHours} horas`;
  }
  if (diffDays === 1) {
    return "ontem";
  }
  return `há ${diffDays} dias`;
}

export const RESCUE_MSG_1_TEMPLATE = ({ nome, faltou }: { nome: string; faltou: string }) =>
  `Oi, ${nome}! Notei que você criou sua conta no InnoChat ${faltou} mas ainda não entrou no painel. É por aí que tudo começa: o bot só consegue atender clientes depois que você conecta o WhatsApp e cadastra os serviços. Quer que eu te guie rapidinho? Responde aqui que eu te ajudo. Se preferir não receber mais mensagens, é só responder SAIR.`;

export const RESCUE_MSG_2_TEMPLATE = ({ nome }: { nome: string }) =>
  `Oi, ${nome}! Passando aqui pela última vez: se ainda quiser testar o InnoChat, posso te ligar rapidinho pra te mostrar como funciona — é só responder SIM que eu te chamo. Se preferir, responde SAIR e eu paro de mandar mensagem.`;

export const RESCUE_OPT_OUT_CONFIRMATION = "Tudo certo, não mando mais. Obrigado!";
