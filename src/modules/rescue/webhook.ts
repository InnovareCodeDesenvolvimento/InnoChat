import { getPrisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { digitsOnly, isOptOutText, maskPhone, phoneDigitVariants } from "@/core/platform-whatsapp/rules";
import { getEvolutionClient, type EvolutionClient } from "@/modules/whatsapp/evolution-client";
import { optOut, markResponded } from "./service";
import { RESCUE_OPT_OUT_CONFIRMATION } from "./messages";

export type RescueWebhookDeps = {
  evolution?: EvolutionClient;
  now?: Date;
};

export type RescueInboundResult = {
  handled: boolean;
  kind?: "OPT_OUT" | "RESPONDED" | "IGNORED";
  leadId?: string;
  senderDigits?: string;
};

/**
 * Processa mensagens recebidas na conexão de propósito RESCUE (docs/resgate).
 *
 * Contrato:
 * - Se texto normalizado for opt-out (STOP / SAIR / PARAR / CANCELAR):
 *     1. Localiza RescueLead pelo telefone do remetente (variantes com/sem 9º dígito).
 *     2. Executa optOut(leadId, now) marcando status como OPTED_OUT.
 *     3. Envia confirmação: "Tudo certo, não mando mais. Obrigado!" (RESCUE_OPT_OUT_CONFIRMATION).
 * - Se texto for qualquer outra coisa:
 *     1. Localiza RescueLead pelo telefone.
 *     2. Executa markResponded(leadId, now, messageBody) marcando como RESPONDED.
 *     3. O model RescueLead com status RESPONDED já alimenta automaticamente o sino
 *        do Admin via PlatformNotification com kind RESCUE_LEAD_RESPONDED.
 *     4. NÃO envia resposta automática (o admin/suporte assume o atendimento humanizado).
 */
export async function handleRescueInboundMessage(
  args: {
    connectionId: string;
    senderDigits: string;
    text: string;
    replyTo: string;
  },
  deps?: RescueWebhookDeps,
): Promise<RescueInboundResult> {
  const now = deps?.now ?? new Date();
  const prisma = getPrisma();
  const senderDigits = digitsOnly(args.senderDigits);
  if (!senderDigits) {
    return { handled: false };
  }

  const variants = phoneDigitVariants(senderDigits);
  if (variants.length === 0) {
    return { handled: false };
  }

  // Busca o RescueLead correspondente a qualquer uma das variantes de telefone
  const lead = await prisma.rescueLead.findFirst({
    where: {
      phoneE164: { in: variants },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, tenantId: true },
  });

  if (!lead) {
    logger.info("rescue.inbound_no_lead_found", { from: maskPhone(senderDigits) });
    return { handled: false, senderDigits };
  }

  const isOptOut = isOptOutText(args.text);

  if (isOptOut) {
    await optOut(lead.id, now);
    logger.info("rescue.opt_out_received", { leadId: lead.id, from: maskPhone(senderDigits) });

    // Envia resposta de confirmação de opt-out
    try {
      const connection = await prisma.platformWhatsappConnection.findUnique({
        where: { id: args.connectionId },
        select: { instanceName: true, role: true },
      });

      if (connection && connection.role === "ACTIVE") {
        const evolution = deps?.evolution ?? (await getEvolutionClient());
        await evolution.sendText(connection.instanceName, args.replyTo, RESCUE_OPT_OUT_CONFIRMATION);
      }
    } catch (error) {
      logger.warn("rescue.opt_out_reply_failed", {
        leadId: lead.id,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }

    return { handled: true, kind: "OPT_OUT", leadId: lead.id, senderDigits };
  }

  // Qualquer outra resposta: marca como RESPONDED
  await markResponded(lead.id, now, args.text);
  logger.info("rescue.lead_responded", { leadId: lead.id, from: maskPhone(senderDigits) });

  return { handled: true, kind: "RESPONDED", leadId: lead.id, senderDigits };
}
