"use server";

import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { runAction, type Result } from "@/lib/result";
import { DUNNING_STEPS } from "@/core/billing";
import {
  getCompanyBilling,
  getFinanceOverview,
  listCompanyBillingTimeline,
  type CompanyBilling,
  type FinanceOverview,
  type TimelineItem,
} from "./finance-service";
import { pagingInputShape, type PageInfo, type PageSize } from "./paging";
import {
  getBillingNoticePreview,
  listBillingNotices,
  resendBillingNotice,
  type NoticePreview,
  type NoticeRegisterPage,
  type ResendResult,
} from "./notice-register";

/**
 * Server Actions da visão financeira e do registro de envios (F6, docs/regua-de-cobranca.md §3.1; contrato em
 * docs/contratos.md). TODAS atrás de `requirePlatformAdmin()`: a empresa nunca chega aqui.
 */

const idSchema = z.string().trim().min(1).max(64);

export async function getFinanceOverviewAction(): Promise<Result<FinanceOverview>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    return getFinanceOverview();
  });
}

export async function getCompanyBillingAction(tenantId: string): Promise<Result<CompanyBilling>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    return getCompanyBilling(idSchema.parse(tenantId));
  });
}

const timelineSchema = z.object(pagingInputShape);

export async function listCompanyBillingTimelineAction(tenantId: string, input?: unknown): Promise<Result<{ items: TimelineItem[] } & PageInfo>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    const data = timelineSchema.parse(input ?? {});
    return listCompanyBillingTimeline(idSchema.parse(tenantId), data as { page?: number; pageSize?: PageSize });
  });
}

const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a data no formato AAAA-MM-DD.");

const noticeFiltersSchema = z
  .object({
    from: localDate.optional(),
    to: localDate.optional(),
    tenantQuery: z.string().trim().max(120).optional(),
    tenantId: idSchema.optional(),
    channel: z.enum(["EMAIL", "WHATSAPP"]).optional(),
    status: z.enum(["PENDING", "SENDING", "SENT", "FAILED", "SKIPPED"]).optional(),
    step: z.enum(DUNNING_STEPS).optional(),
    onlyFailures: z.boolean().optional(),
    ...pagingInputShape,
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: "A data inicial não pode ser depois da final.", path: ["from"] });

/** Registro global de envios da régua (quem recebeu o quê, quando e por qual canal). Destino COMPLETO para o admin. */
export async function listBillingNoticesAction(filters?: unknown): Promise<Result<NoticeRegisterPage>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    const data = noticeFiltersSchema.parse(filters ?? {});
    return listBillingNotices({ ...data, tenantQuery: data.tenantQuery || undefined });
  });
}

export async function getBillingNoticePreviewAction(noticeId: string): Promise<Result<NoticePreview>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    return getBillingNoticePreview(idSchema.parse(noticeId));
  });
}

export async function resendBillingNoticeAction(noticeId: string): Promise<Result<ResendResult>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    return resendBillingNotice(idSchema.parse(noticeId), admin.id);
  });
}
