import { getPrisma } from "@/lib/db/prisma";
import { forTenant } from "@/lib/db/tenant-client";
import { describeDbError, isUniqueViolation } from "@/lib/db/prisma-errors";
import { logger } from "@/lib/logger";
import { effectiveStatus } from "@/core/billing";
import { digitsFromJid } from "@/core/bot/evolution-normalize";
import { formatDayLabel, formatTimeLabel } from "@/core/bot/format";
import { DEFAULT_BOT_TEXTS, renderTemplate } from "@/core/bot/texts";
import { isInsideSendWindow, reminderFirstName, reminderStartsAtRange, whenLabel } from "@/core/reminders/window";
import { appendRecentOutbound } from "@/modules/bot-api/claim";
import { logChatMessage } from "@/modules/conversations/log";
import { EvolutionApiError, getEvolutionClient, type EvolutionClient } from "@/modules/whatsapp/evolution-client";

/**
 * Lembrete de véspera ao cliente final por WhatsApp. Roda DENTRO do tick horário de cobrança
 * (`src/modules/billing/tick.ts`), com a falha isolada lá: erro aqui nunca derruba a cobrança.
 *
 * Idempotência: o envio é "reservado" ANTES de mandar, com `updateMany` condicional
 * (`reminderSentAt` nulo -> `now`) — dois ticks concorrentes disputam a mesma linha e só um pega
 * `count === 1`. Se o envio falha, a reserva volta a nulo (só se ainda for a NOSSA — uma remarcação
 * concorrente que zerou/refez não é pisada) — mas SÓ em falha transitória (rede, timeout, 5xx, 408/429).
 * Rejeição permanente (4xx: número inválido/inexistente) mantém `reminderSentAt` marcado: reenviar
 * toda hora para um número que a Evolution recusa só geraria ruído e risco de bloqueio do número.
 *
 * Ritmo (anti-bloqueio do WhatsApp): teto por empresa por rodada, teto global, intervalo com jitter
 * entre envios pelo MESMO número e orçamento de tempo total dentro do tick (o que sobra fica para a
 * próxima rodada — a seleção é sempre "mais próximos primeiro").
 */

/** Teto de mensagens por rodada — o tick é horário; o resto entra na rodada seguinte (mais próximos primeiro). */
export const REMINDER_BATCH_LIMIT = 100;
/** Teto por EMPRESA por rodada (um número só não deve mandar rajada). */
export const REMINDER_TENANT_BATCH_LIMIT = 20;
/** Orçamento de tempo do lembrete dentro do tick horário; estourou, sai e deixa o resto para a próxima rodada. */
export const REMINDER_TIME_BUDGET_MS = 45_000;
/** Intervalo entre dois envios pelo mesmo número: 1,5–3 s (sorteado). */
export const REMINDER_SEND_GAP_MIN_MS = 1_500;
export const REMINDER_SEND_GAP_MAX_MS = 3_000;
/** Tentativas por agendamento (contadas em memória — ver `failedAttempts`). */
export const REMINDER_MAX_ATTEMPTS = 2;

export type ReminderTickSummary = {
  remindersToClientsSent: number;
  remindersToClientsFailed: number;
};

export type ReminderTickDeps = {
  /** Injetável nos testes; por padrão resolve o cliente real pelas credenciais da plataforma. */
  evolution?: EvolutionClient;
  /** Injetáveis nos testes (pausa, relógio monotônico em ms, sorteio 0..1 e orçamento). */
  sleep?: (ms: number) => Promise<void>;
  clockMs?: () => number;
  random?: () => number;
  timeBudgetMs?: number;
};

/**
 * Falhas TRANSITÓRIAS por agendamento nesta instância do servidor. Sem coluna no schema para contar tentativas
 * (e sem alterá-lo), o limite é em memória: após `REMINDER_MAX_ATTEMPTS` falhas o agendamento é
 * abandonado ATÉ o processo reiniciar — e, mesmo assim, a repetição tem teto natural: some da
 * seleção quando faltar menos de 2h. Nunca é retry infinito.
 */
const failedAttempts = new Map<string, number>();
const FAILED_ATTEMPTS_MAX_ENTRIES = 5000;

function rememberFailure(appointmentId: string): number {
  if (failedAttempts.size >= FAILED_ATTEMPTS_MAX_ENTRIES) failedAttempts.clear();
  const next = (failedAttempts.get(appointmentId) ?? 0) + 1;
  failedAttempts.set(appointmentId, next);
  return next;
}

/** Só para testes. */
export function resetReminderFailureMemory(): void {
  failedAttempts.clear();
}

/** Nunca `message` (o Prisma reproduz argumentos, incl. texto do cliente): só nome, code e alvo. */
function safeError(error: unknown) {
  return describeDbError(error);
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Falha transitória (rede, timeout, 5xx, 408, 429) devolve a reserva; 4xx permanente não. */
export function isPermanentSendRejection(error: unknown): boolean {
  if (!(error instanceof EvolutionApiError)) return false;
  const status = error.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export async function runReminderTick(now: Date = new Date(), deps: ReminderTickDeps = {}): Promise<ReminderTickSummary> {
  const summary: ReminderTickSummary = { remindersToClientsSent: 0, remindersToClientsFailed: 0 };
  const prisma = getPrisma();

  // Só empresas que PODEM enviar agora: lembrete ligado, número conectado de verdade (não sandbox)
  // e assinatura não suspensa/cancelada (status gravado é filtro barato; o efetivo é conferido abaixo).
  const tenants = await prisma.tenant.findMany({
    where: {
      reminderEnabled: true,
      subscription: { is: { status: { notIn: ["SUSPENDED", "CANCELED"] } } },
      whatsappInstances: { some: { status: "CONNECTED", sandbox: false, deletedAt: null } },
    },
    include: {
      subscription: true,
      whatsappInstances: { where: { status: "CONNECTED", sandbox: false, deletedAt: null }, orderBy: { createdAt: "asc" } },
    },
  });
  if (tenants.length === 0) return summary;

  let evolution = deps.evolution;
  let budget = REMINDER_BATCH_LIMIT;
  const sleep = deps.sleep ?? realSleep;
  const clockMs = deps.clockMs ?? (() => Date.now());
  const random = deps.random ?? Math.random;
  const timeBudgetMs = deps.timeBudgetMs ?? REMINDER_TIME_BUDGET_MS;
  const startedAtMs = clockMs();
  const lastSendAtByInstance = new Map<string, number>();
  let outOfTime = false;

  for (const tenant of tenants) {
    if (budget <= 0 || outOfTime) break;
    if (!tenant.subscription) continue;
    const status = effectiveStatus(tenant.subscription, now);
    if (status === "SUSPENDED" || status === "CANCELED") continue;
    // Horário de silêncio: espera o próximo tick dentro da janela (a seleção re-avalia o "> 2h").
    if (!isInsideSendWindow(now, tenant.timezone)) continue;

    try {
      const range = reminderStartsAtRange(now, tenant.reminderHoursBefore);
      const db = forTenant(tenant.id);
      const candidates = await db.appointment.findMany({
        where: { status: "SCHEDULED", reminderSentAt: null, startsAt: range },
        orderBy: { startsAt: "asc" },
        take: Math.min(budget, REMINDER_TENANT_BATCH_LIMIT),
        include: {
          contact: { include: { chatSessions: { where: { humanUntil: { gt: now } }, select: { id: true } } } },
          service: { select: { name: true } },
          professional: { select: { name: true } },
        },
      });
      if (candidates.length === 0) continue;

      if (!evolution) {
        try {
          evolution = await getEvolutionClient();
        } catch (error) {
          logger.warn("reminders.tick.evolution_unavailable", { errorName: error instanceof Error ? error.name : "unknown" });
          return summary; // sem Evolution não há o que enviar para ninguém
        }
      }

      const template = await loadReminderTemplate(tenant.id);
      const connectedIds = new Set(tenant.whatsappInstances.map((i) => i.id));

      let tenantAttempts = 0;
      for (const appointment of candidates) {
        if (budget <= 0 || tenantAttempts >= REMINDER_TENANT_BATCH_LIMIT) break;
        const { contact } = appointment;
        // Bot pausado para o cliente ("pausar o bot" em Clientes, ou atendente humano assumiu).
        if ((contact.botPausedUntil && contact.botPausedUntil > now) || contact.chatSessions.length > 0) continue;
        if ((failedAttempts.get(appointment.id) ?? 0) >= REMINDER_MAX_ATTEMPTS) continue;

        const number = recipientNumber(contact);
        if (!number) continue;

        const instance =
          tenant.whatsappInstances.find((i) => i.id === appointment.whatsappInstanceId && connectedIds.has(i.id)) ??
          tenant.whatsappInstances[0];
        if (!instance) continue;

        const text = renderTemplate(template, {
          nome: reminderFirstName(contact.name, contact.pushName),
          empresa: tenant.name,
          servico: appointment.service.name,
          profissional: appointment.professional.name,
          data: formatDayLabel(appointment.startsAt, tenant.timezone),
          hora: formatTimeLabel(appointment.startsAt, tenant.timezone),
          quando: whenLabel(appointment.startsAt, now, tenant.timezone),
        });

        // Ritmo: pausa com jitter entre envios pelo MESMO número e respeito ao orçamento de tempo.
        const lastSend = lastSendAtByInstance.get(instance.id);
        const gapMs = lastSend === undefined ? 0 : REMINDER_SEND_GAP_MIN_MS + random() * (REMINDER_SEND_GAP_MAX_MS - REMINDER_SEND_GAP_MIN_MS);
        if (clockMs() - startedAtMs + gapMs >= timeBudgetMs) {
          outOfTime = true;
          logger.info("reminders.tick.time_budget_exhausted", { ...summary, timeBudgetMs });
          break;
        }
        if (gapMs > 0) await sleep(gapMs);
        lastSendAtByInstance.set(instance.id, clockMs());

        budget -= 1;
        tenantAttempts += 1;
        const sent = await sendOne({
          evolution,
          tenantId: tenant.id,
          appointment,
          contactId: contact.id,
          instance,
          number,
          text,
          now,
          range,
        });
        if (sent === true) summary.remindersToClientsSent += 1;
        else if (sent === false) summary.remindersToClientsFailed += 1;
      }
    } catch (error) {
      // Uma empresa com problema nunca impede as demais.
      logger.error("reminders.tick.tenant_failed", { tenantId: tenant.id, ...safeError(error) });
    }
  }

  logger.info("reminders.tick.completed", { ...summary });
  return summary;
}

async function loadReminderTemplate(tenantId: string): Promise<string> {
  const row = await forTenant(tenantId).botText.findFirst({ where: { key: "REMINDER" } });
  return row?.text ?? DEFAULT_BOT_TEXTS.REMINDER;
}

export function recipientNumber(contact: { waJid: string; phoneE164: string | null }): string | null {
  if (contact.waJid.endsWith("@s.whatsapp.net")) {
    const digits = digitsFromJid(contact.waJid).replace(/\D/g, "");
    if (digits) return digits;
  }
  const fromPhone = (contact.phoneE164 ?? "").replace(/\D/g, "");
  return fromPhone || null;
}

/** `true` = enviado; `false` = falhou; `null` = outro tick/remarcação levou a vez OU a conversa estava ocupada (fica para a próxima rodada). */
async function sendOne(params: {
  evolution: EvolutionClient;
  tenantId: string;
  appointment: { id: string; startsAt: Date };
  contactId: string;
  instance: { id: string; instanceName: string };
  number: string;
  text: string;
  now: Date;
  range: { gt: Date; lte: Date };
}): Promise<boolean | null> {
  const { evolution, tenantId, appointment, instance, text, now } = params;
  const db = forTenant(tenantId);

  // Reserva atômica ANTES de enviar. Reconfere status, horário e a janela de "> 2h" na própria
  // condição: uma remarcação/cancelamento entre a leitura e aqui faz `count === 0`.
  const reserved = await db.appointment.updateMany({
    where: {
      id: appointment.id,
      status: "SCHEDULED",
      reminderSentAt: null,
      startsAt: { equals: appointment.startsAt, gt: params.range.gt },
    },
    data: { reminderSentAt: now },
  });
  if (reserved.count === 0) return null;

  // Desfaz SÓ a nossa reserva (mesmo carimbo) — não pisa numa remarcação que já zerou/refez.
  const releaseReservation = () =>
    db.appointment.updateMany({ where: { id: appointment.id, reminderSentAt: now }, data: { reminderSentAt: null } }).catch((rollbackError) => {
      logger.error("reminders.rollback_failed", { tenantId, appointmentId: appointment.id, ...safeError(rollbackError) });
    });

  try {
    // O Evolution devolve o nosso envio como evento `fromMe`; o `claim` trataria isso como "um
    // humano assumiu" e pausaria o bot para o cliente por horas — quebrando o "responda menu".
    // Registrar o hash na sessão faz o `claim` reconhecer o eco. Antes do envio: o webhook pode
    // chegar antes do retorno do POST. Se o bot está no meio de uma conversa (lock ativo), NÃO
    // enviamos agora: o PUT do bot regravaria `recentOutbound` e perderia o nosso hash.
    const echo = await registerOutboundEcho(instance.id, params.contactId, text, now);
    if (echo === "busy") {
      await releaseReservation();
      logger.info("reminders.skipped_session_busy", { tenantId, appointmentId: appointment.id });
      return null;
    }
    const { messageId } = await evolution.sendText(instance.instanceName, params.number, text);
    await logChatMessage({
      tenantId,
      whatsappInstanceId: instance.id,
      contactId: params.contactId,
      direction: "OUTBOUND",
      body: text,
      providerMessageId: messageId,
    }); // já enviada: falha/duplicata no histórico nunca desfaz a reserva (logChatMessage não lança)
    failedAttempts.delete(appointment.id);
    logger.info("reminders.sent", { tenantId, appointmentId: appointment.id });
    return true;
  } catch (error) {
    if (isPermanentSendRejection(error)) {
      // 4xx permanente (número inválido/inexistente): NÃO devolve a reserva — não repete nunca mais.
      logger.warn("reminders.send_rejected_permanent", {
        tenantId,
        appointmentId: appointment.id,
        status: (error as EvolutionApiError).status,
      });
      failedAttempts.delete(appointment.id);
      return false;
    }
    await releaseReservation();
    const attempts = rememberFailure(appointment.id);
    logger.warn("reminders.send_failed", {
      tenantId,
      appointmentId: appointment.id,
      attempts,
      gaveUp: attempts >= REMINDER_MAX_ATTEMPTS,
      errorName: error instanceof Error ? error.name : "unknown",
      status: error instanceof EvolutionApiError ? error.status : undefined,
    });
    return false;
  }
}

const ECHO_APPEND_MAX_TRIES = 5;

/**
 * Acrescenta o hash do lembrete em `ChatSession.recentOutbound` de forma ATÔMICA: o `updateMany`
 * só vale se a linha ainda tem o `updatedAt` lido (nenhum outro escritor passou no meio — outro
 * lembrete, o PUT do bot) E a trava está livre. Perdeu a corrida → relê e tenta de novo (curto);
 * trava ativa → `"busy"` (o chamador adia). Nunca sobrescreve o hash de outro escritor.
 * A trava é gravada pelo `claim` com relógio de parede, por isso comparamos com `new Date()` real.
 */
export async function registerOutboundEcho(instanceId: string, contactId: string, text: string, now: Date): Promise<"ok" | "busy"> {
  const prisma = getPrisma();
  for (let attempt = 1; attempt <= ECHO_APPEND_MAX_TRIES; attempt += 1) {
    let session;
    try {
      session = await prisma.chatSession.upsert({
        where: { whatsappInstanceId_contactId: { whatsappInstanceId: instanceId, contactId } },
        update: {},
        create: { whatsappInstanceId: instanceId, contactId, state: "MAIN_MENU", lastInboundAt: now },
      });
    } catch (error) {
      // upsert do Prisma NÃO é atômico quando a linha não existe: quem perdeu a criação (outro
      // lembrete ou o claim) relê na próxima volta.
      if (!isUniqueViolation(error)) throw error;
      continue;
    }
    const wallNow = new Date();
    if (session.lockToken && session.lockedUntil && session.lockedUntil > wallNow) return "busy";
    const updated = await prisma.chatSession.updateMany({
      where: {
        id: session.id,
        updatedAt: session.updatedAt,
        OR: [{ lockToken: null }, { lockedUntil: null }, { lockedUntil: { lte: wallNow } }],
      },
      data: { recentOutbound: appendRecentOutbound(session.recentOutbound, [text], now) },
    });
    if (updated.count === 1) return "ok";
    await new Promise((resolve) => setTimeout(resolve, 5 + Math.random() * 25));
  }
  // Muita disputa seguida: mais seguro adiar do que enviar sem o hash registrado.
  return "busy";
}
