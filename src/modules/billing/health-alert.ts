import { getPrisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { sendMail, SmtpNotConfiguredError } from "@/lib/email";
import { tryGetPublicBaseUrl } from "@/lib/public-url";
import { BILLING_DOWN_ALERT_INTERVAL_HOURS, type BillingHealthReason, type BillingHealthReport } from "@/core/billing/billing-health";

/**
 * Aviso por e-mail ao admin da plataforma quando a cobrança vira `down` (F7).
 *
 * QUEM DISPARA. O tick de cobrança não pode avisar que parou: se ele não roda, nada o chama. Por isso há dois gatilhos que
 * não dependem dele: o próprio `GET /api/health/billing` (consultado a cada 5 min pelo monitor externo) e a manutenção
 * diária (`maintenance/tick`). Os dois vêm do n8n/monitor; se o n8n inteiro cair, a manutenção também não roda, e a
 * garantia real é o monitor EXTERNO (UptimeRobot), que avisa por conta própria, sem passar por este sistema.
 * O e-mail sai pelo SMTP da plataforma: se o SMTP for justamente o que quebrou, ele também não chega. Outro motivo para
 * o monitor externo ser a garantia real.
 *
 * LIMITE DE 1 E-MAIL A CADA 6 H. A reserva é atômica no banco (`UPDATE ... WHERE lastBillingDownAlertAt IS NULL OR < corte`):
 * dois disparos simultâneos nunca mandam dois e-mails. Se o envio falhar, a reserva é refeita para tentar de novo em
 * `RETRY_AFTER_FAILURE_MINUTES`, em vez de ficar 6 h sem aviso.
 */

const HOUR_MS = 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MINUTES = 30;
const MAX_RECIPIENTS = 5;

const REASON_TEXT: Record<BillingHealthReason, string> = {
  TICK_STALE: "A rotina de cobrança não roda há mais de 3 horas.",
  TICK_NEVER_RAN: "A rotina de cobrança nunca rodou.",
  NOTICES_STUCK_EMAIL: "Há avisos por e-mail que passaram da hora e não saíram.",
  EMAIL_FAILING_IN_SEQUENCE: "Os e-mails de cobrança estão falhando rodada após rodada.",
  TICK_DEADLINE_REACHED: "A última rodada parou por falta de tempo.",
  TICK_LOCK_TIMED_OUT: "A última rodada passou do tempo limite.",
  NOTICES_STUCK_WHATSAPP: "Há avisos por WhatsApp parados.",
  EMAIL_FAILED_LAST_ROUND: "Alguns e-mails falharam na última rodada.",
  PLATFORM_WHATSAPP_DOWN: "O WhatsApp de cobrança está fora do ar.",
  HEALTH_UNAVAILABLE: "Não foi possível medir a saúde da cobrança.",
};

export type BillingDownAlertDeps = {
  /** Só para teste. Padrão: `sendMail`. */
  send?: (input: { to: string; subject: string; html: string; text: string }) => Promise<{ sent: boolean }>;
};

export type BillingDownAlertResult =
  | { sent: false; reason: "NOT_DOWN" | "RATE_LIMITED" | "NO_RECIPIENT" | "SEND_FAILED" | "SMTP_NOT_CONFIGURED" | "ERROR" }
  | { sent: true; recipients: number };

/** Destinatários: os usuários admin da plataforma; sem nenhum, o contato de Dados da empresa. Nunca vai a log. */
export async function loadRecipients(): Promise<string[]> {
  const prisma = getPrisma();
  const admins = await prisma.user.findMany({
    where: { isPlatformAdmin: true },
    orderBy: { createdAt: "asc" },
    take: MAX_RECIPIENTS,
    select: { email: true },
  });
  const emails = admins.map((a) => a.email).filter((e): e is string => typeof e === "string" && e.includes("@"));
  if (emails.length > 0) return [...new Set(emails)];
  const settings = await prisma.platformSettings.findUnique({ where: { id: 1 }, select: { contactEmail: true } });
  return settings?.contactEmail?.includes("@") ? [settings.contactEmail] : [];
}

/** Texto do e-mail. Só motivos fixos e números: nenhum dado de cliente. Exportada para teste. */
export function buildBillingDownEmail(report: BillingHealthReport, adminUrl: string | null): { subject: string; text: string; html: string } {
  const reasons = report.reasons.map((r) => REASON_TEXT[r]);
  const since = report.minutesSinceLastTick === null ? "nunca rodou" : `há ${Math.floor(report.minutesSinceLastTick / 60)} h e ${report.minutesSinceLastTick % 60} min`;
  const lines = [
    "A cobrança do InnoChat parou de andar. Enquanto isso, nenhum aviso de mensalidade sai e nenhuma assinatura é atualizada.",
    "",
    ...reasons.map((r) => `- ${r}`),
    "",
    `Última rodada: ${since}.`,
    `Avisos vencidos presos: ${report.pendingOverdue}. Falhas nas últimas 24 h: ${report.failedLast24h}.`,
    "",
    "O que fazer: abra o n8n e confira se o fluxo do cron (innochat-cron) está ligado e sem erro. Depois rode a rotina de cobrança à mão e veja a tela Saúde.",
    ...(adminUrl ? ["", `Tela Saúde: ${adminUrl}`] : []),
    "",
    `Este aviso sai no máximo a cada ${BILLING_DOWN_ALERT_INTERVAL_HOURS} horas enquanto o problema durar.`,
  ];
  const text = lines.join("\n");
  const html =
    `<p>A cobrança do InnoChat parou de andar. Enquanto isso, nenhum aviso de mensalidade sai e nenhuma assinatura é atualizada.</p>` +
    `<ul>${reasons.map((r) => `<li>${r}</li>`).join("")}</ul>` +
    `<p>Última rodada: ${since}.<br>Avisos vencidos presos: ${report.pendingOverdue}. Falhas nas últimas 24 h: ${report.failedLast24h}.</p>` +
    `<p>O que fazer: abra o n8n e confira se o fluxo do cron (innochat-cron) está ligado e sem erro. Depois rode a rotina de cobrança à mão e veja a tela Saúde.</p>` +
    (adminUrl ? `<p><a href="${adminUrl}">Abrir a tela Saúde</a></p>` : "") +
    `<p>Este aviso sai no máximo a cada ${BILLING_DOWN_ALERT_INTERVAL_HOURS} horas enquanto o problema durar.</p>`;
  return { subject: "Cobrança do InnoChat parada", text, html };
}

/** Reserva a janela de 6 h. `true` = esta chamada ganhou o direito de enviar. */
async function claimAlertWindow(now: Date): Promise<boolean> {
  const cutoff = new Date(now.getTime() - BILLING_DOWN_ALERT_INTERVAL_HOURS * HOUR_MS);
  const claimed = await getPrisma().platformSettings.updateMany({
    where: { id: 1, OR: [{ lastBillingDownAlertAt: null }, { lastBillingDownAlertAt: { lt: cutoff } }] },
    data: { lastBillingDownAlertAt: now },
  });
  return claimed.count === 1;
}

/** Falhou: devolve a reserva para a próxima tentativa daqui a pouco, não daqui a 6 h. */
async function scheduleRetry(now: Date): Promise<void> {
  const retryMark = new Date(now.getTime() - (BILLING_DOWN_ALERT_INTERVAL_HOURS * 60 - RETRY_AFTER_FAILURE_MINUTES) * 60_000);
  await getPrisma().platformSettings.updateMany({ where: { id: 1, lastBillingDownAlertAt: now }, data: { lastBillingDownAlertAt: retryMark } });
}

/** Nunca lança: é chamada de rotas e de rotinas que não podem cair por causa de um aviso. */
export async function notifyAdminBillingDown(report: BillingHealthReport, now: Date = new Date(), deps: BillingDownAlertDeps = {}): Promise<BillingDownAlertResult> {
  if (report.status !== "down") return { sent: false, reason: "NOT_DOWN" };
  try {
    if (!(await claimAlertWindow(now))) return { sent: false, reason: "RATE_LIMITED" };

    const recipients = await loadRecipients();
    if (recipients.length === 0) {
      logger.warn("billing.monitor.alert_no_recipient", {});
      await scheduleRetry(now);
      return { sent: false, reason: "NO_RECIPIENT" };
    }

    const baseUrl = await tryGetPublicBaseUrl().catch(() => null);
    const mail = buildBillingDownEmail(report, baseUrl ? `${baseUrl.replace(/\/$/, "")}/admin/saude` : null);
    const send = deps.send ?? sendMail;

    let delivered = 0;
    for (const to of recipients) {
      try {
        const result = await send({ to, ...mail });
        if (result.sent) delivered += 1;
      } catch (error) {
        if (error instanceof SmtpNotConfiguredError) {
          logger.warn("billing.monitor.alert_smtp_not_configured", {});
          await scheduleRetry(now);
          return { sent: false, reason: "SMTP_NOT_CONFIGURED" };
        }
        throw error;
      }
    }
    if (delivered === 0) {
      logger.warn("billing.monitor.alert_send_failed", { recipients: recipients.length });
      await scheduleRetry(now);
      return { sent: false, reason: "SEND_FAILED" };
    }
    logger.warn("billing.monitor.down_alert_sent", { recipients: delivered, reasons: report.reasons });
    return { sent: true, recipients: delivered };
  } catch (error) {
    logger.error("billing.monitor.alert_error", { errorName: error instanceof Error ? error.name : "unknown" });
    await scheduleRetry(now).catch(() => undefined);
    return { sent: false, reason: "ERROR" };
  }
}
