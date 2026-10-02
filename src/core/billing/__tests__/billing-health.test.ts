import { describe, expect, it } from "vitest";
import {
  BILLING_TICK_DOWN_AFTER_MINUTES,
  evaluateBillingHealth,
  readTickResult,
  unavailableBillingHealth,
  type BillingHealthInput,
} from "../billing-health";

const NOW = new Date("2026-10-10T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function input(over: Partial<BillingHealthInput> = {}): BillingHealthInput {
  return {
    now: NOW,
    lastTickAt: minutesAgo(10),
    lastTickResult: { noticesSent: 4, noticesFailed: 0, emailsFailed: 0 },
    hasTenantOlderThanDownLimit: true,
    stuckEmailNotices: 0,
    stuckWhatsappNotices: 0,
    failedLast24h: 0,
    emailFailingInSequence: false,
    platformWhatsapp: "connected",
    ...over,
  };
}

describe("evaluateBillingHealth: limites", () => {
  it("tudo em dia é ok, com os números da última rodada", () => {
    const report = evaluateBillingHealth(input());
    expect(report.status).toBe("ok");
    expect(report.minutesSinceLastTick).toBe(10);
    expect(report.lastTickResult).toEqual({ sent: 4, failed: 0 });
    expect(report.reasons).toEqual([]);
    expect(report.emailFailing).toBe(false);
  });

  it("rodada de exatamente 3 h ainda é ok; um minuto a mais é down", () => {
    expect(evaluateBillingHealth(input({ lastTickAt: minutesAgo(BILLING_TICK_DOWN_AFTER_MINUTES) })).status).toBe("ok");
    const down = evaluateBillingHealth(input({ lastTickAt: minutesAgo(BILLING_TICK_DOWN_AFTER_MINUTES + 1) }));
    expect(down.status).toBe("down");
    expect(down.reasons).toContain("TICK_STALE");
  });

  it("nunca rodou: down só se já existe empresa antiga; sem empresa é ok", () => {
    const never = evaluateBillingHealth(input({ lastTickAt: null, lastTickResult: null }));
    expect(never.status).toBe("down");
    expect(never.reasons).toEqual(["TICK_NEVER_RAN"]);
    expect(never.minutesSinceLastTick).toBeNull();
    expect(evaluateBillingHealth(input({ lastTickAt: null, lastTickResult: null, hasTenantOlderThanDownLimit: false })).status).toBe("ok");
  });

  it("aviso de e-mail preso é down; aviso de WhatsApp preso é só degraded", () => {
    const email = evaluateBillingHealth(input({ stuckEmailNotices: 1 }));
    expect(email.status).toBe("down");
    expect(email.pendingOverdue).toBe(1);
    const wa = evaluateBillingHealth(input({ stuckWhatsappNotices: 2 }));
    expect(wa.status).toBe("degraded");
    expect(wa.pendingOverdue).toBe(2);
  });

  it("e-mails falhando em sequência é down; falha só na última rodada é degraded", () => {
    const seq = evaluateBillingHealth(input({ emailFailingInSequence: true }));
    expect(seq.status).toBe("down");
    expect(seq.emailFailing).toBe(true);
    const once = evaluateBillingHealth(input({ lastTickResult: { noticesSent: 1, noticesFailed: 1, emailsFailed: 1 } }));
    expect(once.status).toBe("degraded");
    expect(once.emailFailing).toBe(true);
  });

  it("WhatsApp da plataforma caído ou sem número é degraded; desligado é ok", () => {
    expect(evaluateBillingHealth(input({ platformWhatsapp: "disconnected" })).status).toBe("degraded");
    expect(evaluateBillingHealth(input({ platformWhatsapp: "missing" })).status).toBe("degraded");
    expect(evaluateBillingHealth(input({ platformWhatsapp: "disabled" })).status).toBe("ok");
  });

  it("rodada que parou por tempo é degraded e aparece no resultado", () => {
    const report = evaluateBillingHealth(input({ lastTickResult: { noticesSent: 0, noticesFailed: 0, deadlineReached: true } }));
    expect(report.status).toBe("degraded");
    expect(report.lastTickResult).toEqual({ sent: 0, failed: 0, deadlineReached: true });
  });

  it("down vence degraded", () => {
    const report = evaluateBillingHealth(input({ stuckEmailNotices: 1, platformWhatsapp: "disconnected" }));
    expect(report.status).toBe("down");
    expect(report.reasons).toEqual(["NOTICES_STUCK_EMAIL", "PLATFORM_WHATSAPP_DOWN"]);
  });
});

describe("leitura segura do resultado e relatório sem dado pessoal", () => {
  it("JSON estranho no banco não quebra nem vaza texto", () => {
    expect(readTickResult(null)).toBeNull();
    expect(readTickResult("x")).toBeNull();
    expect(readTickResult([1])).toBeNull();
    const weird = readTickResult({ noticesSent: "9", noticesFailed: -2, emailsFailed: Number.NaN, secret: "abc@x.com" });
    expect(weird).toEqual({ sent: 0, failed: 0, emailsFailed: 0 });
  });

  it("o relatório só tem chaves esperadas, números e códigos (nenhum e-mail, telefone ou nome)", () => {
    const json = JSON.stringify(
      evaluateBillingHealth(input({ stuckEmailNotices: 3, lastTickResult: { noticesSent: 1, email: "a@b.com", phone: "5584999990001", tenant: "Salão da Ana" } })),
    );
    expect(json).not.toMatch(/@|5584|Salão|Ana/);
    expect(Object.keys(JSON.parse(json)).sort()).toEqual(
      ["emailFailing", "failedLast24h", "lastTickAt", "lastTickResult", "minutesSinceLastTick", "pendingOverdue", "platformWhatsapp", "reasons", "status"],
    );
  });

  it("relatório de indisponibilidade é down e genérico", () => {
    const r = unavailableBillingHealth();
    expect(r.status).toBe("down");
    expect(r.reasons).toEqual(["HEALTH_UNAVAILABLE"]);
  });
});
