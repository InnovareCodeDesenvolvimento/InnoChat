/**
 * Tipos públicos das ações de suporte em assinatura/cobrança.
 *
 * Mantidos em arquivo separado (sem "use server") para que componentes Client
 * possam importar APENAS os tipos sem arrastar a cadeia de imports server-only
 * (next/headers, prisma) para o bundle do cliente — caso contrário o Turbopack
 * reclama que o componente Client usa API de Server.
 */

export type ExtendTrialResult = {
  trialEndsAt: string;
};

export type ResendPaymentLinkResult = {
  invoiceId: string;
  recipientEmail: string;
  pixCopyPaste: string | null;
};

export type SupportSessionItem = {
  id: string;
  adminName: string;
  adminEmail: string;
  reason: string;
  startedAt: string;
  expiresAt: string;
  closedAt: string | null;
  closeReason: string | null;
  status: "ACTIVE" | "EXPIRED" | "CLOSED";
};

export type SupportSessionsPage = {
  items: SupportSessionItem[];
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
};

export type SupportInvoiceOption = {
  id: string;
  amountCents: number;
  dueAt: string;
  status: string;
};
