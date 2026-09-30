import { formatInTimeZone } from "date-fns-tz";
import type { NotificationKind, NotificationSeverity } from "./types";

/**
 * Textos e formatação da central de notificações — puro (sem I/O), testado em `format.test.ts`.
 * Nunca recebe nem devolve telefone: só o NOME do contato (fallback "Cliente").
 */

export type EventAction = "CREATED" | "CANCELED" | "RESCHEDULED" | "COMPLETED" | "NO_SHOW";
export type EventAuthorType = "CONTACT" | "USER" | "SYSTEM";
export type NotificationSource = "WHATSAPP" | "PANEL" | "SYSTEM";

export const EVENT_KIND: Record<EventAction, NotificationKind> = {
  CREATED: "APPOINTMENT_CREATED",
  RESCHEDULED: "APPOINTMENT_RESCHEDULED",
  CANCELED: "APPOINTMENT_CANCELED",
  COMPLETED: "APPOINTMENT_COMPLETED",
  NO_SHOW: "APPOINTMENT_NO_SHOW",
};

export const EVENT_SEVERITY: Record<EventAction, NotificationSeverity> = {
  CREATED: "success",
  RESCHEDULED: "info",
  CANCELED: "warning",
  COMPLETED: "success",
  NO_SHOW: "warning",
};

/** Origem de um evento: na criação vale a origem do agendamento; nas demais, quem agiu. */
export function eventSource(action: EventAction, authorType: EventAuthorType, appointmentSource: "WHATSAPP" | "PANEL"): NotificationSource {
  if (action === "CREATED") return appointmentSource;
  if (authorType === "CONTACT") return "WHATSAPP";
  if (authorType === "USER") return "PANEL";
  return "SYSTEM";
}

const SOURCE_SUFFIX: Record<NotificationSource, string> = { WHATSAPP: " pelo WhatsApp", PANEL: " pelo painel", SYSTEM: "" };

export function eventTitle(action: EventAction, source: NotificationSource): string {
  switch (action) {
    case "CREATED":
      return `Novo agendamento${SOURCE_SUFFIX[source]}`;
    case "RESCHEDULED":
      return `Agendamento remarcado${SOURCE_SUFFIX[source]}`;
    case "CANCELED":
      return `Agendamento cancelado${SOURCE_SUFFIX[source]}`;
    case "COMPLETED":
      return "Atendimento concluído";
    case "NO_SHOW":
      return "Cliente não compareceu";
  }
}

/** Pedido de atendente (bot v2): título fixo e corpo "<nome>" ou "<nome> · fora do horário". */
export const HANDOFF_TITLE = "Cliente pediu atendente";

export function handoffBody(contactName: string, offHours: boolean): string {
  return offHours ? `${contactName} · fora do horário` : contactName;
}

/** "qui 02/10 às 14:00" no fuso da empresa. */
const WEEKDAY_ABBR = ["seg", "ter", "qua", "qui", "sex", "sáb", "dom"]; // índice = ISO weekday - 1

export function formatWhen(date: Date, timezone: string): string {
  // Abreviação própria: o locale pt-BR do date-fns devolve o nome inteiro ("quinta") em EEE.
  const weekday = WEEKDAY_ABBR[Number(formatInTimeZone(date, timezone, "i")) - 1];
  return `${weekday} ${formatInTimeZone(date, timezone, "dd/MM 'às' HH:mm")}`;
}

export function dayISO(date: Date, timezone: string): string {
  return formatInTimeZone(date, timezone, "yyyy-MM-dd");
}

export function contactDisplayName(c: { name: string | null; pushName: string | null } | null | undefined): string {
  return c?.name?.trim() || c?.pushName?.trim() || "Cliente";
}

/** "Maria • Corte • com Ana • qui 02/10 às 14:00" */
export function appointmentBody(p: { contactName: string; serviceName: string; professionalName: string; startsAt: Date; timezone: string }): string {
  return [p.contactName, p.serviceName, `com ${p.professionalName}`, formatWhen(p.startsAt, p.timezone)].join(" • ");
}

/** Ação de um evento na linha do tempo. REOPENED existe só aqui: não gera notificação. */
export type TimelineAction = EventAction | "REOPENED";

/**
 * Rótulo pt-BR da linha do tempo. `authorName` (nome curto do membro da equipe, quando resolvido)
 * só entra nos eventos de encerramento: "Atendimento concluído por ana".
 */
export function timelineLabel(action: TimelineAction, authorType: EventAuthorType, authorName?: string | null): string {
  const who = authorType === "CONTACT" ? "Cliente" : null;
  const via = authorType === "CONTACT" ? " pelo WhatsApp" : authorType === "USER" ? " pelo painel" : " pelo sistema";
  const by = authorType === "USER" && authorName ? ` por ${authorName}` : "";
  switch (action) {
    case "CREATED":
      return who ? `Cliente agendou${via}` : `Agendado${via}`;
    case "RESCHEDULED":
      return who ? `Cliente remarcou${via}` : `Remarcado${via}`;
    case "CANCELED":
      return who ? `Cliente cancelou${via}` : `Cancelado${via}`;
    case "COMPLETED":
      return `Atendimento concluído${by}`;
    case "NO_SHOW":
      return by ? `Cliente faltou — marcado${by}` : "Cliente faltou";
    case "REOPENED":
      return `Atendimento reaberto${by}`;
  }
}

export function minutesUntil(startsAt: Date, now: Date): number {
  return Math.max(0, Math.ceil((startsAt.getTime() - now.getTime()) / 60_000));
}
