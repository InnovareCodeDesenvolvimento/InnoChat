import { describe, expect, it } from "vitest";
import { shouldAskForDocument } from "../document-notice";

const NOW = new Date("2026-10-12T12:00:00.000Z");
const HOUR = 3_600_000;
const VALID_CPF = "52998224725";

function sub(overrides: Record<string, unknown> = {}) {
  const trialEndsAt = new Date(NOW.getTime() + 10 * HOUR);
  return {
    status: "TRIALING" as const,
    trialEndsAt,
    currentPeriodEnd: trialEndsAt,
    firstPaidAt: null,
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

describe("shouldAskForDocument (faixa do CPF/CNPJ no painel)", () => {
  it("dono, teste, sem documento, últimas 24 h: mostra", () => {
    expect(shouldAskForDocument({ role: "OWNER", document: null, subscription: sub(), now: NOW })).toBe(true);
  });

  it("documento inválido salvo conta como sem documento", () => {
    expect(shouldAskForDocument({ role: "OWNER", document: "11111111111", subscription: sub(), now: NOW })).toBe(true);
  });

  it("com documento válido: não mostra", () => {
    expect(shouldAskForDocument({ role: "OWNER", document: VALID_CPF, subscription: sub(), now: NOW })).toBe(false);
  });

  it("equipe (STAFF) nunca vê", () => {
    expect(shouldAskForDocument({ role: "STAFF", document: null, subscription: sub(), now: NOW })).toBe(false);
  });

  it("antes das últimas 24 h: não mostra", () => {
    const trialEndsAt = new Date(NOW.getTime() + 25 * HOUR);
    expect(shouldAskForDocument({ role: "OWNER", document: null, subscription: sub({ trialEndsAt, currentPeriodEnd: trialEndsAt }), now: NOW })).toBe(false);
  });

  it("na hora exata de 24 h faltando: mostra", () => {
    const trialEndsAt = new Date(NOW.getTime() + 24 * HOUR);
    expect(shouldAskForDocument({ role: "OWNER", document: null, subscription: sub({ trialEndsAt, currentPeriodEnd: trialEndsAt }), now: NOW })).toBe(true);
  });

  it("teste já vencido (carência, suspensa): não mostra", () => {
    const trialEndsAt = new Date(NOW.getTime() - HOUR);
    expect(shouldAskForDocument({ role: "OWNER", document: null, subscription: sub({ trialEndsAt, currentPeriodEnd: trialEndsAt }), now: NOW })).toBe(false);
  });

  it("quem já pagou ou agendou o cancelamento: não mostra", () => {
    expect(shouldAskForDocument({ role: "OWNER", document: null, subscription: sub({ firstPaidAt: new Date(NOW.getTime() - 40 * 24 * HOUR) }), now: NOW })).toBe(false);
    expect(shouldAskForDocument({ role: "OWNER", document: null, subscription: sub({ cancelAtPeriodEnd: true }), now: NOW })).toBe(false);
  });

  it("sem assinatura: não mostra", () => {
    expect(shouldAskForDocument({ role: "OWNER", document: null, subscription: null, now: NOW })).toBe(false);
  });
});
