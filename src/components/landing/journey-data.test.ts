import { describe, expect, it } from "vitest";
import { buildDemoScript } from "./demo-script";
import { clampStep, JOURNEY_STEPS, messageCountForStep } from "./journey-data";

describe("jornada da landing", () => {
  const messages = buildDemoScript(new Date("2026-10-01T15:00:00Z"));

  it("tem 5 passos e cada um aponta para uma mensagem real do roteiro", () => {
    expect(JOURNEY_STEPS).toHaveLength(5);
    JOURNEY_STEPS.forEach((step, i) => {
      expect(messageCountForStep(messages, i), step.id).toBeGreaterThan(0);
    });
  });

  it("a conversa só cresce de um passo para o seguinte", () => {
    const counts = JOURNEY_STEPS.map((_, i) => messageCountForStep(messages, i));
    expect([...counts].sort((a, b) => a - b)).toEqual(counts);
  });

  it("o lembrete (passo 4) termina na mensagem do lembrete, com a legenda do dia anterior", () => {
    const last = messages[messageCountForStep(messages, 3) - 1];
    expect(last.note).toMatch(/dia anterior/);
    expect(last.text).toMatch(/lembr/i);
  });

  it("o passo 2 termina na saudação do bot v2 (texto vindo do renderizador)", () => {
    const last = messages[messageCountForStep(messages, 1) - 1];
    expect(last.from).toBe("bot");
    expect(last.text).toMatch(/Agendar horário/);
  });

  it("clampStep limita ao intervalo", () => {
    expect(clampStep(-3)).toBe(0);
    expect(clampStep(99)).toBe(4);
    expect(clampStep(2.4)).toBe(2);
  });
});
