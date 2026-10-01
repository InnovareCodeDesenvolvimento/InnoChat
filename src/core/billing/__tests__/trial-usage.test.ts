import { describe, expect, it } from "vitest";
import { describeMissingStep, describeStrandedClients, describeTrialResults, summarizeTrialUsage, type TrialUsageRaw } from "../trial-usage";

const base: TrialUsageRaw = {
  appointmentsByBot: 0,
  conversationsAnswered: 0,
  remindersSent: 0,
  returningClients: 0,
  botClients: 0,
  whatsappConnected: true,
  hasService: true,
  hasProfessional: true,
};

describe("summarizeTrialUsage", () => {
  it("com horários marcados é RESULTS e a frase lista só o que é maior que zero", () => {
    const usage = summarizeTrialUsage({ ...base, appointmentsByBot: 3, conversationsAnswered: 12, remindersSent: 2, botClients: 3 });
    expect(usage.variant).toBe("RESULTS");
    expect(describeTrialResults(usage)).toBe("marcou 3 horários, respondeu 12 conversas e mandou 2 lembretes");
  });

  it("singular e plural", () => {
    expect(describeTrialResults(summarizeTrialUsage({ ...base, appointmentsByBot: 1 }))).toBe("marcou 1 horário");
    expect(describeTrialResults(summarizeTrialUsage({ ...base, appointmentsByBot: 1, conversationsAnswered: 1, remindersSent: 1, returningClients: 1 }))).toBe(
      "marcou 1 horário, respondeu 1 conversa, mandou 1 lembrete e fez 1 cliente voltar a marcar",
    );
    expect(describeTrialResults(summarizeTrialUsage({ ...base, appointmentsByBot: 2, returningClients: 2 }))).toBe("marcou 2 horários e fez 2 clientes voltarem a marcar");
  });

  it("só conversas respondidas já conta como resultado real", () => {
    const usage = summarizeTrialUsage({ ...base, conversationsAnswered: 4 });
    expect(usage.variant).toBe("RESULTS");
    expect(describeTrialResults(usage)).toBe("respondeu 4 conversas");
  });

  it("tudo zero vira a variação 'falta pouco' e nunca devolve frase de resultado", () => {
    const usage = summarizeTrialUsage(base);
    expect(usage.variant).toBe("ALMOST");
    expect(describeTrialResults(usage)).toBeNull();
  });

  it("lembretes sozinhos não são resultado: o Inno ainda não atendeu ninguém", () => {
    expect(summarizeTrialUsage({ ...base, remindersSent: 5 }).variant).toBe("ALMOST");
  });

  it("o que falta segue a ordem: conectar, serviço, profissional, divulgar", () => {
    expect(summarizeTrialUsage({ ...base, whatsappConnected: false, hasService: false }).missing).toBe("CONNECT_WHATSAPP");
    expect(summarizeTrialUsage({ ...base, hasService: false, hasProfessional: false }).missing).toBe("ADD_SERVICE");
    expect(summarizeTrialUsage({ ...base, hasProfessional: false }).missing).toBe("ADD_PROFESSIONAL");
    expect(summarizeTrialUsage(base).missing).toBe("SHARE_NUMBER");
    expect(describeMissingStep("CONNECT_WHATSAPP")).toBe("conectar o número de WhatsApp da empresa");
  });

  it("ignora número negativo, NaN e fração", () => {
    const usage = summarizeTrialUsage({ ...base, appointmentsByBot: -2, conversationsAnswered: Number.NaN, remindersSent: 2.9 });
    expect(usage.variant).toBe("ALMOST");
    expect(usage.appointments).toBe(0);
    expect(usage.reminders).toBe(2);
  });
});

describe("describeStrandedClients", () => {
  it("singular e plural", () => {
    expect(describeStrandedClients(1)).toBe("1 cliente que marcou pelo WhatsApp vai ficar sem resposta");
    expect(describeStrandedClients(4)).toBe("4 clientes que marcaram pelo WhatsApp vão ficar sem resposta");
  });
});
