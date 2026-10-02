"use server";

import { z } from "zod";
import { requirePlatformAdmin, requireTenantMember } from "@/lib/auth/guards";
import { runAction, type Result } from "@/lib/result";
import { pagingInputShape, type PageSize } from "@/modules/billing/paging";
import { listAdminAudit, listTenantAudit, type AuditPage } from "./queries";

/**
 * Leitura do histórico de alterações. Só lê: nada aqui grava nem apaga linha de auditoria.
 * - Admin: `requirePlatformAdmin()`, vê todas as empresas e a plataforma.
 * - Empresa: só `OWNER` e só o próprio tenant (vem do guard, nunca de parâmetro).
 */

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a data no formato AAAA-MM-DD.");

const filtersShape = {
  area: z.string().trim().max(40).optional(),
  actor: z.string().trim().max(120).optional(),
  from: dateOnly.optional(),
  to: dateOnly.optional(),
  ...pagingInputShape,
};

const adminSchema = z.object({ tenantQuery: z.string().trim().max(120).optional(), ...filtersShape });
const tenantSchema = z.object(filtersShape);

export async function listAdminAuditAction(input?: unknown): Promise<Result<AuditPage>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    const data = adminSchema.parse(input ?? {});
    return listAdminAudit(data, { page: data.page, pageSize: data.pageSize as PageSize | undefined });
  });
}

export async function listTenantAuditAction(tenantSlug: string, input?: unknown): Promise<Result<AuditPage>> {
  return runAction(async () => {
    const { tenant } = await requireTenantMember(tenantSlug, ["OWNER"]);
    const data = tenantSchema.parse(input ?? {});
    return listTenantAudit(tenant.id, tenant.timezone, data, { page: data.page, pageSize: data.pageSize as PageSize | undefined });
  });
}
