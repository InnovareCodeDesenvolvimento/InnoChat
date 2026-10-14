"use server";

import { z } from "zod";
import { requireTenantMember } from "@/lib/auth/guards";
import { runAction, type Result } from "@/lib/result";
import { forTenant } from "@/lib/db/tenant-client";
import { assertTenantCanWrite } from "@/modules/billing/service";
import { auditAppointmentAction } from "@/modules/audit/describe";
import { memberActor } from "@/modules/audit/record";
import { notifyClientOfStaffChange } from "./staff-notify";
import {
  cancelAppointmentDetailed,
  createAppointmentManual,
  finishAppointment,
  listAppointments,
  reopenAppointment,
  rescheduleAppointment,
  type AppointmentView,
} from "./appointments";

const listSchema = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
  professionalId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export async function listAppointmentsAction(tenantSlug: string, input: unknown): Promise<Result<unknown>> {
  return runAction(async () => {
    const { tenant } = await requireTenantMember(tenantSlug);
    const data = listSchema.parse(input);
    return listAppointments(tenant.id, data);
  });
}

const createAppointmentSchema = z.object({
  contactId: z.string().min(1).optional(),
  contactName: z.string().trim().min(1).max(120).optional(),
  contactPhoneE164: z.string().trim().max(20).optional(),
  serviceId: z.string().min(1),
  professionalId: z.string().min(1).nullable(),
  startsAt: z.coerce.date(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export async function createAppointmentAction(tenantSlug: string, input: unknown): Promise<Result<unknown>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant, user } = ctx;
    await assertTenantCanWrite(tenant.id);
    const data = createAppointmentSchema.parse(input);
    const result = await createAppointmentManual(tenant.id, data, user.id);
    if (!result.alreadyExisted) {
      await auditAppointmentAction({
        tenantId: tenant.id,
        timezone: tenant.timezone,
        actor: memberActor(ctx),
        appointmentId: (result.appointment as { id: string }).id,
        action: "appointment.created",
        supportSessionId: ctx.supportSessionId ?? null,
      });
    }
    // Aviso ao cliente (aditivo): só quando esta chamada CRIOU (repetição idempotente não reavisa).
    const clientNotification = result.alreadyExisted
      ? "DISABLED"
      : await notifyClientOfStaffChange({ tenantId: tenant.id, appointmentId: (result.appointment as { id: string }).id, kind: "BOOKED" });
    return { ...result, clientNotification };
  });
}

const cancelSchema = z.object({ note: z.string().trim().max(500).optional() });

export async function cancelAppointmentAction(tenantSlug: string, appointmentId: string, input?: unknown): Promise<Result<unknown>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant, user } = ctx;
    await assertTenantCanWrite(tenant.id);
    const data = cancelSchema.parse(input ?? {});
    const { appointment, changed } = await cancelAppointmentDetailed(tenant.id, appointmentId, user.id, data.note);
    if (changed) {
      await auditAppointmentAction({
        tenantId: tenant.id,
        timezone: tenant.timezone,
        actor: memberActor(ctx),
        appointmentId,
        action: "appointment.canceled",
        supportSessionId: ctx.supportSessionId ?? null,
      });
    }
    const clientNotification = changed ? await notifyClientOfStaffChange({ tenantId: tenant.id, appointmentId, kind: "CANCELED" }) : "DISABLED";
    return { ...appointment, clientNotification };
  });
}

const rescheduleSchema = z.object({ startsAt: z.coerce.date() });

export async function rescheduleAppointmentAction(tenantSlug: string, appointmentId: string, input: unknown): Promise<Result<unknown>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant, user } = ctx;
    await assertTenantCanWrite(tenant.id);
    const data = rescheduleSchema.parse(input);
    const before = await forTenant(tenant.id).appointment.findFirst({ where: { id: appointmentId }, select: { startsAt: true } });
    const updated = await rescheduleAppointment(tenant.id, appointmentId, data.startsAt, user.id);
    // Mesmo horário (arrastou e soltou no lugar): nada mudou para o cliente, não avisa.
    const moved = !before || before.startsAt.getTime() !== updated.startsAt.getTime();
    if (moved) {
      await auditAppointmentAction({
        tenantId: tenant.id,
        timezone: tenant.timezone,
        actor: memberActor(ctx),
        appointmentId,
        action: "appointment.rescheduled",
        changes: { startsAt: { de: before?.startsAt ?? null, para: updated.startsAt } },
        supportSessionId: ctx.supportSessionId ?? null,
      });
    }
    const clientNotification = moved ? await notifyClientOfStaffChange({ tenantId: tenant.id, appointmentId, kind: "RESCHEDULED" }) : "DISABLED";
    return { ...updated, clientNotification };
  });
}

const appointmentRefSchema = z.object({ tenantSlug: z.string().min(1).max(100), appointmentId: z.string().min(1).max(120) });

/**
 * Concluir / cliente faltou / reabrir — OWNER e STAFF (qualquer membro), bloqueados com a conta
 * suspensa. Recebem um objeto `{ tenantSlug, appointmentId }` e devolvem o agendamento atualizado.
 */
export async function completeAppointmentAction(input: { tenantSlug: string; appointmentId: string }): Promise<Result<AppointmentView>> {
  return runAction(async () => {
    const data = appointmentRefSchema.parse(input);
    const ctx = await requireTenantMember(data.tenantSlug);
    const { tenant, user } = ctx;
    await assertTenantCanWrite(tenant.id);
    const before = await forTenant(tenant.id).appointment.findFirst({ where: { id: data.appointmentId }, select: { status: true } });
    const result = await finishAppointment(tenant.id, data.appointmentId, user.id, "COMPLETED");
    if (before && before.status !== result.status) {
      await auditAppointmentAction({
        tenantId: tenant.id,
        timezone: tenant.timezone,
        actor: memberActor(ctx),
        appointmentId: data.appointmentId,
        action: "appointment.completed",
        changes: { status: { de: before.status, para: result.status } },
        supportSessionId: ctx.supportSessionId ?? null,
      });
    }
    return result;
  });
}

export async function markNoShowAppointmentAction(input: { tenantSlug: string; appointmentId: string }): Promise<Result<AppointmentView>> {
  return runAction(async () => {
    const data = appointmentRefSchema.parse(input);
    const ctx = await requireTenantMember(data.tenantSlug);
    const { tenant, user } = ctx;
    await assertTenantCanWrite(tenant.id);
    const before = await forTenant(tenant.id).appointment.findFirst({ where: { id: data.appointmentId }, select: { status: true } });
    const result = await finishAppointment(tenant.id, data.appointmentId, user.id, "NO_SHOW");
    if (before && before.status !== result.status) {
      await auditAppointmentAction({
        tenantId: tenant.id,
        timezone: tenant.timezone,
        actor: memberActor(ctx),
        appointmentId: data.appointmentId,
        action: "appointment.no_show",
        changes: { status: { de: before.status, para: result.status } },
        supportSessionId: ctx.supportSessionId ?? null,
      });
    }
    return result;
  });
}

export async function reopenAppointmentAction(input: { tenantSlug: string; appointmentId: string }): Promise<Result<AppointmentView>> {
  return runAction(async () => {
    const data = appointmentRefSchema.parse(input);
    const ctx = await requireTenantMember(data.tenantSlug);
    const { tenant, user } = ctx;
    await assertTenantCanWrite(tenant.id);
    const before = await forTenant(tenant.id).appointment.findFirst({ where: { id: data.appointmentId }, select: { status: true } });
    const result = await reopenAppointment(tenant.id, data.appointmentId, user.id);
    if (before && before.status !== result.status) {
      await auditAppointmentAction({
        tenantId: tenant.id,
        timezone: tenant.timezone,
        actor: memberActor(ctx),
        appointmentId: data.appointmentId,
        action: "appointment.reopened",
        changes: { status: { de: before.status, para: result.status } },
        supportSessionId: ctx.supportSessionId ?? null,
      });
    }
    return result;
  });
}
