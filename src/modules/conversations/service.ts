import { forTenant } from "@/lib/db/tenant-client";
import { DomainError } from "@/lib/errors";

export const CONVERSATION_PAGE_SIZE = 50;

export type ConversationItem = {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  body: string;
  createdAt: string;
  instanceLabel: string | null;
  /** Quem escreveu: CLIENT (entrada), AGENT (atendente do painel, `authorUserId`) ou BOT (demais saídas). */
  author: "CLIENT" | "BOT" | "AGENT";
  /** Nome do atendente (só quando `author === "AGENT"` e o usuário ainda existe). */
  authorName: string | null;
};

export function toConversationItem(r: {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  body: string;
  createdAt: Date;
  authorUserId: string | null;
  whatsappInstance: { label: string } | null;
  authorUser: { name: string | null } | null;
}): ConversationItem {
  return {
    id: r.id,
    direction: r.direction,
    body: r.body,
    createdAt: r.createdAt.toISOString(),
    instanceLabel: r.whatsappInstance?.label ?? null,
    author: r.direction === "INBOUND" ? "CLIENT" : r.authorUserId ? "AGENT" : "BOT",
    authorName: r.authorUser ? r.authorUser.name?.trim() || "Atendente" : null,
  };
}

export const CONVERSATION_ITEM_SELECT = {
  id: true,
  direction: true,
  body: true,
  createdAt: true,
  authorUserId: true,
  whatsappInstance: { select: { label: true } },
  authorUser: { select: { name: true } },
} as const;

function encodeCursor(item: { createdAt: Date; id: string }): string {
  return Buffer.from(`${item.createdAt.toISOString()}|${item.id}`).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const [iso, ...rest] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    const id = rest.join("|");
    const createdAt = new Date(iso);
    if (!iso || !id || Number.isNaN(createdAt.getTime())) throw new Error("bad");
    return { createdAt, id };
  } catch {
    throw new DomainError("INVALID_CURSOR", "Cursor inválido.");
  }
}

/**
 * Conversa de um cliente: página de 50, mais antigas no topo e mais novas embaixo. `cursor`
 * (opaco) aponta para a mensagem MAIS ANTIGA já carregada; a próxima página traz as anteriores.
 * Escopo por `forTenant` — o `contactId` de outra empresa cai em NOT_FOUND.
 */
export async function getConversation(
  tenantId: string,
  contactId: string,
  cursor?: string,
): Promise<{ items: ConversationItem[]; nextCursor: string | null }> {
  const db = forTenant(tenantId);
  const contact = await db.contact.findFirst({ where: { id: contactId }, select: { id: true } });
  if (!contact) throw new DomainError("NOT_FOUND", "Cliente não encontrado.");

  const cur = cursor ? decodeCursor(cursor) : null;
  const rows = await db.chatMessage.findMany({
    where: {
      contactId,
      ...(cur ? { OR: [{ createdAt: { lt: cur.createdAt } }, { createdAt: cur.createdAt, id: { lt: cur.id } }] } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: CONVERSATION_PAGE_SIZE + 1,
    select: CONVERSATION_ITEM_SELECT,
  });

  const hasMore = rows.length > CONVERSATION_PAGE_SIZE;
  const page = rows.slice(0, CONVERSATION_PAGE_SIZE);
  const oldest = page[page.length - 1];

  return {
    items: page.reverse().map(toConversationItem),
    nextCursor: hasMore && oldest ? encodeCursor(oldest) : null,
  };
}
