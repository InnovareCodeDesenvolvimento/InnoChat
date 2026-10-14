"use server";

import { z } from "zod";
import { requireTenantMember } from "@/lib/auth/guards";
import { runAction, type Result } from "@/lib/result";
import { forTenant } from "@/lib/db/tenant-client";
import { getPrisma } from "@/lib/db/prisma";
import { formatBrl, formatDateTimeBr, formatWorkingHours } from "@/modules/audit/describe";
import { memberActor, recordAudit } from "@/modules/audit/record";
import { diffChanges } from "@/modules/audit/sanitize";
import { assertTenantCanWrite } from "@/modules/billing/service";
import {
  createProfessional,
  createScheduleException,
  createService,
  deleteProfessional,
  deleteScheduleException,
  deleteService,
  listProfessionals,
  listScheduleExceptions,
  listServices,
  setProfessionalServices,
  setProfessionalWorkingHours,
  updateProfessional,
  updateService,
} from "./catalog";
import { getCommissionConfig, setProfessionalCommission, type ProfessionalCommission } from "./commissions";

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const serviceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  durationMin: z.coerce.number().int().min(5).max(24 * 60),
  bufferAfterMin: z.coerce.number().int().min(0).max(24 * 60).default(0),
  priceCents: z.coerce.number().int().min(0).nullable().optional(),
  active: z.boolean().default(true),
  sortOrder: z.coerce.number().int().default(0),
});

const SERVICE_FIELDS = ["name", "durationMin", "bufferAfterMin", "priceCents", "active", "sortOrder"] as const;
const PROFESSIONAL_FIELDS = ["name", "active", "sortOrder"] as const;

export async function listServicesAction(tenantSlug: string): Promise<Result<unknown>> {
  return runAction(async () => {
    const { tenant } = await requireTenantMember(tenantSlug);
    return listServices(tenant.id);
  });
}

export async function createServiceAction(tenantSlug: string, input: unknown): Promise<Result<unknown>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);
    const data = serviceSchema.parse(input);
    const created = await createService(tenant.id, { ...data, priceCents: data.priceCents ?? null });
    await recordAudit({
      tenantId: tenant.id,
      actor: memberActor(ctx),
      action: "service.created",
      targetType: "service",
      targetId: created.id,
      summary: `Criou o serviço ${created.name} (${created.durationMin} min, ${formatBrl(created.priceCents)}).`,
      supportSessionId: ctx.supportSessionId ?? null,
    });
    return created;
  });
}

export async function updateServiceAction(tenantSlug: string, serviceId: string, input: unknown): Promise<Result<unknown>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);
    const data = serviceSchema.partial().parse(input);
    const before = await forTenant(tenant.id).service.findFirst({ where: { id: serviceId } });
    const updated = await updateService(tenant.id, serviceId, data);
    if (before) {
      const changes = diffChanges(before, updated, SERVICE_FIELDS);
      if (Object.keys(changes).length > 0) {
        const priceChanged = "priceCents" in changes;
        await recordAudit({
          tenantId: tenant.id,
          actor: memberActor(ctx),
          action: priceChanged ? "service.price_changed" : "service.updated",
          targetType: "service",
          targetId: serviceId,
          summary: priceChanged
            ? `Mudou o preço do serviço ${updated.name} de ${formatBrl(before.priceCents)} para ${formatBrl(updated.priceCents)}.`
            : `Alterou o serviço ${updated.name}.`,
          changes,
          supportSessionId: ctx.supportSessionId ?? null,
        });
      }
    }
    return updated;
  });
}

export async function deleteServiceAction(tenantSlug: string, serviceId: string): Promise<Result<{ id: string }>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);
    const before = await forTenant(tenant.id).service.findFirst({ where: { id: serviceId }, select: { name: true } });
    await deleteService(tenant.id, serviceId);
    await recordAudit({
      tenantId: tenant.id,
      actor: memberActor(ctx),
      action: "service.deleted",
      targetType: "service",
      targetId: serviceId,
      summary: `Excluiu o serviço ${before?.name ?? serviceId}.`,
      supportSessionId: ctx.supportSessionId ?? null,
    });
    return { id: serviceId };
  });
}

// ---------------------------------------------------------------------------
// Professional
// ---------------------------------------------------------------------------

const professionalSchema = z.object({
  name: z.string().trim().min(1).max(120),
  active: z.boolean().default(true),
  sortOrder: z.coerce.number().int().default(0),
});

export async function listProfessionalsAction(tenantSlug: string): Promise<Result<unknown>> {
  return runAction(async () => {
    const { tenant } = await requireTenantMember(tenantSlug);
    return listProfessionals(tenant.id);
  });
}

export async function createProfessionalAction(tenantSlug: string, input: unknown): Promise<Result<unknown>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);
    const data = professionalSchema.parse(input);
    const created = await createProfessional(tenant.id, data);
    await recordAudit({
      tenantId: tenant.id,
      actor: memberActor(ctx),
      action: "professional.created",
      targetType: "professional",
      targetId: created.id,
      summary: `Cadastrou o profissional ${created.name}.`,
      supportSessionId: ctx.supportSessionId ?? null,
    });
    return created;
  });
}

export async function updateProfessionalAction(tenantSlug: string, professionalId: string, input: unknown): Promise<Result<unknown>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);
    const data = professionalSchema.partial().parse(input);
    const before = await forTenant(tenant.id).professional.findFirst({ where: { id: professionalId } });
    const updated = await updateProfessional(tenant.id, professionalId, data);
    if (before) {
      const changes = diffChanges(before, updated, PROFESSIONAL_FIELDS);
      if (Object.keys(changes).length > 0) {
        await recordAudit({
          tenantId: tenant.id,
          actor: memberActor(ctx),
          action: "professional.updated",
          targetType: "professional",
          targetId: professionalId,
          summary: `Alterou o profissional ${updated.name}.`,
          changes,
          supportSessionId: ctx.supportSessionId ?? null,
        });
      }
    }
    return updated;
  });
}

export async function deleteProfessionalAction(tenantSlug: string, professionalId: string): Promise<Result<{ id: string }>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);
    const before = await forTenant(tenant.id).professional.findFirst({ where: { id: professionalId }, select: { name: true } });
    await deleteProfessional(tenant.id, professionalId);
    await recordAudit({
      tenantId: tenant.id,
      actor: memberActor(ctx),
      action: "professional.deleted",
      targetType: "professional",
      targetId: professionalId,
      summary: `Excluiu o profissional ${before?.name ?? professionalId}.`,
      supportSessionId: ctx.supportSessionId ?? null,
    });
    return { id: professionalId };
  });
}

const serviceIdsSchema = z.object({ serviceIds: z.array(z.string().min(1)) });

export async function setProfessionalServicesAction(tenantSlug: string, professionalId: string, input: unknown): Promise<Result<unknown>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);
    const data = serviceIdsSchema.parse(input);
    const linkedBefore = await getPrisma().professionalService.findMany({ where: { professionalId, professional: { tenantId: tenant.id } }, select: { serviceId: true } });
    const updated = await setProfessionalServices(tenant.id, professionalId, data.serviceIds);
    const linkedAfter = updated.professionalServices.map((l) => l.serviceId);
    const beforeIds = linkedBefore.map((l) => l.serviceId);
    if (beforeIds.length !== linkedAfter.length || beforeIds.some((id) => !linkedAfter.includes(id))) {
      const names = await servicesNames(tenant.id, [...beforeIds, ...linkedAfter]);
      const text = (ids: string[]) => ids.map((id) => names.get(id) ?? id).sort().join(", ") || "nenhum";
      await recordAudit({
        tenantId: tenant.id,
        actor: memberActor(ctx),
        action: "professional.services_changed",
        targetType: "professional",
        targetId: professionalId,
        summary: `Mudou os serviços que ${updated.name} atende.`,
        changes: { servicos: { de: text(beforeIds), para: text(linkedAfter) } },
        supportSessionId: ctx.supportSessionId ?? null,
      });
    }
    return updated;
  });
}

const workingHourSchema = z.object({
  weekday: z.coerce.number().int().min(0).max(6),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Formato HH:mm"),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Formato HH:mm"),
});
const workingHoursSchema = z.object({ hours: z.array(workingHourSchema).max(7 * 4) });

export async function setProfessionalWorkingHoursAction(tenantSlug: string, professionalId: string, input: unknown): Promise<Result<unknown>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);
    const data = workingHoursSchema.parse(input);
    const professional = await forTenant(tenant.id).professional.findFirst({ where: { id: professionalId }, select: { name: true } });
    const hoursBefore = professional
      ? await getPrisma().workingHour.findMany({ where: { professionalId }, select: { weekday: true, startTime: true, endTime: true } })
      : [];
    const saved = await setProfessionalWorkingHours(tenant.id, professionalId, data.hours);
    const textBefore = formatWorkingHours(hoursBefore);
    const textAfter = formatWorkingHours(saved);
    if (textBefore !== textAfter) {
      await recordAudit({
        tenantId: tenant.id,
        actor: memberActor(ctx),
        action: "working_hours.changed",
        targetType: "professional",
        targetId: professionalId,
        summary: `Mudou o horário de funcionamento de ${professional?.name ?? "um profissional"}.`,
        changes: { horarios: { de: textBefore, para: textAfter } },
        supportSessionId: ctx.supportSessionId ?? null,
      });
    }
    return saved;
  });
}

// ---------------------------------------------------------------------------
// ScheduleException
// ---------------------------------------------------------------------------

const scheduleExceptionSchema = z.object({
  professionalId: z.string().min(1).nullable().default(null),
  type: z.enum(["BLOCK", "HOLIDAY"]),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  reason: z.string().trim().max(255).nullable().optional(),
});

export async function listScheduleExceptionsAction(
  tenantSlug: string,
  range?: { from: string; to: string },
): Promise<Result<unknown>> {
  return runAction(async () => {
    const { tenant } = await requireTenantMember(tenantSlug);
    const parsedRange = range ? { from: new Date(range.from), to: new Date(range.to) } : undefined;
    return listScheduleExceptions(tenant.id, parsedRange);
  });
}

export async function createScheduleExceptionAction(tenantSlug: string, input: unknown): Promise<Result<unknown>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);
    const data = scheduleExceptionSchema.parse(input);
    const created = await createScheduleException(tenant.id, { ...data, reason: data.reason ?? null });
    await recordAudit({
      tenantId: tenant.id,
      actor: memberActor(ctx),
      action: "schedule_block.created",
      targetType: "schedule_exception",
      targetId: created.id,
      summary: `Criou ${created.type === "HOLIDAY" ? "um feriado" : "um bloqueio"} na agenda (${formatDateTimeBr(created.startsAt, tenant.timezone)} até ${formatDateTimeBr(created.endsAt, tenant.timezone)}).`,
      changes: { motivo: { de: null, para: created.reason }, abrangencia: { de: null, para: created.professionalId ? "um profissional" : "toda a empresa" } },
      supportSessionId: ctx.supportSessionId ?? null,
    });
    return created;
  });
}

export async function deleteScheduleExceptionAction(tenantSlug: string, exceptionId: string): Promise<Result<{ id: string }>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);
    const before = await forTenant(tenant.id).scheduleException.findFirst({ where: { id: exceptionId }, select: { type: true, startsAt: true } });
    await deleteScheduleException(tenant.id, exceptionId);
    await recordAudit({
      tenantId: tenant.id,
      actor: memberActor(ctx),
      action: "schedule_block.deleted",
      targetType: "schedule_exception",
      targetId: exceptionId,
      summary: before
        ? `Removeu ${before.type === "HOLIDAY" ? "o feriado" : "o bloqueio"} de ${formatDateTimeBr(before.startsAt, tenant.timezone)}.`
        : "Removeu um bloqueio da agenda.",
      supportSessionId: ctx.supportSessionId ?? null,
    });
    return { id: exceptionId };
  });
}

// ---------------------------------------------------------------------------
// Comissão (Melhoria 8) — SÓ o dono vê e grava; STAFF recebe FORBIDDEN.
// ---------------------------------------------------------------------------

const pctSchema = z.coerce
  .number()
  .min(0, "A comissão não pode ser negativa.")
  .max(100, "A comissão não pode passar de 100%.")
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, "Use no máximo 2 casas decimais.");
const commissionSchema = z.object({
  pct: pctSchema.nullable(),
  overrides: z.array(z.object({ serviceId: z.string().min(1), pct: pctSchema.nullable() })).max(500),
});

export async function getCommissionConfigAction(tenantSlug: string): Promise<Result<ProfessionalCommission[]>> {
  return runAction(async () => {
    const { tenant } = await requireTenantMember(tenantSlug, ["OWNER"]);
    return getCommissionConfig(tenant.id);
  });
}

export async function setProfessionalCommissionAction(tenantSlug: string, professionalId: string, input: unknown): Promise<Result<ProfessionalCommission>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug, ["OWNER"]);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);
    const data = commissionSchema.parse(input);
    const [before] = await getCommissionConfig(tenant.id, professionalId);
    const saved = await setProfessionalCommission(tenant.id, professionalId, data);
    if (saved) await auditCommissionChange(ctx, professionalId, before, saved);
    return saved;
  });
}

async function servicesNames(tenantId: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await forTenant(tenantId).service.findMany({ where: { id: { in: Array.from(new Set(ids)) } }, select: { id: true, name: true } });
  return new Map(rows.map((r) => [r.id, r.name]));
}

const pctText = (pct: number | null | undefined) => (pct === null || pct === undefined ? "padrão" : `${pct}%`);

/** Comissão do profissional e a de cada serviço dele: grava só o que mudou, com o nome do serviço no de/para. */
async function auditCommissionChange(
  ctx: Awaited<ReturnType<typeof requireTenantMember>>,
  professionalId: string,
  before: ProfessionalCommission | undefined,
  after: ProfessionalCommission,
) {
  const changes: Record<string, { de: unknown; para: unknown }> = {};
  if ((before?.pct ?? null) !== after.pct) changes["comissao_padrao"] = { de: pctText(before?.pct), para: pctText(after.pct) };
  const beforeByService = new Map((before?.overrides ?? []).map((o) => [o.serviceId, o.pct]));
  const changedServiceIds = after.overrides.filter((o) => (beforeByService.get(o.serviceId) ?? null) !== o.pct).map((o) => o.serviceId);
  const names = await servicesNames(ctx.tenant.id, changedServiceIds);
  for (const o of after.overrides) {
    if (!changedServiceIds.includes(o.serviceId)) continue;
    changes[`comissao_servico:${names.get(o.serviceId) ?? o.serviceId}`] = { de: pctText(beforeByService.get(o.serviceId)), para: pctText(o.pct) };
  }
  if (Object.keys(changes).length === 0) return;
  const professional = await forTenant(ctx.tenant.id).professional.findFirst({ where: { id: professionalId }, select: { name: true } });
  await recordAudit({
    tenantId: ctx.tenant.id,
    actor: memberActor(ctx),
    action: "professional.commission_changed",
    targetType: "professional",
    targetId: professionalId,
    summary: `Mudou a comissão de ${professional?.name ?? "um profissional"}.`,
    changes,
    supportSessionId: ctx.supportSessionId ?? null,
  });
}
