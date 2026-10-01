import { describe, expect, it } from "vitest";
import {
  accessEndsAt,
  CANCEL_AFTER_SUSPENDED_DAYS,
  CANCEL_AFTER_SUSPENDED_TRIAL_DAYS,
  computeNextPeriodEnd,
  computeTrialEndsAt,
  effectiveStatus,
  GRACE_DAYS,
} from "../status";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("computeTrialEndsAt", () => {
  it("é +3 dias a partir do cadastro (decisão do dono, 2026-09-29 — trocou de 1 para 3 dias)", () => {
    const signupAt = new Date("2026-09-28T10:00:00.000Z");
    expect(computeTrialEndsAt(signupAt).toISOString()).toBe("2026-10-01T10:00:00.000Z");
  });
});

describe("effectiveStatus — trial (§7.4)", () => {
  const trialEndsAt = new Date("2026-09-29T10:00:00.000Z");
  const base = {
    status: "TRIALING" as const,
    trialEndsAt,
    currentPeriodEnd: trialEndsAt,
  };

  it("TRIALING antes do fim do trial", () => {
    expect(effectiveStatus(base, new Date(trialEndsAt.getTime() - HOUR))).toBe("TRIALING");
  });

  it("continua TRIALING no instante exato do vencimento (now < dueAt, não <=)", () => {
    expect(effectiveStatus(base, new Date(trialEndsAt.getTime() - 1))).toBe("TRIALING");
  });

  it("PAST_DUE logo depois do fim do trial", () => {
    expect(effectiveStatus(base, new Date(trialEndsAt.getTime() + HOUR))).toBe("PAST_DUE");
  });

  it("SUSPENDED depois de 1 dia de carência (GRACE_DAYS)", () => {
    const graceEnd = new Date(trialEndsAt.getTime() + GRACE_DAYS * DAY);
    expect(effectiveStatus(base, new Date(graceEnd.getTime() + HOUR))).toBe("SUSPENDED");
  });

  it("ainda PAST_DUE no último instante da carência", () => {
    const graceEnd = new Date(trialEndsAt.getTime() + GRACE_DAYS * DAY);
    expect(effectiveStatus(base, new Date(graceEnd.getTime() - 1))).toBe("PAST_DUE");
  });

  it("CANCELED depois de 60 dias em SUSPENDED", () => {
    const graceEnd = new Date(trialEndsAt.getTime() + GRACE_DAYS * DAY);
    const cancelAt = new Date(graceEnd.getTime() + CANCEL_AFTER_SUSPENDED_DAYS * DAY);
    expect(effectiveStatus(base, new Date(cancelAt.getTime() + HOUR))).toBe("CANCELED");
  });

  it("ainda SUSPENDED no último instante antes de completar os 60 dias", () => {
    const graceEnd = new Date(trialEndsAt.getTime() + GRACE_DAYS * DAY);
    const cancelAt = new Date(graceEnd.getTime() + CANCEL_AFTER_SUSPENDED_DAYS * DAY);
    expect(effectiveStatus(base, new Date(cancelAt.getTime() - 1))).toBe("SUSPENDED");
  });
});

describe("effectiveStatus — teste não convertido (nunca pagou: firstPaidAt === null)", () => {
  const trialEndsAt = new Date("2026-09-29T10:00:00.000Z");
  const neverPaid = { status: "TRIALING" as const, trialEndsAt, currentPeriodEnd: trialEndsAt, firstPaidAt: null };
  const cancelAt = new Date(trialEndsAt.getTime() + (GRACE_DAYS + CANCEL_AFTER_SUSPENDED_TRIAL_DAYS) * DAY);

  it("a constante é 7 dias", () => {
    expect(CANCEL_AFTER_SUSPENDED_TRIAL_DAYS).toBe(7);
  });

  it("ainda SUSPENDED no último instante antes de graceEnd + 7 dias", () => {
    expect(effectiveStatus(neverPaid, new Date(cancelAt.getTime() - 1))).toBe("SUSPENDED");
  });

  it("CANCELED exatamente em graceEnd + 7 dias", () => {
    expect(effectiveStatus(neverPaid, cancelAt)).toBe("CANCELED");
  });

  it("a carência de 1 dia continua igual (PAST_DUE → SUSPENDED)", () => {
    expect(effectiveStatus(neverPaid, new Date(trialEndsAt.getTime() + HOUR))).toBe("PAST_DUE");
    expect(effectiveStatus(neverPaid, new Date(trialEndsAt.getTime() + GRACE_DAYS * DAY + HOUR))).toBe("SUSPENDED");
  });

  it("assinatura que já pagou (firstPaidAt preenchido) mantém os 60 dias", () => {
    const paidBefore = { ...neverPaid, status: "SUSPENDED" as const, firstPaidAt: new Date("2026-08-01T00:00:00.000Z") };
    expect(effectiveStatus(paidBefore, cancelAt)).toBe("SUSPENDED");
    const cancel60 = new Date(trialEndsAt.getTime() + (GRACE_DAYS + CANCEL_AFTER_SUSPENDED_DAYS) * DAY);
    expect(effectiveStatus(paidBefore, new Date(cancel60.getTime() - 1))).toBe("SUSPENDED");
    expect(effectiveStatus(paidBefore, cancel60)).toBe("CANCELED");
  });

  it("firstPaidAt ausente no snapshot (desconhecido) não cancela mais cedo", () => {
    const { firstPaidAt: _omit, ...unknown } = neverPaid;
    void _omit;
    expect(effectiveStatus(unknown, cancelAt)).toBe("SUSPENDED");
  });
});

describe("effectiveStatus — ciclo pago (currentPeriodEnd)", () => {
  const currentPeriodEnd = new Date("2026-10-28T10:00:00.000Z");

  it("ACTIVE quando status persistido é ACTIVE e ainda não venceu", () => {
    const sub = { status: "ACTIVE" as const, trialEndsAt: null, currentPeriodEnd };
    expect(effectiveStatus(sub, new Date(currentPeriodEnd.getTime() - DAY))).toBe("ACTIVE");
  });

  it(
    "ACTIVE mesmo com status persistido PAST_DUE/SUSPENDED, se currentPeriodEnd já avançou " +
      "(pagamento confirmado moveu a âncora para o futuro antes do próximo tick persistir)",
    () => {
      const sub = { status: "SUSPENDED" as const, trialEndsAt: null, currentPeriodEnd };
      expect(effectiveStatus(sub, new Date(currentPeriodEnd.getTime() - DAY))).toBe("ACTIVE");
    },
  );

  it("PAST_DUE depois do vencimento, dentro da carência", () => {
    const sub = { status: "ACTIVE" as const, trialEndsAt: null, currentPeriodEnd };
    expect(effectiveStatus(sub, new Date(currentPeriodEnd.getTime() + HOUR))).toBe("PAST_DUE");
  });

  it("SUSPENDED depois da carência", () => {
    const sub = { status: "PAST_DUE" as const, trialEndsAt: null, currentPeriodEnd };
    const graceEnd = new Date(currentPeriodEnd.getTime() + GRACE_DAYS * DAY);
    expect(effectiveStatus(sub, new Date(graceEnd.getTime() + HOUR))).toBe("SUSPENDED");
  });

  it("CANCELED depois de 60 dias SUSPENDED", () => {
    const sub = { status: "SUSPENDED" as const, trialEndsAt: null, currentPeriodEnd };
    const graceEnd = new Date(currentPeriodEnd.getTime() + GRACE_DAYS * DAY);
    const cancelAt = new Date(graceEnd.getTime() + CANCEL_AFTER_SUSPENDED_DAYS * DAY);
    expect(effectiveStatus(sub, new Date(cancelAt.getTime() + HOUR))).toBe("CANCELED");
  });
});

describe("effectiveStatus — CANCELED é terminal", () => {
  it("nunca sai de CANCELED, mesmo que currentPeriodEnd esteja no futuro", () => {
    const future = new Date(Date.now() + 30 * DAY);
    const sub = { status: "CANCELED" as const, trialEndsAt: null, currentPeriodEnd: future };
    expect(effectiveStatus(sub, new Date())).toBe("CANCELED");
  });
});

describe("effectiveStatus — cancelamento agendado (cancelAtPeriodEnd)", () => {
  const periodEnd = new Date("2026-11-20T12:00:00.000Z");
  const active = { status: "ACTIVE" as const, trialEndsAt: null, currentPeriodEnd: periodEnd, cancelAtPeriodEnd: true };

  it("até o fim do período continua ACTIVE (acesso total)", () => {
    expect(effectiveStatus(active, new Date(periodEnd.getTime() - 1))).toBe("ACTIVE");
  });

  it("no fim do período vai direto a CANCELED, sem carência nem suspensão", () => {
    expect(effectiveStatus(active, periodEnd)).toBe("CANCELED");
    expect(effectiveStatus(active, new Date(periodEnd.getTime() + 10 * DAY))).toBe("CANCELED");
  });

  it("em teste, a referência é o fim do teste", () => {
    const trialEnd = new Date("2026-10-04T10:00:00.000Z");
    const trial = { status: "TRIALING" as const, trialEndsAt: trialEnd, currentPeriodEnd: trialEnd, cancelAtPeriodEnd: true };
    expect(effectiveStatus(trial, new Date(trialEnd.getTime() - 1))).toBe("TRIALING");
    expect(effectiveStatus(trial, trialEnd)).toBe("CANCELED");
  });

  it("sem agendamento, o comportamento é o de sempre (carência de 1 dia)", () => {
    expect(effectiveStatus({ ...active, cancelAtPeriodEnd: false }, periodEnd)).toBe("PAST_DUE");
  });
});

describe("accessEndsAt", () => {
  it("TRIALING usa trialEndsAt; os demais, currentPeriodEnd", () => {
    const trialEnd = new Date("2026-10-04T10:00:00.000Z");
    const periodEnd = new Date("2026-11-04T10:00:00.000Z");
    expect(accessEndsAt({ status: "TRIALING", trialEndsAt: trialEnd, currentPeriodEnd: periodEnd })).toEqual(trialEnd);
    expect(accessEndsAt({ status: "ACTIVE", trialEndsAt: null, currentPeriodEnd: periodEnd })).toEqual(periodEnd);
  });
});

describe("computeNextPeriodEnd (§7.1)", () => {
  it("mantém o dia-âncora quando não estava SUSPENDED: +1 mês a partir do currentPeriodEnd", () => {
    const currentPeriodEnd = new Date("2026-01-31T10:00:00.000Z");
    const next = computeNextPeriodEnd({ currentPeriodEnd, wasSuspended: false, paidAt: new Date("2026-01-25T00:00:00.000Z") });
    // date-fns addMonths ajusta dias que não existem no mês seguinte: fevereiro/2026 (não
    // bissexto) só tem 28 dias, então +1 mês de 31/jan cai em 28/fev, não em 1/mar.
    expect(next.getUTCFullYear()).toBe(2026);
    expect(next.getUTCMonth()).toBe(1); // fevereiro (0-indexed)
    expect(next.getUTCDate()).toBe(28);
  });

  it("conta a partir de paidAt quando estava SUSPENDED — perde o dia-âncora antigo", () => {
    const currentPeriodEnd = new Date("2026-01-05T10:00:00.000Z");
    const paidAt = new Date("2026-02-20T15:30:00.000Z");
    const next = computeNextPeriodEnd({ currentPeriodEnd, wasSuspended: true, paidAt });
    expect(next.toISOString()).toBe("2026-03-20T15:30:00.000Z");
  });
});
