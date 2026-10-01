export type PlatformNotificationKind =
  | "TENANT_SIGNED_UP"
  | "PAYMENT_RECEIVED"
  | "TENANT_SUSPENDED"
  | "TENANT_CANCELED"
  | "TENANT_CANCEL_SCHEDULED"
  | "PAYMENT_ON_VOID_INVOICE"
  | "TRIAL_ENDING"
  | "WHATSAPP_DISCONNECTED"
  | "MP_WEBHOOK_REJECTED"
  | "TICK_LATE";

export type PlatformNotificationSeverity = "info" | "success" | "warning" | "danger";

export type AdminNotification = {
  id: string;
  kind: PlatformNotificationKind;
  severity: PlatformNotificationSeverity;
  title: string;
  body: string;
  href: string | null;
  createdAt: string;
  read: boolean;
  tenant?: { id: string; name: string; slug: string };
};
