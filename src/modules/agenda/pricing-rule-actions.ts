"use server";

import { z } from "zod";
import { requireTenantMember } from "@/lib/auth/guards";
import { runAction, type Result } from "@/lib/result";
import { DomainError } from "@/lib/errors";
import { getPrisma } from "@/lib/db/prisma";
import { forTenant } from "@/lib/db/tenant-client";
import { memberActor, recordAudit } from "@/modules/audit/record";
import { diffChanges } from "@/modules/audit/sanitize";
import { assertTenantCanWrite } from "@/modules/billing/service";
import type { PricingRuleKind, Prisma } from "@/lib/db/types";

// ---------------------------------------------------------------------------
// Schemas e tipos
// ---------------------------------------------------------------------------

/**
 * Validação de config de PricingRule por kind.
 * 1. WEEKDAY_OVERRIDE: dias da semana (0..6) com preço específico
 * 2. HOUR_OVERRIDE: faixas de horário "HH:mm"-"HH:mm" com preço específico
 * 3. DURATION_OVERRIDE: duração em minutos com preço
 * 4. TIER: faixas de duração com preço (ex.: [{ upToMin: 30, priceCents: 5000 }, { upToMin: 60, priceCents: 8000 }])
 */
const weekdayConfigSchema = z.object({
  weekdays: z.array(z.number().int().min(0).max(6)).min(1, "Selecione pelo menos um dia da semana."),
  priceCents: z.coerce.number().int().min(0, "Preço não pode ser negativo."),
});

const hourConfigSchema = z.object({
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Formato de hora inválido (HH:mm)."),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Formato de hora inválido (HH:mm)."),
  priceCents: z.coerce.number().int().min(0, "Preço não pode ser negativo."),
});

const durationConfigSchema = z.object({
  durationMin: z.coerce.number().int().min(5).max(1440),
  priceCents: z.coerce.number().int().min(0, "Preço não pode ser negativo."),
});

const tierConfigSchema = z.object({
  tiers: z
    .array(
      z.object({
        upToMin: z.coerce.number().int().min(5).max(1440),
        priceCents: z.coerce.number().int().min(0, "Preço não pode ser negativo."),
      }),
    )
    .min(1, "Defina pelo menos uma faixa de preço."),
});

const PRICING_RULE_KINDS = ["WEEKDAY_OVERRIDE", "HOUR_OVERRIDE", "DURATION_OVERRIDE", "TIER"] as const;

export function validatePricingRuleConfig(kind: PricingRuleKind, config: unknown): Record<string, unknown> {
  switch (kind) {
    case "WEEKDAY_OVERRIDE":
      return weekdayConfigSchema.parse(config);
    case "HOUR_OVERRIDE":
      return hourConfigSchema.parse(config);
    case "DURATION_OVERRIDE":
      return durationConfigSchema.parse(config);
    case "TIER":
      return tierConfigSchema.parse(config);
    default:
      throw new DomainError("INVALID_PRICING_KIND", `Tipo de regra de preço desconhecido: ${kind}`);
  }
}

const ruleCreateSchema = z.object({
  serviceId: z.string().trim().nullable().optional(),
  kind: z.enum(PRICING_RULE_KINDS),
  config: z.record(z.string(), z.unknown()),
  isActive: z.boolean().default(true),
});

const ruleUpdateSchema = z.object({
  serviceId: z.string().trim().nullable().optional(),
  kind: z.enum(PRICING_RULE_KINDS).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().optional(),
  priceChangeReason: z.string().trim().min(15, "O motivo da alteração de preço deve ter pelo menos 15 caracteres.").max(500, "O motivo da alteração de preço não pode ultrapassar 500 caracteres.").optional(),
});

const RULE_FIELDS = ["serviceId", "kind", "config", "isActive"] as const;

export type PricingRuleItem = {
  id: string;
  tenantId: string;
  serviceId: string | null;
  kind: PricingRuleKind;
  config: unknown;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  service?: { id: string; name: string } | null;
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Cria uma regra de precificação para o tenant.
 * Se serviceId for informado, valida se o serviço pertence ao tenant.
 */
export async function createPricingRuleAction(
  tenantSlug: string,
  input: unknown,
): Promise<Result<PricingRuleItem>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);

    const data = ruleCreateSchema.parse(input);

    let serviceName: string | null = null;
    if (data.serviceId) {
      const service = await forTenant(tenant.id).service.findFirst({
        where: { id: data.serviceId },
        select: { id: true, name: true },
      });
      if (!service) {
        throw new DomainError("NOT_FOUND", "Serviço não encontrado.");
      }
      serviceName = service.name;
    }

    const validatedConfig = validatePricingRuleConfig(data.kind as PricingRuleKind, data.config);

    const prisma = getPrisma();
    const created = await prisma.pricingRule.create({
      data: {
        tenantId: tenant.id,
        serviceId: data.serviceId ?? null,
        kind: data.kind as PricingRuleKind,
        config: validatedConfig as Prisma.InputJsonValue,
        isActive: data.isActive,
      },
      include: {
        service: { select: { id: true, name: true } },
      },
    });

    const targetDesc = serviceName ? `para o serviço '${serviceName}'` : "geral da empresa";
    await recordAudit({
      tenantId: tenant.id,
      actor: memberActor(ctx),
      action: "pricing_rule.created",
      targetType: "pricing_rule",
      targetId: created.id,
      summary: `Criou regra de preço (${data.kind}) ${targetDesc}.`,
      supportSessionId: ctx.supportSessionId ?? null,
    });

    return created;
  });
}

/**
 * Atualiza uma regra de precificação.
 * Se envolver alteração de valores de preço no config, valida justificativa se fornecida.
 */
export async function updatePricingRuleAction(
  tenantSlug: string,
  ruleId: string,
  input: unknown,
): Promise<Result<PricingRuleItem>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);

    const data = ruleUpdateSchema.parse(input);
    const prisma = getPrisma();

    const before = await prisma.pricingRule.findFirst({
      where: { id: ruleId, tenantId: tenant.id },
      include: { service: { select: { id: true, name: true } } },
    });
    if (!before) {
      throw new DomainError("NOT_FOUND", "Regra de preço não encontrada.");
    }

    const kindToUse = (data.kind ?? before.kind) as PricingRuleKind;
    let validatedConfig: Record<string, unknown> | undefined;
    if (data.config !== undefined) {
      validatedConfig = validatePricingRuleConfig(kindToUse, data.config);
    }

    if (data.serviceId !== undefined && data.serviceId !== null) {
      const service = await forTenant(tenant.id).service.findFirst({
        where: { id: data.serviceId },
        select: { id: true },
      });
      if (!service) {
        throw new DomainError("NOT_FOUND", "Serviço não encontrado.");
      }
    }

    // Se mudou o config, confere se houve mudança de preço e se justificativa foi enviada
    const beforeConfigStr = JSON.stringify(before.config);
    const newConfigStr = validatedConfig ? JSON.stringify(validatedConfig) : beforeConfigStr;
    const configChanged = beforeConfigStr !== newConfigStr;

    if (configChanged && data.priceChangeReason !== undefined) {
      if (data.priceChangeReason.trim().length < 15) {
        throw new DomainError("PRICE_CHANGE_REASON_REQUIRED", "Alteração de preço exige justificativa com pelo menos 15 caracteres.");
      }
    }

    const { priceChangeReason, ...updateFields } = data;
    const updateData: Prisma.PricingRuleUpdateInput = {
      ...(updateFields.serviceId !== undefined ? { service: updateFields.serviceId ? { connect: { id: updateFields.serviceId } } : { disconnect: true } } : {}),
      ...(updateFields.kind !== undefined ? { kind: updateFields.kind as PricingRuleKind } : {}),
      ...(validatedConfig !== undefined ? { config: validatedConfig as Prisma.InputJsonValue } : {}),
      ...(updateFields.isActive !== undefined ? { isActive: updateFields.isActive } : {}),
    };

    const updated = await prisma.pricingRule.update({
      where: { id: ruleId },
      data: updateData,
      include: {
        service: { select: { id: true, name: true } },
      },
    });

    const changes = diffChanges(before, updated, RULE_FIELDS);
    if (Object.keys(changes).length > 0) {
      const reasonSuffix = priceChangeReason ? ` Motivo: ${priceChangeReason.trim()}` : "";
      await recordAudit({
        tenantId: tenant.id,
        actor: memberActor(ctx),
        action: "pricing_rule.updated",
        targetType: "pricing_rule",
        targetId: ruleId,
        summary: `Alterou regra de preço (${updated.kind}).${reasonSuffix}`,
        changes,
        supportSessionId: ctx.supportSessionId ?? null,
      });
    }

    return updated;
  });
}

/**
 * Soft delete de regra de preço via isActive = false.
 */
export async function deletePricingRuleAction(
  tenantSlug: string,
  ruleId: string,
): Promise<Result<{ id: string }>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug);
    const { tenant } = ctx;
    await assertTenantCanWrite(tenant.id);

    const prisma = getPrisma();
    const existing = await prisma.pricingRule.findFirst({
      where: { id: ruleId, tenantId: tenant.id },
      select: { id: true, kind: true, isActive: true },
    });
    if (!existing) {
      throw new DomainError("NOT_FOUND", "Regra de preço não encontrada.");
    }

    await prisma.pricingRule.update({
      where: { id: ruleId },
      data: { isActive: false },
    });

    await recordAudit({
      tenantId: tenant.id,
      actor: memberActor(ctx),
      action: "pricing_rule.deleted",
      targetType: "pricing_rule",
      targetId: ruleId,
      summary: `Desativou regra de preço (${existing.kind}).`,
      supportSessionId: ctx.supportSessionId ?? null,
    });

    return { id: ruleId };
  });
}

/**
 * Lista regras de preço do tenant, opcionalmente filtrando por serviço (ou gerais onde serviceId é null).
 */
export async function listPricingRulesAction(
  tenantSlug: string,
  serviceId?: string,
): Promise<Result<PricingRuleItem[]>> {
  return runAction(async () => {
    const { tenant } = await requireTenantMember(tenantSlug);
    const prisma = getPrisma();

    return prisma.pricingRule.findMany({
      where: {
        tenantId: tenant.id,
        ...(serviceId !== undefined ? { serviceId } : {}),
      },
      include: {
        service: { select: { id: true, name: true } },
      },
      orderBy: [{ createdAt: "asc" }],
    });
  });
}
