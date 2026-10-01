import { describe, expect, it } from "vitest";
import { effectiveStatus, subscriptionBoundaries } from "@/core/billing";
import { formatCountdown, resolveBillingBanner, type BannerSubscription } from "./billing-banner-state";

const NOW = new Date("2026-10-10T15:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

function sub(overrides: Partial<BannerSubscription> = {}): BannerSubscription {
  return {
    status: "ACTIVE",
    trialEndsAt: null,
    currentPeriodEnd: at(20 * DAY),
    cancelAtPeriodEnd: false,
    firstPaidAt: at(-10 * DAY),
    ...overrides,
  };
}

describe("formatCountdown", () => {
  it("dias e horas", () => expect(formatCountdown(NOW.getTime() + 30 * 60 * 60 * 1000, NOW.getTime())).toBe("1 dia e 6h"));
  it("dias inteiros", () => expect(formatCountdown(NOW.getTime() + 3 * DAY, NOW.getTime())).toBe("3 dias"));
  it("horas e minutos com zero à esquerda", () => expect(formatCountdown(NOW.getTime() + (5 * 60 + 7) * 60_000, NOW.getTime())).toBe("5h07"));
  it("só minutos, arredondando para cima", () => expect(formatCountdown(NOW.getTime() + 12 * 60_000 - 1000, NOW.getTime())).toBe("12 min"));
  it("zero ou passado", () => expect(formatCountdown(NOW.getTime(), NOW.getTime())).toBe("agora"));
});

describe("resolveBillingBanner", () => {
  it("teste: contador até o fim do teste e se já existe fatura", () => {
    const trialEndsAt = at(2 * DAY);
    const state = resolveBillingBanner(
      { subscription: sub({ status: "TRIALING", trialEndsAt, currentPeriodEnd: trialEndsAt, firstPaidAt: null }), openInvoice: null, lastPaidAt: null },
      NOW,
    );
    expect(state).toEqual({ kind: "TRIAL", endsAt: trialEndsAt.toISOString(), hasInvoice: false });
  });

  it("ativa, fatura aberta a 5 dias: amarelo com valor e vencimento", () => {
    const dueAt = at(5 * DAY);
    const subscription = sub({ currentPeriodEnd: dueAt });
    const state = resolveBillingBanner({ subscription, openInvoice: { amountCents: 9900, dueAt }, lastPaidAt: null }, NOW);
    // O contador vai até o fim do vencimento do core (23:59 local de quem paga), não até o `dueAt` bruto.
    expect(state).toEqual({ kind: "INVOICE_DUE", dueAt: subscriptionBoundaries(subscription).dueAt.toISOString(), amountCents: 9900 });
  });

  it("ativa, fatura aberta a mais de 5 dias: sem banner", () => {
    const dueAt = at(7 * DAY);
    expect(resolveBillingBanner({ subscription: sub({ currentPeriodEnd: dueAt }), openInvoice: { amountCents: 9900, dueAt }, lastPaidAt: null }, NOW)).toBeNull();
  });

  it("ativa com cancelamento agendado: nada a cobrar", () => {
    const dueAt = at(1 * DAY);
    expect(
      resolveBillingBanner({ subscription: sub({ currentPeriodEnd: dueAt, cancelAtPeriodEnd: true }), openInvoice: { amountCents: 9900, dueAt }, lastPaidAt: null }, NOW),
    ).toBeNull();
  });

  it("pago há menos de 7 dias: cartão de renovada até o fim do período", () => {
    const state = resolveBillingBanner({ subscription: sub(), openInvoice: null, lastPaidAt: at(-6 * DAY) }, NOW);
    expect(state).toEqual({ kind: "RENEWED", until: sub().currentPeriodEnd.toISOString() });
  });

  it("pago há mais de 7 dias: some", () => {
    expect(resolveBillingBanner({ subscription: sub(), openInvoice: null, lastPaidAt: at(-8 * DAY) }, NOW)).toBeNull();
  });

  it("carência (PAST_DUE): `stopsAt` é exatamente quando o status efetivo deixa de ser PAST_DUE, seja qual for a regra", () => {
    const subscription = sub({ status: "PAST_DUE", currentPeriodEnd: at(-36 * 60 * 60 * 1000) });
    expect(effectiveStatus(subscription, NOW)).toBe("PAST_DUE");
    const state = resolveBillingBanner({ subscription, openInvoice: { amountCents: 9900, dueAt: subscription.currentPeriodEnd }, lastPaidAt: null }, NOW);
    expect(state?.kind).toBe("GRACE");
    if (state?.kind !== "GRACE") return;
    const stops = new Date(state.stopsAt);
    expect(effectiveStatus(subscription, stops)).not.toBe("PAST_DUE");
    expect(effectiveStatus(subscription, new Date(stops.getTime() - 1))).toBe("PAST_DUE");
  });

  it("suspensa: `cancelsAt` é quando o status efetivo vira CANCELED", () => {
    const subscription = sub({ status: "SUSPENDED", currentPeriodEnd: at(-10 * DAY) });
    expect(effectiveStatus(subscription, NOW)).toBe("SUSPENDED");
    const state = resolveBillingBanner({ subscription, openInvoice: null, lastPaidAt: null }, NOW);
    expect(state?.kind).toBe("SUSPENDED");
    if (state?.kind !== "SUSPENDED") throw new Error("estado errado");
    const cancels = new Date(state.cancelsAt);
    expect(effectiveStatus(subscription, cancels)).toBe("CANCELED");
    expect(effectiveStatus(subscription, new Date(cancels.getTime() - 1))).toBe("SUSPENDED");
  });

  it("cancelada", () => {
    expect(resolveBillingBanner({ subscription: sub({ status: "CANCELED" }), openInvoice: null, lastPaidAt: null }, NOW)).toEqual({ kind: "CANCELED" });
  });
});
