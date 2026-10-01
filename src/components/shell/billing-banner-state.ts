import { effectiveStatus, subscriptionBoundaries, type SubscriptionSnapshot } from "@/core/billing";

/**
 * Estado do banner de cobrança (docs/regua-de-cobranca.md §2.2 coluna B e §3.3). Puro: sem Prisma
 * e sem relógio próprio (`now` entra por parâmetro), então é testável com data fixa.
 *
 * Regra de ouro: este arquivo NÃO conhece carência nem prazo de cancelamento. O estado vem de
 * `effectiveStatus` e os instantes (fim do vencimento, da carência e do cancelamento) de
 * `subscriptionBoundaries`, ambos do core de billing: a mesma conta que o servidor usa para
 * suspender, então o contador nunca discorda do que de fato vai acontecer.
 */

export type BillingBannerState =
  | { kind: "TRIAL"; endsAt: string; hasInvoice: boolean }
  | { kind: "INVOICE_DUE"; dueAt: string; amountCents: number }
  | { kind: "GRACE"; stopsAt: string; amountCents: number | null }
  | { kind: "SUSPENDED"; cancelsAt: string }
  | { kind: "CANCELED" }
  | { kind: "RENEWED"; until: string };

export type BannerSubscription = SubscriptionSnapshot;

export type BannerInput = {
  subscription: BannerSubscription;
  openInvoice: { amountCents: number; dueAt: Date } | null;
  /** Pagamento mais recente confirmado (`Invoice.paidAt`), ou null. */
  lastPaidAt: Date | null;
};

/** A partir de quantos dias antes do vencimento o banner avisa de fatura aberta (docs §2.2: D-5). */
export const INVOICE_BANNER_LEAD_DAYS = 5;
/** Quantos dias o cartão "Assinatura renovada" fica depois do pagamento (docs §2.2). */
export const RENEWED_CARD_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export function resolveBillingBanner(input: BannerInput, now: Date): BillingBannerState | null {
  const { subscription, openInvoice, lastPaidAt } = input;
  const status = effectiveStatus(subscription, now);

  if (status === "CANCELED") return { kind: "CANCELED" };

  const boundaries = subscriptionBoundaries(subscription);

  if (status === "SUSPENDED") {
    return { kind: "SUSPENDED", cancelsAt: boundaries.cancelsAt.toISOString() };
  }

  if (status === "PAST_DUE") {
    return { kind: "GRACE", stopsAt: boundaries.graceEndsAt.toISOString(), amountCents: openInvoice?.amountCents ?? null };
  }

  if (status === "TRIALING") {
    return { kind: "TRIAL", endsAt: boundaries.dueAt.toISOString(), hasInvoice: openInvoice !== null };
  }

  // ACTIVE. Com cancelamento agendado não há nova cobrança: nada a avisar.
  if (subscription.cancelAtPeriodEnd) return null;

  // "D-5" é por dia do calendário: o vencimento é 23:59 do dia D, então o aviso nasce às 00:00 de D-5,
  // isto é, quando faltam menos de 6 dias. O contador vai até o fim do vencimento pelo core (23:59 do dia local de quem paga), que é
  // quando a fatura de fato passa a estar atrasada, e não até o `dueAt` bruto da fatura.
  if (openInvoice && boundaries.dueAt.getTime() - now.getTime() < (INVOICE_BANNER_LEAD_DAYS + 1) * DAY_MS) {
    return { kind: "INVOICE_DUE", dueAt: boundaries.dueAt.toISOString(), amountCents: openInvoice.amountCents };
  }

  if (lastPaidAt && now.getTime() - lastPaidAt.getTime() <= RENEWED_CARD_DAYS * DAY_MS) {
    return { kind: "RENEWED", until: subscription.currentPeriodEnd.toISOString() };
  }

  return null;
}

/**
 * Tempo restante em texto curto para o contador. Arredonda para CIMA no minuto (nunca mostra
 * "0 min" antes de acabar) e some a unidade menor quando ela é irrelevante.
 * 30h20 -> "1 dia e 6h", 5h12 -> "5h12", 12 min -> "12 min", <= 0 -> "agora".
 */
export function formatCountdown(targetMs: number, nowMs: number): string {
  const diff = targetMs - nowMs;
  if (diff <= 0) return "agora";
  const totalMin = Math.ceil(diff / MINUTE_MS);
  const days = Math.floor(totalMin / (24 * 60));
  const hours = Math.floor((totalMin % (24 * 60)) / 60);
  const minutes = totalMin % 60;
  if (days > 0) {
    const dayLabel = days === 1 ? "1 dia" : `${days} dias`;
    return hours > 0 ? `${dayLabel} e ${hours}h` : dayLabel;
  }
  if (hours > 0) return minutes > 0 ? `${hours}h${String(minutes).padStart(2, "0")}` : `${hours}h`;
  return `${minutes} min`;
}
