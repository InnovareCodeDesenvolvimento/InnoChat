export const SUBSCRIPTION_STATUS_LABEL: Record<string, string> = {
  TRIALING: "Em teste",
  ACTIVE: "Ativa",
  PAST_DUE: "Fatura atrasada",
  SUSPENDED: "Suspensa",
  CANCELED: "Cancelada",
};

export const SUBSCRIPTION_STATUS_VARIANT: Record<string, "primary" | "success" | "warning" | "danger" | "neutral"> = {
  TRIALING: "primary",
  ACTIVE: "success",
  PAST_DUE: "warning",
  SUSPENDED: "danger",
  CANCELED: "neutral",
};

export const INVOICE_STATUS_LABEL: Record<string, string> = { OPEN: "Aberta", PAID: "Paga", EXPIRED: "Expirada", VOID: "Anulada" };

export const INVOICE_STATUS_VARIANT: Record<string, "warning" | "success" | "danger" | "neutral"> = {
  OPEN: "warning",
  PAID: "success",
  EXPIRED: "danger",
  VOID: "neutral",
};
