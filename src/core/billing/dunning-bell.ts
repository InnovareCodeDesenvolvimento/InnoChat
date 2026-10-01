import type { DunningStep } from "./dunning-policy";

/**
 * Texto do sino do painel (docs/regua-de-cobranca.md §2.2 coluna S e §2.3) para cada etapa da régua. Puro. O sino
 * mostra UMA etapa por vez (a mais recente que já chegou); o id muda a cada etapa, então cada passo da régua volta
 * como não lido. Sem números de uso do teste: o sino é consultado a cada 30 s e não pode fazer consulta pesada.
 */

export type BillingBellKind =
  | "INVOICE_OPEN"
  | "INVOICE_DUE"
  | "INVOICE_OVERDUE"
  | "SUBSCRIPTION_SUSPENDED"
  | "CANCEL_WARNING"
  | "TRIAL_ENDING"
  | "TRIAL_PROGRESS";

export type BillingBellSeverity = "info" | "warning" | "danger";

export type BillingBellData = {
  /** "R$ 49,90". */
  amount: string;
  dueDate: string;
  /** Último dia em que o bot ainda atende na carência. */
  lastServiceDate: string;
  daysSuspended: number;
  daysToCancel: number;
  cancelDate: string;
  trialEndsDate: string;
  trialEndsTime: string;
  /** Conta que nunca pagou (teste não convertido). */
  trialNotConverted: boolean;
};

export type BillingBellText = { kind: BillingBellKind; severity: BillingBellSeverity; title: string; body: string };

function days(n: number): string {
  return n === 1 ? "1 dia" : `${n} dias`;
}

/** Texto do sino da etapa, ou `null` se a etapa não aparece no sino (AUTO_CANCELED, PAYMENT_CONFIRMED tem fluxo próprio). */
export function describeBellStep(step: DunningStep, d: BillingBellData): BillingBellText | null {
  switch (step) {
    case "INVOICE_CREATED":
      return { kind: "INVOICE_OPEN", severity: "info", title: "Fatura disponível", body: `${d.amount}, vence em ${d.dueDate}. Dá pra pagar com Pix pelo painel.` };
    case "DUE_D3":
      return { kind: "INVOICE_OPEN", severity: "info", title: "Sua fatura vence em 3 dias", body: `${d.amount} até ${d.dueDate}. O bot continua atendendo normalmente.` };
    case "DUE_D1":
      return { kind: "INVOICE_DUE", severity: "warning", title: "Sua fatura vence amanhã", body: `${d.amount} até ${d.dueDate}. Pague com Pix pelo painel.` };
    case "DUE_D0":
      return { kind: "INVOICE_DUE", severity: "warning", title: "Sua fatura vence hoje", body: `Pague ${d.amount} até as 23h59 para o bot seguir atendendo.` };
    case "GRACE_D1":
    case "GRACE_D2":
      return {
        kind: "INVOICE_OVERDUE",
        severity: "danger",
        title: "Fatura vencida",
        body: `O bot continua atendendo até o fim do dia ${d.lastServiceDate}. Pague ${d.amount} com Pix para ele não parar.`,
      };
    case "GRACE_LAST":
      return {
        kind: "INVOICE_OVERDUE",
        severity: "danger",
        title: "Último dia para pagar",
        body: `Se a fatura de ${d.amount} não for paga até a meia-noite, o bot para de responder amanhã.`,
      };
    case "SUSPENDED":
      return d.trialNotConverted
        ? { kind: "SUBSCRIPTION_SUSPENDED", severity: "danger", title: "Seu teste terminou", body: `O bot está parado. Assine com Pix para ele voltar. A conta de teste é encerrada em ${d.cancelDate}.` }
        : {
            kind: "SUBSCRIPTION_SUSPENDED",
            severity: "danger",
            title: "Bot pausado por falta de pagamento",
            body: `Pague ${d.amount} e ele volta. Se a fatura continuar em aberto, a conta é encerrada em ${d.cancelDate}.`,
          };
    case "SUSP_3":
    case "SUSP_7":
    case "SUSP_15":
    case "SUSP_30":
    case "SUSP_45":
      return {
        kind: "SUBSCRIPTION_SUSPENDED",
        severity: "danger",
        title: `Bot parado há ${days(d.daysSuspended)}`,
        body: `Sua agenda e seus clientes continuam guardados. Pague ${d.amount} para o bot voltar.`,
      };
    case "CANCEL_WARN_7":
    case "CANCEL_WARN_1":
      return {
        kind: "CANCEL_WARNING",
        severity: "danger",
        title: d.daysToCancel === 1 ? "Sua conta será encerrada amanhã" : `Sua conta será encerrada em ${days(d.daysToCancel)}`,
        body: `Pague ${d.amount} até ${d.cancelDate} para manter a conta e os números conectados.`,
      };
    case "TRIAL_DAY1":
      return {
        kind: "TRIAL_PROGRESS",
        severity: "info",
        title: "Primeiro dia de teste concluído",
        body: `Veja o que o Inno já fez e o que ainda falta ligar. O teste vai até ${d.trialEndsDate}, às ${d.trialEndsTime}.`,
      };
    case "TRIAL_T1":
      return { kind: "TRIAL_ENDING", severity: "warning", title: "Seu teste termina amanhã", body: `Termina às ${d.trialEndsTime}. Assine com Pix para o bot não parar.` };
    case "TRIAL_T0":
      return { kind: "TRIAL_ENDING", severity: "warning", title: "Seu teste termina hoje", body: `Termina às ${d.trialEndsTime}. Assine com Pix para o bot seguir atendendo amanhã.` };
    case "TRIAL_SUSP_3":
      return { kind: "SUBSCRIPTION_SUSPENDED", severity: "danger", title: "O bot segue parado", body: `Assine com Pix para ele voltar. A conta de teste é encerrada em ${d.cancelDate}.` };
    case "TRIAL_CANCEL_WARN":
      return { kind: "CANCEL_WARNING", severity: "danger", title: "Última chance de assinar", body: `A conta de teste é encerrada em ${d.cancelDate}.` };
    default:
      return null;
  }
}
