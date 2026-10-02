/**
 * Tipos e mapas de apresentação da UI de cobrança do Admin. Os formatos de dado vêm do backend
 * (`finance-service.ts` e `notice-register.ts`), só reexportados aqui como `type` (nada de servidor vai para o navegador).
 */
export type {
  NoticeRegisterItem as BillingNoticeItem,
  NoticeRegisterPage as BillingNoticePage,
  NoticeRegisterFilters as BillingNoticeFilters,
  NoticePreview as BillingNoticePreview,
  NoticeChannelFilter as NoticeChannel,
  NoticeStatusFilter as NoticeStatus,
} from "@/modules/billing/notice-register";
export type { FinanceOverview, CompanyBilling, TimelineItem } from "@/modules/billing/finance-service";

import type { NoticeStatusFilter } from "@/modules/billing/notice-register";

export type BillingNoticeTotals = { sent: number; failed: number; skipped: number; pending: number };

export const NOTICE_STATUS_VARIANT: Record<NoticeStatusFilter, "success" | "danger" | "neutral" | "warning"> = {
  SENT: "success",
  FAILED: "danger",
  SKIPPED: "neutral",
  PENDING: "warning",
  SENDING: "warning",
};
