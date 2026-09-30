import { getPrisma } from "@/lib/db/prisma";
import type { HandoffEndReason, HandoffReason } from "@/lib/db/types";

/**
 * Pedido de atendente (spec bot v2 §3.10). No máximo UM aberto (`endedAt IS NULL`) por sessão — o
 * índice único parcial `handoff_requests_one_open_per_session` é o backstop contra a corrida.
 *
 * As funções recebem `tx` (o client da transação do chamador) para gravar junto com a sessão.
 * Nenhuma delas lança por causa da corrida do índice único: o "já existe" vira reaproveitamento.
 */
export type HandoffDb = Pick<ReturnType<typeof getPrisma>, "handoffRequest">;

/** Pedido aberto da sessão, ou `null`. Leitura simples, sem transação. */
export async function findOpenHandoff(chatSessionId: string): Promise<{ id: string; reason: HandoffReason } | null> {
  return getPrisma().handoffRequest.findFirst({
    where: { chatSessionId, endedAt: null },
    select: { id: true, reason: true },
  });
}

/**
 * Garante UM pedido aberto para a sessão. Se já há um, reaproveita (o cliente repetiu o pedido).
 *
 * Usa `createMany({ skipDuplicates })` (ON CONFLICT DO NOTHING) em vez de `create` + captura de
 * P2002: a violação do índice parcial abortaria a transação inteira do chamador (a sessão já
 * atualizada junto). Perdeu a corrida = alguém acabou de abrir o pedido = "já em atendimento".
 */
export async function ensureOpenHandoff(
  tx: HandoffDb,
  p: {
    tenantId: string;
    whatsappInstanceId: string;
    contactId: string;
    chatSessionId: string;
    reason: HandoffReason;
    offHours: boolean;
  },
): Promise<{ id: string; created: boolean }> {
  const open = await tx.handoffRequest.findFirst({ where: { chatSessionId: p.chatSessionId, endedAt: null }, select: { id: true } });
  if (open) return { id: open.id, created: false };

  const inserted = await tx.handoffRequest.createMany({ data: [p], skipDuplicates: true });
  const current = await tx.handoffRequest.findFirst({ where: { chatSessionId: p.chatSessionId, endedAt: null }, select: { id: true } });
  if (!current) {
    // Só acontece se o pedido concorrente foi encerrado entre o INSERT ignorado e a leitura (corrida
    // com "menu"/painel). O pedido atual ainda vale: cria um novo.
    const again = await tx.handoffRequest.create({ data: p, select: { id: true } });
    return { id: again.id, created: true };
  }
  return { id: current.id, created: inserted.count > 0 };
}

/** Encerra o pedido aberto da sessão (se houver). Idempotente: sem aberto, não faz nada. */
export async function closeOpenHandoff(tx: HandoffDb, chatSessionId: string, reason: HandoffEndReason, now: Date): Promise<number> {
  const result = await tx.handoffRequest.updateMany({ where: { chatSessionId, endedAt: null }, data: { endedAt: now, endReason: reason } });
  return result.count;
}

/** Marca a 1ª resposta da equipe (só se ainda nula — respostas seguintes não mudam o instante). */
export async function markHandoffAnswered(tx: HandoffDb, id: string, now: Date): Promise<void> {
  await tx.handoffRequest.updateMany({ where: { id, answeredAt: null }, data: { answeredAt: now } });
}
