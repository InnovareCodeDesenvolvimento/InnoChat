import { getMergedBotTexts } from "@/modules/bot-texts/service";
import { reminderFirstName } from "@/core/reminders/window";
import { renderTemplate } from "@/core/bot/texts";
import { getPrisma } from "@/lib/db/prisma";
import { forTenant } from "@/lib/db/tenant-client";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { markHandoffAnswered } from "@/modules/bot-api/handoff";
import { CONVERSATION_ITEM_SELECT, toConversationItem, type ConversationItem } from "@/modules/conversations/service";
import type { EvolutionClient } from "@/modules/whatsapp/evolution-client";
import { sendTextToContact } from "./outbound";

/**
 * Atendimento humano pelo painel (fila, responder, encerrar). Regras em docs/contratos.md
 * ("Atendimento pelo painel"). Isolamento: tudo por `forTenant`; `ChatSession` (sem `tenantId`
 * próprio) só é tocada filtrando pela instância da empresa.
 */

export const AGENT_MESSAGE_MAX = 4096;
export const AGENT_SEND_LIMIT_PER_MINUTE = 20;
const RECENT_WINDOW_MS = 24 * 3_600_000;
const QUEUE_ACTIVE_TAKE = 100;
const QUEUE_RECENT_TAKE = 50;
const LAST_MESSAGE_PREVIEW_MAX = 200;

export type AttendanceStatus = "WAITING" | "IN_PROGRESS" | "RECENT";

export type AttendanceQueueItem = {
  contactId: string;
  contactName: string;
  handoffId: string | null;
  status: AttendanceStatus;
  requestedAt: string | null;
  offHours: boolean;
  lastMessage: { body: string; direction: "INBOUND" | "OUTBOUND"; author: "CLIENT" | "BOT" | "AGENT"; createdAt: string } | null;
  botPausedUntil: string | null;
};

type ContactLite = { id: string; name: string | null; pushName: string | null; botPausedUntil: Date | null };

function displayName(c: { name: string | null; pushName: string | null }): string {
  return c.name?.trim() || c.pushName?.trim() || "Cliente";
}

/** Pedidos abertos ainda sem resposta da equipe (badge do menu). */
export async function countWaitingAttendance(tenantId: string): Promise<number> {
  return forTenant(tenantId).handoffRequest.count({ where: { endedAt: null, answeredAt: null } });
}

type Draft = Omit<AttendanceQueueItem, "lastMessage"> & { sortAt: number };

const STATUS_RANK = { WAITING: 0, IN_PROGRESS: 1, RECENT: 2 } as const;

export async function listAttendanceQueue(
  tenantId: string,
  now: Date = new Date(),
): Promise<{ items: AttendanceQueueItem[]; waitingCount: number }> {
  const db = forTenant(tenantId);
  const since = new Date(now.getTime() - RECENT_WINDOW_MS);
  const contactSelect = { select: { id: true, name: true, pushName: true, botPausedUntil: true } } as const;
  const select = { id: true, contactId: true, requestedAt: true, answeredAt: true, endedAt: true, offHours: true, contact: contactSelect } as const;

  const [open, recent, humanSessions, waitingCount] = await Promise.all([
    db.handoffRequest.findMany({ where: { endedAt: null }, orderBy: { requestedAt: "asc" }, take: QUEUE_ACTIVE_TAKE, select }),
    db.handoffRequest.findMany({ where: { endedAt: { gte: since } }, orderBy: { endedAt: "desc" }, take: QUEUE_RECENT_TAKE, select }),
    getPrisma().chatSession.findMany({
      where: { whatsappInstance: { tenantId }, humanUntil: { gt: now } },
      orderBy: { humanUntil: "desc" },
      take: QUEUE_ACTIVE_TAKE,
      select: { humanUntil: true, contact: contactSelect },
    }),
    countWaitingAttendance(tenantId),
  ]);

  const pausedUntil = (c: ContactLite, humanUntil?: Date | null): string | null => {
    const candidates = [c.botPausedUntil, humanUntil].filter((d): d is Date => !!d && d > now);
    if (candidates.length === 0) return null;
    return new Date(Math.max(...candidates.map((d) => d.getTime()))).toISOString();
  };

  // Um item por cliente; vence o status mais urgente (WAITING > IN_PROGRESS > RECENT).
  const byContact = new Map<string, Draft>();
  const put = (draft: Draft) => {
    const current = byContact.get(draft.contactId);
    if (!current || STATUS_RANK[draft.status] < STATUS_RANK[current.status]) byContact.set(draft.contactId, draft);
    else if (current.status === "WAITING" && draft.status === "WAITING" && draft.sortAt < current.sortAt) byContact.set(draft.contactId, draft);
  };

  for (const h of open) {
    put({
      contactId: h.contactId,
      contactName: displayName(h.contact),
      handoffId: h.id,
      status: h.answeredAt ? "IN_PROGRESS" : "WAITING",
      requestedAt: h.requestedAt.toISOString(),
      offHours: h.offHours,
      botPausedUntil: pausedUntil(h.contact),
      sortAt: h.requestedAt.getTime(),
    });
  }
  for (const s of humanSessions) {
    put({
      contactId: s.contact.id,
      contactName: displayName(s.contact),
      handoffId: null,
      status: "IN_PROGRESS",
      requestedAt: null,
      offHours: false,
      botPausedUntil: pausedUntil(s.contact, s.humanUntil),
      sortAt: 0,
    });
  }
  for (const h of recent) {
    put({
      contactId: h.contactId,
      contactName: displayName(h.contact),
      handoffId: h.id,
      status: "RECENT",
      requestedAt: h.requestedAt.toISOString(),
      offHours: h.offHours,
      botPausedUntil: null,
      sortAt: h.endedAt?.getTime() ?? 0,
    });
  }

  const drafts = [...byContact.values()];
  const lasts = await Promise.all(
    drafts.map((d) =>
      db.chatMessage.findFirst({
        where: { contactId: d.contactId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: CONVERSATION_ITEM_SELECT,
      }),
    ),
  );

  const built = drafts.map((d, i) => {
    const row = lasts[i];
    const last = row ? toConversationItem(row) : null;
    const lastMessage: AttendanceQueueItem["lastMessage"] = last
      ? { body: last.body.slice(0, LAST_MESSAGE_PREVIEW_MAX), direction: last.direction, author: last.author, createdAt: last.createdAt }
      : null;
    // WAITING: mais antigo primeiro. IN_PROGRESS e RECENT: atividade mais recente primeiro.
    const sortAt = d.status === "WAITING" ? d.sortAt : (row?.createdAt.getTime() ?? d.sortAt);
    const item: AttendanceQueueItem = {
      contactId: d.contactId,
      contactName: d.contactName,
      handoffId: d.handoffId,
      status: d.status,
      requestedAt: d.requestedAt,
      offHours: d.offHours,
      lastMessage,
      botPausedUntil: d.botPausedUntil,
    };
    return { item, status: d.status, sortAt };
  });
  built.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || (a.status === "WAITING" ? a.sortAt - b.sortAt : b.sortAt - a.sortAt));

  return { items: built.map((b) => b.item), waitingCount };
}

async function loadOpenHandoff(tenantId: string, contactId: string) {
  return forTenant(tenantId).handoffRequest.findFirst({
    where: { contactId, endedAt: null },
    orderBy: { requestedAt: "asc" },
    select: { id: true, whatsappInstanceId: true },
  });
}

/**
 * Prolonga a pausa do bot depois de a equipe falar. Com pedido aberto: marca a 1ª resposta e estende a
 * pausa da SESSÃO (mesma mecânica do `fromMe` pelo celular, spec §3.10). Sem pedido (a equipe puxou a
 * conversa): pausa a sessão E o contato. Nunca ENCURTA uma pausa maior já existente.
 */
async function extendBotPause(tenantId: string, contactId: string, openHandoffId: string | null, until: Date, now: Date): Promise<void> {
  const prisma = getPrisma();
  await prisma.chatSession.updateMany({
    where: { contactId, whatsappInstance: { tenantId }, OR: [{ humanUntil: null }, { humanUntil: { lt: until } }] },
    data: { state: "HUMAN", humanUntil: until },
  });
  if (openHandoffId) {
    await markHandoffAnswered(prisma, openHandoffId, now);
  } else {
    await prisma.contact.updateMany({
      where: { id: contactId, tenantId, OR: [{ botPausedUntil: null }, { botPausedUntil: { lt: until } }] },
      data: { botPausedUntil: until },
    });
  }
}

export async function sendAgentMessage(
  params: { tenantId: string; userId: string; contactId: string; text: string },
  deps: { evolution?: EvolutionClient; now?: Date } = {},
): Promise<{ message: ConversationItem }> {
  const { tenantId, userId, contactId } = params;
  const text = params.text.trim();
  if (!text) throw new DomainError("TEXT_EMPTY", "Escreva uma mensagem antes de enviar.");
  if (text.length > AGENT_MESSAGE_MAX) {
    throw new DomainError("TEXT_TOO_LONG", `A mensagem passa de ${AGENT_MESSAGE_MAX} caracteres.`, { max: AGENT_MESSAGE_MAX });
  }

  const now = deps.now ?? new Date();
  const contact = await forTenant(tenantId).contact.findFirst({ where: { id: contactId }, select: { id: true } });
  if (!contact) throw new DomainError("NOT_FOUND", "Cliente não encontrado.");

  const open = await loadOpenHandoff(tenantId, contactId);
  const result = await sendTextToContact({
    tenantId,
    contactId,
    text,
    authorUserId: userId,
    preferredInstanceId: open?.whatsappInstanceId,
    evolution: deps.evolution,
  });

  if (result.outcome === "NO_PHONE") throw new DomainError("CONTACT_HAS_NO_PHONE", "Este cliente não tem telefone de WhatsApp cadastrado.");
  if (result.outcome === "NO_WHATSAPP") throw new DomainError("WHATSAPP_NOT_CONNECTED", "Nenhum número de WhatsApp conectado. Conecte um número para responder.");
  if (result.outcome === "BUSY") throw new DomainError("CONVERSATION_BUSY", "O assistente está respondendo esse cliente agora. Tente de novo em instantes.");
  if (result.outcome !== "SENT") throw new DomainError("SEND_FAILED", "Não foi possível enviar agora. Tente de novo.");

  try {
    const tenant = await getPrisma().tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { handoffResumeMinutes: true } });
    const until = new Date(now.getTime() + tenant.handoffResumeMinutes * 60_000);
    await extendBotPause(tenantId, contactId, open?.id ?? null, until, now);
  } catch (error) {
    // A mensagem JÁ foi enviada: não devolve erro ao atendente (ele reenviaria e duplicaria).
    logger.error("attendance.pause_failed", { tenantId, contactId, errorName: error instanceof Error ? error.name : "unknown" });
  }

  const author = await getPrisma().user.findUnique({ where: { id: userId }, select: { name: true } });
  return {
    message: {
      id: result.message.id,
      direction: "OUTBOUND",
      body: text,
      createdAt: result.message.createdAt.toISOString(),
      instanceLabel: null,
      author: "AGENT",
      authorName: author?.name?.trim() || "Atendente",
    },
  };
}

/**
 * Encerra o atendimento: fecha o pedido aberto (`endReason: PANEL_RESUME` — o mesmo do "Retomar bot" do
 * painel; nenhum outro valor do enum descreve "equipe encerrou"), devolve o bot ao cliente e o avisa com
 * `HANDOFF_CLOSED`. Idempotente: sem nada aberto/pausado, não faz nem manda nada. A troca é por
 * `updateMany` condicional, então dois cliques simultâneos só notificam uma vez.
 */
export async function closeAttendance(
  params: { tenantId: string; contactId: string },
  deps: { evolution?: EvolutionClient; now?: Date } = {},
): Promise<{ closed: true; clientNotified: boolean }> {
  const { tenantId, contactId } = params;
  const now = deps.now ?? new Date();
  const db = forTenant(tenantId);
  const contact = await db.contact.findFirst({ where: { id: contactId }, select: { id: true, name: true, pushName: true } });
  if (!contact) throw new DomainError("NOT_FOUND", "Cliente não encontrado.");

  const open = await loadOpenHandoff(tenantId, contactId);
  const prisma = getPrisma();
  const [handoffs, contacts, sessions] = await prisma.$transaction([
    prisma.handoffRequest.updateMany({ where: { tenantId, contactId, endedAt: null }, data: { endedAt: now, endReason: "PANEL_RESUME" } }),
    prisma.contact.updateMany({ where: { id: contactId, tenantId, botPausedUntil: { gt: now } }, data: { botPausedUntil: null } }),
    prisma.chatSession.updateMany({
      where: { contactId, whatsappInstance: { tenantId }, humanUntil: { gt: now } },
      data: { humanUntil: null, state: "MAIN_MENU" },
    }),
  ]);
  if (handoffs.count + contacts.count + sessions.count === 0) return { closed: true, clientNotified: false };

  let clientNotified = false;
  try {
    const [texts, tenant] = await Promise.all([
      getMergedBotTexts(tenantId, 2),
      prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { name: true } }),
    ]);
    const text = renderTemplate(texts.HANDOFF_CLOSED, { nome: reminderFirstName(contact.name, contact.pushName), empresa: tenant.name });
    const sent = await sendTextToContact({ tenantId, contactId, text, preferredInstanceId: open?.whatsappInstanceId, evolution: deps.evolution });
    clientNotified = sent.outcome === "SENT";
  } catch (error) {
    logger.warn("attendance.close_notify_failed", { tenantId, contactId, errorName: error instanceof Error ? error.name : "unknown" });
  }
  return { closed: true, clientNotified };
}
