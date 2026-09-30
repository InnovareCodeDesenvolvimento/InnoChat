"use server";

import { z } from "zod";
import { requireTenantMember } from "@/lib/auth/guards";
import { runAction, type Result } from "@/lib/result";
import { forTenant } from "@/lib/db/tenant-client";
import { assertTenantCanWrite } from "@/modules/billing/service";
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
    const { tenant, user } = await requireTenantMember(tenantSlug);
    await assertTenantCanWrite(tenant.id);
    const data = createAppointmentSchema.parse(input);
    const result = await createAppointmentManual(tenant.id, data, user.id);
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
    const { tenant, user } = await requireTenantMember(tenantSlug);
    await assertTenantCanWrite(tenant.id);
    const data = cancelSchema.parse(input ?? {});
    const { appointment, changed } = await cancelAppointmentDetailed(tenant.id, appointmentId, user.id, data.note);
    const clientNotification = changed ? await notifyClientOfStaffChange({ tenantId: tenant.id, appointmentId, kind: "CANCELED" }) : "DISABLED";
    return { ...appointment, clientNotification };
  });
}

const rescheduleSchema = z.object({ startsAt: z.coerce.date() });

export async function rescheduleAppointmentAction(tenantSlug: string, appointmentId: string, input: unknown): Promise<Result<unknown>> {
  return runAction(async () => {
    const { tenant, user } = await requireTenantMember(tenantSlug);
    await assertTenantCanWrite(tenant.id);
    const data = rescheduleSchema.parse(input);
    const before = await forTenant(tenant.id).appointment.findFirst({ where: { id: appointmentId }, select: { startsAt: true } });
    const updated = await rescheduleAppointment(tenant.id, appointmentId, data.startsAt, user.id);
    // Mesmo horário (arrastou e soltou no lugar): nada mudou para o cliente, não avisa.
    const moved = !before || before.startsAt.getTime() !== updated.startsAt.getTime();
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
    const { tenant, user } = await requireTenantMember(data.tenantSlug);
    await assertTenantCanWrite(tenant.id);
    return finishAppointment(tenant.id, data.appointmentId, user.id, "COMPLETED");
  });
}

export async function markNoShowAppointmentAction(input: { tenantSlug: string; appointmentId: string }): Promise<Result<AppointmentView>> {
  return runAction(async () => {
    const data = appointmentRefSchema.parse(input);
    const { tenant, user } = await requireTenantMember(data.tenantSlug);
    await assertTenantCanWrite(tenant.id);
    return finishAppointment(tenant.id, data.appointmentId, user.id, "NO_SHOW");
  });
}

export async function reopenAppointmentAction(input: { tenantSlug: string; appointmentId: string }): Promise<Result<AppointmentView>> {
  return runAction(async () => {
    const data = appointmentRefSchema.parse(input);
    const { tenant, user } = await requireTenantMember(data.tenantSlug);
    await assertTenantCanWrite(tenant.id);
    return reopenAppointment(tenant.id, data.appointmentId, user.id);
  });
}
