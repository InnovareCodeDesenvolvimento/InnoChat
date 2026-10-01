import { addDaysToLocalDate, localDateOf, localDateTimeToInstant, weekdayOfLocalDate } from "./local-time";

/**
 * Política da régua de cobrança (docs/regua-de-cobranca.md §2.2, §2.3.1, §2.3.2, §2.5 e §6). Constantes e
 * funções puras: o que cada etapa faz, por quais canais, em que janela de horário e com que espera entre
 * tentativas. Dívida consciente da §5: a política vive no código, não numa tela do Admin.
 */

/** Nomes de etapa gravados em `BillingNotice.step`. Os 7 primeiros são EXATAMENTE os do backfill LEGACY_SENT da F1. */
export const DUNNING_STEPS = [
  "DUE_D1",
  "DUE_D0",
  "TRIAL_T1",
  "TRIAL_T0",
  "SUSPENDED",
  "INVOICE_CREATED",
  "AUTO_CANCELED",
  "DUE_D3",
  "GRACE_D1",
  "GRACE_D2",
  "GRACE_LAST",
  "SUSP_3",
  "SUSP_7",
  "SUSP_15",
  "SUSP_30",
  "SUSP_45",
  "CANCEL_WARN_7",
  "CANCEL_WARN_1",
  "TRIAL_DAY1",
  "TRIAL_SUSP_3",
  "TRIAL_CANCEL_WARN",
  "PAYMENT_CONFIRMED",
] as const;

export type DunningStep = (typeof DUNNING_STEPS)[number];
export type NoticeChannel = "EMAIL" | "WHATSAPP";

export function isDunningStep(value: string): value is DunningStep {
  return (DUNNING_STEPS as readonly string[]).includes(value);
}

export type StepPolicy = {
  email: boolean;
  whatsapp: boolean;
  /** Aparece no sino do painel (derivado do estado, sem linha no outbox). */
  bell: boolean;
  /**
   * Etapa crítica (§2.4/§2.5): o OWNER recebe junto do e-mail de cobrança (D4) e o WhatsApp espera até
   * `CRITICAL_WAIT_FOR_CHANNEL_HOURS` pelo número da plataforma voltar, em vez de pular na hora.
   */
  critical: boolean;
  /** Pode sair por WhatsApp no domingo (D9: só suspensão e cancelamento). */
  whatsappOnSunday: boolean;
  /** Leva o Pix copia e cola (e o despachante regera o Pix se estiver perto de expirar). */
  carriesPix: boolean;
  /** Ignora a janela de horário: é resposta a uma ação do cliente (pagamento confirmado). */
  immediate: boolean;
};

const P = (partial: Partial<StepPolicy>): StepPolicy => ({
  email: false,
  whatsapp: false,
  bell: false,
  critical: false,
  whatsappOnSunday: false,
  carriesPix: false,
  immediate: false,
  ...partial,
});

export const STEP_POLICY: Record<DunningStep, StepPolicy> = {
  // Pagante: antes do vencimento.
  INVOICE_CREATED: P({ email: true, whatsapp: true, bell: true, carriesPix: true }),
  DUE_D3: P({ bell: true }),
  DUE_D1: P({ email: true, whatsapp: true, bell: true, carriesPix: true }),
  DUE_D0: P({ email: true, whatsapp: true, bell: true, critical: true, carriesPix: true }),
  // Pagante: carência de 3 dias (D+1, D+2, D+3). §2.3.2: cada mensagem leva o Pix; WhatsApp em D+1 e no último dia.
  GRACE_D1: P({ email: true, whatsapp: true, bell: true, critical: true, carriesPix: true }),
  GRACE_D2: P({ email: true, bell: true, carriesPix: true }),
  GRACE_LAST: P({ email: true, whatsapp: true, bell: true, critical: true, carriesPix: true }),
  // Suspensão.
  SUSPENDED: P({ email: true, whatsapp: true, bell: true, critical: true, whatsappOnSunday: true, carriesPix: true }),
  SUSP_3: P({ email: true, bell: true }),
  SUSP_7: P({ email: true, whatsapp: true, bell: true }),
  SUSP_15: P({ email: true, bell: true }),
  SUSP_30: P({ email: true, whatsapp: true, bell: true }),
  SUSP_45: P({ email: true, bell: true }),
  CANCEL_WARN_7: P({ email: true, whatsapp: true, bell: true, critical: true, whatsappOnSunday: true }),
  CANCEL_WARN_1: P({ email: true, whatsapp: true, bell: true, critical: true, whatsappOnSunday: true }),
  AUTO_CANCELED: P({ email: true, whatsapp: true, critical: true, whatsappOnSunday: true }),
  // Teste (§2.3.1). Nenhum desconto automático.
  TRIAL_DAY1: P({ email: true, whatsapp: true, bell: true }),
  TRIAL_T1: P({ email: true, whatsapp: true, bell: true, carriesPix: true }),
  TRIAL_T0: P({ email: true, whatsapp: true, bell: true, critical: true, carriesPix: true }),
  TRIAL_SUSP_3: P({ email: true, bell: true }),
  TRIAL_CANCEL_WARN: P({ email: true, whatsapp: true, bell: true, critical: true, whatsappOnSunday: true }),
  // Resposta a uma ação do cliente: sai na hora.
  PAYMENT_CONFIRMED: P({ email: true, whatsapp: true, bell: true, immediate: true }),
};

/** Janela de envio no fuso da empresa (§2.1). `endHour` é exclusivo: 19:00 já está fora. */
export const SEND_WINDOW: Record<NoticeChannel, { startHour: number; endHour: number }> = {
  EMAIL: { startHour: 8, endHour: 20 },
  WHATSAPP: { startHour: 9, endHour: 19 },
};

/** Tentativas e espera crescente entre elas (§2.5): 5 min, 30 min, 2 h, 6 h; teto de 5 tentativas. */
export const NOTICE_MAX_ATTEMPTS = 5;
export const NOTICE_BACKOFF_MINUTES = [5, 30, 120, 360] as const;

/** Minutos de espera depois da tentativa de número `attempts` (1-based) que falhou. */
export function retryDelayMinutes(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), NOTICE_BACKOFF_MINUTES.length) - 1;
  return NOTICE_BACKOFF_MINUTES[index];
}

/** `SENDING` com `updatedAt` mais velho que isto é considerado preso (o processo morreu no meio do envio). */
export const SENDING_STUCK_MINUTES = 15;

/** Etapa crítica de WhatsApp sem número da plataforma fica esperando por até isto (§2.4), sempre dentro da janela. */
export const CRITICAL_WAIT_FOR_CHANNEL_HOURS = 12;

/** O Pix que vai num aviso precisa valer por pelo menos isto; senão o despachante regera (R7). */
export const PIX_MIN_REMAINING_HOURS = 24;

/** O WhatsApp pode sair neste dia local para esta etapa? Domingo só nas etapas `whatsappOnSunday` (D9). */
function whatsappAllowedOnDate(step: DunningStep, date: string): boolean {
  if (weekdayOfLocalDate(date) !== 0) return true;
  return STEP_POLICY[step].whatsappOnSunday;
}

/**
 * Primeiro instante `>= from` em que `channel` pode sair para `step`: o próprio `from` se já está na janela,
 * senão a abertura da próxima janela permitida (e-mail todo dia, 08h às 20h; WhatsApp de segunda a sábado,
 * 09h às 19h, e domingo só nas etapas críticas de suspensão e cancelamento). Etapa `immediate` ignora a janela.
 */
export function nextSendableAt(channel: NoticeChannel, step: DunningStep, from: Date, timezone: string): Date {
  if (STEP_POLICY[step].immediate) return from;
  const { startHour, endHour } = SEND_WINDOW[channel];
  const open = `${String(startHour).padStart(2, "0")}:00`;
  const close = `${String(endHour).padStart(2, "0")}:00`;
  let date = localDateOf(from, timezone);
  for (let i = 0; i < 9; i += 1) {
    const allowed = channel === "EMAIL" || whatsappAllowedOnDate(step, date);
    if (allowed) {
      const opensAt = localDateTimeToInstant(date, open, timezone);
      const closesAt = localDateTimeToInstant(date, close, timezone);
      if (from < closesAt) return from < opensAt ? opensAt : from;
    }
    date = addDaysToLocalDate(date, 1);
  }
  return from; // inalcançável: em 9 dias sempre há uma janela
}

export function isInSendWindow(channel: NoticeChannel, step: DunningStep, at: Date, timezone: string): boolean {
  return nextSendableAt(channel, step, at, timezone).getTime() === at.getTime();
}
