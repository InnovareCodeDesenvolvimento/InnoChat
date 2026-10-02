import type { DunningStep } from "./dunning-policy";

/**
 * Rótulos em português para o Admin (registro de envios e linha do tempo da empresa). Puro. Texto que o ADMIN lê:
 * nada aqui vai para o cliente final. Valor desconhecido devolve o próprio código (nunca lança, nunca inventa).
 */

export const STEP_LABELS: Record<DunningStep, string> = {
  INVOICE_CREATED: "Fatura gerada",
  DUE_D3: "Lembrete de 3 dias antes do vencimento",
  DUE_D1: "Lembrete da véspera",
  DUE_D0: "Aviso de vencimento hoje",
  GRACE_D1: "Fatura vencida (1º dia de atraso)",
  GRACE_D2: "Fatura vencida (2º dia de atraso)",
  GRACE_LAST: "Último dia antes da suspensão",
  SUSPENDED: "Aviso de suspensão",
  SUSP_3: "Conta suspensa há 3 dias",
  SUSP_7: "Conta suspensa há 7 dias",
  SUSP_15: "Conta suspensa há 15 dias",
  SUSP_30: "Conta suspensa há 30 dias",
  SUSP_45: "Conta suspensa há 45 dias",
  CANCEL_WARN_7: "Aviso de cancelamento (faltam 7 dias)",
  CANCEL_WARN_1: "Aviso de cancelamento (falta 1 dia)",
  AUTO_CANCELED: "Conta cancelada automaticamente",
  TRIAL_DAY1: "Teste grátis: 1º dia",
  TRIAL_T1: "Teste grátis termina amanhã",
  TRIAL_T0: "Teste grátis termina hoje",
  TRIAL_SUSP_3: "Teste vencido há 3 dias",
  TRIAL_CANCEL_WARN: "Aviso de cancelamento do teste",
  PAYMENT_CONFIRMED: "Pagamento confirmado (recibo)",
};

export function stepLabel(step: string): string {
  return (STEP_LABELS as Record<string, string>)[step] ?? step;
}

export const NOTICE_STATUS_LABELS: Record<string, string> = {
  PENDING: "Na fila",
  SENDING: "Enviando",
  SENT: "Enviado",
  FAILED: "Falhou",
  SKIPPED: "Não enviado",
};

export function noticeStatusLabel(status: string): string {
  return NOTICE_STATUS_LABELS[status] ?? status;
}

export const SKIPPED_REASON_LABELS: Record<string, string> = {
  PAID: "Já estava pago",
  STATUS_CHANGED: "A situação da assinatura mudou antes do envio",
  NO_RECIPIENT: "Sem destinatário cadastrado",
  OPTED_OUT: "O cliente pediu para não receber no WhatsApp",
  NO_PLATFORM_NUMBER: "Sem número de WhatsApp da plataforma conectado",
  CHANNEL_DOWN: "WhatsApp da plataforma fora do ar",
  OUT_OF_WINDOW_EXPIRED: "O prazo acabou antes de abrir a janela de horário",
  PERMANENT_REJECTION: "O destino recusou o envio de forma definitiva",
  BLOCKED_LOOP: "Bloqueado para não conversar com outro robô",
  MANUAL_SUSPENSION: "Suspensa manualmente (não é atraso)",
  UNCONFIRMED_DAILY_LIMIT: "Limite de 1 mensagem por dia para contato não confirmado",
  LEGACY_SENT: "Enviado antes da régua atual",
};

export function skippedReasonLabel(reason: string): string {
  return SKIPPED_REASON_LABELS[reason] ?? reason;
}

export const NOTICE_ERROR_LABELS: Record<string, string> = {
  EMAIL_NOT_SENT: "O servidor de e-mail não aceitou o envio",
  WHATSAPP_SEND_FAILED: "O WhatsApp não conseguiu enviar",
  UNEXPECTED_ERROR: "Erro inesperado no envio",
  STUCK_MAX_ATTEMPTS: "O envio travou e esgotou as tentativas",
};

export function noticeErrorLabel(code: string): string {
  return NOTICE_ERROR_LABELS[code] ?? code;
}

export const CHANNEL_LABELS: Record<string, string> = { EMAIL: "e-mail", WHATSAPP: "WhatsApp" };

export function channelLabel(channel: string): string {
  return CHANNEL_LABELS[channel] ?? channel;
}

/** Frase da linha do tempo para um aviso: "Lembrete da véspera enviado por WhatsApp". */
export function noticeTimelineLabel(step: string, channel: string, status: string, skippedReason?: string | null): string {
  const base = stepLabel(step);
  const via = channelLabel(channel);
  switch (status) {
    case "SENT":
      return `${base} enviado por ${via}`;
    case "FAILED":
      return `${base}: falha no envio por ${via}`;
    case "SKIPPED":
      return `${base} por ${via} não foi enviado${skippedReason ? ` (${skippedReasonLabel(skippedReason).toLowerCase()})` : ""}`;
    case "SENDING":
      return `${base} sendo enviado por ${via}`;
    default:
      return `${base} na fila para ${via}`;
  }
}

/** Frase da linha do tempo para um evento de assinatura/cobrança. */
export function billingEventLabel(type: string, ctx: { from?: string | null; to?: string | null; actor: string }): string {
  const status = (s?: string | null) => (s ? (STATUS_LABELS[s] ?? s) : "—");
  switch (type) {
    case "STATUS_CHANGED":
      return `Situação mudou de ${status(ctx.from)} para ${status(ctx.to)}`;
    case "INVOICE_CREATED":
      return "Fatura gerada";
    case "PAYMENT_CONFIRMED":
      return ctx.from === "PAST_DUE" || ctx.from === "SUSPENDED" ? "Pagamento confirmado (conta recuperada)" : "Pagamento confirmado";
    case "CANCELED":
      return "Assinatura cancelada";
    case "PIX_REGENERATED":
      return "Pix gerado de novo";
    case "PLAN_CHANGED":
      return "Plano alterado";
    case "CANCEL_REQUESTED":
      return "Cancelamento agendado pelo dono";
    case "CANCEL_UNDONE":
      return "Cancelamento desfeito";
    case "REACTIVATION_STARTED":
      return "Reativação iniciada";
    case "MANUAL_PAYMENT":
      return "Pagamento baixado manualmente pelo admin";
    case "MANUAL_SUSPEND":
      return "Suspensa manualmente pelo admin";
    case "MANUAL_REACTIVATE":
      return "Reativada manualmente pelo admin";
    case "TRIAL_EXTENDED":
      return "Teste grátis estendido pelo admin";
    default:
      return type;
  }
}

const STATUS_LABELS: Record<string, string> = {
  TRIALING: "Em teste",
  ACTIVE: "Ativa",
  PAST_DUE: "Em atraso",
  SUSPENDED: "Suspensa",
  CANCELED: "Cancelada",
};

export function subscriptionStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}
