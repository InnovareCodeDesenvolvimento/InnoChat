import { renderTemplate } from "@/core/bot/texts";
import { formatDayLabel, formatTimeLabel } from "@/core/bot/format";
import { reminderFirstName, whenLabel } from "@/core/reminders/window";
import { getPrisma } from "@/lib/db/prisma";
import { forTenant } from "@/lib/db/tenant-client";
import { logger } from "@/lib/logger";
import { sendTextToContact } from "@/modules/attendance/outbound";
import { getMergedBotTexts } from "@/modules/bot-texts/service";
import type { EvolutionClient } from "@/modules/whatsapp/evolution-client";

/**
 * Aviso ao cliente quando a EQUIPE cria, remarca ou cancela um agendamento pelo painel. Roda DEPOIS do
 * commit e nunca lança: qualquer falha vira `"FAILED"` (logada sem o corpo) e a operação de agenda
 * segue de pé. Concluir e "faltou" não avisam (não chamam isto).
 */

export type StaffChangeKind = "BOOKED" | "RESCHEDULED" | "CANCELED";
export type ClientNotification = "SENT" | "DISABLED" | "NO_WHATSAPP" | "NO_PHONE" | "FAILED";

const TEXT_KEY = { BOOKED: "STAFF_BOOKED", RESCHEDULED: "STAFF_RESCHEDULED", CANCELED: "STAFF_CANCELED" } as const;

export async function notifyClientOfStaffChange(
  params: { tenantId: string; appointmentId: string; kind: StaffChangeKind },
  deps: { evolution?: EvolutionClient; now?: Date } = {},
): Promise<ClientNotification> {
  const { tenantId, appointmentId, kind } = params;
  try {
    const tenant = await getPrisma().tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { name: true, timezone: true, notifyClientOnStaffChanges: true },
    });
    if (!tenant.notifyClientOnStaffChanges) return "DISABLED";

    const appointment = await forTenant(tenantId).appointment.findFirst({
      where: { id: appointmentId },
      include: {
        contact: { select: { id: true, name: true, pushName: true } },
        service: { select: { name: true } },
        professional: { select: { name: true } },
      },
    });
    if (!appointment) return "FAILED";

    const now = deps.now ?? new Date();
    const texts = await getMergedBotTexts(tenantId, 2);
    const text = renderTemplate(texts[TEXT_KEY[kind]], {
      nome: reminderFirstName(appointment.contact.name, appointment.contact.pushName),
      empresa: tenant.name,
      servico: appointment.service.name,
      profissional: appointment.professional.name,
      data: formatDayLabel(appointment.startsAt, tenant.timezone),
      hora: formatTimeLabel(appointment.startsAt, tenant.timezone),
      quando: whenLabel(appointment.startsAt, now, tenant.timezone),
    });

    const sent = await sendTextToContact({
      tenantId,
      contactId: appointment.contact.id,
      text,
      preferredInstanceId: appointment.whatsappInstanceId,
      evolution: deps.evolution,
    });
    return sent.outcome === "SENT" ? "SENT" : sent.outcome === "NO_PHONE" || sent.outcome === "NO_WHATSAPP" ? sent.outcome : "FAILED";
  } catch (error) {
    logger.warn("agenda.staff_notify_failed", { tenantId, appointmentId, kind, errorName: error instanceof Error ? error.name : "unknown" });
    return "FAILED";
  }
}
