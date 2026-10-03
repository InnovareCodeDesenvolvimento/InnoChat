import { addDays } from "date-fns";
import { getPrisma } from "@/lib/db/prisma";
import {
  asBillingCycle,
  CANCELED_RETENTION_DAYS,
  CANCEL_AFTER_SUSPENDED_DAYS,
  CANCEL_AFTER_SUSPENDED_TRIAL_DAYS,
  diffLocalDates,
  localDateOf,
  localTimeLabel,
  subscriptionBoundaries,
  summarizeTrialUsage,
  type DunningCopyData,
  type DunningStep,
  type TrialUsage,
} from "@/core/billing";
import { getPublicBaseUrl } from "@/lib/public-url";
import { getPlatformSalesWhatsapp } from "@/modules/platform/sales-contact";
import { formatCentsBRL, formatDateBR } from "../format";
import type { DunningSubject } from "./snapshot";

/**
 * Monta os dados dos textos NO MOMENTO do envio (valor, datas e uso do teste lidos agora, não no
 * planejamento): o aviso que sai depois de uma espera nunca fala de um valor ou prazo velho.
 */

const TRIAL_STEPS = new Set<DunningStep>(["TRIAL_DAY1", "TRIAL_T1", "TRIAL_T0", "TRIAL_SUSP_3", "TRIAL_CANCEL_WARN"]);

/** Uso real do teste (§2.3.1): consultas ao próprio tenant desde o cadastro. Nada é estimado nem inventado. */
export async function loadTrialUsage(tenantId: string, since: Date): Promise<TrialUsage> {
  const prisma = getPrisma();
  const [appointmentsByBot, answered, remindersSent, byContact, botContacts, instances, services, professionals] = await Promise.all([
    prisma.appointment.count({ where: { tenantId, source: "WHATSAPP", status: { not: "CANCELED" }, createdAt: { gte: since } } }),
    prisma.chatMessage.findMany({ where: { tenantId, direction: "OUTBOUND", authorUserId: null, createdAt: { gte: since } }, distinct: ["contactId"], select: { contactId: true }, take: 1000 }),
    prisma.appointment.count({ where: { tenantId, reminderSentAt: { gte: since } } }),
    prisma.appointment.groupBy({ by: ["contactId"], where: { tenantId, status: { not: "CANCELED" }, createdAt: { gte: since } }, _count: { _all: true } }),
    prisma.appointment.findMany({ where: { tenantId, source: "WHATSAPP", status: { not: "CANCELED" }, createdAt: { gte: since } }, distinct: ["contactId"], select: { contactId: true }, take: 1000 }),
    prisma.whatsappInstance.count({ where: { tenantId, deletedAt: null, sandbox: false, status: "CONNECTED" } }),
    prisma.service.count({ where: { tenantId, active: true } }),
    prisma.professional.count({ where: { tenantId, active: true } }),
  ]);
  return summarizeTrialUsage({
    appointmentsByBot,
    conversationsAnswered: answered.length,
    remindersSent,
    returningClients: byContact.filter((row) => row._count._all >= 2).length,
    botClients: botContacts.length,
    whatsappConnected: instances > 0,
    hasService: services > 0,
    hasProfessional: professionals > 0,
  });
}

export type NoticeCopyContext = {
  data: DunningCopyData;
  /** Dados extras só do e-mail de cancelamento. */
  retentionUntilBr: string | null;
  clientsUrl: string;
  /** Fatura que o aviso cobra/confirma (para o despachante regerar o Pix). */
  invoice: { id: string; status: string; amountCents: number; pixCopyPaste: string | null; pixExpiresAt: Date | null; paidAt: Date | null } | null;
};

export async function buildNoticeCopyContext(args: {
  step: DunningStep;
  invoiceId: string | null;
  subject: DunningSubject;
  ownerFirstName: string | null;
  now: Date;
  firstWhatsapp: boolean;
}): Promise<NoticeCopyContext> {
  const { step, subject, now } = args;
  const sub = subject.input.subscription;
  const tz = subject.input.timezone;
  const prisma = getPrisma();

  const invoiceId = args.invoiceId ?? subject.input.openInvoice?.id ?? null;
  const invoice = invoiceId
    ? await prisma.invoice.findUnique({ where: { id: invoiceId }, select: { id: true, status: true, amountCents: true, pixCopyPaste: true, pixExpiresAt: true, paidAt: true, dueAt: true, cycle: true } })
    : null;
  const amountCents = invoice?.amountCents ?? subject.planPriceCents;

  const b = subscriptionBoundaries({ ...sub, timezone: tz });
  const neverPaid = sub.firstPaidAt === null;
  const today = localDateOf(now, tz);
  const suspensionDate = localDateOf(new Date(b.graceEndsAt.getTime() + 1), tz);
  const cancelDate = localDateOf(new Date(b.cancelsAt.getTime() + 1), tz);
  const trialEnd = sub.trialEndsAt ?? sub.currentPeriodEnd;
  const base = await getPublicBaseUrl();
  const sales = await getPlatformSalesWhatsapp().catch(() => null);

  const needsTrial = TRIAL_STEPS.has(step) || (step === "SUSPENDED" && neverPaid);
  const trial = needsTrial ? await loadTrialUsage(subject.tenantId, sub.createdAt) : null;

  // Vencimento mostrado: reativação usa o da própria fatura; teste, o fim do teste; quem paga, o fim do dia local.
  const dueInstant = sub.status === "CANCELED" && invoice ? invoice.dueAt : TRIAL_STEPS.has(step) || neverPaid ? trialEnd : b.dueAt;
  const data: DunningCopyData = {
    ownerName: args.ownerFirstName,
    tenantName: subject.tenantName,
    amount: formatCentsBRL(amountCents),
    // Fatura trimestral, semestral ou anual: os textos dizem "plano <ciclo>" junto do valor e nunca "por mês".
    cycle: invoice ? asBillingCycle(invoice.cycle) : subject.billingCycle,
    dueDate: formatDateBR(dueInstant, tz),
    billingUrl: `${base}/${subject.tenantSlug}/assinatura`,
    panelUrl: `${base}/${subject.tenantSlug}/inicio`,
    pixCopyPaste: null, // o despachante preenche depois de garantir um Pix vigente
    lastServiceDate: formatDateBR(b.graceEndsAt, tz),
    daysSuspended: Math.max(0, diffLocalDates(suspensionDate, today)),
    daysToCancel: Math.max(0, diffLocalDates(today, cancelDate)),
    cancelDate: formatDateBR(new Date(b.cancelsAt.getTime() + 1), tz),
    suspendedDate: formatDateBR(new Date(b.graceEndsAt.getTime() + 1), tz),
    retentionDays: CANCELED_RETENTION_DAYS,
    unpaidDays: neverPaid ? CANCEL_AFTER_SUSPENDED_TRIAL_DAYS : CANCEL_AFTER_SUSPENDED_DAYS,
    salesWhatsapp: sales?.display ?? null,
    trialEndsDate: formatDateBR(trialEnd, tz),
    trialEndsTime: localTimeLabel(trialEnd, tz),
    trial,
    paidDate: invoice?.paidAt ? formatDateBR(invoice.paidAt, tz) : null,
    activeUntil: formatDateBR(sub.currentPeriodEnd, tz),
    firstPayment: Boolean(sub.firstPaidAt && invoice?.paidAt && sub.firstPaidAt.getTime() === invoice.paidAt.getTime()),
    trialNotConverted: neverPaid,
    firstWhatsapp: args.firstWhatsapp,
  };

  const canceledAt = sub.canceledAt;
  return {
    data,
    retentionUntilBr: canceledAt ? formatDateBR(addDays(canceledAt, CANCELED_RETENTION_DAYS), tz) : null,
    clientsUrl: `${base}/${subject.tenantSlug}/clientes`,
    invoice: invoice ? { id: invoice.id, status: invoice.status, amountCents: invoice.amountCents, pixCopyPaste: invoice.pixCopyPaste, pixExpiresAt: invoice.pixExpiresAt, paidAt: invoice.paidAt } : null,
  };
}
