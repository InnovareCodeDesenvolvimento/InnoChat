import { getPrisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { retryDelayMinutes, type PlannedNotice } from "@/core/billing";

/**
 * Outbox da régua (`BillingNotice`, docs/regua-de-cobranca.md §2.5): gravação idempotente, saída de fila e
 * transições de estado. As transições são CONDICIONAIS em `status = SENDING`: se o aviso foi recuperado de
 * um envio preso e outro despachante já o concluiu, o resultado atrasado não sobrescreve nada.
 *
 * Contrato do CHECK do banco: `status = SKIPPED` se e somente se `skippedReason` não é nulo.
 */

export type SkipReason =
  | "PAID"
  | "STATUS_CHANGED"
  | "NO_RECIPIENT"
  | "OPTED_OUT"
  | "NO_PLATFORM_NUMBER"
  | "CHANNEL_DOWN"
  | "OUT_OF_WINDOW_EXPIRED"
  | "PERMANENT_REJECTION"
  | "BLOCKED_LOOP"
  | "MANUAL_SUSPENSION"
  | "UNCONFIRMED_DAILY_LIMIT"
  | "LEGACY_SENT";

/** "jo***@gmail.com": o suporte confere "foi para o endereço certo?" sem expor o dado. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, Math.min(2, local.length))}***@${domain}`;
}

/** "+55 84 9****-1234" a partir de só dígitos com DDI. */
export function maskPhoneE164(e164: string): string {
  const d = e164.replace(/\D/g, "");
  if (d.length < 12) return "+** ****";
  const ddd = d.slice(2, 4);
  const sub = d.slice(4);
  return `+${d.slice(0, 2)} ${ddd} ${sub.slice(0, 1)}****-${sub.slice(-4)}`;
}

/**
 * Reenvio manual pelo Admin (F6): o aviso novo leva `<cycleKey original>:resend:<id do aviso reenviado>`. A chave única
 * `(cycleKey, step, channel)` torna o reenvio idempotente (reenviar o MESMO aviso duas vezes não cria dois). O despachante
 * reconfere "ainda é devido?" com a chave ORIGINAL, então reenviar nunca cobra quem já pagou nem uma etapa que já passou.
 */
export const RESEND_CYCLE_MARKER = ":resend:";

export function baseCycleKey(cycleKey: string): string {
  const index = cycleKey.indexOf(RESEND_CYCLE_MARKER);
  return index === -1 ? cycleKey : cycleKey.slice(0, index);
}

type EnqueueSubject = { tenantId: string; subscriptionId: string };

/**
 * Grava os avisos planejados com `ON CONFLICT DO NOTHING` na chave `(cycleKey, step, channel)`: planejar
 * duas vezes (dois ticks, tick + reprocessamento) nunca cria dois. Devolve quantas linhas NASCERAM.
 */
export async function enqueueNotices(subject: EnqueueSubject, planned: PlannedNotice[]): Promise<number> {
  if (planned.length === 0) return 0;
  const result = await getPrisma().billingNotice.createMany({
    data: planned.map((p) => ({
      tenantId: subject.tenantId,
      subscriptionId: subject.subscriptionId,
      invoiceId: p.invoiceId,
      step: p.step,
      channel: p.channel,
      cycleKey: p.cycleKey,
      status: "PENDING",
      notBefore: p.notBefore,
      expiresAt: p.expiresAt,
      nextAttemptAt: p.notBefore,
    })),
    skipDuplicates: true,
  });
  return result.count;
}

/** `PENDING` cujo prazo passou sem nunca ter saído: a mensagem ficaria desatualizada e é encerrada. */
export async function expireStaleNotices(now: Date): Promise<number> {
  const result = await getPrisma().billingNotice.updateMany({
    where: { status: "PENDING", expiresAt: { lte: now } },
    data: { status: "SKIPPED", skippedReason: "OUT_OF_WINDOW_EXPIRED" },
  });
  return result.count;
}

/**
 * `SENDING` preso (o processo morreu no envio) que já gastou todas as tentativas: o claim não o pega mais, e sem isto ele
 * ficaria `SENDING` para sempre, invisível. Vira `FAILED` terminal (`attempts >= maxAttempts` não é reivindicável).
 */
export async function failExhaustedStuckNotices(stuckBefore: Date, maxAttempts: number): Promise<number> {
  const result = await getPrisma().billingNotice.updateMany({
    where: { status: "SENDING", updatedAt: { lt: stuckBefore }, attempts: { gte: maxAttempts } },
    data: { status: "FAILED", lastErrorCode: "STUCK_MAX_ATTEMPTS" },
  });
  return result.count;
}

export type NoticeRecipientKind = "OWNER" | "BILLING_EMAIL" | "BILLING_WHATSAPP";

/** Teto do texto guardado no snapshot (o maior aviso tem ~2 mil caracteres; o resto é folga, não vira armazenamento ilimitado). */
const SNAPSHOT_MAX_CHARS = 8000;

/**
 * F6: destino COMPLETO + snapshot do que foi enviado, para o registro global do Admin. Dado pessoal: só vai ao banco
 * (nunca a log) e a manutenção zera depois de 12 meses (`purgeNoticePersonalData`).
 */
export type NoticeAuditFields = {
  recipient?: string | null;
  recipientKind?: NoticeRecipientKind | null;
  renderedSubject?: string | null;
  renderedText?: string | null;
};

function auditData(extra: NoticeAuditFields | undefined) {
  if (!extra) return {};
  return {
    ...(extra.recipient !== undefined ? { recipient: extra.recipient?.slice(0, 500) ?? null } : {}),
    ...(extra.recipientKind !== undefined ? { recipientKind: extra.recipientKind } : {}),
    ...(extra.renderedSubject !== undefined ? { renderedSubject: extra.renderedSubject?.slice(0, 300) ?? null } : {}),
    ...(extra.renderedText !== undefined ? { renderedText: extra.renderedText?.slice(0, SNAPSHOT_MAX_CHARS) ?? null } : {}),
  };
}

/** Separador entre as mensagens de um mesmo aviso de WhatsApp (texto + Pix copia e cola) dentro de `renderedText`. */
export const RENDERED_PARTS_SEPARATOR = "\n\n<<<mensagem-seguinte>>>\n\n";

export async function markNoticeSent(
  id: string,
  now: Date,
  data: { recipientMasked: string | null; providerMessageId?: string | null; platformConnectionId?: string | null; senderPhoneE164?: string | null } & NoticeAuditFields,
): Promise<void> {
  await getPrisma().billingNotice.updateMany({
    where: { id, status: "SENDING" },
    data: {
      status: "SENT",
      sentAt: now,
      attempts: { increment: 1 },
      lastErrorCode: null,
      recipientMasked: data.recipientMasked,
      providerMessageId: data.providerMessageId ?? null,
      platformConnectionId: data.platformConnectionId ?? null,
      senderPhoneE164: data.senderPhoneE164 ?? null,
      ...auditData(data),
    },
  });
}

/**
 * Grava `SENT` DEPOIS de a mensagem já ter saído. Se a gravação falhar (ex.: a conexão que enviou foi removida e a
 * FK recusou), tenta de novo sem os campos da conexão: reenviar o aviso por causa de um erro de bookkeeping
 * duplicaria a mensagem no celular do cliente. Se nem isso der, só loga (o aviso será recuperado como `SENDING` preso).
 */
export async function markNoticeSentSafely(...args: Parameters<typeof markNoticeSent>): Promise<void> {
  const [id, now, data] = args;
  try {
    await markNoticeSent(id, now, data);
    return;
  } catch (error) {
    logger.error("billing.notice.mark_sent_failed", { noticeId: id, errorName: error instanceof Error ? error.name : "unknown" });
  }
  try {
    await markNoticeSent(id, now, {
      recipientMasked: data.recipientMasked,
      providerMessageId: data.providerMessageId,
      recipient: data.recipient,
      recipientKind: data.recipientKind,
      renderedSubject: data.renderedSubject,
      renderedText: data.renderedText,
    });
    return;
  } catch (error) {
    logger.error("billing.notice.mark_sent_retry_failed", { noticeId: id, errorName: error instanceof Error ? error.name : "unknown" });
  }
  // 3a tentativa, a mais enxuta possivel: so o status e o instante (sem nenhum campo extra que possa recusar a
  // gravacao). Se nem isso gravar, o aviso fica SENDING e o claim o recupera no maximo `NOTICE_MAX_ATTEMPTS` vezes.
  try {
    await getPrisma().billingNotice.updateMany({ where: { id, status: "SENDING" }, data: { status: "SENT", sentAt: now } });
  } catch (error) {
    logger.error("billing.notice.mark_sent_minimal_failed", { noticeId: id, errorName: error instanceof Error ? error.name : "unknown" });
  }
}

export async function markNoticeSkipped(id: string, reason: SkipReason, extra: { recipientMasked?: string | null } & NoticeAuditFields = {}): Promise<void> {
  await getPrisma().billingNotice.updateMany({
    where: { id, status: "SENDING" },
    data: { status: "SKIPPED", skippedReason: reason, ...(extra.recipientMasked !== undefined ? { recipientMasked: extra.recipientMasked } : {}), ...auditData(extra) },
  });
}

/** Falhou nesta tentativa: espera crescente até o teto de tentativas ou o prazo do aviso. Só o CÓDIGO do erro é gravado. */
export async function markNoticeFailed(id: string, now: Date, attemptsBefore: number, errorCode: string, extra?: NoticeAuditFields): Promise<void> {
  const attempts = attemptsBefore + 1;
  await getPrisma().billingNotice.updateMany({
    where: { id, status: "SENDING" },
    data: {
      status: "FAILED",
      attempts,
      lastErrorCode: errorCode.slice(0, 60),
      nextAttemptAt: new Date(now.getTime() + retryDelayMinutes(attempts) * 60_000),
      ...auditData(extra),
    },
  });
}

/** Devolve o aviso à fila SEM contar tentativa (fora da janela de horário, ou esperando o canal voltar). */
export async function releaseNotice(id: string, nextAttemptAt: Date): Promise<void> {
  await getPrisma().billingNotice.updateMany({ where: { id, status: "SENDING" }, data: { status: "PENDING", nextAttemptAt } });
}

/**
 * Grava o aviso de cancelamento automático JÁ encerrado (`SKIPPED/STATUS_CHANGED`) para a conta que está sendo
 * reativada agora: "sua conta foi encerrada" seria ruído, e a chave única impede o planejador de recriá-lo.
 */
export async function suppressAutoCancelNotices(tenantId: string, subscriptionId: string, currentPeriodEnd: Date): Promise<void> {
  const now = new Date();
  await getPrisma().billingNotice.createMany({
    data: (["EMAIL", "WHATSAPP"] as const).map((channel) => ({
      tenantId,
      subscriptionId,
      step: "AUTO_CANCELED",
      channel,
      cycleKey: `${subscriptionId}:${currentPeriodEnd.toISOString()}`,
      status: "SKIPPED",
      skippedReason: "STATUS_CHANGED",
      notBefore: now,
      expiresAt: now,
      nextAttemptAt: now,
    })),
    skipDuplicates: true,
  });
}

/**
 * "Fatura gerada" enviada NA HORA pelo cadastro: grava a linha já como `SENT` (chave `invoiceId + INVOICE_CREATED +
 * EMAIL`, a mesma do planejador e do backfill), para a régua não mandar o mesmo aviso de novo. Idempotente.
 */
export async function recordInlineInvoiceNotice(args: { tenantId: string; subscriptionId: string; invoiceId: string; expiresAt: Date; recipientMasked: string; recipient?: string | null }): Promise<void> {
  const now = new Date();
  await getPrisma().billingNotice.createMany({
    data: [
      {
        tenantId: args.tenantId,
        subscriptionId: args.subscriptionId,
        invoiceId: args.invoiceId,
        step: "INVOICE_CREATED",
        channel: "EMAIL",
        cycleKey: args.invoiceId,
        status: "SENT",
        attempts: 1,
        notBefore: now,
        expiresAt: args.expiresAt,
        nextAttemptAt: now,
        sentAt: now,
        recipientMasked: args.recipientMasked,
        recipient: args.recipient ?? null,
        recipientKind: args.recipient ? "OWNER" : null,
      },
    ],
    skipDuplicates: true,
  });
}
