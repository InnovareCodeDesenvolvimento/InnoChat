import { forTenant } from "@/lib/db/tenant-client";
import { describeDbError, isUniqueViolation } from "@/lib/db/prisma-errors";
import { logger } from "@/lib/logger";

/**
 * Histórico de conversas do WhatsApp (LGPD: guardado 90 dias, ver `maintenance/tick.ts`).
 * Gravar o histórico é SEMPRE efeito colateral: nada aqui pode derrubar o fluxo do bot — falha
 * inesperada vira `logger.warn` (só ids/tipo do erro, nunca o texto da mensagem) e segue.
 */

export const CHAT_BODY_MAX = 4000;

export type ChatLogEntry = {
  tenantId: string;
  whatsappInstanceId: string | null;
  contactId: string;
  direction: "INBOUND" | "OUTBOUND";
  body: string;
  /** Id da mensagem na Evolution — dedup (`@@unique([tenantId, providerMessageId])`). Nulo = sem dedup. */
  providerMessageId?: string | null;
  /** Atendente do painel que enviou (null = bot ou cliente). */
  authorUserId?: string | null;
};

/** Teto de mensagens RECEBIDAS por contato por dia gravadas no histórico (anti-inundação/abuso). */
export const CHAT_INBOUND_DAILY_CAP = 200;
const CAP_LOG_EVERY_MS = 60 * 60_000;
const capLoggedAt = new Map<string, number>();

/** Só para testes. */
export function resetInboundCapLogMemory(): void {
  capLoggedAt.clear();
}

// NUL (\u0000) faz o Postgres recusar o texto; demais controles (exceto tab, LF e CR) sao lixo de protocolo.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Remove caracteres de controle, corta no limite e garante UTF-16 bem formado (sem surrogate solto). */
export function sanitizeChatBody(body: string): string {
  const cleaned = body.replace(CONTROL_CHARS, "");
  const clamped = cleaned.length > CHAT_BODY_MAX ? cleaned.slice(0, CHAT_BODY_MAX) : cleaned;
  return typeof clamped.toWellFormed === "function" ? clamped.toWellFormed() : clamped;
}

/** `true` se o contato já atingiu o teto de INBOUND nas últimas 24h. Loga o id no máximo 1x/hora. */
async function inboundCapReached(tenantId: string, contactId: string): Promise<boolean> {
  const since = new Date(Date.now() - 24 * 3_600_000);
  const count = await forTenant(tenantId).chatMessage.count({ where: { contactId, direction: "INBOUND", createdAt: { gte: since } } });
  if (count < CHAT_INBOUND_DAILY_CAP) return false;
  const last = capLoggedAt.get(contactId) ?? 0;
  if (Date.now() - last >= CAP_LOG_EVERY_MS) {
    if (capLoggedAt.size > 5000) capLoggedAt.clear();
    capLoggedAt.set(contactId, Date.now());
    logger.warn("conversations.inbound_cap_reached", { tenantId, contactId, cap: CHAT_INBOUND_DAILY_CAP });
  }
  return true;
}

/**
 * Regra de "conversa do dono": mensagem enviada PELA empresa (fromMe) só entra no histórico se o
 * contato já falou com o número (INBOUND) ou tem agendamento — senão é conversa pessoal do dono.
 */
export async function contactHasBusinessRelation(tenantId: string, contactId: string): Promise<boolean> {
  const db = forTenant(tenantId);
  const inbound = await db.chatMessage.count({ where: { contactId, direction: "INBOUND" }, take: 1 });
  if (inbound > 0) return true;
  return (await db.appointment.count({ where: { contactId }, take: 1 })) > 0;
}

/**
 * Grava e devolve `{ id, createdAt }`; `null` se era duplicata (P2002), texto vazio, teto atingido ou
 * falha (já logada). Nunca lança.
 */
export async function saveChatMessage(entry: ChatLogEntry): Promise<{ id: string; createdAt: Date } | null> {
  const body = sanitizeChatBody(entry.body);
  if (!body) return null;
  try {
    if (entry.direction === "INBOUND" && (await inboundCapReached(entry.tenantId, entry.contactId))) return null;
    const row = await forTenant(entry.tenantId).chatMessage.create({
      data: {
        tenantId: entry.tenantId, // literal só para o TS; forTenant sobrescreve em runtime
        contactId: entry.contactId,
        whatsappInstanceId: entry.whatsappInstanceId,
        direction: entry.direction,
        body,
        providerMessageId: entry.providerMessageId ?? null,
        authorUserId: entry.authorUserId ?? null,
      },
      select: { id: true, createdAt: true },
    });
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    logger.warn("conversations.log_failed", {
      direction: entry.direction,
      contactId: entry.contactId,
      ...describeDbError(error), // nunca error.message: o Prisma reproduz o corpo da mensagem nela
    });
    return null;
  }
}

/** `true` se gravou; `false` se era duplicata (P2002) ou se falhou (já logado). Nunca lança. */
export async function logChatMessage(entry: ChatLogEntry): Promise<boolean> {
  return (await saveChatMessage(entry)) !== null;
}

/** Saída do bot: uma linha por texto, na ordem (createdAt escalonado em 1ms para manter a ordem estável). */
export async function logOutboundTexts(params: {
  tenantId: string;
  whatsappInstanceId: string;
  contactId: string;
  texts: string[];
}): Promise<void> {
  const base = Date.now();
  const texts = params.texts.map(sanitizeChatBody).filter((t) => t.length > 0);
  if (texts.length === 0) return;
  try {
    await forTenant(params.tenantId).chatMessage.createMany({
      data: texts.map((text, i) => ({
        tenantId: params.tenantId,
        contactId: params.contactId,
        whatsappInstanceId: params.whatsappInstanceId,
        direction: "OUTBOUND" as const,
        body: text,
        createdAt: new Date(base + i),
      })),
    });
  } catch (error) {
    logger.warn("conversations.log_outbound_failed", {
      contactId: params.contactId,
      ...describeDbError(error),
    });
  }
}
