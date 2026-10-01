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
  const footerReason = "Você recebeu este e-mail porque este endereço foi usado para criar uma conta no InnoChat. Se não foi você, é só ignorar esta mensagem.";
  return build({
    subject: "Confirme seu e-mail — InnoChat",
    preheader: "Falta só um clique para ativar sua conta e conectar seu WhatsApp.",
    rows: [
      heading("Confirme seu e-mail"),
      paragraph("Olá! Para ativar sua conta no InnoChat e poder conectar seu WhatsApp, confirme seu e-mail."),
      button(params.verifyUrl, "Confirmar meu e-mail"),
      innoSays("Oi, eu sou o Inno! Assim que você confirmar, eu te ajudo a colocar o atendimento no ar em poucos minutos.", params.ctx ?? {}),
      fallbackLink(params.verifyUrl),
      note("Se você não fez este cadastro, ignore esta mensagem."),
    ].join("\n"),
    text: `Olá!\n\nPara ativar sua conta no InnoChat e poder conectar seu WhatsApp, confirme seu e-mail:\n\n${params.verifyUrl}\n\nSe você não fez este cadastro, ignore esta mensagem.`,
    footerReason,
    ctx: params.ctx,
  });
}

export function passwordResetEmail(params: { resetUrl: string; ctx?: EmailContext }): Built {
  const footerReason = "Você recebeu este e-mail porque foi pedida a redefinição de senha da conta associada a este endereço no InnoChat.";
  return build({
    subject: "Redefinir sua senha — InnoChat",
    preheader: "Crie uma nova senha — o link vale por 1 hora.",
    rows: [
      heading("Redefinir sua senha"),
      paragraph("Recebemos um pedido para redefinir sua senha no InnoChat. Clique no botão abaixo para criar uma nova senha. O link é válido por 1 hora."),
      button(params.resetUrl, "Criar nova senha"),
      fallbackLink(params.resetUrl),
      note("Se você não pediu isso, ignore esta mensagem — sua senha continua a mesma."),
    ].join("\n"),
    text: `Recebemos um pedido para redefinir sua senha no InnoChat.\n\nClique no link abaixo para criar uma nova senha (válido por 1 hora):\n\n${params.resetUrl}\n\nSe você não pediu isso, ignore esta mensagem — sua senha continua a mesma.`,
    footerReason,
    ctx: params.ctx,
  });
}

export function teamInviteEmail(params: { tenantName: string; inviteUrl: string; ctx?: EmailContext }): Built {
  const footerReason = `Você recebeu este e-mail porque alguém convidou este endereço para a equipe de "${params.tenantName}" no InnoChat. Se você não esperava o convite, pode ignorá-lo.`;
  return build({
    subject: `Convite para ${params.tenantName} — InnoChat`,
    preheader: `Você foi convidado para a equipe de ${params.tenantName}. O convite vale por 7 dias.`,
    rows: [
      heading("Você foi convidado"),
      paragraph(`Você foi convidado para fazer parte da equipe de "${params.tenantName}" no InnoChat. Aceite o convite para criar sua senha e começar. Ele é válido por 7 dias.`),
      button(params.inviteUrl, "Aceitar convite"),
      innoSays("Vou estar por aqui para ajudar a equipe com o atendimento e a agenda.", params.ctx ?? {}),
      fallbackLink(params.inviteUrl),
    ].join("\n"),
    text: `Você foi convidado para fazer parte da equipe de "${params.tenantName}" no InnoChat.\n\nAceite o convite (válido por 7 dias):\n\n${params.inviteUrl}`,
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
    subject: `Fatura disponível — ${params.tenantName}`,
    preheader: `Sua fatura de ${params.amountReais} vence em ${params.dueDateBr}. Pague com Pix em poucos segundos.`,
    rows: [
      heading("Sua fatura está disponível"),
      paragraph(pix ? "Pague com Pix agora: é rápido e a confirmação é automática." : "Acesse a tela de Assinatura para gerar o Pix e pagar em poucos segundos."),
      invoiceCard({ tenantName: params.tenantName, amount: params.amountReais, dateLabel: "Vencimento", dateValue: params.dueDateBr }),
      pix ? pixBlock(pix) : "",
      button(params.billingUrl, pix ? "Ver QR code e detalhes" : "Ver fatura e pagar"),
      fallbackLink(params.billingUrl),
    ].join("\n"),
    text: pix
      ? `Sua fatura de ${params.amountReais} está disponível, com vencimento em ${params.dueDateBr}.\n\nPague com Pix (copie e cole no app do seu banco):\n\n${pix}\n\nOu acesse a tela de Assinatura para ver o QR code:\n${params.billingUrl}`
      : `Sua fatura de ${params.amountReais} está disponível, com vencimento em ${params.dueDateBr}.\n\nAcesse a tela de Assinatura para gerar o Pix e pagar:\n${params.billingUrl}`,
    footerReason: BILLING_REASON(params.tenantName),
    ctx: params.ctx,
  });
}

export function invoiceDueReminderEmail(params: { tenantName: string; amountReais: string; dueDateBr: string; billingUrl: string; dueToday: boolean; ctx?: EmailContext }): Built {
  const when = params.dueToday ? "vence hoje" : "vence amanhã";
  return build({
    subject: `Sua fatura ${when} — ${params.tenantName}`,
    preheader: `Pague com Pix pela tela de Assinatura e evite a suspensão do atendimento por WhatsApp.`,
    rows: [
      heading(params.dueToday ? "Sua fatura vence hoje" : "Sua fatura vence amanhã"),
      paragraph("Pague com Pix pela tela de Assinatura para evitar a suspensão do atendimento por WhatsApp."),
      invoiceCard({ tenantName: params.tenantName, amount: params.amountReais, dateLabel: "Vencimento", dateValue: params.dueDateBr }),
      button(params.billingUrl, "Pagar com Pix"),
      fallbackLink(params.billingUrl),
    ].join("\n"),
    text: `Sua fatura de ${params.amountReais} ${when} (${params.dueDateBr}).\n\nPague com Pix pela tela de Assinatura para evitar a suspensão do atendimento por WhatsApp:\n${params.billingUrl}`,
    footerReason: BILLING_REASON(params.tenantName),
    ctx: params.ctx,
  });
}

export function subscriptionSuspendedEmail(params: { tenantName: string; billingUrl: string; trialNotConverted?: boolean; cancelInDays?: number; ctx?: EmailContext }): Built {
  if (params.trialNotConverted) {
    const cancelNote = params.cancelInDays ? `Se a assinatura não for feita, a conta será encerrada em ${params.cancelInDays} dias.` : "";
    return build({
      subject: `Seu teste terminou — ${params.tenantName}`,
      preheader: "O atendimento automático foi pausado. Assine para continuar usando o InnoChat.",
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
    subject: `Atendimento por WhatsApp suspenso — ${params.tenantName}`,
    preheader: "Pague a fatura em aberto para reativar o atendimento.",
    rows: [
      heading("Atendimento por WhatsApp suspenso"),
      paragraph(`O atendimento automático por WhatsApp de "${params.tenantName}" foi suspenso por falta de pagamento.`),
      paragraph("O painel continua acessível só para leitura (agenda e clientes). Pague a fatura em aberto para reativar o atendimento."),
      button(params.billingUrl, "Pagar fatura em aberto"),
      fallbackLink(params.billingUrl),
    ].join("\n"),
    text: `O atendimento automático por WhatsApp de "${params.tenantName}" foi suspenso por falta de pagamento.\n\nO painel continua acessível só para leitura (agenda e clientes). Pague a fatura em aberto para reativar o atendimento:\n${params.billingUrl}`,
    footerReason: BILLING_REASON(params.tenantName),
    ctx: params.ctx,
  });
}

/** Recibo: enviado uma única vez, na primeira baixa da fatura (`applyInvoicePayment`). */
export function paymentConfirmedEmail(params: { tenantName: string; amountReais: string; paidDateBr: string; activeUntilBr: string; billingUrl: string; ctx?: EmailContext }): Built {
  return build({
    subject: `Pagamento confirmado — ${params.tenantName}`,
    preheader: `Recebemos ${params.amountReais}. Sua assinatura está ativa até ${params.activeUntilBr}.`,
    rows: [
      heading("Pagamento confirmado"),
      paragraph(`Recebemos seu pagamento e sua assinatura está ativa até ${params.activeUntilBr}. Obrigado por confiar no InnoChat!`),
      factsCard([
        { label: "Empresa", value: params.tenantName },
        { label: "Valor pago", value: params.amountReais, strong: true },
        { label: "Pago em", value: params.paidDateBr },
        { label: "Ativa até", value: params.activeUntilBr },
      ]),
      innoSays("Tudo certo por aqui! Seu atendimento segue funcionando normalmente.", params.ctx ?? {}),
      button(params.billingUrl, "Ver minha assinatura"),
      fallbackLink(params.billingUrl),
    ].join("\n"),
    text: `Pagamento confirmado — sua assinatura está ativa até ${params.activeUntilBr}.\n\nEmpresa: ${params.tenantName}\nValor pago: ${params.amountReais}\nPago em: ${params.paidDateBr}\nAtiva até: ${params.activeUntilBr}\n\nObrigado por confiar no InnoChat! Veja os detalhes na tela de Assinatura:\n${params.billingUrl}`,
    footerReason: BILLING_REASON(params.tenantName),
    ctx: params.ctx,
  });
}

/**
 * Confirmação de cancelamento pelo painel (OWNER). `immediate` = suspensa/atrasada: o acesso já
 * terminou; senão, `endsAtBr` é a data em que termina (fim do período já pago).
 */
export function subscriptionCancelEmail(params: {
  tenantName: string;
  immediate: boolean;
  endsAtBr: string;
  retentionDays: number;
  clientsUrl: string;
  billingUrl: string;
  ctx?: EmailContext;
}): Built {
  const lead = params.immediate
    ? `A assinatura de "${params.tenantName}" foi cancelada e o acesso ao painel foi encerrado. Os números de WhatsApp foram desconectados.`
    : `Recebemos o pedido de cancelamento da assinatura de "${params.tenantName}". Você continua usando tudo normalmente até ${params.endsAtBr}; depois disso, os números de WhatsApp são desconectados e o painel mostra só a tela de Assinatura. Não haverá nova cobrança.`;
  const keep = `Seus dados ficam guardados por ${params.retentionDays} dias após o cancelamento. Depois disso, os dados dos seus clientes são anonimizados.`;
  const csv = params.immediate
    ? ""
    : "Antes de a data chegar, recomendamos exportar a lista dos seus clientes (CSV) pela tela de Clientes.";
  const undo = params.immediate ? "Para voltar a usar o InnoChat, reative a assinatura pela tela de Assinatura." : "Mudou de ideia? Você pode desfazer o cancelamento na tela de Assinatura até essa data.";
  const url = params.immediate ? params.billingUrl : params.clientsUrl;
  const cta = params.immediate ? "Reativar minha assinatura" : "Exportar meus clientes (CSV)";
  const subject = params.immediate ? `Assinatura cancelada — ${params.tenantName}` : `Cancelamento agendado para ${params.endsAtBr} — ${params.tenantName}`;
  return build({
    subject,
    preheader: params.immediate ? "Sua assinatura foi cancelada." : `Seu acesso vai até ${params.endsAtBr}. Exporte seus clientes antes.`,
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
