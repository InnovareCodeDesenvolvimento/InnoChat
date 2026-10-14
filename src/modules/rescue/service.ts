import { getPrisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { digitsOnly } from "@/core/platform-whatsapp/rules";
import type { RescueLead, RescueLeadStatus } from "@/lib/db/types";

export type { RescueLead, RescueLeadStatus };

const STEP1_HOURS = 24;
const STEP2_HOURS = 96;

/** Normaliza telefone para formato numérico E.164 (ex: 558499998888). */
export function sanitizeRescuePhone(phone: string): string {
  const digits = digitsOnly(phone);
  if (digits.length === 10 || digits.length === 11) {
    return `55${digits}`;
  }
  return digits;
}

/**
 * Garante a criação de um RescueLead para o usuário.
 * Idempotente: se já existe para este userId, não duplica e retorna o existente.
 */
export async function ensureRescueLead(
  userId: string,
  tenantId: string,
  phoneE164: string,
  now: Date = new Date()
): Promise<RescueLead | null> {
  const prisma = getPrisma();
  const cleanPhone = sanitizeRescuePhone(phoneE164);
  if (!cleanPhone || cleanPhone.length < 12 || cleanPhone.length > 13) {
    logger.warn("rescue.ensure_lead_invalid_phone", { userId, tenantId, phone: cleanPhone });
    return null;
  }

  const step1ScheduledAt = new Date(now.getTime() + STEP1_HOURS * 60 * 60 * 1000);
  const step2ScheduledAt = new Date(now.getTime() + STEP2_HOURS * 60 * 60 * 1000);

  try {
    const existing = await prisma.rescueLead.findUnique({ where: { userId } });
    if (existing) {
      return existing;
    }

    return await prisma.rescueLead.create({
      data: {
        userId,
        tenantId,
        phoneE164: cleanPhone,
        status: "PENDING",
        step1ScheduledAt,
        step2ScheduledAt,
        nextRunAt: step1ScheduledAt,
      },
    });
  } catch (error) {
    // Corrida com outro create concorrente: busca o existente
    const fallback = await prisma.rescueLead.findUnique({ where: { userId } });
    if (fallback) return fallback;
    logger.error("rescue.ensure_lead_error", {
      userId,
      tenantId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Transição de status atômica e idempotente via updateMany ({ id, status: expectedStatus }).
 * Se o status atual não for o esperado (ex: já foi CONVERTED, RESPONDED ou OPTED_OUT),
 * a operação falha com ok: false sem sobrescrever o status terminal.
 */
export async function transitionRescueLead(
  lead: { id: string; status: RescueLeadStatus },
  toStatus: RescueLeadStatus,
  now: Date = new Date(),
  extra?: Partial<RescueLead>
): Promise<{ ok: boolean; newStatus: RescueLeadStatus }> {
  const prisma = getPrisma();

  const data: Record<string, unknown> = {
    status: toStatus,
    updatedAt: now,
  };

  if (extra?.step1SentAt !== undefined) data.step1SentAt = extra.step1SentAt;
  if (extra?.step2SentAt !== undefined) data.step2SentAt = extra.step2SentAt;
  if (extra?.nextRunAt !== undefined) data.nextRunAt = extra.nextRunAt;
  if (extra?.attempts !== undefined) data.attempts = extra.attempts;
  if (extra?.lastErrorCode !== undefined) data.lastErrorCode = extra.lastErrorCode;
  if (extra?.platformConnectionId !== undefined) data.platformConnectionId = extra.platformConnectionId;
  if (extra?.senderPhoneE164 !== undefined) data.senderPhoneE164 = extra.senderPhoneE164;
  if (extra?.providerMessageId1 !== undefined) data.providerMessageId1 = extra.providerMessageId1;
  if (extra?.providerMessageId2 !== undefined) data.providerMessageId2 = extra.providerMessageId2;
  if (extra?.optedOutAt !== undefined) data.optedOutAt = extra.optedOutAt;
  if (extra?.convertedAt !== undefined) data.convertedAt = extra.convertedAt;
  if (extra?.respondedAt !== undefined) data.respondedAt = extra.respondedAt;

  const result = await prisma.rescueLead.updateMany({
    where: {
      id: lead.id,
      status: lead.status,
    },
    data,
  });

  if (result.count > 0) {
    return { ok: true, newStatus: toStatus };
  }

  // Se não atualizou, verifica qual é o status real agora
  const fresh = await prisma.rescueLead.findUnique({ where: { id: lead.id }, select: { status: true } });
  return { ok: false, newStatus: fresh?.status ?? lead.status };
}

/**
 * Marca como OPTED_OUT quando o lead responde STOP/SAIR/PARAR.
 * Zera nextRunAt para cessar envios futuros.
 */
export async function optOut(leadId: string, now: Date = new Date()): Promise<void> {
  const prisma = getPrisma();
  await prisma.rescueLead.updateMany({
    where: {
      id: leadId,
      status: { notIn: ["OPTED_OUT", "CONVERTED"] },
    },
    data: {
      status: "OPTED_OUT",
      optedOutAt: now,
      nextRunAt: null,
    },
  });
}

/**
 * Marca como RESPONDED quando o lead envia qualquer outra mensagem.
 * Zera nextRunAt para não disparar nova mensagem de resgate automática.
 */
export async function markResponded(leadId: string, now: Date = new Date(), messageBody?: string): Promise<void> {
  void messageBody;
  const prisma = getPrisma();
  await prisma.rescueLead.updateMany({
    where: {
      id: leadId,
      status: { notIn: ["OPTED_OUT", "CONVERTED", "RESPONDED"] },
    },
    data: {
      status: "RESPONDED",
      respondedAt: now,
      nextRunAt: null,
    },
  });
}

/**
 * Marca como CONVERTED quando o usuário entra no painel (User.lastSeenAt preenchido).
 */
export async function markConverted(userId: string, now: Date = new Date()): Promise<void> {
  const prisma = getPrisma();
  await prisma.rescueLead.updateMany({
    where: {
      userId,
      status: { notIn: ["CONVERTED", "OPTED_OUT"] },
    },
    data: {
      status: "CONVERTED",
      convertedAt: now,
      nextRunAt: null,
    },
  });
}
