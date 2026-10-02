import { getPrisma } from "@/lib/db/prisma";
import { globalState } from "@/lib/global-state";
import { logger } from "@/lib/logger";
import { sendMail, SmtpNotConfiguredError } from "@/lib/email";
import { tryGetPublicBaseUrl } from "@/lib/public-url";
import { loadRecipients } from "@/modules/billing/health-alert";

/**
 * Alerta de erro NOVO (Melhoria 1): e-mail ao admin da plataforma. O sino do admin é derivado direto dos grupos
 * (`platform-notifications/service.ts`), sem depender deste envio.
 *
 * - "Novo" = grupo OPEN com `alertedAt` nulo (grupo recém-criado, ou RESOLVED que voltou: o upsert zera `alertedAt`).
 * - Contra avalanche: no máximo 1 e-mail a cada `ERROR_ALERT_INTERVAL_MINUTES`, juntando todos os erros novos do
 *   período num só e-mail (até `MAX_GROUPS_PER_EMAIL`; o resto vai no próximo). A reserva da janela é atômica no
 *   banco (linha única em `ProviderEvent`, provider "error-alert", id = número da janela): dois disparos
 *   simultâneos nunca mandam dois e-mails.
 * - Texto livre de origem CLIENT (mensagem, tipo, rota) NUNCA entra no e-mail: a rota do navegador é pública e o texto é do
 *   atacante (link de phishing vindo do remetente oficial). O e-mail só traz a contagem de erros do navegador e o link
 *   para Admin > Erros; o texto do servidor segue como antes.
 * - Marcar `alertedAt` é uma reserva por `updateMany` condicional; se o envio falha (SMTP fora, sem destinatário), a marca
 *   é desfeita e a janela já gasta evita martelar o SMTP: o próximo e-mail tenta de novo na janela seguinte.
 * - Quem dispara: a própria captura (`scheduleErrorAlertFlush`, adiado se a janela está ocupada) e a manutenção diária.
 */

export const ERROR_ALERT_INTERVAL_MINUTES = 15;
const MAX_GROUPS_PER_EMAIL = 20;
const WINDOW_MS = ERROR_ALERT_INTERVAL_MINUTES * 60_000;
const PROVIDER = "error-alert";

export type ErrorAlertDeps = {
  /** Só para teste. Padrão: `sendMail`. */
  send?: (input: { to: string; subject: string; html: string; text: string }) => Promise<{ sent: boolean }>;
};

export type ErrorAlertResult =
  | { sent: false; reason: "NOTHING_PENDING" | "RATE_LIMITED" | "NO_RECIPIENT" | "SEND_FAILED" | "SMTP_NOT_CONFIGURED" | "ERROR" }
  | { sent: true; groups: number; recipients: number };

type AlertGroup = { id: string; type: string; message: string; route: string | null; source: string; lastVersion: string | null; count: number };

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Texto do e-mail. A mensagem já foi redigida na gravação. Exportada para teste. */
export function buildErrorAlertEmail(groups: AlertGroup[], extra: number, adminUrl: string | null): { subject: string; text: string; html: string } {
  const total = groups.length + extra;
  const subject = total === 1 ? "Erro novo no InnoChat" : `${total} erros novos no InnoChat`;
  const serverGroups = groups.filter((g) => g.source !== "CLIENT");
  const clientCount = groups.length - serverGroups.length;
  const describe = (g: AlertGroup) =>
    `No servidor: ${g.type}, ${g.message}${g.route ? ` (em ${g.route})` : ""}${g.lastVersion ? `, versão ${g.lastVersion}` : ""}.`;
  const clientLine =
    clientCount > 0 ? `${clientCount === 1 ? "1 erro novo no navegador" : `${clientCount} erros novos no navegador`} (o texto fica só na tela de Erros).` : null;
  const lines = [
    total === 1 ? "O InnoChat registrou um erro que ainda não tinha aparecido:" : `O InnoChat registrou ${total} erros que ainda não tinham aparecido:`,
    "",
    ...serverGroups.map((g) => `- ${describe(g)}`),
    ...(clientLine ? [`- ${clientLine}`] : []),
    ...(extra > 0 ? [`- E mais ${extra} no painel.`] : []),
    "",
    adminUrl ? `Veja os detalhes e marque como resolvido: ${adminUrl}` : "Veja os detalhes no painel do admin, em Erros.",
    "",
    `Para não lotar sua caixa, mandamos no máximo um e-mail a cada ${ERROR_ALERT_INTERVAL_MINUTES} minutos.`,
  ];
  const html =
    `<p>${total === 1 ? "O InnoChat registrou um erro que ainda não tinha aparecido:" : `O InnoChat registrou ${total} erros que ainda não tinham aparecido:`}</p>` +
    `<ul>${serverGroups.map((g) => `<li>${escapeHtml(describe(g))}</li>`).join("")}${clientLine ? `<li>${escapeHtml(clientLine)}</li>` : ""}${extra > 0 ? `<li>E mais ${extra} no painel.</li>` : ""}</ul>` +
    (adminUrl ? `<p><a href="${escapeHtml(adminUrl)}">Abrir a tela de Erros</a></p>` : "<p>Veja os detalhes no painel do admin, em Erros.</p>") +
    `<p>Para não lotar sua caixa, mandamos no máximo um e-mail a cada ${ERROR_ALERT_INTERVAL_MINUTES} minutos.</p>`;
  return { subject, text: lines.join("\n"), html };
}

const pendingWhere = { status: "OPEN", alertedAt: null } as const;

/** Nunca lança: é chamada de rotinas que não podem cair por causa de um aviso. */
export async function flushErrorAlerts(now: Date = new Date(), deps: ErrorAlertDeps = {}): Promise<ErrorAlertResult> {
  const prisma = getPrisma();
  try {
    if ((await prisma.errorGroup.count({ where: pendingWhere })) === 0) return { sent: false, reason: "NOTHING_PENDING" };

    // Reserva da janela de 15 min: a linha única decide quem envia (`skipDuplicates`: sem exceção nem log de erro do Prisma
    // a cada tentativa dentro da janela).
    const reserved = await prisma.providerEvent.createMany({
      data: [{ provider: PROVIDER, providerEventId: String(Math.floor(now.getTime() / WINDOW_MS)), payload: {}, processedAt: now }],
      skipDuplicates: true,
    });
    if (reserved.count === 0) return { sent: false, reason: "RATE_LIMITED" };

    const candidates = await prisma.errorGroup.findMany({ where: pendingWhere, orderBy: { firstSeenAt: "asc" }, take: MAX_GROUPS_PER_EMAIL, select: { id: true } });
    const ids = candidates.map((c) => c.id);
    const claimed = await prisma.errorGroup.updateMany({ where: { id: { in: ids }, ...pendingWhere }, data: { alertedAt: now } });
    if (claimed.count === 0) return { sent: false, reason: "NOTHING_PENDING" };

    const groups = await prisma.errorGroup.findMany({
      where: { id: { in: ids }, alertedAt: now },
      orderBy: { firstSeenAt: "asc" },
      select: { id: true, type: true, message: true, route: true, source: true, lastVersion: true, count: true },
    });
    const extra = Math.max(0, (await prisma.errorGroup.count({ where: pendingWhere })));
    const undo = () => prisma.errorGroup.updateMany({ where: { id: { in: groups.map((g) => g.id) }, alertedAt: now }, data: { alertedAt: null } });

    const recipients = await loadRecipients();
    if (recipients.length === 0) {
      logger.warn("errors.monitor.alert_no_recipient", {});
      await undo();
      return { sent: false, reason: "NO_RECIPIENT" };
    }

    const baseUrl = await tryGetPublicBaseUrl().catch(() => null);
    const mail = buildErrorAlertEmail(groups, extra, baseUrl ? `${baseUrl.replace(/\/$/, "")}/admin/erros` : null);
    const send = deps.send ?? sendMail;

    let delivered = 0;
    for (const to of recipients) {
      try {
        if ((await send({ to, ...mail })).sent) delivered += 1;
      } catch (error) {
        if (error instanceof SmtpNotConfiguredError) {
          logger.warn("errors.monitor.alert_smtp_not_configured", {});
          await undo();
          return { sent: false, reason: "SMTP_NOT_CONFIGURED" };
        }
        throw error;
      }
    }
    if (delivered === 0) {
      logger.warn("errors.monitor.alert_send_failed", { recipients: recipients.length });
      await undo();
      return { sent: false, reason: "SEND_FAILED" };
    }
    logger.info("errors.monitor.alert_sent", { groups: groups.length, recipients: delivered });
    return { sent: true, groups: groups.length, recipients: delivered };
  } catch (error) {
    // `warn`, nunca `error`: `logger.error` alimenta a captura e um erro no alerta viraria mais um alerta.
    logger.warn("errors.monitor.alert_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    return { sent: false, reason: "ERROR" };
  }
}

// Em `globalThis` (ver `src/lib/global-state.ts`): um único timer por processo, não um por bundle do Next.
const timerState = globalState("error-alert-timer", () => ({ timer: null as ReturnType<typeof setTimeout> | null }));

/**
 * Pede o envio sem esperar. Se a janela está ocupada, agenda uma nova tentativa para o começo da próxima (um único
 * timer por processo, sem segurar o processo vivo): assim o erro novo recebido no meio da janela não espera o próximo erro.
 */
export function scheduleErrorAlertFlush(): void {
  if (timerState.timer) return;
  void flushErrorAlerts().then((result) => {
    if (result.sent === false && result.reason === "RATE_LIMITED" && !timerState.timer) {
      const wait = WINDOW_MS - (Date.now() % WINDOW_MS) + 1_000;
      timerState.timer = setTimeout(() => {
        timerState.timer = null;
        void flushErrorAlerts();
      }, wait);
      timerState.timer.unref?.();
    }
  });
}

/** Só para testes. */
export function __resetAlertTimerForTests() {
  if (timerState.timer) clearTimeout(timerState.timer);
  timerState.timer = null;
}
