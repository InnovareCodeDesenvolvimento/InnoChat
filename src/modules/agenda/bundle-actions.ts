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

const bundleCreateSchema = z.object({
  name: z.string().trim().min(3, "Nome do combo deve ter pelo menos 3 caracteres.").max(120, "Nome do combo pode ter até 120 caracteres."),
  priceCents: z.coerce.number().int("Preço deve ser um número inteiro de centavos.").min(0, "Preço não pode ser negativo."),
  isActive: z.boolean().default(true),
});

const bundleUpdateSchema = z.object({
  name: z.string().trim().min(3, "Nome do combo deve ter pelo menos 3 caracteres.").max(120, "Nome do combo pode ter até 120 caracteres.").optional(),
  priceCents: z.coerce.number().int("Preço deve ser um número inteiro de centavos.").min(0, "Preço não pode ser negativo.").optional(),
  isActive: z.boolean().optional(),
  priceChangeReason: z.string().trim().min(15, "O motivo da alteração de preço deve ter pelo menos 15 caracteres.").max(500, "O motivo da alteração de preço não pode ultrapassar 500 caracteres.").optional(),
});

const bundleItemAddSchema = z.object({
  serviceId: z.string().trim().min(1, "ID do serviço é obrigatório."),
  quantity: z.coerce.number().int("Quantidade deve ser um número inteiro.").min(1, "Quantidade mínima é 1.").max(99, "Quantidade máxima é 99.").default(1),
  order: z.coerce.number().int().min(0, "Ordem não pode ser negativa.").default(0),
});

const BUNDLE_FIELDS = ["name", "priceCents", "isActive"] as const;

export type ServiceBundleItemDetail = {
  id: string;
  bundleId: string;
  serviceId: string;
  order: number;
  quantity: number;
  service?: {
    id: string;
    name: string;
    priceCents: number | null;
    durationMin: number;
  };
};

export type ServiceBundleWithItems = {
  id: string;
  tenantId: string;
  name: string;
  priceCents: number;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  items: ServiceBundleItemDetail[];
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Cria um combo/bundle de serviços para a empresa.
 */
export async function createServiceBundleAction(
  tenantSlug: string,
  input: unknown,
): Promise<Result<ServiceBundleWithItems>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);

    const data = bundleCreateSchema.parse(input);
    const prisma = getPrisma();

    const created = await prisma.serviceBundle.create({
      data: {
        tenantId: tenant.id,
        name: data.name,
        priceCents: data.priceCents,
        isActive: data.isActive,
      },
      include: {
        items: {
          include: {
            service: {
              select: { id: true, name: true, priceCents: true, durationMin: true },
            },
          },
          orderBy: { order: "asc" },
        },
      },
    });

    await recordAudit({
      tenantId: tenant.id,
      actor: memberActor(ctx),
      action: "service_bundle.created",
      targetType: "service_bundle",
      targetId: created.id,
      summary: `Criou o combo '${created.name}' (${formatBrl(created.priceCents)}).`,
      supportSessionId: ctx.supportSessionId ?? null,
    });

    return created;
  });
}

/**
 * Atualiza um combo/bundle de serviços.
 * Se o preço mudar, exige priceChangeReason com pelo menos 15 caracteres.
 */
export async function updateServiceBundleAction(
  tenantSlug: string,
  bundleId: string,
  input: unknown,
): Promise<Result<ServiceBundleWithItems>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);

    const data = bundleUpdateSchema.parse(input);
    const prisma = getPrisma();

    const before = await prisma.serviceBundle.findFirst({
      where: { id: bundleId, tenantId: tenant.id },
    });
    if (!before) {
      throw new DomainError("NOT_FOUND", "Combo não encontrado.");
    }

    if (data.priceCents !== undefined && data.priceCents !== before.priceCents) {
      if (!data.priceChangeReason || data.priceChangeReason.trim().length < 15) {
        throw new DomainError("PRICE_CHANGE_REASON_REQUIRED", "Alteração de preço exige justificativa com pelo menos 15 caracteres.");
      }
    }

    const { priceChangeReason, ...updateFields } = data;
    const updated = await prisma.serviceBundle.update({
      where: { id: bundleId },
      data: updateFields,
      include: {
        items: {
          include: {
            service: {
              select: { id: true, name: true, priceCents: true, durationMin: true },
            },
          },
          orderBy: { order: "asc" },
        },
      },
    });

    const changes = diffChanges(before, updated, BUNDLE_FIELDS);
    if (Object.keys(changes).length > 0) {
      const priceChanged = "priceCents" in changes;
      const reasonSuffix = priceChanged && priceChangeReason ? ` Motivo: ${priceChangeReason.trim()}` : "";
      await recordAudit({
        tenantId: tenant.id,
        actor: memberActor(ctx),
        action: priceChanged ? "service_bundle.price_changed" : "service_bundle.updated",
        targetType: "service_bundle",
        targetId: bundleId,
        summary: priceChanged
          ? `Alterou preço do combo '${updated.name}' de ${formatBrl(before.priceCents)} para ${formatBrl(updated.priceCents)}.${reasonSuffix}`
          : `Alterou o combo '${updated.name}'.`,
        changes,
        supportSessionId: ctx.supportSessionId ?? null,
      });
    }

    return updated;
  });
}

/**
 * Soft delete de combo via isActive = false.
 */
export async function deleteServiceBundleAction(
  tenantSlug: string,
  bundleId: string,
): Promise<Result<{ id: string }>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);

    const prisma = getPrisma();
    const existing = await prisma.serviceBundle.findFirst({
      where: { id: bundleId, tenantId: tenant.id },
      select: { id: true, name: true, isActive: true },
    });
    if (!existing) {
      throw new DomainError("NOT_FOUND", "Combo não encontrado.");
    }

    await prisma.serviceBundle.update({
      where: { id: bundleId },
      data: { isActive: false },
    });

    await recordAudit({
      tenantId: tenant.id,
      actor: memberActor(ctx),
      action: "service_bundle.deleted",
      targetType: "service_bundle",
      targetId: bundleId,
      summary: `Desativou o combo '${existing.name}'.`,
      supportSessionId: ctx.supportSessionId ?? null,
    });

    return { id: bundleId };
  });
}

/**
 * Adiciona um serviço como item de um combo.
 * Valida se o serviço pertence ao mesmo tenant.
 * A UNIQUE constraint @@unique([bundleId, serviceId]) impede duplicados.
 */
export async function addBundleItemAction(
  tenantSlug: string,
  bundleId: string,
  serviceId: string,
  quantity?: number,
  order?: number,
): Promise<Result<ServiceBundleItemDetail>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);

    const data = bundleItemAddSchema.parse({ serviceId, quantity: quantity ?? 1, order: order ?? 0 });
    const prisma = getPrisma();

    // Valida bundle pertence ao tenant
    const bundle = await prisma.serviceBundle.findFirst({
      where: { id: bundleId, tenantId: tenant.id },
      select: { id: true, name: true },
    });
    if (!bundle) {
      throw new DomainError("NOT_FOUND", "Combo não encontrado.");
    }

    // Valida serviço pertence ao mesmo tenant
    const service = await forTenant(tenant.id).service.findFirst({
      where: { id: data.serviceId },
      select: { id: true, name: true, priceCents: true, durationMin: true },
    });
    if (!service) {
      throw new DomainError("NOT_FOUND", "Serviço não encontrado.");
    }

    const created = await prisma.serviceBundleItem.create({
      data: {
        bundleId,
        serviceId: data.serviceId,
        quantity: data.quantity,
        order: data.order,
      },
      include: {
        service: {
          select: { id: true, name: true, priceCents: true, durationMin: true },
        },
      },
    });

    await recordAudit({
      tenantId: tenant.id,
      actor: memberActor(ctx),
      action: "service_bundle.item_added",
      targetType: "service_bundle",
      targetId: bundleId,
      summary: `Adicionou ${data.quantity}x '${service.name}' ao combo '${bundle.name}'.`,
      supportSessionId: ctx.supportSessionId ?? null,
    });

    return created;
  });
}

/**
 * Remove um item do combo.
 * Garante que o item pertence a um combo do tenant.
 */
export async function removeBundleItemAction(
  tenantSlug: string,
  bundleItemId: string,
): Promise<Result<{ id: string }>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);

    const prisma = getPrisma();
    const existing = await prisma.serviceBundleItem.findFirst({
      where: {
        id: bundleItemId,
        bundle: { tenantId: tenant.id },
      },
      include: {
        bundle: { select: { id: true, name: true } },
        service: { select: { id: true, name: true } },
      },
    });
    if (!existing) {
      throw new DomainError("NOT_FOUND", "Item do combo não encontrado.");
    }

    await prisma.serviceBundleItem.delete({
      where: { id: bundleItemId },
    });

    await recordAudit({
      tenantId: tenant.id,
      actor: memberActor(ctx),
      action: "service_bundle.item_removed",
      targetType: "service_bundle",
      targetId: existing.bundle.id,
      summary: `Removeu '${existing.service.name}' do combo '${existing.bundle.name}'.`,
      supportSessionId: ctx.supportSessionId ?? null,
    });

    return { id: bundleItemId };
  });
}

/**
 * Lista combos da empresa, incluindo os itens e detalhes dos serviços.
 */
export async function listServiceBundlesAction(
  tenantSlug: string,
): Promise<Result<ServiceBundleWithItems[]>> {
  return runAction(async () => {
    const { tenant } = await requireTenantMember(tenantSlug);
    const prisma = getPrisma();

    return prisma.serviceBundle.findMany({
      where: { tenantId: tenant.id },
      include: {
        items: {
          include: {
            service: {
              select: { id: true, name: true, priceCents: true, durationMin: true },
            },
          },
          orderBy: { order: "asc" },
        },
      },
      orderBy: [{ createdAt: "asc" }],
    });
  });
}
