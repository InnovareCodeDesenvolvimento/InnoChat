import { STATE_ALIASES } from "@/core/bot/engine/aliases";
import { normalizeText } from "@/core/bot/engine/normalize";
import { formatDayLabel, formatLeadLabel, formatLongDayLabel, formatTimeLabel } from "@/core/bot/format";
import { WAITLIST_ACTIVE_STATUSES, WAITLIST_OFFER_MINUTES } from "@/core/waitlist/match";
import { getPrisma } from "@/lib/db/prisma";
import { forTenant } from "@/lib/db/tenant-client";

/**
 * Apoio do `claim` (src/modules/bot-api/claim.ts) à lista de espera. Arquivo propositalmente leve (só
 * leitura e formatação): o `claim` importa isto, e o módulo de oferta importa o `claim`, então aqui
 * não pode entrar nada que envie mensagem.
 */

/** Quantas filas ativas o cliente tem (decide se o menu do bot mostra "Minha lista de espera"). */
export async function countContactActiveWaitlist(tenantId: string, contactId: string): Promise<number> {
  return forTenant(tenantId).waitlistEntry.count({ where: { contactId, status: { in: [...WAITLIST_ACTIVE_STATUSES] } } });
}

export type PendingWaitlistOffer = {
  entryId: string;
  serviceName: string;
  professionalName: string;
  slotStart: Date;
  timezone: string;
};

/** Até quando um "sim"/"não" atrasado ainda é lido como resposta à oferta que venceu (depois disso é conversa nova). */
const LATE_ANSWER_WINDOW_MS = 6 * 3_600_000;

/** A mensagem inteira é um "sim" ou um "não" (as mesmas palavras do estado WAITLIST_OFFER do motor)? */
export function isWaitlistAnswerText(text: string): boolean {
  const norm = normalizeText(text);
  const words = STATE_ALIASES.WAITLIST_OFFER;
  return [...words.ACCEPT, ...words.DECLINE].some((w) => normalizeText(w) === norm);
}

/**
 * A oferta aberta mais recente do cliente, SE ele ainda não falou depois dela (`offeredAt` posterior
 * à última mensagem recebida) e o prazo não acabou. Depois da primeira resposta, o estado da sessão
 * segue o fluxo normal e esta checagem deixa de valer. Com `answerLike` (a mensagem é só "sim" ou
 * "não"), uma oferta que venceu há pouco também vale: assim quem responde atrasado recebe "o prazo
 * acabou" em vez de um "não entendi".
 */
export async function findPendingWaitlistOffer(
  tenantId: string,
  contactId: string,
  lastInboundAt: Date,
  now: Date,
  options: { answerLike?: boolean } = {},
): Promise<PendingWaitlistOffer | null> {
  const stillOpen = { status: "OFFERED" as const, offerExpiresAt: { gt: now } };
  const lateAnswer = { status: { in: ["OFFERED" as const, "EXPIRED" as const] }, offerExpiresAt: { gt: new Date(now.getTime() - LATE_ANSWER_WINDOW_MS) } };
  const entry = await forTenant(tenantId).waitlistEntry.findFirst({
    where: { contactId, offeredAt: { gt: lastInboundAt }, ...(options.answerLike ? { OR: [stillOpen, lateAnswer] } : stillOpen) },
    orderBy: { offeredAt: "desc" },
    include: { service: { select: { name: true } }, offeredProfessional: { select: { name: true } } },
  });
  if (!entry || !entry.offeredSlotStart) return null;
  const tenant = await getPrisma().tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { timezone: true } });
  return {
    entryId: entry.id,
    serviceName: entry.service.name,
    professionalName: entry.offeredProfessional?.name ?? "a equipe",
    slotStart: entry.offeredSlotStart,
    timezone: tenant.timezone,
  };
}

/** Contexto da sessão no estado `WAITLIST_OFFER`: as opções 1 (sim) e 2 (não) e o texto para repetir. */
export function buildWaitlistOfferContext(offer: PendingWaitlistOffer, texts: Record<string, string>): Record<string, unknown> {
  const accept = texts.LABEL_WAITLIST_ACCEPT || "Sim, quero esse horário";
  const decline = texts.LABEL_WAITLIST_DECLINE || "Não, obrigado";
  return {
    v: 2,
    waitlistEntryId: offer.entryId,
    options: [
      { n: 1, id: "ACCEPT", title: accept, label: accept },
      { n: 2, id: "DECLINE", title: decline, label: decline },
    ],
    lastTextKey: "WAITLIST_OFFER",
    lastVars: {
      servico: offer.serviceName,
      profissional: offer.professionalName,
      data: formatDayLabel(offer.slotStart, offer.timezone),
      data_longa: formatLongDayLabel(offer.slotStart, offer.timezone),
      hora: formatTimeLabel(offer.slotStart, offer.timezone),
      prazo: formatLeadLabel(WAITLIST_OFFER_MINUTES),
    },
  };
}
