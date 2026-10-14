"use server";

import { z } from "zod";
import { requireTenantMember } from "@/lib/auth/guards";
import { runAction, type Result } from "@/lib/result";
import { DomainError } from "@/lib/errors";
import { getPrisma } from "@/lib/db/prisma";
import { forTenant } from "@/lib/db/tenant-client";
import { formatBrl } from "@/modules/audit/describe";
import { memberActor, recordAudit } from "@/modules/audit/record";
import { diffChanges } from "@/modules/audit/sanitize";
import { assertTenantCanWrite } from "@/modules/billing/service";

// ---------------------------------------------------------------------------
// Schemas e tipos
// ---------------------------------------------------------------------------

const addonCreateSchema = z.object({
  name: z.string().trim().min(3, "Nome do adicional deve ter pelo menos 3 caracteres.").max(80, "Nome do adicional pode ter até 80 caracteres."),
  priceCents: z.coerce.number().int("Preço deve ser um número inteiro de centavos.").min(0, "Preço não pode ser negativo.").default(0),
  isRequired: z.boolean().default(false),
  order: z.coerce.number().int().min(0, "Ordem não pode ser negativa.").default(0),
  isActive: z.boolean().default(true),
});

const addonUpdateSchema = z.object({
  name: z.string().trim().min(3, "Nome do adicional deve ter pelo menos 3 caracteres.").max(80, "Nome do adicional pode ter até 80 caracteres.").optional(),
  priceCents: z.coerce.number().int("Preço deve ser um número inteiro de centavos.").min(0, "Preço não pode ser negativo.").optional(),
  isRequired: z.boolean().optional(),
  order: z.coerce.number().int().min(0, "Ordem não pode ser negativa.").optional(),
  isActive: z.boolean().optional(),
  priceChangeReason: z.string().trim().min(15, "O motivo da alteração de preço deve ter pelo menos 15 caracteres.").max(500, "O motivo da alteração de preço não pode ultrapassar 500 caracteres.").optional(),
});

const ADDON_FIELDS = ["name", "priceCents", "isRequired", "order", "isActive"] as const;

export type ServiceAddonItem = {
  id: string;
  serviceId: string;
  name: string;
  priceCents: number;
  isRequired: boolean;
  order: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Cria um adicional para um serviço do tenant.
 * Valida se o serviço pertence ao tenant antes de criar.
 */
export async function createServiceAddonAction(
  tenantSlug: string,
  serviceId: string,
  input: unknown,
): Promise<Result<ServiceAddonItem>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);

    // Garante que o serviço existe e pertence ao tenant
    const service = await forTenant(tenant.id).service.findFirst({
      where: { id: serviceId },
      select: { id: true, name: true },
    });
    if (!service) {
      throw new DomainError("NOT_FOUND", "Serviço não encontrado.");
    }

    const data = addonCreateSchema.parse(input);
    const prisma = getPrisma();
    const created = await prisma.serviceAddon.create({
      data: {
        serviceId,
        name: data.name,
        priceCents: data.priceCents,
        isRequired: data.isRequired,
        order: data.order,
        isActive: data.isActive,
      },
    });

    await recordAudit({
      tenantId: tenant.id,
      actor: memberActor(ctx),
      action: "service_addon.created",
      targetType: "service_addon",
      targetId: created.id,
      summary: `Criou adicional '${created.name}' para o serviço '${service.name}' (${formatBrl(created.priceCents)}).`,
      supportSessionId: ctx.supportSessionId ?? null,
    });

    return created;
  });
}

/**
 * Atualiza um adicional de serviço.
 * Se o preço mudar, exige priceChangeReason com pelo menos 15 caracteres.
 */
export async function updateServiceAddonAction(
  tenantSlug: string,
  addonId: string,
  input: unknown,
): Promise<Result<ServiceAddonItem>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);

    const data = addonUpdateSchema.parse(input);
    const prisma = getPrisma();

    // Busca o adicional garantindo que o serviço pertença ao tenant
    const before = await prisma.serviceAddon.findFirst({
      where: {
        id: addonId,
        service: { tenantId: tenant.id },
      },
      include: {
        service: { select: { id: true, name: true } },
      },
    });
    if (!before) {
      throw new DomainError("NOT_FOUND", "Adicional não encontrado.");
    }

    // Dupla confirmação para alteração de preço
    if (data.priceCents !== undefined && data.priceCents !== before.priceCents) {
      if (!data.priceChangeReason || data.priceChangeReason.trim().length < 15) {
        throw new DomainError("PRICE_CHANGE_REASON_REQUIRED", "Alteração de preço exige justificativa com pelo menos 15 caracteres.");
      }
    }

    const { priceChangeReason, ...updateFields } = data;
    const updated = await prisma.serviceAddon.update({
      where: { id: addonId },
      data: updateFields,
    });

    const changes = diffChanges(before, updated, ADDON_FIELDS);
    if (Object.keys(changes).length > 0) {
      const priceChanged = "priceCents" in changes;
      const reasonSuffix = priceChanged && priceChangeReason ? ` Motivo: ${priceChangeReason.trim()}` : "";
      await recordAudit({
        tenantId: tenant.id,
        actor: memberActor(ctx),
        action: priceChanged ? "service_addon.price_changed" : "service_addon.updated",
        targetType: "service_addon",
        targetId: addonId,
        summary: priceChanged
          ? `Alterou preço do adicional '${updated.name}' de ${formatBrl(before.priceCents)} para ${formatBrl(updated.priceCents)}.${reasonSuffix}`
          : `Alterou adicional '${updated.name}' do serviço '${before.service.name}'.`,
        changes,
        supportSessionId: ctx.supportSessionId ?? null,
      });
    }

    return updated;
  });
}

/**
 * Soft delete de adicional via isActive = false (preserva histórico de pedidos/agendamentos).
 */
export async function deleteServiceAddonAction(
  tenantSlug: string,
  addonId: string,
): Promise<Result<{ id: string }>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);

    const prisma = getPrisma();
    const existing = await prisma.serviceAddon.findFirst({
      where: {
        id: addonId,
        service: { tenantId: tenant.id },
      },
      select: { id: true, name: true, isActive: true },
    });
    if (!existing) {
      throw new DomainError("NOT_FOUND", "Adicional não encontrado.");
    }

    await prisma.serviceAddon.update({
      where: { id: addonId },
      data: { isActive: false },
    });

    await recordAudit({
      tenantId: tenant.id,
      actor: memberActor(ctx),
      action: "service_addon.deleted",
      targetType: "service_addon",
      targetId: addonId,
      summary: `Desativou o adicional '${existing.name}'.`,
      supportSessionId: ctx.supportSessionId ?? null,
    });

    return { id: addonId };
  });
}

/**
 * Lista adicionais de um serviço do tenant.
 */
export async function listServiceAddonsAction(
  tenantSlug: string,
  serviceId: string,
): Promise<Result<ServiceAddonItem[]>> {
  return runAction(async () => {
    const { tenant } = await requireTenantMember(tenantSlug);

    // Valida se o serviço pertence ao tenant
    const service = await forTenant(tenant.id).service.findFirst({
      where: { id: serviceId },
      select: { id: true },
    });
    if (!service) {
      throw new DomainError("NOT_FOUND", "Serviço não encontrado.");
    }

    const prisma = getPrisma();
    return prisma.serviceAddon.findMany({
      where: { serviceId },
      orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    });
  });
}
