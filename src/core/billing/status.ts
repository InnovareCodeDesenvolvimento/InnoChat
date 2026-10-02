import { addDays, addMonths } from "date-fns";
import type { SubscriptionSnapshot, SubscriptionStatus } from "./types";
import { addDaysToLocalDate, DEFAULT_BILLING_TIMEZONE, endOfLocalDay, localDateOf, safeTimezone } from "./local-time";

/**
 * Carência do TESTE e de quem nunca pagou: 1 dia (decisão do dono, 2026-09-28; mantida em 2026-10-01, D3).
 * Também é o valor que a landing e o FAQ citam para o primeiro pagamento.
 */
export const GRACE_DAYS_TRIAL = 1;

/**
 * Carência de quem JÁ PAGA (decisão do dono, 2026-10-01, D3): 3 dias. Pix pontual depende de o dono
 * lembrar; 1 dia suspendia quem esqueceu num fim de semana.
 */
export const GRACE_DAYS_PAYING = 3;

/**
 * @deprecated Use `GRACE_DAYS_TRIAL` / `GRACE_DAYS_PAYING` (ou `subscriptionBoundaries`). Mantido igual
 * ao valor do teste porque o FAQ da landing descreve o primeiro pagamento.
 */
export const GRACE_DAYS = GRACE_DAYS_TRIAL;

/** Tempo em SUSPENDED antes de virar CANCELED (§7.4). */
export const CANCEL_AFTER_SUSPENDED_DAYS = 60;

/**
 * Tempo em SUSPENDED antes de virar CANCELED para quem NUNCA pagou (teste não convertido —
 * decisão do dono, 2026-09-29). Quem já foi pagante continua com `CANCEL_AFTER_SUSPENDED_DAYS`.
 */
export const CANCEL_AFTER_SUSPENDED_TRIAL_DAYS = 7;

/** Dias que os dados ficam guardados depois do cancelamento; depois, os dados de clientes finais são anonimizados (Termos §9). */
export const CANCELED_RETENTION_DAYS = 90;

/** Trial (decisão do dono, 2026-09-29 — trocou de 1 para 3 dias): 3 dias a partir do cadastro. */
export const TRIAL_DAYS = 3;

export function computeTrialEndsAt(signupAt: Date): Date {
  return addDays(signupAt, TRIAL_DAYS);
}

/**
 * Regras de TESTE valem para o status persistido `TRIALING` e para quem NUNCA pagou (`firstPaidAt === null`,
 * inclusive o teste que já virou `PAST_DUE`/`SUSPENDED` e a assinatura liberada à mão pelo admin sem
 * cobrança). `undefined` (snapshot sem o campo) é tratado como pagante: na dúvida, nunca suspender mais
 * cedo do que o combinado.
 */
export function usesTrialRules(subscription: Pick<SubscriptionSnapshot, "status" | "firstPaidAt">): boolean {
  return subscription.status === "TRIALING" || subscription.firstPaidAt === null;
}

/**
 * Os três instantes que movem a assinatura depois do vencimento. Pura.
 *
 * - `dueAt`: até aqui está em dia. Teste: o instante exato do fim do teste. Pagante: 23:59:59.999 do dia
 *   LOCAL do `currentPeriodEnd` (D7: "vence hoje" é verdade o dia todo). Isso só ADIA o vencimento, nunca
 *   o antecipa, então ninguém perde horas já pagas e quem estava na carência antiga não é suspenso antes.
 * - `graceEndsAt`: fim da carência (`PAST_DUE` até aqui, `SUSPENDED` depois). Pagante: fim do dia local
 *   D+3; teste: `dueAt` + 1 dia.
 * - `cancelsAt`: depois daqui, `CANCELED` (60 dias suspensa; 7 se nunca pagou).
 */
export type SubscriptionBoundaries = { dueAt: Date; graceEndsAt: Date; cancelsAt: Date };

export function subscriptionBoundaries(
  subscription: Pick<SubscriptionSnapshot, "status" | "trialEndsAt" | "currentPeriodEnd" | "firstPaidAt" | "timezone">,
): SubscriptionBoundaries {
  const rawDue = subscription.status === "TRIALING" ? subscription.trialEndsAt ?? subscription.currentPeriodEnd : subscription.currentPeriodEnd;
  if (usesTrialRules(subscription)) {
    const graceEndsAt = addDays(rawDue, GRACE_DAYS_TRIAL);
    const cancelDays = subscription.firstPaidAt === null ? CANCEL_AFTER_SUSPENDED_TRIAL_DAYS : CANCEL_AFTER_SUSPENDED_DAYS;
    return { dueAt: rawDue, graceEndsAt, cancelsAt: addDays(graceEndsAt, cancelDays) };
  }
  const tz = safeTimezone(subscription.timezone ?? DEFAULT_BILLING_TIMEZONE);
  const dueDate = localDateOf(rawDue, tz);
  return {
    dueAt: endOfLocalDay(dueDate, tz),
    graceEndsAt: endOfLocalDay(addDaysToLocalDate(dueDate, GRACE_DAYS_PAYING), tz),
    cancelsAt: endOfLocalDay(addDaysToLocalDate(dueDate, GRACE_DAYS_PAYING + CANCEL_AFTER_SUSPENDED_DAYS), tz),
  };
}

/**
 * Status EFETIVO de uma assinatura em `now`, calculado sob demanda (§7.4: "O status efetivo é
 * calculado sob demanda... Se o cron falhar, o acesso continua correto"). Pura: nunca lê nem
 * grava nada — `billing/tick` (src/modules/billing/tick.ts) é quem persiste a mudança.
 *
 * Regras:
 * - `CANCELED` é terminal: uma vez cancelada (pelo dono da empresa ou por 60 dias em
 *   `SUSPENDED`), só volta por uma ação explícita (admin, ou o dono pagando a reativação — fora
 *   desta função).
 * - `cancelAtPeriodEnd` (cancelamento agendado): no vencimento de referência vai direto a `CANCELED`.
 * - Enquanto `status` persistido é `TRIALING`, o vencimento de referência é `trialEndsAt`.
 *   Nos demais casos (`ACTIVE`/`PAST_DUE`/`SUSPENDED`), é `currentPeriodEnd` — que só avança
 *   quando um pagamento é confirmado (`computeNextPeriodEnd`). Isso é o que permite ao
 *   `status` persistido estar "atrasado" (ex.: ainda `PAST_DUE` no banco) sem afetar o
 *   resultado: se o pagamento já moveu `currentPeriodEnd` para o futuro, o efetivo já é
 *   `ACTIVE`, mesmo antes do próximo `tick` persistir isso.
 * - Depois do vencimento: carência (3 dias de quem paga, 1 dia de teste/quem nunca pagou: `PAST_DUE`),
 *   depois `SUSPENDED`, depois `CANCELED` após `CANCEL_AFTER_SUSPENDED_DAYS` em `SUSPENDED` (ou
 *   `CANCEL_AFTER_SUSPENDED_TRIAL_DAYS` se nunca pagou: `firstPaidAt === null`). Ver `subscriptionBoundaries`.
 */
export function effectiveStatus(subscription: SubscriptionSnapshot, now: Date): SubscriptionStatus {
  if (subscription.status === "CANCELED") {
    return "CANCELED";
  }

  const { dueAt, graceEndsAt, cancelsAt } = subscriptionBoundaries(subscription);

  if (now < dueAt) {
    return subscription.status === "TRIALING" ? "TRIALING" : "ACTIVE";
  }

  // Cancelamento agendado pelo dono: o acesso termina no fim do período já pago —
  // sem carência nem suspensão. Calculado sob demanda, então não depende de o tick já ter rodado.
  if (subscription.cancelAtPeriodEnd) {
    return "CANCELED";
  }

  // Suspensão manual do admin nunca vira PAST_DUE pela carência (ex.: suspensão antiga, gravada com 1 dia de
  // folga, que a carência de 3 dias "reabriria"): fica SUSPENDED até o cancelamento automático.
  if (subscription.manualSuspendedAt) {
    return now < cancelsAt ? "SUSPENDED" : "CANCELED";
  }

  if (now < graceEndsAt) {
    return "PAST_DUE";
  }

  if (now < cancelsAt) {
    return "SUSPENDED";
  }

  return "CANCELED";
}

/**
 * `currentPeriodEnd` depois de um pagamento confirmado (§7.1): "+1 mês a partir do vencimento
 * anterior (mantém o dia-âncora)"; mas "se a empresa estava SUSPENDED, o novo período conta a
 * partir de `paidAt`" — perder o dia-âncora é o preço de ter ficado suspenso, e evita que a
 * empresa "ganhe de volta" os dias em que ficou sem pagar.
 */
export function computeNextPeriodEnd(params: {
  currentPeriodEnd: Date;
  wasSuspended: boolean;
  paidAt: Date;
  /** Meses que a fatura paga cobre: 1 (mensal, padrão) ou 12 (anual). */
  months?: number;
}): Date {
  const anchor = params.wasSuspended ? params.paidAt : params.currentPeriodEnd;
  return addMonths(anchor, params.months ?? 1);
}

/** `true` quando falta `leadDays` dias ou menos para `dueAt` (ou já venceu). */
export function isWithinLeadDays(dueAt: Date, now: Date, leadDays: number): boolean {
  return addDays(now, leadDays) >= dueAt;
}

/**
 * Quando o acesso termina para uma assinatura com cancelamento agendado: o fim do teste
 * (`TRIALING`) ou do período pago corrente (demais casos).
 */
export function accessEndsAt(subscription: Pick<SubscriptionSnapshot, "status" | "trialEndsAt" | "currentPeriodEnd">): Date {
  return subscription.status === "TRIALING" ? (subscription.trialEndsAt ?? subscription.currentPeriodEnd) : subscription.currentPeriodEnd;
}
