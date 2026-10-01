import {
  BadgeCheck,
  BellRing,
  CalendarClock,
  CalendarPlus,
  CalendarX,
  CheckCircle2,
  Building2,
  Headset,
  Hourglass,
  Lock,
  Receipt,
  TriangleAlert,
  Timer,
  ShieldAlert,
  Ban,
  CreditCard,
  UserPlus,
  LayoutDashboard,
  MessageCircle,
  Settings2,
  Sparkles,
  UserX,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import type { AdminNotificationKind, NotificationKind, NotificationSeverity, NotificationSource } from "./types";

/** Ícone por tipo de notificação. */
export const KIND_ICON: Record<NotificationKind | "HANDOFF_REQUESTED", LucideIcon> = {
  HANDOFF_REQUESTED: Headset,
  APPOINTMENT_CREATED: CalendarPlus,
  APPOINTMENT_RESCHEDULED: CalendarClock,
  APPOINTMENT_CANCELED: CalendarX,
  APPOINTMENT_COMPLETED: CheckCircle2,
  APPOINTMENT_NO_SHOW: UserX,
  APPOINTMENT_UPCOMING: BellRing,
  WHATSAPP_DISCONNECTED: WifiOff,
  TRIAL_ENDING: Hourglass,
  PAYMENT_CONFIRMED: BadgeCheck,
  // Régua de cobrança (só OWNER). O tom (azul, amarelo, vermelho) vem da `severity` de cada item.
  INVOICE_OPEN: Receipt,
  INVOICE_DUE: CalendarClock,
  INVOICE_OVERDUE: TriangleAlert,
  SUBSCRIPTION_SUSPENDED: Lock,
  CANCEL_WARNING: Hourglass,
  TRIAL_PROGRESS: Sparkles,
};

/** Ícones das notificações do admin da plataforma. */
export const ADMIN_KIND_ICON: Record<AdminNotificationKind, LucideIcon> = {
  TENANT_SIGNED_UP: UserPlus,
  PAYMENT_RECEIVED: CreditCard,
  TENANT_SUSPENDED: Ban,
  TENANT_CANCELED: Building2,
  TENANT_CANCEL_SCHEDULED: CalendarClock,
  PAYMENT_ON_VOID_INVOICE: ShieldAlert,
  TRIAL_ENDING: Hourglass,
  WHATSAPP_DISCONNECTED: WifiOff,
  MP_WEBHOOK_REJECTED: ShieldAlert,
  TICK_LATE: Timer,
  BILLING_EMAIL_FAILING: ShieldAlert,
  PLATFORM_WHATSAPP_MISSING: WifiOff,
  PLATFORM_WHATSAPP_DISCONNECTED: WifiOff,
  PLATFORM_WHATSAPP_REPLY: MessageCircle,
};

/**
 * Ícone de qualquer notificação do sino (tenant ou admin), por `kind`. Lookup estático (e não uma
 * função que devolve componente): o lint proíbe criar componente durante o render. `kind`
 * desconhecido cai em `FALLBACK_ICON` (`?? FALLBACK_ICON` no ponto de uso).
 */
export const ICON_BY_KIND: Record<string, LucideIcon> = { ...ADMIN_KIND_ICON, ...KIND_ICON };
export const FALLBACK_ICON: LucideIcon = BellRing;

/** Cor do "chip" do ícone por severidade — só tokens, valem nos 3 temas. */
export const SEVERITY_TONE: Record<NotificationSeverity, string> = {
  info: "bg-primary/10 text-primary",
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  danger: "bg-danger-bg text-danger",
};

export const SOURCE_VISUAL: Record<NotificationSource, { icon: LucideIcon; label: string }> = {
  WHATSAPP: { icon: MessageCircle, label: "WhatsApp" },
  PANEL: { icon: LayoutDashboard, label: "Painel" },
  SYSTEM: { icon: Settings2, label: "Sistema" },
};
