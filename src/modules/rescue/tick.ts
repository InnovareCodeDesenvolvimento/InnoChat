import { getPrisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { withAdvisoryLock } from "@/lib/db/advisory-lock";
import { recordAudit } from "@/modules/audit/record";
import { planNextActions, type ActionPlan, type LeadWithUser, type RescueSettings } from "./planner";
import { transitionRescueLead } from "./service";
import { sendRescueWhatsapp, type RescueSendDeps } from "./sender";

export { planNextActions, type ActionPlan, type RescueSettings };

export type TickResult = {
  processed: number;
  sent: number;
  skipped: number;
  errors: number;
  deferred: number;
  skippedByLock?: boolean;
};

export type RunRescueTickOptions = {
  dryRun?: boolean;
  limit?: number;
  deps?: RescueSendDeps;
};

const RESCUE_TICK_LOCK = "rescue:tick";
const DEFAULT_BATCH_LIMIT = 50;

/**
 * Tick do Resgate de Leads (docs e plano de melhorias).
 *
 * Contrato:
 * - Protegido por advisory lock para não rodar concorrentemente.
 * - Lê PlatformSettings: se rescueWhatsappEnabled for false, sai com noop.
 * - Busca até N leads com status elegível e nextRunAt <= now.
 * - Planeja com planNextActions puro.
 * - Executa as ações atômicas uma a uma com transição idempotente.
 * - Auditoria registrada via recordAudit com actor.role = "SYSTEM".
 *
 * NOTA: conforme a memória `tick-global-polui-banco-de-teste`, testes unitários
 * e de integração NUNCA chamam runRescueTick() diretamente; testam `planNextActions`
 * com fixtures.
 */
export async function runRescueTick(
  now: Date = new Date(),
  options?: RunRescueTickOptions,
): Promise<TickResult> {
  const prisma = getPrisma();
  const limit = options?.limit ?? DEFAULT_BATCH_LIMIT;
  const isDryRun = options?.dryRun ?? false;

  const result: TickResult = {
    processed: 0,
    sent: 0,
    skipped: 0,
    errors: 0,
    deferred: 0,
  };

  return (await withAdvisoryLock(RESCUE_TICK_LOCK, async () => {
    const settingsRow = await prisma.platformSettings.findUnique({
      where: { id: 1 },
      select: {
        rescueWhatsappEnabled: true,
        rescueQuietHoursStart: true,
        rescueQuietHoursEnd: true,
      },
    });

    const settings: RescueSettings = {
      rescueWhatsappEnabled: settingsRow?.rescueWhatsappEnabled ?? false,
      rescueQuietHoursStart: settingsRow?.rescueQuietHoursStart ?? 20,
      rescueQuietHoursEnd: settingsRow?.rescueQuietHoursEnd ?? 8,
    };

    if (!settings.rescueWhatsappEnabled) {
      logger.info("rescue.tick_skipped_disabled");
      return result;
    }

    // Busca leads com nextRunAt vencido e status elegíveis para avanço
    const leads = (await prisma.rescueLead.findMany({
      where: {
        status: { in: ["PENDING", "MESSAGE_1_SENT", "MESSAGE_2_SENT"] },
        nextRunAt: { lte: now },
      },
      include: {
        user: {
          select: {
            name: true,
            createdAt: true,
            lastSeenAt: true,
          },
        },
      },
      orderBy: { nextRunAt: "asc" },
      take: limit,
    })) as unknown as LeadWithUser[];

    if (leads.length === 0) {
      return result;
    }

    const plans = planNextActions(leads, now, settings);

    for (const plan of plans) {
      result.processed++;
      const lead = leads.find((l) => l.id === plan.leadId);
      if (!lead) continue;

      if (plan.kind === "NOOP" || plan.kind === "SKIP_DISABLED") {
        result.skipped++;
        continue;
      }

      if (plan.kind === "DEFER_QUIET_HOURS") {
        result.deferred++;
        if (!isDryRun && plan.nextRunAt) {
          await prisma.rescueLead.update({
            where: { id: plan.leadId },
            data: { nextRunAt: plan.nextRunAt },
          }).catch(() => undefined);
        }
        continue;
      }

      if (plan.kind === "EXPIRE") {
        if (!isDryRun) {
          await transitionRescueLead(lead, "EXPIRED", now, { nextRunAt: null });
        }
        result.skipped++;
        continue;
      }

      if (plan.kind === "SEND_MESSAGE_1" || plan.kind === "SEND_MESSAGE_2") {
        if (isDryRun) {
          result.sent++;
          continue;
        }

        const isStep1 = plan.kind === "SEND_MESSAGE_1";
        const sendingStatus = isStep1 ? "MESSAGE_1_SENDING" : "MESSAGE_2_SENDING";
        const successStatus = isStep1 ? "MESSAGE_1_SENT" : "MESSAGE_2_SENT";

        // Trava linha atômica passando para SENDING
        const claim = await transitionRescueLead(lead, sendingStatus, now);
        if (!claim.ok) {
          result.skipped++;
          continue;
        }

        const text = plan.messageText ?? "";
        const sendResult = await sendRescueWhatsapp(
          {
            toE164: lead.phoneE164,
            text,
            leadId: lead.id,
            tenantId: lead.tenantId,
          },
          options?.deps,
        );

        if (sendResult.outcome === "SENT") {
          result.sent++;
          const nextRun = isStep1 ? lead.step2ScheduledAt : null;
          await transitionRescueLead(
            { id: lead.id, status: sendingStatus },
            successStatus,
            now,
            {
              nextRunAt: nextRun,
              platformConnectionId: sendResult.connectionId,
              senderPhoneE164: sendResult.senderPhoneE164,
              ...(isStep1
                ? { step1SentAt: now, providerMessageId1: sendResult.providerMessageId }
                : { step2SentAt: now, providerMessageId2: sendResult.providerMessageId }),
            },
          );

          // Auditoria de envio da mensagem de resgate
          await recordAudit({
            tenantId: lead.tenantId,
            actor: { userId: null, role: "SYSTEM" },
            action: isStep1 ? "rescue.message_1_sent" : "rescue.message_2_sent",
            targetType: "RescueLead",
            targetId: lead.id,
            summary: `Mensagem de resgate (${isStep1 ? "Passo 1" : "Passo 2"}) enviada via WhatsApp`,
            changes: {
              status: { de: lead.status, para: successStatus },
              providerMessageId: { de: null, para: sendResult.providerMessageId ?? "sent" },
            },
          }).catch(() => undefined);
        } else if (sendResult.outcome === "RATE_LIMITED" || sendResult.outcome === "CHANNEL_DOWN") {
          // Reverte para o status anterior e tenta novamente em 30 min
          const retryAt = new Date(now.getTime() + 30 * 60 * 1000);
          await transitionRescueLead(
            { id: lead.id, status: sendingStatus },
            lead.status,
            now,
            {
              nextRunAt: retryAt,
              lastErrorCode: sendResult.outcome,
            },
          );
          result.errors++;
        } else {
          // Erro permanente ou número inválido: incrementa tentativa ou pula
          const newAttempts = (lead.attempts ?? 0) + 1;
          const terminal = newAttempts >= 3 || sendResult.reason === "INVALID_NUMBER";
          await transitionRescueLead(
            { id: lead.id, status: sendingStatus },
            terminal ? "SKIPPED" : lead.status,
            now,
            {
              attempts: newAttempts,
              nextRunAt: terminal ? null : new Date(now.getTime() + 60 * 60 * 1000),
              lastErrorCode: sendResult.reason ?? sendResult.outcome,
            },
          );
          result.errors++;
        }
      }
    }

    return result;
  })).acquired ? result : { ...result, skippedByLock: true };
}
