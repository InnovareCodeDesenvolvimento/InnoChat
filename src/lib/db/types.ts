/**
 * Reexporta os tipos gerados pelo Prisma (enums e afins) que o resto do código precisa
 * referenciar. Existe só para respeitar a regra de ESLint (`no-restricted-imports` em
 * eslint.config.mjs): `@prisma/client` cru só pode ser importado dentro de `src/lib/db/`.
 * Módulos/ações que precisam de um tipo de enum importam daqui, nunca de `@prisma/client`
 * direto.
 */
export type {
  MembershipRole,
  PanelTheme,
  AppointmentStatus,
  AppointmentSource,
  AppointmentEventAction,
  AppointmentEventAuthorType,
  ScheduleExceptionType,
  WhatsappInstanceStatus,
  InboundOutcome,
  InboundIgnoreReason,
  BotTextKey,
  HandoffReason,
  HandoffEndReason,
  InvoiceStatus,
  SubscriptionStatus,
  MercadoPagoEnvironment,
  PlatformSettings,
  SupportSessionCloseReason,
  Prisma,
} from "@prisma/client";
