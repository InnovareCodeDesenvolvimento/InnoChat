import { describe, expect, it } from "vitest";
import {
  accessEndsAt,
  CANCEL_AFTER_SUSPENDED_DAYS,
  CANCEL_AFTER_SUSPENDED_TRIAL_DAYS,
  computeNextPeriodEnd,
  computeTrialEndsAt,
  effectiveStatus,
  GRACE_DAYS,
  GRACE_DAYS_PAYING,
  GRACE_DAYS_TRIAL,
  subscriptionBoundaries,
  usesTrialRules,
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
    cancelAtPeriodEnd: false,
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

  it("SUSPENDED depois de 1 dia de carência (GRACE_DAYS_TRIAL)", () => {
    const graceEnd = new Date(trialEndsAt.getTime() + GRACE_DAYS_TRIAL * DAY);
    expect(effectiveStatus(base, new Date(graceEnd.getTime() + HOUR))).toBe("SUSPENDED");
  });

  it("ainda PAST_DUE no último instante da carência", () => {
    const graceEnd = new Date(trialEndsAt.getTime() + GRACE_DAYS_TRIAL * DAY);
    expect(effectiveStatus(base, new Date(graceEnd.getTime() - 1))).toBe("PAST_DUE");
  });

  it("CANCELED depois de 60 dias em SUSPENDED (firstPaidAt desconhecido)", () => {
    const graceEnd = new Date(trialEndsAt.getTime() + GRACE_DAYS_TRIAL * DAY);
    const cancelAt = new Date(graceEnd.getTime() + CANCEL_AFTER_SUSPENDED_DAYS * DAY);
    expect(effectiveStatus(base, new Date(cancelAt.getTime() + HOUR))).toBe("CANCELED");
  });

  it("ainda SUSPENDED no último instante antes de completar os 60 dias", () => {
    const graceEnd = new Date(trialEndsAt.getTime() + GRACE_DAYS_TRIAL * DAY);
    const cancelAt = new Date(graceEnd.getTime() + CANCEL_AFTER_SUSPENDED_DAYS * DAY);
    expect(effectiveStatus(base, new Date(cancelAt.getTime() - 1))).toBe("SUSPENDED");
  });
});

describe("effectiveStatus — teste não convertido (nunca pagou: firstPaidAt === null)", () => {
  const trialEndsAt = new Date("2026-09-29T10:00:00.000Z");
  const neverPaid = { status: "TRIALING" as const, trialEndsAt, currentPeriodEnd: trialEndsAt, firstPaidAt: null, cancelAtPeriodEnd: false };
  const cancelAt = new Date(trialEndsAt.getTime() + (GRACE_DAYS_TRIAL + CANCEL_AFTER_SUSPENDED_TRIAL_DAYS) * DAY);

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
    expect(effectiveStatus(neverPaid, new Date(trialEndsAt.getTime() + GRACE_DAYS_TRIAL * DAY + HOUR))).toBe("SUSPENDED");
  });

  it("assinatura que já pagou (firstPaidAt preenchido) mantém os 60 dias, contados da carência de 3 dias", () => {
    const paidBefore = { ...neverPaid, status: "SUSPENDED" as const, firstPaidAt: new Date("2026-08-01T00:00:00.000Z") };
    expect(effectiveStatus(paidBefore, cancelAt)).toBe("SUSPENDED");
    const { cancelsAt } = subscriptionBoundaries(paidBefore);
    expect(effectiveStatus(paidBefore, new Date(cancelsAt.getTime() - 1))).toBe("SUSPENDED");
    expect(effectiveStatus(paidBefore, cancelsAt)).toBe("CANCELED");
  });

  it("firstPaidAt ausente no snapshot (desconhecido) não cancela mais cedo", () => {
    const { firstPaidAt: _omit, ...unknown } = neverPaid;
    void _omit;
    expect(effectiveStatus(unknown, cancelAt)).toBe("SUSPENDED");
  });
});

describe("effectiveStatus — ciclo pago (D3: 3 dias de carência; D7: vence às 23:59 do dia local)", () => {
  // 10:00 UTC = 07:00 em São Paulo (UTC-3). Dia local do vencimento: 28/10.
  const currentPeriodEnd = new Date("2026-10-28T10:00:00.000Z");
  const endOfDueDay = new Date("2026-10-29T02:59:59.999Z"); // 23:59:59.999 de 28/10 em SP
  const sub = (status: "ACTIVE" | "PAST_DUE" | "SUSPENDED") => ({
    status,
    trialEndsAt: null,
    currentPeriodEnd,
    firstPaidAt: new Date("2026-06-01T00:00:00.000Z"),
    cancelAtPeriodEnd: false,
  });

  it("as constantes: 3 dias para quem paga, 1 para o teste", () => {
    expect(GRACE_DAYS_PAYING).toBe(3);
    expect(GRACE_DAYS_TRIAL).toBe(1);
    expect(GRACE_DAYS).toBe(1);
  });

  it("ACTIVE quando ainda não venceu", () => {
    expect(effectiveStatus(sub("ACTIVE"), new Date(currentPeriodEnd.getTime() - DAY))).toBe("ACTIVE");
  });

  it(
    "ACTIVE mesmo com status persistido PAST_DUE/SUSPENDED, se currentPeriodEnd já avançou " +
      "(pagamento confirmado moveu a âncora para o futuro antes do próximo tick persistir)",
    () => {
      expect(effectiveStatus(sub("SUSPENDED"), new Date(currentPeriodEnd.getTime() - DAY))).toBe("ACTIVE");
    },
  );

  it("o vencimento só ADIA: no horário original e durante o dia local do vencimento ainda é ACTIVE", () => {
    expect(effectiveStatus(sub("ACTIVE"), currentPeriodEnd)).toBe("ACTIVE");
    expect(effectiveStatus(sub("ACTIVE"), new Date(currentPeriodEnd.getTime() + 10 * HOUR))).toBe("ACTIVE");
    expect(effectiveStatus(sub("ACTIVE"), new Date(endOfDueDay.getTime() - 1))).toBe("ACTIVE");
  });

  it("PAST_DUE a partir do fim do dia do vencimento, durante os 3 dias de carência", () => {
    expect(effectiveStatus(sub("ACTIVE"), endOfDueDay)).toBe("PAST_DUE");
    expect(effectiveStatus(sub("ACTIVE"), new Date("2026-10-30T12:00:00.000Z"))).toBe("PAST_DUE"); // D+2
    // último instante do D+3 local (31/10 23:59:59.999 em SP = 01/11 02:59:59.999Z)
    expect(effectiveStatus(sub("ACTIVE"), new Date("2026-11-01T02:59:59.998Z"))).toBe("PAST_DUE");
  });

  it("SUSPENDED logo depois do fim do D+3 local", () => {
    expect(effectiveStatus(sub("PAST_DUE"), new Date("2026-11-01T02:59:59.999Z"))).toBe("SUSPENDED");
    expect(effectiveStatus(sub("PAST_DUE"), new Date("2026-11-01T10:00:00.000Z"))).toBe("SUSPENDED");
  });

  it("nunca suspende ANTES do que suspendia com a regra antiga (1 dia de carência sobre o instante cru)", () => {
    // Regra antiga: SUSPENDED a partir de currentPeriodEnd + 1 dia. A nova só adia.
    const oldSuspendedFrom = new Date(currentPeriodEnd.getTime() + 1 * DAY);
    expect(effectiveStatus(sub("SUSPENDED"), oldSuspendedFrom)).toBe("PAST_DUE");
    // Quem estava no meio da carência antiga (PAST_DUE) continua em dia por mais tempo.
    expect(effectiveStatus(sub("PAST_DUE"), new Date(currentPeriodEnd.getTime() + 12 * HOUR))).toBe("ACTIVE");
  });

  it("CANCELED depois de 60 dias SUSPENDED (contados do fim da carência de 3 dias)", () => {
    const b = subscriptionBoundaries(sub("SUSPENDED"));
    // D+63 local = 30/12 (28/10 + 63 dias), fim do dia em SP.
    expect(b.cancelsAt.toISOString()).toBe("2026-12-31T02:59:59.999Z");
    expect(effectiveStatus(sub("SUSPENDED"), new Date(b.cancelsAt.getTime() - 1))).toBe("SUSPENDED");
    expect(effectiveStatus(sub("SUSPENDED"), b.cancelsAt)).toBe("CANCELED");
  });
});

describe("effectiveStatus — fuso, virada de dia e horário de verão", () => {
  const paid = new Date("2026-01-01T00:00:00Z");

  it("o dia do vencimento é o dia LOCAL, não o dia UTC (02:00Z ainda é o dia anterior em São Paulo)", () => {
    const periodEnd = new Date("2026-03-10T02:00:00.000Z"); // 09/03 23:00 em SP
    const s = { status: "ACTIVE" as const, trialEndsAt: null, currentPeriodEnd: periodEnd, firstPaidAt: paid, cancelAtPeriodEnd: false };
    expect(subscriptionBoundaries(s).dueAt.toISOString()).toBe("2026-03-10T02:59:59.999Z");
    expect(effectiveStatus(s, new Date("2026-03-10T02:30:00.000Z"))).toBe("ACTIVE");
    expect(effectiveStatus(s, new Date("2026-03-10T03:00:00.000Z"))).toBe("PAST_DUE");
  });

  it("outro fuso muda o corte (Fortaleza e Nova York)", () => {
    const periodEnd = new Date("2026-06-15T01:00:00.000Z");
    const base = { status: "ACTIVE" as const, trialEndsAt: null, currentPeriodEnd: periodEnd, firstPaidAt: paid, cancelAtPeriodEnd: false };
    expect(subscriptionBoundaries({ ...base, timezone: "America/Fortaleza" }).dueAt.toISOString()).toBe("2026-06-15T02:59:59.999Z"); // 14/06 23:59 UTC-3
    expect(subscriptionBoundaries({ ...base, timezone: "America/New_York" }).dueAt.toISOString()).toBe("2026-06-15T03:59:59.999Z"); // 14/06 23:59 UTC-4
  });

  it("horário de verão (Nova York, 08/03/2026): a carência de 3 dias dura até o fim do D+3 local, sem escorregar 1 hora", () => {
    // Vence em 06/03 (EST, UTC-5). D+3 = 09/03, já em EDT (UTC-4): fim do dia = 10/03 03:59:59.999Z.
    const s = { status: "ACTIVE" as const, trialEndsAt: null, currentPeriodEnd: new Date("2026-03-06T15:00:00.000Z"), firstPaidAt: paid, cancelAtPeriodEnd: false, timezone: "America/New_York" };
    const b = subscriptionBoundaries(s);
    expect(b.dueAt.toISOString()).toBe("2026-03-07T04:59:59.999Z");
    expect(b.graceEndsAt.toISOString()).toBe("2026-03-10T03:59:59.999Z");
    expect(effectiveStatus(s, new Date("2026-03-10T03:59:59.998Z"))).toBe("PAST_DUE");
    expect(effectiveStatus(s, new Date("2026-03-10T03:59:59.999Z"))).toBe("SUSPENDED");
  });

  it("horário de verão antigo de São Paulo (04/11/2018, 00:00 não existia): o fim do dia continua certo", () => {
    const s = { status: "ACTIVE" as const, trialEndsAt: null, currentPeriodEnd: new Date("2018-11-03T15:00:00.000Z"), firstPaidAt: new Date("2018-01-01T00:00:00Z"), cancelAtPeriodEnd: false };
    // 03/11/2018 ainda UTC-3; 04/11 já UTC-2 (verão): fim do dia 03/11 = 04/11 02:59:59.999Z.
    const b = subscriptionBoundaries(s);
    expect(b.dueAt.toISOString()).toBe("2018-11-04T02:59:59.999Z");
    expect(b.graceEndsAt.toISOString()).toBe("2018-11-07T01:59:59.999Z"); // 06/11 23:59:59.999 em UTC-2
  });

  it("o teste NÃO usa a regra de 23:59: vence no instante exato", () => {
    const trialEndsAt = new Date("2026-10-04T10:00:00.000Z");
    const s = { status: "TRIALING" as const, trialEndsAt, currentPeriodEnd: trialEndsAt, firstPaidAt: null, cancelAtPeriodEnd: false };
    expect(subscriptionBoundaries(s).dueAt).toEqual(trialEndsAt);
    expect(effectiveStatus(s, trialEndsAt)).toBe("PAST_DUE");
  });
});

describe("usesTrialRules e teste que já virou PAST_DUE persistido", () => {
  it("TRIALING e firstPaidAt null usam a regra de teste; firstPaidAt preenchido ou ausente, não", () => {
    expect(usesTrialRules({ status: "TRIALING", firstPaidAt: undefined })).toBe(true);
    expect(usesTrialRules({ status: "PAST_DUE", firstPaidAt: null })).toBe(true);
    expect(usesTrialRules({ status: "PAST_DUE", firstPaidAt: new Date() })).toBe(false);
    expect(usesTrialRules({ status: "PAST_DUE" })).toBe(false);
  });

  it("o teste não ganha a carência de 3 dias quando o tick já persistiu PAST_DUE", () => {
    const trialEndsAt = new Date("2026-10-04T10:00:00.000Z");
    const s = { status: "PAST_DUE" as const, trialEndsAt, currentPeriodEnd: trialEndsAt, firstPaidAt: null, cancelAtPeriodEnd: false };
    expect(effectiveStatus(s, new Date(trialEndsAt.getTime() + 1 * DAY + HOUR))).toBe("SUSPENDED");
  });
});

describe("effectiveStatus — CANCELED é terminal", () => {
  it("nunca sai de CANCELED, mesmo que currentPeriodEnd esteja no futuro", () => {
    const future = new Date(Date.now() + 30 * DAY);
    const sub = { status: "CANCELED" as const, trialEndsAt: null, currentPeriodEnd: future, cancelAtPeriodEnd: false };
    expect(effectiveStatus(sub, new Date())).toBe("CANCELED");
  });
});

describe("effectiveStatus — cancelamento agendado (cancelAtPeriodEnd)", () => {
  const periodEnd = new Date("2026-11-20T12:00:00.000Z");
  const endOfDay = new Date("2026-11-21T02:59:59.999Z");
  const paid = new Date("2026-06-01T00:00:00.000Z");
  const active = { status: "ACTIVE" as const, trialEndsAt: null, currentPeriodEnd: periodEnd, firstPaidAt: paid, cancelAtPeriodEnd: true };

  it("até o fim do dia do vencimento continua ACTIVE (acesso total)", () => {
    expect(effectiveStatus(active, new Date(periodEnd.getTime() - 1))).toBe("ACTIVE");
    expect(effectiveStatus(active, periodEnd)).toBe("ACTIVE");
    expect(effectiveStatus(active, new Date(endOfDay.getTime() - 1))).toBe("ACTIVE");
  });

  it("no fim do dia do vencimento vai direto a CANCELED, sem carência nem suspensão", () => {
    expect(effectiveStatus(active, endOfDay)).toBe("CANCELED");
    expect(effectiveStatus(active, new Date(periodEnd.getTime() + 10 * DAY))).toBe("CANCELED");
  });

  it("em teste, a referência é o fim do teste (instante exato)", () => {
    const trialEnd = new Date("2026-10-04T10:00:00.000Z");
    const trial = { status: "TRIALING" as const, trialEndsAt: trialEnd, currentPeriodEnd: trialEnd, cancelAtPeriodEnd: true };
    expect(effectiveStatus(trial, new Date(trialEnd.getTime() - 1))).toBe("TRIALING");
    expect(effectiveStatus(trial, trialEnd)).toBe("CANCELED");
  });

  it("sem agendamento, o comportamento é o de sempre (carência de 3 dias de quem paga)", () => {
    expect(effectiveStatus({ ...active, cancelAtPeriodEnd: false }, endOfDay)).toBe("PAST_DUE");
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
