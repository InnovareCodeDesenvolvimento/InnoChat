import { forTenant } from "@/lib/db/tenant-client";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { saveChatMessage } from "@/modules/conversations/log";
import { recipientNumber, registerOutboundEcho } from "@/modules/reminders/tick";
import { EvolutionApiError, getEvolutionClient, type EvolutionClient } from "@/modules/whatsapp/evolution-client";

/**
 * Envio de texto AO CLIENTE pelo número da empresa, fora do fluxo do bot (atendente pelo painel,
 * aviso de mudança da equipe, encerramento). Um único caminho para os três, com as mesmas garantias
 * do lembrete: eco registrado ANTES do envio (senão o `fromMe` devolvido pela Evolution pausaria o
 * bot do cliente por engano), histórico gravado depois, e nunca lança por falha de envio — devolve o
 * desfecho para o chamador decidir (a operação principal nunca é desfeita por causa disto).
 */

export type OutboundOutcome = "SENT" | "NO_PHONE" | "NO_WHATSAPP" | "BUSY" | "FAILED";

export type OutboundResult =
  | { outcome: "SENT"; message: { id: string; createdAt: Date }; instanceId: string }
  | { outcome: Exclude<OutboundOutcome, "SENT"> };

const ECHO_TRIES = 3;
const ECHO_WAIT_MS = 400;

/** Instâncias que realmente podem enviar: conectadas, não sandbox, não removidas. */
export async function listSendableInstances(tenantId: string) {
  return forTenant(tenantId).whatsappInstance.findMany({
    where: { status: "CONNECTED", sandbox: false, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, instanceName: true },
  });
}

async function resolveEvolution(evolution?: EvolutionClient): Promise<EvolutionClient | null> {
  if (evolution) return evolution;
  try {
    return await getEvolutionClient();
  } catch (error) {
    logger.warn("attendance.evolution_unavailable", { errorName: error instanceof Error ? error.name : "unknown" });
    return null;
  }
}

/** `text` já vem pronto (validado/renderizado); aqui só envia, registra o eco e grava o histórico. */
export async function sendTextToContact(params: {
  tenantId: string;
  contactId: string;
  text: string;
  authorUserId?: string | null;
  /** Instância preferida (a do pedido de atendente); se não estiver conectada, cai na última usada / primeira. */
  preferredInstanceId?: string | null;
  evolution?: EvolutionClient;
}): Promise<OutboundResult> {
  const { tenantId, contactId, text } = params;
  const db = forTenant(tenantId);

  const contact = await db.contact.findFirst({ where: { id: contactId }, select: { id: true, waJid: true, phoneE164: true } });
  if (!contact) throw new DomainError("NOT_FOUND", "Cliente não encontrado.");
  const number = recipientNumber(contact);
  if (!number) return { outcome: "NO_PHONE" };

  const instances = await listSendableInstances(tenantId);
  if (instances.length === 0) return { outcome: "NO_WHATSAPP" };

  let instance = params.preferredInstanceId ? instances.find((i) => i.id === params.preferredInstanceId) : undefined;
  if (!instance) {
    const last = await db.chatMessage.findFirst({
      where: { contactId, whatsappInstanceId: { not: null } },
      orderBy: { createdAt: "desc" },
      select: { whatsappInstanceId: true },
    });
    instance = instances.find((i) => i.id === last?.whatsappInstanceId) ?? instances[0];
  }

  const evolution = await resolveEvolution(params.evolution);
  if (!evolution) return { outcome: "NO_WHATSAPP" };

  const now = new Date();
  let echo: "ok" | "busy" = "busy";
  for (let attempt = 1; attempt <= ECHO_TRIES && echo === "busy"; attempt += 1) {
    echo = await registerOutboundEcho(instance.id, contactId, text, now);
    if (echo === "busy" && attempt < ECHO_TRIES) await new Promise((resolve) => setTimeout(resolve, ECHO_WAIT_MS));
  }
  if (echo === "busy") return { outcome: "BUSY" }; // o bot está no meio da conversa: nada foi enviado

  let messageId: string | null;
  try {
    ({ messageId } = await evolution.sendText(instance.instanceName, number, text));
  } catch (error) {
    // Nunca o corpo da mensagem no log — só ids e o tipo do erro.
    logger.warn("attendance.send_failed", {
      tenantId,
      contactId,
      errorName: error instanceof Error ? error.name : "unknown",
      status: error instanceof EvolutionApiError ? error.status : undefined,
    });
    return { outcome: "FAILED" };
  }

  // Já enviada: falha no histórico nunca vira erro para quem chamou (saveChatMessage não lança).
  const saved = await saveChatMessage({
    tenantId,
    whatsappInstanceId: instance.id,
    contactId,
    direction: "OUTBOUND",
    body: text,
    providerMessageId: messageId,
    authorUserId: params.authorUserId ?? null,
  });
  return { outcome: "SENT", message: saved ?? { id: `unsaved-${messageId ?? Date.now()}`, createdAt: now }, instanceId: instance.id };
}
