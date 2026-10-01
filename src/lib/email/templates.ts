/**
 * Templates de e-mail pt-BR. Cada função devolve `{ subject, preheader, html, text }`, pronto
 * para `sendMail` (mailer.ts — que só usa subject/html/text). O HTML vem do layout base
 * (`layout.ts`); o `text` é a versão texto puro, revisada e legível por si só.
 *
 * `ctx` (opcional) traz a URL pública (logo/links do rodapé) e os dados jurídicos da operadora —
 * resolvido por quem envia via `loadEmailContext()`. Sem ele o e-mail sai igual, só sem imagem.
 * Todo dado dinâmico é escapado no layout; URLs são geradas pelo próprio código.
 */
import { button, factsCard, fallbackLink, heading, innoSays, invoiceCard, note, paragraph, pixBlock, renderEmailHtml, renderEmailText, type EmailContext } from "./layout";

export type { EmailContext } from "./layout";

type Built = { subject: string; preheader: string; html: string; text: string };

/** Assunto numa linha só: nome de empresa/motivo vindo do usuário nunca injeta cabeçalho (CR/LF) nem controle. */
export function sanitizeSubject(subject: string): string {
  return subject.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 200);
}

function build(params: { subject: string; preheader: string; rows: string; text: string; footerReason: string; ctx?: EmailContext }): Built {
  return {
    subject: sanitizeSubject(params.subject),
    preheader: params.preheader,
    html: renderEmailHtml({ title: params.subject, preheader: params.preheader, contentRows: params.rows, footerReason: params.footerReason, ctx: params.ctx }),
    text: renderEmailText({ body: params.text, footerReason: params.footerReason, ctx: params.ctx }),
  };
}

export function verificationEmail(params: { verifyUrl: string; ctx?: EmailContext }): Built {
  const footerReason = "Você recebeu este e-mail porque este endereço foi usado para criar uma conta no InnoChat. Se não foi você, pode ignorar.";
  return build({
    subject: "Confirme seu e-mail no InnoChat",
    preheader: "Um clique e sua conta está ativa.",
    rows: [
      heading("Confirme seu e-mail"),
      paragraph("Oi! Falta confirmar seu e-mail para ativar sua conta no InnoChat e conectar o WhatsApp."),
      button(params.verifyUrl, "Confirmar meu e-mail"),
      innoSays("Oi, eu sou o Inno! Quando você confirmar, eu te ajudo a colocar o atendimento no ar.", params.ctx ?? {}),
      fallbackLink(params.verifyUrl),
      note("Não fez esse cadastro? Pode ignorar este e-mail."),
    ].join("\n"),
    text: `Oi!\n\nFalta confirmar seu e-mail para ativar sua conta no InnoChat e conectar o WhatsApp:\n\n${params.verifyUrl}\n\nNão fez esse cadastro? Pode ignorar este e-mail.`,
    footerReason,
    ctx: params.ctx,
  });
}

export function passwordResetEmail(params: { resetUrl: string; ctx?: EmailContext }): Built {
  const footerReason = "Você recebeu este e-mail porque foi pedida a redefinição de senha da conta associada a este endereço no InnoChat.";
  return build({
    subject: "Redefinir sua senha no InnoChat",
    preheader: "O link para criar uma nova senha vale por 1 hora.",
    rows: [
      heading("Redefinir sua senha"),
      paragraph("Recebemos um pedido para redefinir sua senha no InnoChat. Use o botão abaixo para criar uma nova. O link vale por 1 hora."),
      button(params.resetUrl, "Criar nova senha"),
      fallbackLink(params.resetUrl),
      note("Não pediu isso? Pode ignorar este e-mail. Sua senha continua a mesma."),
    ].join("\n"),
    text: `Recebemos um pedido para redefinir sua senha no InnoChat.\n\nPara criar uma nova senha, use o link abaixo (vale por 1 hora):\n\n${params.resetUrl}\n\nNão pediu isso? Pode ignorar este e-mail. Sua senha continua a mesma.`,
    footerReason,
    ctx: params.ctx,
  });
}

export function teamInviteEmail(params: { tenantName: string; inviteUrl: string; ctx?: EmailContext }): Built {
  const footerReason = `Você recebeu este e-mail porque alguém convidou este endereço para a equipe de "${params.tenantName}" no InnoChat. Se não esperava o convite, pode ignorar.`;
  return build({
    subject: `Convite para a equipe de ${params.tenantName} no InnoChat`,
    preheader: `O convite para a equipe de ${params.tenantName} vale por 7 dias.`,
    rows: [
      heading("Você foi convidado"),
      paragraph(`Você foi convidado para a equipe de "${params.tenantName}" no InnoChat. Aceite o convite para criar sua senha e começar. Ele vale por 7 dias.`),
      button(params.inviteUrl, "Aceitar convite"),
      innoSays("Vou ficar por aqui ajudando a equipe com o atendimento e a agenda.", params.ctx ?? {}),
      fallbackLink(params.inviteUrl),
    ].join("\n"),
    text: `Você foi convidado para a equipe de "${params.tenantName}" no InnoChat.\n\nAceite o convite (vale por 7 dias):\n\n${params.inviteUrl}`,
    footerReason,
    ctx: params.ctx,
  });
}

const BILLING_REASON = (tenantName: string) => `Você recebeu este e-mail porque é o responsável pela assinatura de "${tenantName}" no InnoChat.`;

export function invoiceGeneratedEmail(params: {
  tenantName: string;
  amountReais: string;
  dueDateBr: string;
  /** `null` quando o Pix ainda não foi gerado: o e-mail manda a pessoa para a tela de Assinatura. */
  pixCopyPaste: string | null;
  billingUrl: string;
  ctx?: EmailContext;
}): Built {
  const pix = params.pixCopyPaste?.trim() || null;
  return build({
    subject: `Fatura do InnoChat (${params.tenantName})`,
    preheader: `${params.amountReais} com vencimento em ${params.dueDateBr}. Dá pra pagar com Pix.`,
    rows: [
      heading("Sua fatura chegou"),
      paragraph(pix ? "Pague com Pix e a confirmação é automática." : "Abra a tela de Assinatura para gerar o Pix e pagar."),
      invoiceCard({ tenantName: params.tenantName, amount: params.amountReais, dateLabel: "Vencimento", dateValue: params.dueDateBr }),
      pix ? pixBlock(pix) : "",
      button(params.billingUrl, pix ? "Ver QR code e detalhes" : "Ver fatura e pagar"),
      fallbackLink(params.billingUrl),
    ].join("\n"),
    text: pix
      ? `Sua fatura de ${params.amountReais} chegou e vence em ${params.dueDateBr}.\n\nPara pagar com Pix, copie o código abaixo e cole no app do seu banco:\n\n${pix}\n\nO QR code está na tela de Assinatura:\n${params.billingUrl}`
      : `Sua fatura de ${params.amountReais} chegou e vence em ${params.dueDateBr}.\n\nAbra a tela de Assinatura para gerar o Pix e pagar:\n${params.billingUrl}`,
    footerReason: BILLING_REASON(params.tenantName),
    ctx: params.ctx,
  });
}

export function invoiceDueReminderEmail(params: { tenantName: string; amountReais: string; dueDateBr: string; billingUrl: string; dueToday: boolean; ctx?: EmailContext }): Built {
  const when = params.dueToday ? "vence hoje" : "vence amanhã";
  return build({
    subject: `Sua fatura do InnoChat ${when} (${params.tenantName})`,
    preheader: `Pague pela tela de Assinatura para o atendimento por WhatsApp não ser suspenso.`,
    rows: [
      heading(params.dueToday ? "Sua fatura vence hoje" : "Sua fatura vence amanhã"),
      paragraph("Pague com Pix pela tela de Assinatura para o atendimento por WhatsApp não ser suspenso."),
      invoiceCard({ tenantName: params.tenantName, amount: params.amountReais, dateLabel: "Vencimento", dateValue: params.dueDateBr }),
      button(params.billingUrl, "Pagar com Pix"),
      fallbackLink(params.billingUrl),
    ].join("\n"),
    text: `Sua fatura de ${params.amountReais} ${when} (${params.dueDateBr}).\n\nPague com Pix pela tela de Assinatura para o atendimento por WhatsApp não ser suspenso:\n${params.billingUrl}`,
    footerReason: BILLING_REASON(params.tenantName),
    ctx: params.ctx,
  });
}

export function subscriptionSuspendedEmail(params: { tenantName: string; billingUrl: string; trialNotConverted?: boolean; cancelInDays?: number; ctx?: EmailContext }): Built {
  if (params.trialNotConverted) {
    const cancelNote = params.cancelInDays ? `Se a assinatura não for feita, a conta será encerrada em ${params.cancelInDays} dias.` : "";
    return build({
      subject: `Seu teste terminou (${params.tenantName})`,
      preheader: "O atendimento automático foi pausado. Assine para voltar a usar.",
      rows: [
        heading("Seu período de teste terminou"),
        paragraph(`O período de teste de "${params.tenantName}" terminou e o atendimento automático por WhatsApp foi pausado.`),
        paragraph("O painel continua acessível só para leitura (agenda e clientes). Assine para continuar usando o InnoChat."),
        button(params.billingUrl, "Assinar agora"),
        fallbackLink(params.billingUrl),
        cancelNote ? note(cancelNote) : "",
      ].join("\n"),
      text: `O período de teste de "${params.tenantName}" terminou e o atendimento automático por WhatsApp foi pausado.\n\nO painel continua acessível só para leitura (agenda e clientes). Assine para continuar usando o InnoChat:\n${params.billingUrl}${cancelNote ? `\n\n${cancelNote}` : ""}`,
      footerReason: BILLING_REASON(params.tenantName),
      ctx: params.ctx,
    });
  }
  return build({
    subject: `Atendimento por WhatsApp suspenso (${params.tenantName})`,
    preheader: "Pague a fatura em aberto e o atendimento volta.",
    rows: [
      heading("Atendimento por WhatsApp suspenso"),
      paragraph(`O atendimento automático por WhatsApp de "${params.tenantName}" foi suspenso por falta de pagamento.`),
      paragraph("O painel continua acessível só para leitura (agenda e clientes). Pague a fatura em aberto e o atendimento volta."),
      button(params.billingUrl, "Pagar fatura em aberto"),
      fallbackLink(params.billingUrl),
    ].join("\n"),
    text: `O atendimento automático por WhatsApp de "${params.tenantName}" foi suspenso por falta de pagamento.\n\nO painel continua acessível só para leitura (agenda e clientes). Pague a fatura em aberto e o atendimento volta:\n${params.billingUrl}`,
    footerReason: BILLING_REASON(params.tenantName),
    ctx: params.ctx,
  });
}

/** Recibo: enviado uma única vez, na primeira baixa da fatura (`applyInvoicePayment`). */
export function paymentConfirmedEmail(params: { tenantName: string; amountReais: string; paidDateBr: string; activeUntilBr: string; billingUrl: string; ctx?: EmailContext }): Built {
  return build({
    subject: `Pagamento confirmado (${params.tenantName})`,
    preheader: `Recebemos ${params.amountReais}. Sua assinatura vai até ${params.activeUntilBr}.`,
    rows: [
      heading("Pagamento confirmado"),
      paragraph(`Recebemos seu pagamento. Sua assinatura está ativa até ${params.activeUntilBr}. Obrigado!`),
      factsCard([
        { label: "Empresa", value: params.tenantName },
        { label: "Valor pago", value: params.amountReais, strong: true },
        { label: "Pago em", value: params.paidDateBr },
        { label: "Ativa até", value: params.activeUntilBr },
      ]),
      innoSays("Tudo certo por aqui. Seu atendimento continua funcionando normalmente.", params.ctx ?? {}),
      button(params.billingUrl, "Ver minha assinatura"),
      fallbackLink(params.billingUrl),
    ].join("\n"),
    text: `Pagamento confirmado. Sua assinatura está ativa até ${params.activeUntilBr}.\n\nEmpresa: ${params.tenantName}\nValor pago: ${params.amountReais}\nPago em: ${params.paidDateBr}\nAtiva até: ${params.activeUntilBr}\n\nObrigado! Os detalhes estão na tela de Assinatura:\n${params.billingUrl}`,
    footerReason: BILLING_REASON(params.tenantName),
    ctx: params.ctx,
  });
}

/**
 * Confirmação de cancelamento pelo painel (OWNER). `immediate` = suspensa/atrasada: o acesso já
 * terminou; senão, `endsAtBr` é a data em que termina (fim do período já pago).
 */
function automaticCancelEmail(
  params: { tenantName: string; retentionDays: number; billingUrl: string; ctx?: EmailContext },
  auto: { unpaidDays: number; trialNotConverted: boolean; retentionUntilBr: string },
): Built {
  const why = auto.trialNotConverted
    ? `porque o teste terminou e a assinatura não foi paga em ${auto.unpaidDays} dias`
    : `porque a fatura ficou ${auto.unpaidDays} dias sem pagamento`;
  const lead = `A conta de "${params.tenantName}" foi encerrada ${why}. O bot parou de responder e os números de WhatsApp foram desconectados.`;
  const keep = `Seus dados ficam guardados por ${params.retentionDays} dias, até ${auto.retentionUntilBr}. Agenda, serviços e clientes continuam como estavam. Depois dessa data, os dados dos seus clientes são anonimizados.`;
  const csv = "Quer guardar a lista de clientes? Reative a assinatura e exporte o CSV pela tela Clientes.";
  const undo = "Para voltar, reative a assinatura na tela Assinatura e pague o Pix. Depois é só reconectar o número de WhatsApp lendo o QR code.";
  return build({
    subject: `Sua conta no InnoChat foi encerrada (${params.tenantName})`,
    preheader: `Seus dados ficam guardados até ${auto.retentionUntilBr}. Dá pra reativar a qualquer momento.`,
    rows: [
      heading("Conta encerrada"),
      paragraph(lead),
      factsCard([
        { label: "Empresa", value: params.tenantName },
        { label: "Dados guardados até", value: auto.retentionUntilBr, strong: true },
      ]),
      paragraph(keep),
      paragraph(csv),
      note(undo),
      button(params.billingUrl, "Reativar minha assinatura"),
      fallbackLink(params.billingUrl),
    ].join("\n"),
    text: `${lead}\n\n${keep}\n\n${csv}\n\n${undo}\n${params.billingUrl}`,
    footerReason: BILLING_REASON(params.tenantName),
    ctx: params.ctx,
  });
}

export function subscriptionCancelEmail(params: {
  tenantName: string;
  immediate: boolean;
  endsAtBr: string;
  retentionDays: number;
  clientsUrl: string;
  billingUrl: string;
  /**
   * Cancelamento AUTOMÁTICO (fatura sem pagamento por 60 dias, ou 7 no teste): troca o texto de
   * "você cancelou" por "a conta foi encerrada porque...", com prazo de guarda dos dados e o caminho
   * para reativar. Só faz sentido com `immediate: true`.
   */
  automatic?: { unpaidDays: number; trialNotConverted: boolean; retentionUntilBr: string };
  ctx?: EmailContext;
}): Built {
  if (params.automatic) return automaticCancelEmail(params, params.automatic);
  const lead = params.immediate
    ? `A assinatura de "${params.tenantName}" foi cancelada e o acesso ao painel foi encerrado. Os números de WhatsApp foram desconectados.`
    : `Recebemos o pedido de cancelamento da assinatura de "${params.tenantName}". Você continua usando tudo normalmente até ${params.endsAtBr}. Depois disso, os números de WhatsApp são desconectados e o painel mostra só a tela de Assinatura. Não haverá nova cobrança.`;
  const keep = `Seus dados ficam guardados por ${params.retentionDays} dias após o cancelamento. Depois disso, os dados dos seus clientes são anonimizados.`;
  const csv = params.immediate
    ? ""
    : "Antes dessa data, exporte a lista dos seus clientes (CSV) pela tela de Clientes.";
  const undo = params.immediate ? "Para voltar a usar o InnoChat, reative a assinatura na tela de Assinatura." : "Mudou de ideia? Dá pra desfazer o cancelamento na tela de Assinatura até essa data.";
  const url = params.immediate ? params.billingUrl : params.clientsUrl;
  const cta = params.immediate ? "Reativar minha assinatura" : "Exportar meus clientes (CSV)";
  const subject = params.immediate ? `Assinatura cancelada (${params.tenantName})` : `Cancelamento agendado para ${params.endsAtBr} (${params.tenantName})`;
  return build({
    subject,
    preheader: params.immediate ? "Sua assinatura foi cancelada." : `Seu acesso vai até ${params.endsAtBr}. Exporte a lista de clientes antes.`,
    rows: [
      heading(params.immediate ? "Assinatura cancelada" : "Cancelamento agendado"),
      paragraph(lead),
      ...(params.immediate ? [] : [factsCard([{ label: "Empresa", value: params.tenantName }, { label: "Acesso até", value: params.endsAtBr, strong: true }])]),
      paragraph(keep),
      csv ? paragraph(csv) : "",
      note(undo),
      button(url, cta),
      fallbackLink(url),
    ].join("\n"),
    text: `${lead}\n\n${keep}${csv ? `\n\n${csv}\nClientes: ${params.clientsUrl}` : ""}\n\n${undo}\n${params.billingUrl}`,
    footerReason: BILLING_REASON(params.tenantName),
    ctx: params.ctx,
  });
}
