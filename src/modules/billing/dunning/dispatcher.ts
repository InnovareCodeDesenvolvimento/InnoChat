import { addMinutes, subMinutes } from "date-fns";
import { claimDueBillingNotices, type ClaimedBillingNotice } from "@/lib/db/billing-notice-queries";
import { getPrisma } from "@/lib/db/prisma";
import { describeDbError } from "@/lib/db/prisma-errors";
import { logger } from "@/lib/logger";
import { loadEmailContext, renderDunningEmail } from "@/lib/email";
import {
  buildWhatsappMessages,
  CRITICAL_WAIT_FOR_CHANNEL_HOURS,
  isDunningStep,
  isNoticeStillDue,
  nextSendableAt,
  NOTICE_MAX_ATTEMPTS,
  PIX_MIN_REMAINING_HOURS,
  SENDING_STUCK_MINUTES,
  STEP_POLICY,
  type DunningStep,
  type NoticeChannel,
} from "@/core/billing";
import { getPlatformWhatsappRoundBudget, sendPlatformWhatsapp } from "@/modules/platform-whatsapp/sender";
import type { MercadoPagoGateway } from "../mercadopago";
import { regeneratePixForInvoice, sendBillingMail } from "../service";
import { buildNoticeCopyContext } from "./context";
import {
  expireStaleNotices,
  markNoticeFailed,
  markNoticeSentSafely,
  markNoticeSkipped,
  maskEmail,
  maskPhoneE164,
  releaseNotice,
  type SkipReason,
} from "./outbox";
import { resolveNoticeRecipients } from "./recipients";
import { loadDunningSubject, type DunningSubject } from "./snapshot";

/**
 * Despachante da régua (docs/regua-de-cobranca.md §2.5): tira avisos da fila (`FOR UPDATE SKIP LOCKED`),
 * RECONFERE se ainda fazem sentido (quem pagou entre o planejamento e o envio vira `SKIPPED/PAID`), envia
 * e grava o resultado. Um item que falha nunca derruba os demais: tudo é isolado por aviso.
 *
 * - E-mail é o canal base: só vira `SENT` quando o SMTP confirma (`sendMail` devolve `{ sent: true }`).
 * - WhatsApp passa por `sendPlatformWhatsapp` (F4), que resolve o número ativo NO ENVIO. Etapa crítica sem
 *   número aguarda até `CRITICAL_WAIT_FOR_CHANNEL_HOURS`; as demais pulam com o motivo.
 * - Janela de horário (e-mail 08h-20h, WhatsApp 09h-19h de segunda a sábado) e domingo só crítico (D9).
 * - Falha: espera crescente (`retryDelayMinutes`), teto de `NOTICE_MAX_ATTEMPTS`, depois o aviso fica `FAILED`.
 * - Só o CÓDIGO do erro é gravado; texto, telefone e e-mail inteiros nunca vão para o log.
 */

export type DispatchDeps = {
  gateway?: MercadoPagoGateway;
  sendWhatsapp?: typeof sendPlatformWhatsapp;
  /** Espera entre envios de WhatsApp (ritmo anti-bloqueio). Teste injeta uma que não espera. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export type DispatchSummary = {
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  deferred: number;
  emailsSent: number;
  emailsFailed: number;
  /** E-mails enviados por etapa (alimenta os contadores históricos do tick). */
  emailSentSteps: DunningStep[];
  expired: number;
};

export function emptyDispatchSummary(): DispatchSummary {
  return { claimed: 0, sent: 0, skipped: 0, failed: 0, deferred: 0, emailsSent: 0, emailsFailed: 0, emailSentSteps: [], expired: 0 };
}

const EMAIL_BATCH_LIMIT = 200;
/** Teto por rodada no WhatsApp (docs §2.4); o sender ainda aplica o teto de aquecimento do número. */
const WHATSAPP_BATCH_LIMIT = 30;
const WHATSAPP_PAIR_DELAY_MS = 1500;
const WHATSAPP_RETRY_WAIT_MINUTES = 30;

type Outcome = "SENT" | "SKIPPED" | "FAILED" | "DEFERRED";

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type DispatchOptions = {
  budget?: { isOver: () => boolean };
  /** Só estas linhas (envio imediato do pagamento confirmado). */
  onlyIds?: string[];
  deps?: DispatchDeps;
};

export async function dispatchDueNotices(now: Date, options: DispatchOptions = {}): Promise<DispatchSummary> {
  const summary = emptyDispatchSummary();
  const deps = options.deps ?? {};
  const stuckBefore = subMinutes(now, SENDING_STUCK_MINUTES);

  if (!options.onlyIds) summary.expired = await expireStaleNotices(now);

  // E-mail primeiro (canal base), depois WhatsApp (ritmo lento de propósito).
  const emailBatch = await claimDueBillingNotices({ now, limit: EMAIL_BATCH_LIMIT, stuckBefore, maxAttempts: NOTICE_MAX_ATTEMPTS, onlyIds: options.onlyIds, channel: "EMAIL" });
  await runBatch(emailBatch, now, summary, deps, options.budget, false);

  let whatsappLimit = WHATSAPP_BATCH_LIMIT;
  if (!options.onlyIds) {
    const roundBudget = await getPlatformWhatsappRoundBudget(now).catch(() => null);
    // Sem número ativo o aviso precisa ser reivindicado mesmo assim (vira SKIPPED/NO_PLATFORM_NUMBER ou espera).
    if (roundBudget) whatsappLimit = Math.min(WHATSAPP_BATCH_LIMIT, roundBudget.remaining);
  }
  if (whatsappLimit > 0) {
    const whatsappBatch = await claimDueBillingNotices({ now, limit: whatsappLimit, stuckBefore, maxAttempts: NOTICE_MAX_ATTEMPTS, onlyIds: options.onlyIds, channel: "WHATSAPP" });
    await runBatch(whatsappBatch, now, summary, deps, options.budget, true);
  }
  return summary;
}

async function runBatch(
  batch: ClaimedBillingNotice[],
  now: Date,
  summary: DispatchSummary,
  deps: DispatchDeps,
  budget: DispatchOptions["budget"],
  paced: boolean,
) {
  summary.claimed += batch.length;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  let sentAny = false;
  for (let i = 0; i < batch.length; i += 1) {
    const notice = batch[i];
    if (budget?.isOver()) {
      // Orçamento do tick acabou: o resto volta à fila, sem contar tentativa.
      for (const rest of batch.slice(i)) await releaseNotice(rest.id, now);
      return;
    }
    if (paced && sentAny) await sleep(3000 + Math.floor(random() * 5000)); // 3 a 8 s entre envios de WhatsApp
    let outcome: Outcome;
    try {
      outcome = await processNotice(notice, now, summary, deps);
    } catch (error) {
      // Isolado por aviso: erro inesperado (rede, banco) conta como falha da tentativa e a fila segue.
      outcome = "FAILED";
      summary.failed += 1;
      if (notice.channel === "EMAIL") summary.emailsFailed += 1;
      logger.warn("billing.notice.dispatch_failed", { noticeId: notice.id, step: notice.step, channel: notice.channel, ...describeDbError(error) });
      await markNoticeFailed(notice.id, now, notice.attempts, "UNEXPECTED_ERROR").catch(() => undefined);
    }
    if (outcome === "SENT") sentAny = true;
  }
}

function skip(summary: DispatchSummary): Outcome {
  summary.skipped += 1;
  return "SKIPPED";
}

/** Por que o aviso deixou de ser devido (nunca "cobrar quem já pagou"). */
async function skipReasonFor(notice: ClaimedBillingNotice, subject: DunningSubject): Promise<SkipReason> {
  const sub = subject.input.subscription;
  if (notice.invoiceId) {
    const invoice = await getPrisma().invoice.findUnique({ where: { id: notice.invoiceId }, select: { status: true } });
    if (invoice?.status === "PAID") return "PAID";
  }
  if (notice.cycleKey.endsWith(":trial")) {
    if (sub.firstPaidAt !== null) return "PAID";
  } else if (notice.cycleKey.startsWith(`${sub.id}:`)) {
    const periodEnd = notice.cycleKey.slice(sub.id.length + 1);
    if (sub.currentPeriodEnd.toISOString() > periodEnd) return "PAID";
  }
  if (subject.input.manualSuspension) return "MANUAL_SUSPENSION";
  return "STATUS_CHANGED";
}

async function processNotice(notice: ClaimedBillingNotice, now: Date, summary: DispatchSummary, deps: DispatchDeps): Promise<Outcome> {
  if (!isDunningStep(notice.step) || (notice.channel !== "EMAIL" && notice.channel !== "WHATSAPP")) {
    await markNoticeSkipped(notice.id, "STATUS_CHANGED");
    return skip(summary);
  }
  const step: DunningStep = notice.step;
  const channel: NoticeChannel = notice.channel;
  const policy = STEP_POLICY[step];

  const subject = await loadDunningSubject(notice.subscriptionId, now);
  if (!subject) {
    await markNoticeSkipped(notice.id, "STATUS_CHANGED");
    return skip(summary);
  }
  const tz = subject.input.timezone;

  // 1. Reconsulta o estado: ainda é devido AGORA?
  if (step === "PAYMENT_CONFIRMED") {
    const invoice = notice.invoiceId ? await getPrisma().invoice.findUnique({ where: { id: notice.invoiceId }, select: { status: true } }) : null;
    if (invoice?.status !== "PAID") {
      await markNoticeSkipped(notice.id, "STATUS_CHANGED");
      return skip(summary);
    }
  } else if (!isNoticeStillDue(subject.input, now, { step, channel, cycleKey: notice.cycleKey })) {
    await markNoticeSkipped(notice.id, await skipReasonFor(notice, subject));
    return skip(summary);
  }

  // 2. Destinatário e preferência.
  const recipients = await resolveNoticeRecipients(subject.tenantId, step);
  if (channel === "EMAIL" && recipients.emails.length === 0) {
    await markNoticeSkipped(notice.id, "NO_RECIPIENT");
    return skip(summary);
  }
  if (channel === "WHATSAPP") {
    if (recipients.whatsappOptedOut) {
      await markNoticeSkipped(notice.id, "OPTED_OUT");
      return skip(summary);
    }
    if (!recipients.whatsappE164) {
      await markNoticeSkipped(notice.id, "NO_RECIPIENT");
      return skip(summary);
    }
  }

  // 3. Janela de horário (e domingo só crítico no WhatsApp): espera a próxima abertura, se ainda der tempo.
  const sendAt = nextSendableAt(channel, step, now, tz);
  if (sendAt.getTime() > now.getTime()) {
    if (sendAt.getTime() >= notice.expiresAt.getTime()) {
      await markNoticeSkipped(notice.id, "OUT_OF_WINDOW_EXPIRED");
      return skip(summary);
    }
    await releaseNotice(notice.id, sendAt);
    summary.deferred += 1;
    return "DEFERRED";
  }

  // 4. Dados atuais + Pix vigente.
  const firstWhatsapp = channel === "WHATSAPP" ? (await getPrisma().billingNotice.count({ where: { tenantId: subject.tenantId, channel: "WHATSAPP", status: "SENT" } })) === 0 : false;
  const copy = await buildNoticeCopyContext({ step, invoiceId: notice.invoiceId, subject, ownerFirstName: recipients.ownerFirstName, now, firstWhatsapp });
  if (policy.carriesPix && copy.invoice?.status === "OPEN") {
    copy.data.pixCopyPaste = await ensureFreshPix(copy.invoice, recipients.emails[0] ?? null, now, deps.gateway);
  }

  if (channel === "EMAIL") return sendEmail(notice, step, copy, recipients.emails, now, summary);
  return sendWhatsapp(notice, step, subject, copy, recipients.whatsappE164 as string, now, summary, deps);
}

/**
 * O Pix que vai no aviso precisa valer por pelo menos `PIX_MIN_REMAINING_HOURS` (R7: o código do e-mail de D-5
 * expirava em D-2). Perto de expirar, regera; se o Mercado Pago estiver fora, usa o que existe enquanto valer,
 * e sem nada válido o texto manda pagar pelo painel.
 */
async function ensureFreshPix(
  invoice: { id: string; pixCopyPaste: string | null; pixExpiresAt: Date | null },
  payerEmail: string | null,
  now: Date,
  gateway: MercadoPagoGateway | undefined,
): Promise<string | null> {
  const enough = addMinutes(now, PIX_MIN_REMAINING_HOURS * 60);
  if (invoice.pixCopyPaste && invoice.pixExpiresAt && invoice.pixExpiresAt > enough) return invoice.pixCopyPaste;
  if (payerEmail) {
    try {
      const fresh = await regeneratePixForInvoice(invoice.id, payerEmail, gateway);
      if (fresh.pixCopyPaste) return fresh.pixCopyPaste;
    } catch (error) {
      logger.warn("billing.notice.pix_refresh_failed", { invoiceId: invoice.id, errorName: error instanceof Error ? error.name : "unknown" });
    }
  }
  return invoice.pixCopyPaste && invoice.pixExpiresAt && invoice.pixExpiresAt > now ? invoice.pixCopyPaste : null;
}

async function sendEmail(
  notice: ClaimedBillingNotice,
  step: DunningStep,
  copy: Awaited<ReturnType<typeof buildNoticeCopyContext>>,
  emails: string[],
  now: Date,
  summary: DispatchSummary,
): Promise<Outcome> {
  const mail = renderDunningEmail(step, copy.data, await loadEmailContext(), { retentionUntilBr: copy.retentionUntilBr, clientsUrl: copy.clientsUrl });
  if (!mail) {
    await markNoticeSkipped(notice.id, "STATUS_CHANGED");
    return skip(summary);
  }
  let delivered = 0;
  for (const to of emails) {
    if (await sendBillingMail({ to, subject: mail.subject, html: mail.html, text: mail.text }, "billing.notice.email_not_sent")) delivered += 1;
  }
  if (delivered === 0) {
    await markNoticeFailed(notice.id, now, notice.attempts, "EMAIL_NOT_SENT");
    summary.failed += 1;
    summary.emailsFailed += 1;
    return "FAILED";
  }
  await markNoticeSentSafely(notice.id, now, { recipientMasked: emails.map(maskEmail).join(", ") });
  summary.sent += 1;
  summary.emailsSent += 1;
  summary.emailSentSteps.push(step);
  return "SENT";
}

async function sendWhatsapp(
  notice: ClaimedBillingNotice,
  step: DunningStep,
  subject: DunningSubject,
  copy: Awaited<ReturnType<typeof buildNoticeCopyContext>>,
  toE164: string,
  now: Date,
  summary: DispatchSummary,
  deps: DispatchDeps,
): Promise<Outcome> {
  const messages = buildWhatsappMessages(step, copy.data);
  if (messages.length === 0) {
    await markNoticeSkipped(notice.id, "STATUS_CHANGED");
    return skip(summary);
  }
  const send = deps.sendWhatsapp ?? sendPlatformWhatsapp;
  const masked = maskPhoneE164(toE164);
  const first = await send({ toE164, text: messages[0], tenantId: subject.tenantId, noticeId: notice.id });

  if (first.outcome === "SENT") {
    // O Pix copia e cola vai sozinho, em mensagem separada. É melhor-esforço: se falhar, a primeira mensagem
    // já tem o link do painel, e reenviar o aviso inteiro duplicaria o texto no WhatsApp do dono.
    for (const extra of messages.slice(1)) {
      try {
        await (deps.sleep ?? defaultSleep)(WHATSAPP_PAIR_DELAY_MS);
        const second = await send({ toE164, text: extra, tenantId: subject.tenantId, noticeId: notice.id });
        if (second.outcome !== "SENT") logger.warn("billing.notice.whatsapp_pix_message_not_sent", { noticeId: notice.id, outcome: second.outcome });
      } catch (error) {
        logger.warn("billing.notice.whatsapp_pix_message_failed", { noticeId: notice.id, errorName: error instanceof Error ? error.name : "unknown" });
      }
    }
    await markNoticeSentSafely(notice.id, now, {
      recipientMasked: masked,
      providerMessageId: first.providerMessageId,
      platformConnectionId: first.connectionId,
      senderPhoneE164: first.senderPhoneE164,
    });
    summary.sent += 1;
    return "SENT";
  }

  if (first.outcome === "NO_PLATFORM_NUMBER" || first.outcome === "CHANNEL_DOWN") {
    if (STEP_POLICY[step].critical) {
      // Etapa crítica espera o número voltar, sempre dentro da janela (o planejador já a coloca nela).
      const eligibleFrom = nextSendableAt("WHATSAPP", step, notice.notBefore, subject.input.timezone);
      const holdUntil = Math.min(notice.expiresAt.getTime(), eligibleFrom.getTime() + CRITICAL_WAIT_FOR_CHANNEL_HOURS * 3_600_000);
      if (now.getTime() < holdUntil) {
        await releaseNotice(notice.id, addMinutes(now, WHATSAPP_RETRY_WAIT_MINUTES));
        summary.deferred += 1;
        return "DEFERRED";
      }
    }
    await markNoticeSkipped(notice.id, first.outcome, { recipientMasked: masked });
    return skip(summary);
  }

  if (first.outcome === "BLOCKED_LOOP") {
    await markNoticeSkipped(notice.id, "BLOCKED_LOOP", { recipientMasked: masked });
    return skip(summary);
  }

  await markNoticeFailed(notice.id, now, notice.attempts, "WHATSAPP_SEND_FAILED");
  summary.failed += 1;
  return "FAILED";
}
