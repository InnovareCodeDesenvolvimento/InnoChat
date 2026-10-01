export type NotificationKind =
  | "APPOINTMENT_CREATED"
  | "APPOINTMENT_RESCHEDULED"
  | "APPOINTMENT_CANCELED"
  | "APPOINTMENT_COMPLETED"
  | "APPOINTMENT_NO_SHOW"
  | "APPOINTMENT_UPCOMING"
  | "WHATSAPP_DISCONNECTED"
  | "TRIAL_ENDING"
  | "PAYMENT_CONFIRMED"
  | "HANDOFF_REQUESTED"
  // Régua de cobrança (derivados do estado da assinatura, só OWNER; `src/modules/billing/dunning/bell.ts`).
  | "INVOICE_OPEN"
  | "INVOICE_DUE"
  | "INVOICE_OVERDUE"
  | "SUBSCRIPTION_SUSPENDED"
  | "CANCEL_WARNING"
  | "TRIAL_PROGRESS";

export type NotificationSeverity = "info" | "success" | "warning" | "danger";

export type AppNotification = {
  id: string;
  kind: NotificationKind;
  severity: NotificationSeverity;
  title: string;
  body: string;
  href: string | null;
  createdAt: string;
  read: boolean;
  source: "WHATSAPP" | "PANEL" | "SYSTEM";
  appointment?: { id: string; startsAt: string; contactName: string; serviceName: string; professionalName: string };
  /** Só em HANDOFF_REQUESTED: o cliente pediu atendente (bot v2, HandoffRequest). Nunca telefone. */
  handoff?: { contactId: string; contactName: string; offHours: boolean; answered: boolean; ended: boolean };
  /** Extra (aditivo): o próprio usuário logado fez a ação — a UI pode não exibir toast. */
  byMe?: boolean;
};

export type UpcomingAppointmentItem = {
  id: string;
  startsAt: string;
  endsAt: string;
  contactName: string;
  serviceName: string;
  professionalName: string;
  status: "SCHEDULED";
  source: "WHATSAPP" | "PANEL";
  minutesUntil: number;
};

export type TimelineItem = {
  id: string;
  action: "CREATED" | "CANCELED" | "RESCHEDULED" | "COMPLETED" | "NO_SHOW" | "REOPENED";
  authorType: "CONTACT" | "USER" | "SYSTEM";
  authorLabel: string;
  note: string | null;
  createdAt: string;
  label: string;
};
