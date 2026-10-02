import { addDays } from "date-fns";
import { getPrisma } from "@/lib/db/prisma";
import { isUniqueViolation } from "@/lib/db/prisma-errors";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { Prisma } from "@/lib/db/types";
import { loadEmailContext, renderDunningEmail } from "@/lib/email";
import {
  addDaysToLocalDate,
  buildWhatsappMessages,
  DEFAULT_BILLING_TIMEZONE,
  isDunningStep,
  NOTICE_MAX_ATTEMPTS,
  noticeErrorLabel,
  noticeStatusLabel,
  skippedReasonLabel,
  startOfLocalDay,
  stepLabel,
  type DunningStep,
} from "@/core/billing";
import { formatPhoneDisplay } from "@/core/platform-whatsapp/rules";
import { buildNoticeCopyContext } from "./dunning/context";
import { dispatchDueNotices, type DispatchDeps } from "./dunning/dispatcher";
import { recordBillingEvent } from "./dunning/events";
import { baseCycleKey, RENDERED_PARTS_SEPARATOR, RESEND_CYCLE_MARKER, type NoticeRecipientKind } from "./dunning/outbox";
import { resolveNoticeRecipients } from "./dunning/recipients";
import { loadDunningSubject } from "./dunning/snapshot";
import { NOT_LEGACY_NOTICE } from "./finance-service";
import { DEFAULT_PAGE_SIZE, pageInfoOf, resolvePage, type PageInfo, type PageSize } from "./paging";

/**
 * Registro global de envios da régua para o Admin da plataforma ("quais mensagens de cobrança e lembrete foram
 * enviadas, para quem"). Só I/O: `requirePlatformAdmin` fica em `finance-actions.ts`.
 *
 * Dado pessoal: o destino COMPLETO (`BillingNotice.recipient`) só é lido aqui, para o admin (o controlador). Nada
 * disso vai para log. A manutenção zera `recipient`/`renderedText` com mais de 12 meses; depois disso o registro
 * mostra o `recipientMasked` com a marca de "registro anterior".
 */

export type NoticeChannelFilter = "EMAIL" | "WHATSAPP";
export type NoticeStatusFilter = "PENDING" | "SENDING" | "SENT" | "FAILED" | "SKIPPED";

export type NoticeRegisterFilters = {
  /** Datas "YYYY-MM-DD" (inclusivas) no fuso de São Paulo; filtram pela última mudança do aviso. */
  from?: string;
  to?: string;
  /** Busca por nome da empresa (contém, sem diferenciar maiúsculas). */
  tenantQuery?: string;
  tenantId?: string;
  channel?: NoticeChannelFilter;
  status?: NoticeStatusFilter;
  step?: DunningStep;
  /** FAILED, mais os "não enviado" por problema de entrega (sem número da plataforma, canal fora do ar, recusa, sem destinatário). */
  onlyFailures?: boolean;
  /** Página (1-based). Fora do intervalo devolve a última página válida. */
  page?: number;
  /** 10 | 25 | 50 | 100 (padrão 25). */
  pageSize?: PageSize;
};

export type NoticeRegisterItem = {
  id: string;
  at: string;
  tenant: { id: string; name: string; slug: string };
  step: string;
  stepLabel: string;
  channel: NoticeChannelFilter;
  status: NoticeStatusFilter;
  statusLabel: string;
  skippedReason?: string;
  skippedReasonLabel?: string;
  /** Destino COMPLETO (e-mail, ou telefone só com dígitos e DDI). Se `recipientIsMasked`, é o valor mascarado do registro antigo. `null` = ainda sem destino definido. */
  recipient: string | null;
  /** Telefone formatado "+55 84 99999-1234" (e-mail: igual a `recipient`). */
  recipientDisplay: string | null;
  /** `true` para avisos anteriores à F6 ou já apagados pela retenção: só existe o valor mascarado. */
  recipientIsMasked: boolean;
  recipientNote?: string;
  recipientKind: NoticeRecipientKind | null;
  senderPhoneDisplay?: string;
  attempts: number;
  lastErrorCode?: string;
  lastErrorLabel?: string;
  /** E-mail: id da mensagem atribuído no envio e resposta do servidor SMTP (evidência de que foi ACEITO; não prova que chegou na caixa). */
  providerMessageId?: string;
  providerResponse?: string;
  /** Há texto guardado (snapshot) para a prévia exata. */
  hasSnapshot: boolean;
  /** Pode ser reenviado pelo botão: a régua desistiu (falha esgotada) ou não saiu por motivo temporário, e não há outro aviso igual enviado ou em andamento. */
  canResend: boolean;
  invoice?: { id: string; amountCents: number; dueAt: string };
};

export type NoticeRegisterPage = PageInfo & {
  items: NoticeRegisterItem[];
  /** Contagem do mesmo recorte (período, empresa, canal, etapa), SEM o filtro de situação: alimenta os cartões. */
  totals: { sent: number; failed: number; skipped: number; pending: number };
};

/** "Não enviado" por problema de entrega (entra no filtro "só falhas"). */
const PROBLEM_SKIP_REASONS = ["NO_PLATFORM_NUMBER", "CHANNEL_DOWN", "PERMANENT_REJECTION", "NO_RECIPIENT"] as const;

/** Motivos de "não enviado" que o admin pode reenviar (temporários). Os demais (já pago, opt-out, mudou de situação...) não. */
const RESENDABLE_SKIP_REASONS = ["NO_PLATFORM_NUMBER", "CHANNEL_DOWN", "OUT_OF_WINDOW_EXPIRED", "UNCONFIRMED_DAILY_LIMIT", "NO_RECIPIENT"] as const;

const LEGACY_MASKED_NOTE = "Registro anterior: o destino completo não foi guardado, só a versão mascarada.";

type ResendCandidate = {
  id: string;
  tenantId: string;
  step: string;
  channel: string;
  cycleKey: string;
  status: string;
  skippedReason: string | null;
  attempts: number;
  expiresAt: Date;
};

/**
 * Situação do próprio aviso. `FAILED` só é reenviável quando a régua DESISTIU dele (tentativas esgotadas ou prazo
 * vencido): enquanto o despachante ainda vai tentar de novo, reenviar manda a mensagem duas vezes.
 */
function isResendableState(n: Pick<ResendCandidate, "status" | "skippedReason" | "attempts" | "expiresAt">, now: Date): boolean {
  if (n.status === "FAILED") return n.attempts >= NOTICE_MAX_ATTEMPTS || n.expiresAt <= now;
  return n.status === "SKIPPED" && n.skippedReason !== null && (RESENDABLE_SKIP_REASONS as readonly string[]).includes(n.skippedReason);
}

/** Avisos da MESMA chave base (`step`, `channel`, `baseCycleKey`), inclusive reenvios anteriores, já enviados ou em andamento. */
async function loadBlockingNotices(candidates: ResendCandidate[]): Promise<Array<{ id: string; step: string; channel: string; cycleKey: string }>> {
  if (candidates.length === 0) return [];
  return getPrisma().billingNotice.findMany({
    where: {
      status: { in: ["SENT", "PENDING", "SENDING"] },
      OR: candidates.map((c) => {
        const base = baseCycleKey(c.cycleKey);
        return {
          tenantId: c.tenantId,
          step: c.step,
          channel: c.channel,
          OR: [{ cycleKey: base }, { cycleKey: { startsWith: `${base}${RESEND_CYCLE_MARKER}` } }],
        };
      }),
    },
    select: { id: true, step: true, channel: true, cycleKey: true },
  });
}

function isBlockedBy(c: ResendCandidate, blockers: Array<{ id: string; step: string; channel: string; cycleKey: string }>): boolean {
  const base = baseCycleKey(c.cycleKey);
  return blockers.some((b) => b.id !== c.id && b.step === c.step && b.channel === c.channel && baseCycleKey(b.cycleKey) === base);
}

function localDayStart(date: string): Date {
  return startOfLocalDay(date, DEFAULT_BILLING_TIMEZONE);
}

function buildBaseWhere(filters: NoticeRegisterFilters): Prisma.BillingNoticeWhereInput[] {
  const and: Prisma.BillingNoticeWhereInput[] = [NOT_LEGACY_NOTICE];
  if (filters.from || filters.to) {
    // A coluna "Quando" mostra `sentAt ?? updatedAt`: filtra pelo MESMO instante. `sentAt` só é gravado em SENT (e `updatedAt`
    // não muda depois, salvo na retenção, que usa SQL cru justamente para isso); as demais situações caem no `updatedAt`. Sem índice novo em `sentAt` (migration só aditiva seria possível): o registro é pequeno (alguns avisos por empresa ao mês) e a consulta já filtra por período, então a varredura é aceitável; reavaliar se passar de centenas de milhares de linhas.
    const range = {
      ...(filters.from ? { gte: localDayStart(filters.from) } : {}),
      ...(filters.to ? { lt: localDayStart(addDaysToLocalDate(filters.to, 1)) } : {}),
    };
    and.push({ OR: [{ sentAt: range }, { sentAt: null, updatedAt: range }] });
  }
  if (filters.tenantId) and.push({ tenantId: filters.tenantId });
  if (filters.tenantQuery) and.push({ tenant: { name: { contains: filters.tenantQuery, mode: "insensitive" } } });
  if (filters.channel) and.push({ channel: filters.channel });
  if (filters.step) and.push({ step: filters.step });
  return and;
}

export async function listBillingNotices(filters: NoticeRegisterFilters = {}): Promise<NoticeRegisterPage> {
  const prisma = getPrisma();
  const pageSize = filters.pageSize ?? DEFAULT_PAGE_SIZE;

  const base = buildBaseWhere(filters);
  const listAnd: Prisma.BillingNoticeWhereInput[] = [...base];
  if (filters.status) listAnd.push({ status: filters.status });
  if (filters.onlyFailures) {
    listAnd.push({ OR: [{ status: "FAILED" }, { status: "SKIPPED", skippedReason: { in: [...PROBLEM_SKIP_REASONS] } }] });
  }

  // `count` com os MESMOS filtros da lista; os totais dos cartões ignoram só o filtro de situação.
  const [totalItems, grouped] = await Promise.all([
    prisma.billingNotice.count({ where: { AND: listAnd } }),
    prisma.billingNotice.groupBy({ by: ["status"], where: { AND: base }, _count: { _all: true } }),
  ]);
  const info = resolvePage(filters.page, pageSize, totalItems);

  const page = await prisma.billingNotice.findMany({
    where: { AND: listAnd },
    // Ordem estável (o id desempata): a mesma linha nunca aparece em duas páginas nem some entre elas.
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    skip: info.skip,
    take: info.pageSize,
    include: {
      tenant: { select: { id: true, name: true, slug: true } },
      invoice: { select: { id: true, amountCents: true, dueAt: true } },
    },
  });

  const count = (status: string) => grouped.find((g) => g.status === status)?._count._all ?? 0;
  const resendNow = new Date();
  const resendCandidates = page.filter((n) => isResendableState(n, resendNow));
  const blockers = await loadBlockingNotices(resendCandidates);
  const canResendIds = new Set(resendCandidates.filter((n) => !isBlockedBy(n, blockers)).map((n) => n.id));
  const items = page.map((n): NoticeRegisterItem => {
    const full = n.recipient;
    const recipient = full ?? n.recipientMasked ?? null;
    const channel: NoticeChannelFilter = n.channel === "WHATSAPP" ? "WHATSAPP" : "EMAIL";
    const kind = (n.recipientKind as NoticeRecipientKind | null) ?? (channel === "WHATSAPP" && recipient ? "BILLING_WHATSAPP" : null);
    const item: NoticeRegisterItem = {
      id: n.id,
      at: (n.sentAt ?? n.updatedAt).toISOString(),
      tenant: n.tenant,
      step: n.step,
      stepLabel: stepLabel(n.step),
      channel,
      status: n.status as NoticeStatusFilter,
      statusLabel: noticeStatusLabel(n.status),
      recipient,
      recipientDisplay: full && channel === "WHATSAPP" ? formatPhoneDisplay(full) : recipient,
      recipientIsMasked: full === null && n.recipientMasked !== null,
      recipientKind: kind,
      attempts: n.attempts,
      hasSnapshot: n.renderedText !== null,
      canResend: canResendIds.has(n.id),
    };
    if (item.recipientIsMasked) item.recipientNote = LEGACY_MASKED_NOTE;
    if (n.skippedReason) {
      item.skippedReason = n.skippedReason;
      item.skippedReasonLabel = skippedReasonLabel(n.skippedReason);
    }
    if (n.channel === "EMAIL" && n.providerMessageId) item.providerMessageId = n.providerMessageId;
    if (n.channel === "EMAIL" && n.providerResponse) item.providerResponse = n.providerResponse;
    if (n.senderPhoneE164) item.senderPhoneDisplay = formatPhoneDisplay(n.senderPhoneE164) ?? undefined;
    if (n.lastErrorCode) {
      item.lastErrorCode = n.lastErrorCode;
      item.lastErrorLabel = noticeErrorLabel(n.lastErrorCode);
    }
    if (n.invoice) item.invoice = { id: n.invoice.id, amountCents: n.invoice.amountCents, dueAt: n.invoice.dueAt.toISOString() };
    return item;
  });

  return {
    items,
    ...pageInfoOf(info),
    totals: { sent: count("SENT"), failed: count("FAILED"), skipped: count("SKIPPED"), pending: count("PENDING") + count("SENDING") },
  };
}

// ---------------------------------------------------------------------------
// Prévia da mensagem
// ---------------------------------------------------------------------------

export type NoticePreview = {
  noticeId: string;
  channel: NoticeChannelFilter;
  step: string;
  stepLabel: string;
  /** Só e-mail. */
  subject: string | null;
  /** E-mail: texto puro. WhatsApp: as mensagens do aviso unidas por linha em branco. */
  text: string;
  /** WhatsApp: cada mensagem enviada em separado (o Pix copia e cola vai sozinho). E-mail: uma só. */
  messages: string[];
  /** `SNAPSHOT` = o texto exato guardado no envio. `REBUILT` = remontado agora com os dados de hoje. */
  source: "SNAPSHOT" | "REBUILT";
  /** `true` quando o texto foi remontado: pode diferir do que foi (ou será) enviado. Nunca inventamos o que não dá para provar. */
  approximate: boolean;
  approximateReason?: string;
  recipient: string | null;
  recipientIsMasked: boolean;
};

const REBUILT_REASON =
  "O texto exato não foi guardado (aviso anterior ao registro de textos, ainda não enviado, ou apagado pela retenção de 12 meses). Esta é uma remontagem com os dados de hoje e pode diferir do que foi enviado.";

export async function getBillingNoticePreview(noticeId: string, now: Date = new Date()): Promise<NoticePreview> {
  const prisma = getPrisma();
  const notice = await prisma.billingNotice.findUnique({ where: { id: noticeId } });
  if (!notice) throw new DomainError("NOT_FOUND", "Aviso não encontrado.");
  const channel: NoticeChannelFilter = notice.channel === "WHATSAPP" ? "WHATSAPP" : "EMAIL";
  const recipient = notice.recipient ?? notice.recipientMasked ?? null;
  const common = { noticeId: notice.id, channel, step: notice.step, stepLabel: stepLabel(notice.step), recipient, recipientIsMasked: notice.recipient === null && notice.recipientMasked !== null };

  if (notice.renderedText !== null) {
    const messages = channel === "WHATSAPP" ? notice.renderedText.split(RENDERED_PARTS_SEPARATOR) : [notice.renderedText];
    return { ...common, subject: notice.renderedSubject, text: messages.join("\n\n"), messages, source: "SNAPSHOT", approximate: false };
  }

  if (!isDunningStep(notice.step)) throw new DomainError("PREVIEW_UNAVAILABLE", "Esta etapa não existe mais; não dá para remontar o texto.");
  const step = notice.step;
  const subject = await loadDunningSubject(notice.subscriptionId, now);
  if (!subject) throw new DomainError("PREVIEW_UNAVAILABLE", "A assinatura deste aviso não existe mais; não dá para remontar o texto.");
  const recipients = await resolveNoticeRecipients(subject.tenantId, step, now);
  const firstWhatsapp = channel === "WHATSAPP" ? (await prisma.billingNotice.count({ where: { tenantId: subject.tenantId, channel: "WHATSAPP", status: "SENT", id: { not: notice.id } } })) === 0 : false;
  const copy = await buildNoticeCopyContext({ step, invoiceId: notice.invoiceId, subject, ownerFirstName: recipients.ownerFirstName, now, firstWhatsapp });
  // Prévia nunca gera Pix novo (não há efeito colateral): usa o código que a fatura tem agora, se ainda vale.
  if (copy.invoice?.status === "OPEN" && copy.invoice.pixCopyPaste && copy.invoice.pixExpiresAt && copy.invoice.pixExpiresAt > now) {
    copy.data.pixCopyPaste = copy.invoice.pixCopyPaste;
  }

  if (channel === "EMAIL") {
    const mail = renderDunningEmail(step, copy.data, await loadEmailContext(), { retentionUntilBr: copy.retentionUntilBr, clientsUrl: copy.clientsUrl });
    if (!mail) throw new DomainError("PREVIEW_UNAVAILABLE", "Esta etapa não tem e-mail.");
    return { ...common, subject: mail.subject, text: mail.text, messages: [mail.text], source: "REBUILT", approximate: true, approximateReason: REBUILT_REASON };
  }
  const messages = buildWhatsappMessages(step, copy.data);
  if (messages.length === 0) throw new DomainError("PREVIEW_UNAVAILABLE", "Esta etapa não tem WhatsApp.");
  return { ...common, subject: null, text: messages.join("\n\n"), messages, source: "REBUILT", approximate: true, approximateReason: REBUILT_REASON };
}

// ---------------------------------------------------------------------------
// Reenvio manual
// ---------------------------------------------------------------------------

export type ResendResult = {
  /** O aviso NOVO (manual). */
  noticeId: string;
  /** `true` se este mesmo aviso já tinha sido reenviado antes (idempotência): devolve o que já existe, sem criar outro. */
  alreadyQueued: boolean;
  status: NoticeStatusFilter;
};

const RESEND_WINDOW_HOURS = 24;

/**
 * Cria um aviso NOVO (manual) para um `FAILED`/`SKIPPED` temporário e tenta enviar na hora. O despachante é o mesmo da
 * régua e continua mandando: respeita opt-out, janela de horário, ritmo e prazo, e reconfere "ainda é devido?" (quem
 * pagou, ou uma etapa que já passou, vira `SKIPPED`). A chave única `(cycleKey, step, channel)` deixa o reenvio
 * idempotente: clicar duas vezes não manda duas mensagens.
 */
export async function resendBillingNotice(noticeId: string, adminId: string, now: Date = new Date(), deps?: DispatchDeps): Promise<ResendResult> {
  const prisma = getPrisma();
  const original = await prisma.billingNotice.findUnique({ where: { id: noticeId } });
  if (!original) throw new DomainError("NOT_FOUND", "Aviso não encontrado.");
  if (!isResendableState(original, now)) {
    throw new DomainError("NOT_RESENDABLE", "Só dá para reenviar um aviso que falhou de vez (a régua já desistiu) ou que não saiu por um motivo temporário.");
  }
  if (isBlockedBy(original, await loadBlockingNotices([original]))) {
    // Idempotência: o MESMO reenvio já criado volta como "já na fila" (abaixo); qualquer outro aviso igual enviado ou em andamento barra.
    const sameResendKey = `${baseCycleKey(original.cycleKey)}${RESEND_CYCLE_MARKER}${original.id}`;
    const already = await prisma.billingNotice.findUnique({
      where: { cycleKey_step_channel: { cycleKey: sameResendKey, step: original.step, channel: original.channel } },
      select: { id: true, status: true },
    });
    if (already) return { noticeId: already.id, alreadyQueued: true, status: already.status as NoticeStatusFilter };
    throw new DomainError("NOT_RESENDABLE", "Este aviso já foi enviado, ou já está na fila para envio. Não dá para reenviar de novo.");
  }
  if (original.channel === "WHATSAPP") {
    const tenant = await prisma.tenant.findUnique({ where: { id: original.tenantId }, select: { billingWhatsappOptOutAt: true } });
    if (tenant?.billingWhatsappOptOutAt) throw new DomainError("OPTED_OUT", "O cliente pediu para não receber avisos no WhatsApp.");
  }

  const cycleKey = `${baseCycleKey(original.cycleKey)}${RESEND_CYCLE_MARKER}${original.id}`;
  let created: { id: string } | null = null;
  try {
    created = await prisma.billingNotice.create({
      data: {
        tenantId: original.tenantId,
        subscriptionId: original.subscriptionId,
        invoiceId: original.invoiceId,
        step: original.step,
        channel: original.channel,
        cycleKey,
        status: "PENDING",
        notBefore: now,
        expiresAt: addDays(now, RESEND_WINDOW_HOURS / 24),
        nextAttemptAt: now,
      },
      select: { id: true },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }

  if (!created) {
    const existing = await prisma.billingNotice.findUnique({ where: { cycleKey_step_channel: { cycleKey, step: original.step, channel: original.channel } }, select: { id: true, status: true } });
    if (!existing) throw new DomainError("CONFLICT", "Não foi possível registrar o reenvio. Tente de novo.");
    return { noticeId: existing.id, alreadyQueued: true, status: existing.status as NoticeStatusFilter };
  }

  // Trilha de auditoria (append-only): quem reenviou e qual aviso originou qual. Falha ao gravar nunca desfaz o pedido.
  await recordBillingEvent({
    tenantId: original.tenantId,
    subscriptionId: original.subscriptionId,
    invoiceId: original.invoiceId,
    type: "NOTICE_RESENT",
    actorType: "ADMIN",
    actorUserId: adminId,
    metadata: { originalNoticeId: original.id, noticeId: created.id },
  });
  logger.info("billing.notice.manual_resend", { adminId, originalNoticeId: original.id, noticeId: created.id, step: original.step, channel: original.channel });
  try {
    await Promise.race([
      dispatchDueNotices(now, { onlyIds: [created.id], deps }),
      new Promise((resolve) => setTimeout(resolve, 10_000).unref?.()),
    ]);
  } catch (error) {
    // O aviso já está na fila: o próximo tick tenta de novo. Falha daqui nunca desfaz o pedido do admin.
    logger.warn("billing.notice.manual_resend_dispatch_failed", { noticeId: created.id, errorName: error instanceof Error ? error.name : "unknown" });
  }
  const after = await prisma.billingNotice.findUnique({ where: { id: created.id }, select: { status: true } });
  return { noticeId: created.id, alreadyQueued: false, status: (after?.status ?? "PENDING") as NoticeStatusFilter };
}
