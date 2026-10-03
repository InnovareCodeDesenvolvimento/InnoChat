import { forTenant } from "@/lib/db/tenant-client";
import { recordAudit, type AuditActor } from "./record";
import type { AuditChanges } from "./sanitize";

/** Pedaços de texto legíveis usados nos resumos e no de/para. Tudo em português, sem jargão. */

export function formatBrl(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "sem preço";
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function formatDateTimeBr(date: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("pt-BR", {
      timeZone: timezone,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
      .format(date)
      .replace(",", " às");
  } catch {
    return date.toISOString();
  }
}

const WEEKDAY_SHORT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/** "seg 09:00-18:00; ter 09:00-12:00" em ordem de dia e horário. Lista vazia = "sem expediente". */
export function formatWorkingHours(hours: { weekday: number; startTime: string; endTime: string }[]): string {
  if (hours.length === 0) return "sem expediente";
  return [...hours]
    .sort((a, b) => a.weekday - b.weekday || a.startTime.localeCompare(b.startTime))
    .map((h) => `${WEEKDAY_SHORT[h.weekday] ?? h.weekday} ${h.startTime}-${h.endTime}`)
    .join("; ");
}

type AppointmentAuditAction =
  | "appointment.created"
  | "appointment.rescheduled"
  | "appointment.canceled"
  | "appointment.completed"
  | "appointment.no_show"
  | "appointment.reopened";

const APPOINTMENT_VERB: Record<AppointmentAuditAction, string> = {
  "appointment.created": "Criou o agendamento",
  "appointment.rescheduled": "Remarcou o agendamento",
  "appointment.canceled": "Cancelou o agendamento",
  "appointment.completed": "Concluiu o atendimento",
  "appointment.no_show": "Marcou falta no atendimento",
  "appointment.reopened": "Reabriu o atendimento",
};

/**
 * Registra uma ação de agenda feita pelo painel com um resumo legível: "Criou o agendamento de Corte, 12/10/2026 às 14:00".
 * NÃO grava o nome do cliente (LGPD: esta tabela não aceita correção e guarda por anos). O `targetId` é o agendamento; a tela
 * do histórico resolve o nome pelo contato vivo na hora de mostrar, e some junto se o contato for anonimizado.
 * Lê o agendamento de novo (já com o serviço) só para montar o texto; se não achar, grava mesmo assim com o id.
 */
export async function auditAppointmentAction(params: {
  tenantId: string;
  timezone: string;
  actor: AuditActor;
  appointmentId: string;
  action: AppointmentAuditAction;
  changes?: AuditChanges | null;
}): Promise<void> {
  let detail = "";
  try {
    const row = await forTenant(params.tenantId).appointment.findFirst({
      where: { id: params.appointmentId },
      select: { startsAt: true, service: { select: { name: true } } },
    });
    if (row) {
      detail = ` de ${row.service?.name ?? "serviço"}, ${formatDateTimeBr(row.startsAt, params.timezone)}`;
    }
  } catch {
    // Só o texto fica mais pobre; o registro em si não pode falhar por isso.
  }
  await recordAudit({
    tenantId: params.tenantId,
    actor: params.actor,
    action: params.action,
    targetType: "appointment",
    targetId: params.appointmentId,
    summary: `${APPOINTMENT_VERB[params.action]}${detail}.`,
    changes: params.changes ?? null,
  });
}
