import { getPrisma } from "@/lib/db/prisma";
import {
  currentBellStep,
  describeBellStep,
  diffLocalDates,
  localDateOf,
  localTimeLabel,
  subscriptionBoundaries,
  type BillingBellKind,
  type BillingBellSeverity,
} from "@/core/billing";
import { formatCentsBRL, formatDateBR } from "../format";
import { loadDunningSubject } from "./snapshot";

/**
 * Sino da empresa para a cobrança (docs/regua-de-cobranca.md §2.2 coluna S). DERIVADO do estado, como o resto do
 * sino: o mesmo planejador puro da régua diz em que etapa a assinatura está, sem tabela nova e sem esquecer ponto
 * de escrita. Uma etapa por vez (a mais recente que já chegou); o id muda a cada etapa, então cada passo da
 * régua volta como não lido. Só o OWNER vê (dinheiro da empresa).
 */

export type BillingBellItem = {
  /** `bill:<subscriptionId>:<etapa>:<instante da etapa em ms>`. */
  id: string;
  kind: BillingBellKind;
  severity: BillingBellSeverity;
  title: string;
  body: string;
  createdAt: string;
};

export async function loadBillingBellItems(tenant: { id: string; timezone: string }, now: Date): Promise<BillingBellItem[]> {
  const subscription = await getPrisma().subscription.findUnique({ where: { tenantId: tenant.id }, select: { id: true } });
  if (!subscription) return [];
  const subject = await loadDunningSubject(subscription.id, now);
  if (!subject) return [];

  const current = currentBellStep(subject.input, now);
  if (!current) return [];

  const sub = subject.input.subscription;
  const tz = subject.input.timezone;
  const b = subscriptionBoundaries({ ...sub, timezone: tz });
  const neverPaid = sub.firstPaidAt === null;
  const invoice = subject.input.openInvoice
    ? await getPrisma().invoice.findUnique({ where: { id: subject.input.openInvoice.id }, select: { amountCents: true } })
    : null;
  const trialEnd = sub.trialEndsAt ?? sub.currentPeriodEnd;
  const today = localDateOf(now, tz);
  const suspensionDate = localDateOf(new Date(b.graceEndsAt.getTime() + 1), tz);
  const cancelMoment = new Date(b.cancelsAt.getTime() + 1);

  const text = describeBellStep(current.step, {
    amount: formatCentsBRL(invoice?.amountCents ?? subject.planPriceCents),
    dueDate: formatDateBR(neverPaid ? trialEnd : b.dueAt, tz),
    lastServiceDate: formatDateBR(b.graceEndsAt, tz),
    daysSuspended: Math.max(0, diffLocalDates(suspensionDate, today)),
    daysToCancel: Math.max(0, diffLocalDates(today, localDateOf(cancelMoment, tz))),
    cancelDate: formatDateBR(cancelMoment, tz),
    trialEndsDate: formatDateBR(trialEnd, tz),
    trialEndsTime: localTimeLabel(trialEnd, tz),
    trialNotConverted: neverPaid,
  });
  if (!text) return [];

  return [{ id: `bill:${sub.id}:${current.step}:${current.at.getTime()}`, ...text, createdAt: current.at.toISOString() }];
}
