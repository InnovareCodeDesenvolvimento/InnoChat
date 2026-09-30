"use server";

import { z } from "zod";
import { requireTenantMember } from "@/lib/auth/guards";
import { logger } from "@/lib/logger";
import { err, runAction, type Result } from "@/lib/result";
import {
  getAppointmentTimeline,
  getUpcomingAppointments,
  listNotifications,
  markNotificationsRead,
  pollNotifications,
} from "./service";
import type { AppNotification, TimelineItem, UpcomingAppointmentItem } from "./types";

/**
 * Central de notificações do painel (usuários da empresa — dono e equipe). Todas as actions
 * exigem membro da empresa (`requireTenantMember`) e NÃO passam por `assertTenantCanWrite`:
 * ler/marcar como lido é preferência de UX e precisa funcionar até com a conta suspensa.
 * Detalhes e decisões: `src/modules/notifications/service.ts` e docs/contratos.md.
 */

const tenantSlugSchema = z.string().min(1).max(100);

export async function listNotificationsAction(input: {
  tenantSlug: string;
  cursor?: string;
}): Promise<Result<{ items: AppNotification[]; unreadCount: number; nextCursor: string | null; attendanceWaitingCount: number }>> {
  return runAction(async () => {
    const data = z.object({ tenantSlug: tenantSlugSchema, cursor: z.string().max(200).optional() }).parse(input);
    const ctx = await requireTenantMember(data.tenantSlug);
    return listNotifications(ctx, data.cursor);
  });
}

export async function pollNotificationsAction(input: {
  tenantSlug: string;
  since: string;
}): Promise<Result<{ unreadCount: number; fresh: AppNotification[]; attendanceWaitingCount: number }>> {
  return runAction(async () => {
    const data = z.object({ tenantSlug: tenantSlugSchema, since: z.coerce.date() }).parse(input);
    const ctx = await requireTenantMember(data.tenantSlug);
    return pollNotifications(ctx, data.since);
  });
}

export async function markNotificationsReadAction(input: {
  tenantSlug: string;
  ids?: string[];
  all?: boolean;
}): Promise<Result<{ unreadCount: number }>> {
  return runAction(async () => {
    const data = z
      .object({
        tenantSlug: tenantSlugSchema,
        ids: z.array(z.string().min(1).max(120)).max(100).optional(),
        all: z.boolean().optional(),
      })
      .parse(input);
    const ctx = await requireTenantMember(data.tenantSlug);
    return markNotificationsRead(ctx, { ids: data.ids, all: data.all });
  });
}

export async function getUpcomingAppointmentsAction(input: {
  tenantSlug: string;
}): Promise<Result<{ items: UpcomingAppointmentItem[] }>> {
  return runAction(async () => {
    const data = z.object({ tenantSlug: tenantSlugSchema }).parse(input);
    const ctx = await requireTenantMember(data.tenantSlug);
    return getUpcomingAppointments(ctx);
  });
}

/**
 * Histórico do agendamento. Falha INESPERADA (bug, banco) não vira tela de erro do Next: é
 * registrada no log (só ids e o tipo/mensagem técnica do erro, nunca dados do cliente) e devolvida
 * como `Result` de erro `TIMELINE_UNAVAILABLE`, para a UI mostrar a mensagem sem perder o painel.
 */
export async function getAppointmentTimelineAction(input: {
  tenantSlug: string;
  appointmentId: string;
}): Promise<Result<{ items: TimelineItem[] }>> {
  try {
    return await runAction(async () => {
      const data = z.object({ tenantSlug: tenantSlugSchema, appointmentId: z.string().min(1).max(120) }).parse(input);
      const ctx = await requireTenantMember(data.tenantSlug);
      return getAppointmentTimeline(ctx, data.appointmentId);
    });
  } catch (error) {
    const e = error instanceof Error ? error : new Error(String(error));
    logger.error("getAppointmentTimelineAction falhou", {
      appointmentId: typeof input?.appointmentId === "string" ? input.appointmentId.slice(0, 120) : null,
      errorName: e.name,
      errorCode: (e as { code?: unknown }).code ?? null,
      errorMessage: e.message.slice(0, 500),
    });
    return err("TIMELINE_UNAVAILABLE", "Não foi possível carregar o histórico agora.");
  }
}
