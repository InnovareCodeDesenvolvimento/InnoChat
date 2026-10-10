import { effectiveStatus, subscriptionBoundaries, usesTrialRules } from "./status";
import type { SubscriptionStatus } from "./types";
import { addDaysToLocalDate, endOfLocalDay, localDateOf, safeTimezone, startOfLocalDay } from "./local-time";
import { STEP_POLICY, type DunningStep, type NoticeChannel, type StepPolicy } from "./dunning-policy";

/**
 * Planejador PURO da régua de cobrança (docs/regua-de-cobranca.md §2.5, "planNotices"). Dado o retrato da
 * assinatura, da fatura aberta, do fuso e `now`, devolve as etapas que estão DEVIDAS agora. Sem I/O e sem
 * relógio próprio: o tick, o despachante (que reconfere antes de enviar) e o sino do painel usam a mesma
 * função, então "o que o planejador mandaria" e "o que ainda faz sentido enviar" nunca divergem.
 *
 * Chave de ciclo (`cycleKey`, contrato da F1; a unicidade `(cycleKey, step, channel)` é do banco):
 * - fatura (INVOICE_CREATED, DUE_*, GRACE_*): `invoiceId` (também a fatura do teste, só no INVOICE_CREATED);
 * - teste (TRIAL_*): `<subscriptionId>:trial`;
 * - suspensão e cancelamento (SUSPENDED, SUSP_*, CANCEL_WARN_*, AUTO_CANCELED): `<subscriptionId>:<currentPeriodEnd ISO>`.
 *
 * Dias são DIAS LOCAIS do fuso da empresa (virada de dia e horário de verão não escorregam a conta).
 */

export type DunningSubscription = {
  id: string;
  /** Status PERSISTIDO (`Subscription.status`). */
  status: SubscriptionStatus;
  currentPeriodEnd: Date;
  trialEndsAt: Date | null;
  /** `null` = nunca pagou (teste). */
  firstPaidAt: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  cancelRequestedAt: Date | null;
  createdAt: Date;
};

/** Fatura ABERTA da assinatura (a mais recente). */
export type DunningInvoice = { id: string; dueAt: Date; createdAt: Date; isTrialConversion: boolean };

export type DunningInput = {
  timezone: string;
  subscription: DunningSubscription;
  openInvoice: DunningInvoice | null;
  /** O admin suspendeu à mão: não é atraso, então nenhuma etapa de cobrança de suspensão sai. */
  manualSuspension: boolean;
  /** O teste tem um número de WhatsApp conectado (decide se o resumo do 1º dia também vai por WhatsApp). */
  whatsappConnected: boolean;
  /**
   * A empresa tem CPF/CNPJ válido salvo. Sem ele a fatura do teste não tem Pix, e "Sua fatura chegou" (que carrega o Pix)
   * só é devida depois que o documento entrar (cadastro enxuto).
   */
  hasDocument: boolean;
};

export type DueStep = {
  step: DunningStep;
  cycleKey: string;
  invoiceId: string | null;
  /** Quando a etapa passa a valer. */
  at: Date;
  /** Depois daqui a mensagem seria mentira (ex.: "vence amanhã" depois de vencer) e a etapa não sai mais. */
  expiresAt: Date;
  /** Canais em que a etapa sai (política da etapa, já restrita ao caso). */
  channels: NoticeChannel[];
  policy: StepPolicy;
};

export type PlannedNotice = {
  step: DunningStep;
  channel: NoticeChannel;
  cycleKey: string;
  invoiceId: string | null;
  notBefore: Date;
  expiresAt: Date;
  critical: boolean;
};

/** Reenvio do aviso de cancelamento automático só até isto depois do cancelamento. */
const AUTO_CANCEL_NOTICE_DAYS = 3;
/** Suspensão: o aviso "bot parado" ainda vale por até isto (era `SUSPENSION_EMAIL_MAX_AGE_DAYS` da F0). */
const SUSPENDED_NOTICE_DAYS = 7;
const DAY_MS = 86_400_000;

function periodCycleKey(sub: DunningSubscription): string {
  return `${sub.id}:${sub.currentPeriodEnd.toISOString()}`;
}

function channelsOf(step: DunningStep, only?: NoticeChannel[]): NoticeChannel[] {
  const policy = STEP_POLICY[step];
  const all: NoticeChannel[] = [];
  if (policy.email) all.push("EMAIL");
  if (policy.whatsapp) all.push("WHATSAPP");
  return only ? all.filter((c) => only.includes(c)) : all;
}

type Builder = { steps: DueStep[]; tz: string };

function push(
  b: Builder,
  step: DunningStep,
  cycleKey: string,
  invoiceId: string | null,
  at: Date,
  expiresAt: Date,
  only?: NoticeChannel[],
  noBell = false,
) {
  if (expiresAt.getTime() <= at.getTime()) return;
  const policy = noBell ? { ...STEP_POLICY[step], bell: false } : STEP_POLICY[step];
  b.steps.push({ step, cycleKey, invoiceId, at, expiresAt, channels: channelsOf(step, only), policy });
}

function dayWindow(b: Builder, date: string, spanDays = 1): { at: Date; expiresAt: Date } {
  return { at: startOfLocalDay(date, b.tz), expiresAt: endOfLocalDay(addDaysToLocalDate(date, spanDays - 1), b.tz) };
}

/**
 * Todas as etapas do estado ATUAL da assinatura, com a janela de cada uma (`at` a `expiresAt`), tenham ou
 * não chegado a hora. Quem filtra pelo relógio é `listReachedSteps`/`planNotices`.
 */
export function buildSteps(input: DunningInput, now: Date): DueStep[] {
  const tz = safeTimezone(input.timezone);
  const sub = input.subscription;
  const b: Builder = { steps: [], tz };
  const invoice = input.openInvoice;

  // Cancelada: só o aviso de encerramento automático e os lembretes da fatura de REATIVAÇÃO.
  if (sub.status === "CANCELED") {
    const reactivation = invoice !== null && sub.canceledAt !== null && invoice.createdAt >= sub.canceledAt;
    if (reactivation && invoice) {
      const dueDate = localDateOf(invoice.dueAt, tz);
      // Reativação é pedida no painel (a pessoa está lá): só e-mail, só os dois lembretes finais.
      const d1 = dayWindow(b, addDaysToLocalDate(dueDate, -1));
      push(b, "DUE_D1", invoice.id, invoice.id, d1.at, d1.expiresAt, ["EMAIL"]);
      const d0 = dayWindow(b, dueDate);
      push(b, "DUE_D0", invoice.id, invoice.id, d0.at, d0.expiresAt, ["EMAIL"]);
    }
    // Quem já pediu a reativação está no painel agora: "sua conta foi encerrada" seria ruído (e mentira de timing).
    const automatic = !reactivation && !sub.cancelAtPeriodEnd && sub.cancelRequestedAt === null && sub.canceledAt !== null;
    if (automatic && sub.canceledAt) {
      push(b, "AUTO_CANCELED", periodCycleKey(sub), null, sub.canceledAt, new Date(sub.canceledAt.getTime() + AUTO_CANCEL_NOTICE_DAYS * DAY_MS));
    }
    return b.steps;
  }

  // Cancelamento agendado pelo dono: ele sabe que vai embora, nenhuma cobrança.
  if (sub.cancelAtPeriodEnd) return b.steps;

  // Suspensão manual do admin não é atraso: nunca vira PAST_DUE pela carência e nenhuma etapa de cobrança sai.
  if (input.manualSuspension) return b.steps;
  const status = effectiveStatus({ ...sub, timezone: tz }, now);
  const boundaries = subscriptionBoundaries({ ...sub, timezone: tz });
  const neverPaid = sub.firstPaidAt === null;

  if (status === "TRIALING") {
    const trialEnd = sub.trialEndsAt ?? sub.currentPeriodEnd;
    const key = `${sub.id}:trial`;
    // "Sua fatura chegou" do cadastro (já com o Pix): o cadastro envia na hora e grava a marca; se o SMTP
    // falhou, é esta etapa que reenvia. Só e-mail e fora do sino (o sino de teste fala de teste, não de fatura).
    // Cadastro enxuto: sem documento não há Pix, então o aviso espera o CPF/CNPJ entrar (a janela começa na criação da fatura).
    if (invoice && invoice.isTrialConversion && input.hasDocument) push(b, "INVOICE_CREATED", invoice.id, invoice.id, invoice.createdAt, trialEnd, ["EMAIL"], true);
    const startDate = localDateOf(sub.createdAt, tz);
    const endDate = localDateOf(trialEnd, tz);
    const t1Date = addDaysToLocalDate(endDate, -1);
    const day1Date = addDaysToLocalDate(startDate, 1);
    if (day1Date < t1Date) {
      const w = dayWindow(b, day1Date);
      push(b, "TRIAL_DAY1", key, null, w.at, w.expiresAt, input.whatsappConnected ? undefined : ["EMAIL"]);
    }
    const t1 = dayWindow(b, t1Date);
    push(b, "TRIAL_T1", key, null, new Date(Math.max(t1.at.getTime(), sub.createdAt.getTime())), new Date(Math.min(t1.expiresAt.getTime(), trialEnd.getTime())));
    push(b, "TRIAL_T0", key, null, startOfLocalDay(endDate, tz), trialEnd);
    return b.steps;
  }

  if (status === "SUSPENDED") {
    if (input.manualSuspension) return b.steps;
    const key = periodCycleKey(sub);
    const suspendedAt = boundaries.graceEndsAt;
    const suspensionDate = localDateOf(new Date(suspendedAt.getTime() + 1), tz);
    const cancelDate = localDateOf(new Date(boundaries.cancelsAt.getTime() + 1), tz);
    push(b, "SUSPENDED", key, invoice?.id ?? null, suspendedAt, new Date(suspendedAt.getTime() + SUSPENDED_NOTICE_DAYS * DAY_MS));
    if (neverPaid && usesTrialRules(sub)) {
      const trialKey = `${sub.id}:trial`;
      const s3 = dayWindow(b, addDaysToLocalDate(suspensionDate, 3), 2);
      push(b, "TRIAL_SUSP_3", trialKey, null, s3.at, s3.expiresAt);
      const warn = dayWindow(b, addDaysToLocalDate(localDateOf(boundaries.cancelsAt, tz), -2));
      push(b, "TRIAL_CANCEL_WARN", trialKey, null, warn.at, new Date(Math.min(warn.expiresAt.getTime(), boundaries.cancelsAt.getTime())));
      return b.steps;
    }
    for (const [step, days] of [
      ["SUSP_3", 3],
      ["SUSP_7", 7],
      ["SUSP_15", 15],
      ["SUSP_30", 30],
      ["SUSP_45", 45],
    ] as const) {
      const w = dayWindow(b, addDaysToLocalDate(suspensionDate, days), 2);
      push(b, step, key, invoice?.id ?? null, w.at, w.expiresAt);
    }
    const c7 = dayWindow(b, addDaysToLocalDate(cancelDate, -7), 2);
    push(b, "CANCEL_WARN_7", key, invoice?.id ?? null, c7.at, c7.expiresAt);
    const c1 = dayWindow(b, addDaysToLocalDate(cancelDate, -1));
    push(b, "CANCEL_WARN_1", key, invoice?.id ?? null, c1.at, new Date(Math.min(c1.expiresAt.getTime(), boundaries.cancelsAt.getTime())));
    return b.steps;
  }

  // ACTIVE ou PAST_DUE (quem paga): a régua da fatura. Sem fatura aberta (ou fatura do teste) não há o que cobrar aqui.
  if (!invoice || invoice.isTrialConversion) return b.steps;
  const dueDate = localDateOf(boundaries.dueAt, tz);
  const key = invoice.id;

  push(b, "INVOICE_CREATED", key, invoice.id, invoice.createdAt, boundaries.dueAt);
  const d3 = dayWindow(b, addDaysToLocalDate(dueDate, -3), 2);
  push(b, "DUE_D3", key, invoice.id, d3.at, d3.expiresAt);
  const d1 = dayWindow(b, addDaysToLocalDate(dueDate, -1));
  push(b, "DUE_D1", key, invoice.id, d1.at, d1.expiresAt);
  push(b, "DUE_D0", key, invoice.id, startOfLocalDay(dueDate, tz), boundaries.dueAt);
  if (status === "PAST_DUE") {
    const graceSteps: DunningStep[] = ["GRACE_D1", "GRACE_D2", "GRACE_LAST"];
    graceSteps.forEach((step, index) => {
      const w = dayWindow(b, addDaysToLocalDate(dueDate, index + 1));
      push(b, step, key, invoice.id, w.at, w.expiresAt);
    });
  }
  return b.steps;
}

/** Etapas cuja hora já chegou (`at <= now`), vencidas ou não. Serve ao sino: "em que ponto da régua estamos". */
export function listReachedSteps(input: DunningInput, now: Date): DueStep[] {
  return buildSteps(input, now)
    .filter((s) => s.at.getTime() <= now.getTime())
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Avisos DEVIDOS agora (hora chegou e ainda não expirou), um por canal. */
export function planNotices(input: DunningInput, now: Date): PlannedNotice[] {
  const planned: PlannedNotice[] = [];
  for (const s of listReachedSteps(input, now)) {
    if (now.getTime() >= s.expiresAt.getTime()) continue;
    for (const channel of s.channels) {
      planned.push({ step: s.step, channel, cycleKey: s.cycleKey, invoiceId: s.invoiceId, notBefore: s.at, expiresAt: s.expiresAt, critical: s.policy.critical });
    }
  }
  return planned;
}

/** A etapa mais recente da régua que aparece no sino (uma de cada vez: a empresa vê onde está, não o histórico). */
export function currentBellStep(input: DunningInput, now: Date): DueStep | null {
  const reached = listReachedSteps(input, now).filter((s) => s.policy.bell);
  return reached.length > 0 ? reached[reached.length - 1] : null;
}

/** O aviso `(step, channel, cycleKey)` ainda é devido em `now`? Usado pelo despachante para reconferir antes de enviar. */
export function isNoticeStillDue(input: DunningInput, now: Date, notice: { step: DunningStep; channel: NoticeChannel; cycleKey: string }): boolean {
  return planNotices(input, now).some((p) => p.step === notice.step && p.channel === notice.channel && p.cycleKey === notice.cycleKey);
}
