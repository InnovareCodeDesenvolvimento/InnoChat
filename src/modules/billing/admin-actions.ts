"use server";

import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { runAction, type Result } from "@/lib/result";
import type { InvoiceStatus } from "@/lib/db/types";
import { getPrisma } from "@/lib/db/prisma";
import { formatBrl } from "@/modules/audit/describe";
import { platformAdminActor, recordAudit } from "@/modules/audit/record";
import { diffChanges } from "@/modules/audit/sanitize";
import {
  billingMonthlyTotals,
  extendTrialManually,
  listCompanies,
  listDelinquentCompanies,
  listInvoicesAdmin,
  listPlans,
  liveCycleUsageByPlan,
  markInvoicePaidManually,
  reactivateCompanyManually,
  regeneratePixForInvoiceAdmin,
  suspendCompanyManually,
  updatePlan,
  type AdminInvoiceListItem,
  type BillingMonthlyTotals,
  type CompanyListItem,
  type DelinquentCompany,
} from "./admin-service";
import { reconcileInvoicePayment, type ReconcileOutcome } from "./reconcile";
import { pagingInputShape, type PageInfo, type PageSize } from "./paging";

/** Server Actions do admin da plataforma para planos e empresas (docs/contratos.md, Fase 7). */

/** Quantas assinaturas não canceladas pagam em cada ciclo, por plano (a tela Planos avisa antes de apagar um preço em uso). */
export async function planCycleUsageAction() {
  return runAction(async () => {
    await requirePlatformAdmin();
    return liveCycleUsageByPlan();
  });
}

export async function listPlansAction() {
  return runAction(async () => {
    await requirePlatformAdmin();
    return listPlans();
  });
}

const PLAN_FIELDS = ["name", "priceCents", "quarterlyPriceCents", "semiannualPriceCents", "annualPriceCents", "maxWhatsappNumbers", "maxProfessionals", "active", "sortOrder"] as const;

async function companyName(tenantId: string): Promise<string> {
  const row = await getPrisma().tenant.findUnique({ where: { id: tenantId }, select: { name: true } });
  return row?.name ?? tenantId;
}

const updatePlanSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  priceCents: z.coerce.number().int().min(0).optional(),
  // Preço do período em centavos (positivo) ou `null` para tirar o ciclo.
  quarterlyPriceCents: z.coerce.number().int().min(1).nullable().optional(),
  semiannualPriceCents: z.coerce.number().int().min(1).nullable().optional(),
  annualPriceCents: z.coerce.number().int().min(1).nullable().optional(),
  maxWhatsappNumbers: z.coerce.number().int().min(1).optional(),
  maxProfessionals: z.coerce.number().int().min(1).nullable().optional(),
  active: z.boolean().optional(),
  sortOrder: z.coerce.number().int().optional(),
  // Confirmação explícita de preço de período abaixo de 50% das mensalidades (só vale para esse caso).
  confirmLowPrice: z.boolean().optional(),
});

export async function updatePlanAction(planId: string, input: unknown) {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const data = updatePlanSchema.parse(input);
    const before = await getPrisma().plan.findUnique({ where: { id: planId } });
    const updated = await updatePlan(planId, data);
    const changes = before ? diffChanges(before, updated, PLAN_FIELDS) : {};
    if (Object.keys(changes).length > 0) {
      const priceChanged = "priceCents" in changes || "quarterlyPriceCents" in changes || "semiannualPriceCents" in changes || "annualPriceCents" in changes;
      await recordAudit({
        tenantId: null,
        actor: platformAdminActor(admin.id),
        action: priceChanged ? "plan.price_changed" : "plan.updated",
        targetType: "plan",
        targetId: planId,
        summary: priceChanged
          ? `Mudou o preço do plano ${updated.name} (mensal ${formatBrl(updated.priceCents)}).`
          : `Alterou o plano ${updated.name}.`,
        changes,
      });
    }
    return updated;
  });
}

const listCompaniesSchema = z.object(pagingInputShape);

/** Empresas, por página: `{ page (1-based), pageSize 10|25|50|100 (padrão 25) }` → `{ items, page, pageSize, totalItems, totalPages }`. */
export async function listCompaniesAction(input?: unknown): Promise<Result<{ items: CompanyListItem[] } & PageInfo>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    const data = listCompaniesSchema.parse(input ?? {});
    return listCompanies(data as { page?: number; pageSize?: PageSize });
  });
}

export async function suspendCompanyAction(tenantId: string): Promise<Result<{ tenantId: string }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    await suspendCompanyManually(tenantId, admin.id);
    await recordAudit({
      tenantId,
      actor: platformAdminActor(admin.id),
      action: "company.suspended",
      targetType: "tenant",
      targetId: tenantId,
      summary: `Suspendeu a empresa ${await companyName(tenantId)}.`,
      changes: { situacao: { de: null, para: "suspensa" } },
    });
    return { tenantId };
  });
}

export async function reactivateCompanyAction(tenantId: string): Promise<Result<{ tenantId: string }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    await reactivateCompanyManually(tenantId, admin.id);
    await recordAudit({
      tenantId,
      actor: platformAdminActor(admin.id),
      action: "company.reactivated",
      targetType: "tenant",
      targetId: tenantId,
      summary: `Reativou a empresa ${await companyName(tenantId)}.`,
      changes: { situacao: { de: null, para: "ativa" } },
    });
    return { tenantId };
  });
}

const extendTrialSchema = z.object({ extraDays: z.coerce.number().int().min(1).max(30) });

export async function extendTrialAction(tenantId: string, input: unknown): Promise<Result<{ tenantId: string }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const data = extendTrialSchema.parse(input);
    await extendTrialManually(tenantId, data.extraDays, admin.id);
    await recordAudit({
      tenantId,
      actor: platformAdminActor(admin.id),
      action: "company.trial_extended",
      targetType: "tenant",
      targetId: tenantId,
      summary: `Estendeu o teste da empresa ${await companyName(tenantId)} em ${data.extraDays} dia(s).`,
      changes: { diasExtras: { de: null, para: data.extraDays } },
    });
    return { tenantId };
  });
}

// ---------------------------------------------------------------------------
// Admin → Cobrança (docs/contratos.md, "Admin Cobrança")
// ---------------------------------------------------------------------------

const INVOICE_STATUSES = ["OPEN", "PAID", "EXPIRED", "VOID"] as const satisfies readonly InvoiceStatus[];

const listInvoicesAdminSchema = z.object({
  status: z.enum(INVOICE_STATUSES).optional(),
  tenantId: z.string().min(1).optional(),
  fromDate: z.coerce.date().optional(),
  toDate: z.coerce.date().optional(),
  ...pagingInputShape,
});

/** Faturas, por página, com os filtros de situação, empresa e período de vencimento. Mesmo formato de paginação das empresas. */
export async function listInvoicesAdminAction(input?: unknown): Promise<Result<{ items: AdminInvoiceListItem[] } & PageInfo>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    const data = listInvoicesAdminSchema.parse(input ?? {});
    return listInvoicesAdmin(data as Parameters<typeof listInvoicesAdmin>[0]);
  });
}

export async function billingMonthlyTotalsAction(): Promise<Result<BillingMonthlyTotals>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    return billingMonthlyTotals();
  });
}

export async function listDelinquentCompaniesAction(): Promise<Result<DelinquentCompany[]>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    return listDelinquentCompanies();
  });
}

export async function regeneratePixForInvoiceAdminAction(invoiceId: string): Promise<Result<{ invoiceId: string; hasPix: boolean }>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    const invoice = await regeneratePixForInvoiceAdmin(invoiceId);
    return { invoiceId: invoice.id, hasPix: !!invoice.pixCopyPaste };
  });
}

const markInvoicePaidManuallySchema = z.object({
  reason: z.string().trim().min(3, "Informe o motivo da baixa manual.").max(500),
});

export async function markInvoicePaidManuallyAction(invoiceId: string, input: unknown): Promise<Result<{ alreadyProcessed: boolean }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const data = markInvoicePaidManuallySchema.parse(input);
    const result = await markInvoicePaidManually(invoiceId, admin.id, data.reason);
    if (!result.alreadyProcessed) {
      const invoice = await getPrisma().invoice.findUnique({ where: { id: invoiceId }, select: { amountCents: true, subscription: { select: { tenantId: true } } } });
      await recordAudit({
        tenantId: invoice?.subscription.tenantId ?? null,
        actor: platformAdminActor(admin.id),
        action: "invoice.marked_paid_manually",
        targetType: "invoice",
        targetId: invoiceId,
        summary: `Deu baixa manual numa fatura${invoice ? ` de ${formatBrl(invoice.amountCents)}` : ""}.`,
        changes: { motivo: { de: null, para: data.reason } },
      });
    }
    return result;
  });
}

/** "Conferir no Mercado Pago" (Admin → Cobrança): conciliação ativa da fatura, sem rate limit de 5s (ação humana, 1 clique). */
export async function reconcileInvoiceAdminAction(invoiceId: string): Promise<Result<ReconcileOutcome>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    return reconcileInvoicePayment(invoiceId, { source: "admin_button", minIntervalMs: 0 });
  });
}
