import { getPrisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { digitsOnly, maskPhone, ROUND_WINDOW_MS, roundCapFor } from "@/core/platform-whatsapp/rules";
import { mapEvolutionState } from "@/core/whatsapp/connection-event";
import { EvolutionApiError, getEvolutionClient, type EvolutionClient } from "@/modules/whatsapp/evolution-client";
import { markActiveDisconnected } from "@/modules/platform-whatsapp/connections";
import { isPlatformSender } from "@/modules/platform-whatsapp/sender-guard";

export type RescueSendOutcome =
  | "SENT"
  | "DISABLED"
  | "NO_PLATFORM_NUMBER"
  | "CHANNEL_DOWN"
  | "BLOCKED_LOOP"
  | "RATE_LIMITED"
  | "FAILED";

export type RescueSendResult = {
  outcome: RescueSendOutcome;
  connectionId?: string;
  senderPhoneE164?: string;
  providerMessageId?: string;
  reason?: "INVALID_NUMBER";
};

export type RescueSendDeps = {
  evolution?: EvolutionClient;
  now?: Date;
};

/**
 * Envia mensagem pelo slot de WhatsApp dedicado ao Resgate/Suporte (`purpose: 'RESCUE'`).
 *
 * Contrato:
 * - Respeita a flag global `PlatformSettings.rescueWhatsappEnabled`. Se false -> DISABLED.
 * - Resolve a conexão com `purpose: 'RESCUE'` e `role: 'ACTIVE'`. Se não existir ou sem telefone -> NO_PLATFORM_NUMBER.
 * - Conexão precisa estar CONNECTED. Se não -> CHANNEL_DOWN.
 * - Proteção anti-loop: não envia para chips que pertencem à plataforma.
 * - Respeita teto anti-bloqueio / aquecimento da conexão (roundCapFor com 10/h no aquecimento, 30/h normal).
 * - Uma única tentativa de envio (Evolution sem retry agressivo).
 * - Nunca loga telefone cru nem conteúdo pessoal.
 */
export async function sendRescueWhatsapp(
  args: { toE164: string; text: string; leadId: string; tenantId: string },
  deps?: RescueSendDeps,
): Promise<RescueSendResult> {
  const now = deps?.now ?? new Date();
  const prisma = getPrisma();

  const settings = await prisma.platformSettings.findUnique({
    where: { id: 1 },
    select: { rescueWhatsappEnabled: true },
  });

  if (!settings?.rescueWhatsappEnabled) {
    return { outcome: "DISABLED" };
  }

  const active = await prisma.platformWhatsappConnection.findFirst({
    where: { purpose: "RESCUE", role: "ACTIVE" },
  });

  if (!active || !active.phoneE164) {
    return { outcome: "NO_PLATFORM_NUMBER" };
  }

  const base = { connectionId: active.id, senderPhoneE164: active.phoneE164 };

  if (active.status !== "CONNECTED") {
    return { outcome: "CHANNEL_DOWN", connectionId: active.id };
  }

  const to = digitsOnly(args.toE164);
  if (!to) {
    return { outcome: "FAILED", connectionId: active.id };
  }

  if (await isPlatformSender(to, now.getTime())) {
    logger.warn("rescue.send_blocked_loop", { leadId: args.leadId, tenantId: args.tenantId });
    return { outcome: "BLOCKED_LOOP", connectionId: active.id };
  }

  // Teto anti-bloqueio por hora para a conexão de resgate
  const budget = await getRescueRoundBudget(active.id, active.activatedAt, now);
  if (budget.used >= budget.cap) {
    logger.info("rescue.send_round_cap", {
      connectionId: active.id,
      cap: budget.cap,
      leadId: args.leadId,
      tenantId: args.tenantId,
    });
    return { outcome: "RATE_LIMITED", connectionId: active.id };
  }

  let evolution: EvolutionClient;
  try {
    evolution = deps?.evolution ?? (await getEvolutionClient());
  } catch {
    return { outcome: "CHANNEL_DOWN", connectionId: active.id };
  }

  try {
    const sent = await evolution.sendText(active.instanceName, to, args.text);
    logger.info("rescue.whatsapp_sent", {
      connectionId: active.id,
      leadId: args.leadId,
      tenantId: args.tenantId,
      toMasked: maskPhone(to),
    });
    return {
      outcome: "SENT",
      ...base,
      ...(sent.messageId ? { providerMessageId: sent.messageId } : {}),
    };
  } catch (error) {
    logger.warn("rescue.send_failed", {
      connectionId: active.id,
      leadId: args.leadId,
      tenantId: args.tenantId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });

    // Se a sessão caiu, atualiza o status da conexão
    try {
      const mapped = mapEvolutionState(await evolution.connectionState(active.instanceName));
      if (mapped === "DISCONNECTED") {
        await markActiveDisconnected(active.id, now);
        return { outcome: "CHANNEL_DOWN", connectionId: active.id };
      }
    } catch {
      // Ignora erro de checagem
    }

    if (error instanceof EvolutionApiError) {
      if (error.status === 400 || /"exists"\s*:\s*false/.test(error.responseBody ?? "")) {
        return { outcome: "FAILED", connectionId: active.id, reason: "INVALID_NUMBER" };
      }
    }

    return { outcome: "FAILED", connectionId: active.id };
  }
}

/**
 * Calcula o orçamento da rodada deslizante de 1 hora para a conexão de RESCUE.
 * Considera mensagens de resgate enviadas na última hora (step1SentAt ou step2SentAt).
 */
export async function getRescueRoundBudget(
  connectionId: string,
  activatedAt: Date | null,
  now: Date,
): Promise<{ cap: number; used: number }> {
  const prisma = getPrisma();
  const oneHourAgo = new Date(now.getTime() - ROUND_WINDOW_MS);

  const used = await prisma.rescueLead.count({
    where: {
      platformConnectionId: connectionId,
      OR: [
        { step1SentAt: { gte: oneHourAgo } },
        { step2SentAt: { gte: oneHourAgo } },
      ],
    },
  });

  return { cap: roundCapFor(activatedAt, now), used };
}
