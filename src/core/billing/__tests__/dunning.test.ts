import { describe, expect, it } from "vitest";
import { buildSteps, currentBellStep, isNoticeStillDue, listReachedSteps, planNotices, type DunningInput, type DunningSubscription } from "../dunning";
import { isInSendWindow, nextSendableAt, retryDelayMinutes, STEP_POLICY, DUNNING_STEPS } from "../dunning-policy";
import { addDaysToLocalDate, diffLocalDates, endOfLocalDay, localDateOf, startOfLocalDay, weekdayOfLocalDate } from "../local-time";

const SP = "America/Sao_Paulo";
const paid = new Date("2026-06-01T00:00:00.000Z");

/** Pagante: vence em 28/10/2026 07:00 (SP), uma quarta-feira. Fatura criada 5 dias antes. */
function paying(overrides: Partial<DunningSubscription> = {}, input: Partial<DunningInput> = {}): DunningInput {
  return {
    timezone: SP,
    subscription: {
      id: "sub1",
      status: "ACTIVE",
      currentPeriodEnd: new Date("2026-10-28T10:00:00.000Z"),
      trialEndsAt: null,
      firstPaidAt: paid,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      cancelRequestedAt: null,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      ...overrides,
    },
    openInvoice: { id: "inv1", dueAt: new Date("2026-10-28T10:00:00.000Z"), createdAt: new Date("2026-10-23T10:00:00.000Z"), isTrialConversion: false },
    manualSuspension: false,
    whatsappConnected: true,
    ...input,
  };
}

const at = (iso: string) => new Date(iso);
const stepsOf = (input: DunningInput, now: Date) => planNotices(input, now).map((p) => `${p.step}/${p.channel}`).sort();

describe("planNotices: régua de quem paga (D-5 até o cancelamento), fuso America/Sao_Paulo", () => {
  it("D-5: fatura criada, e-mail e WhatsApp", () => {
    expect(stepsOf(paying(), at("2026-10-23T12:00:00Z"))).toEqual(["INVOICE_CREATED/EMAIL", "INVOICE_CREATED/WHATSAPP"]);
  });

  it("D-3: o sino ganha a etapa, mas nenhum aviso novo sai por e-mail ou WhatsApp", () => {
    const input = paying();
    expect(stepsOf(input, at("2026-10-25T12:00:00Z"))).toEqual(["INVOICE_CREATED/EMAIL", "INVOICE_CREATED/WHATSAPP"]);
    expect(currentBellStep(input, at("2026-10-25T12:00:00Z"))?.step).toBe("DUE_D3");
  });

  it("D-1 (terça 27/10): lembrete de véspera por e-mail e WhatsApp", () => {
    expect(stepsOf(paying(), at("2026-10-27T11:00:00Z"))).toContain("DUE_D1/EMAIL");
    expect(stepsOf(paying(), at("2026-10-27T11:00:00Z"))).toContain("DUE_D1/WHATSAPP");
  });

  it("D (quarta 28/10): 'vence hoje' vale o dia inteiro e a véspera já expirou", () => {
    const input = paying();
    const morning = stepsOf(input, at("2026-10-28T11:00:00Z"));
    expect(morning).toContain("DUE_D0/EMAIL");
    expect(morning).toContain("DUE_D0/WHATSAPP");
    expect(morning.some((s) => s.startsWith("DUE_D1"))).toBe(false);
    // 23h do dia D em São Paulo (02:00Z do dia seguinte): ainda "hoje".
    expect(stepsOf(input, at("2026-10-29T02:00:00Z"))).toContain("DUE_D0/EMAIL");
  });

  it("D+1, D+2 e D+3 (carência): GRACE_D1 (e-mail e WhatsApp), GRACE_D2 (só e-mail), GRACE_LAST (e-mail e WhatsApp)", () => {
    const input = paying({ status: "PAST_DUE" });
    const d1 = stepsOf(input, at("2026-10-29T13:00:00Z"));
    expect(d1).toEqual(["GRACE_D1/EMAIL", "GRACE_D1/WHATSAPP"]);
    expect(stepsOf(input, at("2026-10-30T13:00:00Z"))).toEqual(["GRACE_D2/EMAIL"]);
    expect(stepsOf(input, at("2026-10-31T13:00:00Z"))).toEqual(["GRACE_LAST/EMAIL", "GRACE_LAST/WHATSAPP"]);
  });

  it("antes do fim do D+3 o status efetivo ainda é PAST_DUE; no domingo 01/11 a conta está suspensa e sai o aviso de suspensão", () => {
    const input = paying({ status: "PAST_DUE" });
    expect(stepsOf(input, at("2026-11-01T02:59:59.998Z"))).toEqual(["GRACE_LAST/EMAIL", "GRACE_LAST/WHATSAPP"]);
    const sunday = stepsOf({ ...input, subscription: { ...input.subscription, status: "SUSPENDED" } }, at("2026-11-01T12:00:00Z"));
    expect(sunday).toEqual(["SUSPENDED/EMAIL", "SUSPENDED/WHATSAPP"]);
  });

  it("suspensa: S+3, S+7, S+15, S+30 e S+45 nos dias certos, com WhatsApp só em S+7 e S+30", () => {
    const input = paying({ status: "SUSPENDED" });
    // Suspensão em 01/11 (domingo). S+3 = 04/11, S+7 = 08/11, S+15 = 16/11, S+30 = 01/12, S+45 = 16/12.
    expect(stepsOf(input, at("2026-11-04T12:00:00Z"))).toContain("SUSP_3/EMAIL");
    expect(stepsOf(input, at("2026-11-04T12:00:00Z"))).not.toContain("SUSP_3/WHATSAPP");
    const s7 = stepsOf(input, at("2026-11-08T12:00:00Z"));
    expect(s7).toContain("SUSP_7/EMAIL");
    expect(s7).toContain("SUSP_7/WHATSAPP");
    expect(stepsOf(input, at("2026-11-16T12:00:00Z"))).toEqual(["SUSP_15/EMAIL"]);
    expect(stepsOf(input, at("2026-12-01T12:00:00Z"))).toEqual(["SUSP_30/EMAIL", "SUSP_30/WHATSAPP"]);
    expect(stepsOf(input, at("2026-12-16T12:00:00Z"))).toEqual(["SUSP_45/EMAIL"]);
  });

  it("C-7 (24/12) e C-1 (30/12) avisam o encerramento por e-mail e WhatsApp; o cancelamento cai em 31/12", () => {
    const input = paying({ status: "SUSPENDED" });
    expect(stepsOf(input, at("2026-12-24T12:00:00Z"))).toEqual(["CANCEL_WARN_7/EMAIL", "CANCEL_WARN_7/WHATSAPP"]);
    expect(stepsOf(input, at("2026-12-30T12:00:00Z"))).toEqual(["CANCEL_WARN_1/EMAIL", "CANCEL_WARN_1/WHATSAPP"]);
    // 31/12 23h em SP: ainda suspensa (cancela depois do fim do dia 30/12 + ...): conferido pelo status efetivo
    expect(stepsOf(input, at("2026-12-31T03:00:00Z"))).toEqual([]);
  });

  it("cada etapa usa o cycleKey do contrato da F1", () => {
    const input = paying({ status: "SUSPENDED" });
    const susp = planNotices(input, at("2026-11-01T12:00:00Z")).find((p) => p.step === "SUSPENDED");
    expect(susp?.cycleKey).toBe("sub1:2026-10-28T10:00:00.000Z");
    const invoice = planNotices(paying(), at("2026-10-23T12:00:00Z")).find((p) => p.step === "INVOICE_CREATED");
    expect(invoice?.cycleKey).toBe("inv1");
    expect(invoice?.invoiceId).toBe("inv1");
  });

  it("pagou (fatura não está mais aberta e o período avançou): nada é devido", () => {
    const input = paying({ currentPeriodEnd: new Date("2026-11-28T10:00:00.000Z") }, { openInvoice: null });
    expect(planNotices(input, at("2026-10-29T13:00:00Z"))).toEqual([]);
    expect(isNoticeStillDue(input, at("2026-10-29T13:00:00Z"), { step: "GRACE_D1", channel: "EMAIL", cycleKey: "inv1" })).toBe(false);
  });

  it("assinatura sem fatura aberta e ainda em dia não gera aviso de fatura", () => {
    expect(planNotices(paying({}, { openInvoice: null }), at("2026-10-27T12:00:00Z"))).toEqual([]);
  });

  it("suspensão manual do admin não dispara cobrança", () => {
    const input = paying({ status: "SUSPENDED" }, { manualSuspension: true });
    expect(planNotices(input, at("2026-11-01T12:00:00Z"))).toEqual([]);
    expect(planNotices(input, at("2026-11-08T12:00:00Z"))).toEqual([]);
  });

  it("cancelamento agendado pelo dono: nenhuma cobrança", () => {
    const input = paying({ cancelAtPeriodEnd: true });
    expect(planNotices(input, at("2026-10-27T12:00:00Z"))).toEqual([]);
  });

  it("a fatura do teste não entra na régua de quem paga", () => {
    const input = paying({ firstPaidAt: paid }, { openInvoice: { id: "t", dueAt: at("2026-10-28T10:00:00Z"), createdAt: at("2026-10-23T10:00:00Z"), isTrialConversion: true } });
    expect(planNotices(input, at("2026-10-27T12:00:00Z"))).toEqual([]);
  });
});

describe("planNotices: fuso, virada de dia e horário de verão", () => {
  it("o dia D é o dia LOCAL: vencendo 23h de 27/10 em São Paulo, 'vence hoje' é dia 27 (e dia 28 em UTC)", () => {
    const periodEnd = at("2026-10-28T02:00:00Z"); // 27/10 23:00 SP
    const sp = paying({ currentPeriodEnd: periodEnd }, { openInvoice: { id: "i", dueAt: periodEnd, createdAt: at("2026-10-22T10:00:00Z"), isTrialConversion: false } });
    const utc = { ...sp, timezone: "UTC" };
    const now = at("2026-10-27T11:00:00Z"); // 08:00 SP do dia 27, 11:00 UTC do dia 27
    expect(stepsOf(sp, now)).toContain("DUE_D0/EMAIL");
    expect(stepsOf(utc, now)).toContain("DUE_D1/EMAIL");
    expect(stepsOf(utc, now)).not.toContain("DUE_D0/EMAIL");
  });

  it("horário de verão (Nova York, domingo 08/03/2026 tem 23 h): a janela do dia local não escorrega", () => {
    const periodEnd = at("2026-03-06T15:00:00Z");
    const input = paying(
      { currentPeriodEnd: periodEnd, status: "PAST_DUE" },
      { timezone: "America/New_York", openInvoice: { id: "i", dueAt: periodEnd, createdAt: at("2026-03-01T15:00:00Z"), isTrialConversion: false } },
    );
    const d2 = buildSteps(input, at("2026-03-08T16:00:00Z")).find((s) => s.step === "GRACE_D2");
    expect(d2?.at.toISOString()).toBe("2026-03-08T05:00:00.000Z"); // 00:00 EST
    expect(d2?.expiresAt.toISOString()).toBe("2026-03-09T03:59:59.999Z"); // 23:59:59.999 EDT
    expect(stepsOf(input, at("2026-03-08T16:00:00Z"))).toEqual(["GRACE_D2/EMAIL"]);
    // D+3 começa logo depois, sem buraco nem sobreposição.
    const last = buildSteps(input, at("2026-03-09T16:00:00Z")).find((s) => s.step === "GRACE_LAST");
    expect(last?.at.toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  it("horário de verão antigo de São Paulo (00:00 de 04/11/2018 não existia): o dia local começa à 01:00 e o conjunto continua sem buraco", () => {
    const start = startOfLocalDay("2018-11-04", SP);
    expect(start.toISOString()).toBe("2018-11-04T03:00:00.000Z"); // 01:00 em UTC-2
    expect(localDateOf(start, SP)).toBe("2018-11-04");
    expect(localDateOf(new Date(start.getTime() - 1), SP)).toBe("2018-11-03");
    expect(endOfLocalDay("2018-11-03", SP).getTime()).toBeLessThan(start.getTime());
  });

  it("aritmética de datas locais: virada de mês, de ano e ano bissexto", () => {
    expect(addDaysToLocalDate("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysToLocalDate("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDaysToLocalDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(diffLocalDates("2026-10-28", "2026-12-31")).toBe(64);
    expect(weekdayOfLocalDate("2026-11-01")).toBe(0);
    expect(localDateOf(at("2026-10-28T02:30:00Z"), SP)).toBe("2026-10-27");
  });
});

describe("planNotices: sequência de conversão do teste grátis (§2.3.1)", () => {
  // Cadastro quinta 01/10 12:00 SP, fim do teste domingo 04/10 12:00 SP.
  const trial = (overrides: Partial<DunningSubscription> = {}, input: Partial<DunningInput> = {}): DunningInput => ({
    timezone: SP,
    subscription: {
      id: "sub1",
      status: "TRIALING",
      currentPeriodEnd: at("2026-10-04T15:00:00Z"),
      trialEndsAt: at("2026-10-04T15:00:00Z"),
      firstPaidAt: null,
      cancelAtPeriodEnd: false,
      canceledAt: null,
      cancelRequestedAt: null,
      createdAt: at("2026-10-01T15:00:00Z"),
      ...overrides,
    },
    openInvoice: { id: "tinv", dueAt: at("2026-10-04T15:00:00Z"), createdAt: at("2026-10-01T15:00:00Z"), isTrialConversion: true },
    manualSuspension: false,
    whatsappConnected: true,
    ...input,
  });

  it("no dia do cadastro só a fatura gerada (e-mail, fora do sino) é devida: o cadastro a envia na hora e, se o SMTP falhar, a régua reenvia", () => {
    expect(stepsOf(trial(), at("2026-10-01T18:00:00Z"))).toEqual(["INVOICE_CREATED/EMAIL"]);
    expect(currentBellStep(trial(), at("2026-10-01T18:00:00Z"))).toBeNull();
    expect(planNotices(trial({}, { openInvoice: null }), at("2026-10-01T18:00:00Z"))).toEqual([]);
  });

  it("dia seguinte ao cadastro: resumo do 1º dia por e-mail e WhatsApp (só se conectou)", () => {
    expect(stepsOf(trial(), at("2026-10-02T12:00:00Z"))).toEqual(["INVOICE_CREATED/EMAIL", "TRIAL_DAY1/EMAIL", "TRIAL_DAY1/WHATSAPP"]);
    expect(stepsOf(trial({}, { whatsappConnected: false }), at("2026-10-02T12:00:00Z"))).toEqual(["INVOICE_CREATED/EMAIL", "TRIAL_DAY1/EMAIL"]);
  });

  it("véspera do fim (sábado 03/10) e dia do fim (domingo 04/10, até 12:00)", () => {
    expect(stepsOf(trial(), at("2026-10-03T12:00:00Z"))).toEqual(["INVOICE_CREATED/EMAIL", "TRIAL_T1/EMAIL", "TRIAL_T1/WHATSAPP"]);
    expect(stepsOf(trial(), at("2026-10-04T12:00:00Z"))).toEqual(["INVOICE_CREATED/EMAIL", "TRIAL_T0/EMAIL", "TRIAL_T0/WHATSAPP"]);
    // depois do fim do teste, o aviso 'termina hoje' (e a fatura gerada) já não valem
    expect(stepsOf(trial(), at("2026-10-04T15:30:00Z"))).toEqual([]);
  });

  it("o cycleKey do teste é <subscriptionId>:trial", () => {
    const p = planNotices(trial(), at("2026-10-03T12:00:00Z")).find((n) => n.step === "TRIAL_T1");
    expect(p?.cycleKey).toBe("sub1:trial");
    expect(p?.invoiceId).toBeNull();
    // A fatura gerada do cadastro usa o id da fatura (mesma chave do backfill LEGACY_SENT).
    expect(planNotices(trial(), at("2026-10-03T12:00:00Z")).find((n) => n.step === "INVOICE_CREATED")?.cycleKey).toBe("tinv");
  });

  it("teste suspenso (05/10): aviso de suspensão, depois TRIAL_SUSP_3 e o alerta de cancelamento 2 dias antes", () => {
    const input = trial({ status: "SUSPENDED" });
    expect(stepsOf(input, at("2026-10-05T16:00:00Z"))).toEqual(["SUSPENDED/EMAIL", "SUSPENDED/WHATSAPP"]);
    expect(stepsOf(input, at("2026-10-08T12:00:00Z"))).toContain("TRIAL_SUSP_3/EMAIL");
    expect(stepsOf(input, at("2026-10-08T12:00:00Z"))).not.toContain("TRIAL_SUSP_3/WHATSAPP");
    const warn = stepsOf(input, at("2026-10-10T12:00:00Z"));
    expect(warn).toContain("TRIAL_CANCEL_WARN/EMAIL");
    expect(warn).toContain("TRIAL_CANCEL_WARN/WHATSAPP");
    // O teste nunca recebe a sequência de ex-pagante.
    expect(DUNNING_STEPS.filter((s) => s.startsWith("SUSP_")).some((s) => stepsOf(input, at("2026-10-08T12:00:00Z")).some((p) => p.startsWith(s)))).toBe(false);
  });

  it("pagou no meio (firstPaidAt preenchido, ACTIVE): a sequência do teste para", () => {
    const input = trial({ status: "ACTIVE", firstPaidAt: at("2026-10-03T13:00:00Z"), trialEndsAt: null, currentPeriodEnd: at("2026-11-03T13:00:00Z") }, { openInvoice: null });
    expect(planNotices(input, at("2026-10-03T14:00:00Z"))).toEqual([]);
  });

  it("teste de 1 dia só (sem espaço para o resumo do 1º dia): não inventa a etapa", () => {
    const input = trial({ trialEndsAt: at("2026-10-02T15:00:00Z"), currentPeriodEnd: at("2026-10-02T15:00:00Z") });
    const steps = buildSteps(input, at("2026-10-01T16:00:00Z")).map((s) => s.step);
    expect(steps).not.toContain("TRIAL_DAY1");
    expect(steps).toContain("TRIAL_T0");
  });
});

describe("planNotices: cancelamento", () => {
  const canceled = (overrides: Partial<DunningSubscription> = {}, input: Partial<DunningInput> = {}): DunningInput =>
    paying({ status: "CANCELED", canceledAt: at("2026-12-31T03:00:00Z"), ...overrides }, { openInvoice: null, ...input });

  it("cancelamento automático: aviso por e-mail e WhatsApp por 3 dias", () => {
    expect(stepsOf(canceled(), at("2026-12-31T12:00:00Z"))).toEqual(["AUTO_CANCELED/EMAIL", "AUTO_CANCELED/WHATSAPP"]);
    expect(stepsOf(canceled(), at("2027-01-05T12:00:00Z"))).toEqual([]);
  });

  it("cancelamento pedido pelo dono ou agendado não gera aviso automático", () => {
    expect(planNotices(canceled({ cancelRequestedAt: at("2026-12-31T02:00:00Z") }), at("2026-12-31T12:00:00Z"))).toEqual([]);
    expect(planNotices(canceled({ cancelAtPeriodEnd: true }), at("2026-12-31T12:00:00Z"))).toEqual([]);
  });

  it("fatura de reativação: só os lembretes por e-mail, nunca WhatsApp", () => {
    const input = canceled({}, { openInvoice: { id: "re", dueAt: at("2027-01-03T15:00:00Z"), createdAt: at("2027-01-01T12:00:00Z"), isTrialConversion: false } });
    expect(stepsOf(input, at("2027-01-02T12:00:00Z"))).toEqual(["DUE_D1/EMAIL"]);
    expect(stepsOf(input, at("2027-01-03T12:00:00Z"))).toEqual(["DUE_D0/EMAIL"]);
  });

  it("fatura antiga que sobrou aberta numa conta cancelada não cobra", () => {
    const input = canceled({}, { openInvoice: { id: "old", dueAt: at("2026-12-01T15:00:00Z"), createdAt: at("2026-11-25T12:00:00Z"), isTrialConversion: false } });
    expect(planNotices(input, at("2026-11-30T12:00:00Z"))).toEqual([]);
  });
});

describe("sino: etapa atual da régua", () => {
  it("avança D-5 -> D-3 -> D-1 -> D -> D+1 -> suspensão e nunca mostra duas ao mesmo tempo", () => {
    const base = paying();
    const seq: Array<[string, string]> = [
      ["2026-10-23T12:00:00Z", "INVOICE_CREATED"],
      ["2026-10-25T12:00:00Z", "DUE_D3"],
      ["2026-10-27T12:00:00Z", "DUE_D1"],
      ["2026-10-28T12:00:00Z", "DUE_D0"],
    ];
    for (const [iso, step] of seq) expect(currentBellStep(base, at(iso))?.step).toBe(step);
    expect(currentBellStep(paying({ status: "PAST_DUE" }), at("2026-10-29T12:00:00Z"))?.step).toBe("GRACE_D1");
    expect(currentBellStep(paying({ status: "SUSPENDED" }), at("2026-11-02T12:00:00Z"))?.step).toBe("SUSPENDED");
    expect(currentBellStep(paying({ status: "SUSPENDED" }), at("2026-11-10T12:00:00Z"))?.step).toBe("SUSP_7");
  });

  it("depois de listar as etapas alcançadas, a ordem é cronológica", () => {
    const reached = listReachedSteps(paying({ status: "PAST_DUE" }), at("2026-10-30T12:00:00Z")).map((s) => s.step);
    expect(reached).toEqual(["INVOICE_CREATED", "DUE_D3", "DUE_D1", "DUE_D0", "GRACE_D1", "GRACE_D2"]);
  });
});

describe("política: janela de envio, domingo e espera entre tentativas", () => {
  it("e-mail: 08h às 20h todo dia; fora disso espera a próxima abertura", () => {
    expect(nextSendableAt("EMAIL", "DUE_D1", at("2026-10-27T10:00:00Z"), SP).toISOString()).toBe("2026-10-27T11:00:00.000Z"); // 07:00 -> 08:00
    expect(nextSendableAt("EMAIL", "DUE_D1", at("2026-10-27T15:00:00Z"), SP).toISOString()).toBe("2026-10-27T15:00:00.000Z");
    expect(nextSendableAt("EMAIL", "DUE_D1", at("2026-10-27T23:00:00Z"), SP).toISOString()).toBe("2026-10-28T11:00:00.000Z"); // 20:00 já fecha
  });

  it("WhatsApp: 09h às 19h, segunda a sábado; 19:00 em ponto já está fora", () => {
    expect(isInSendWindow("WHATSAPP", "DUE_D1", at("2026-10-27T12:00:00Z"), SP)).toBe(true); // 09:00 terça
    expect(isInSendWindow("WHATSAPP", "DUE_D1", at("2026-10-27T11:59:00Z"), SP)).toBe(false); // 08:59
    expect(isInSendWindow("WHATSAPP", "DUE_D1", at("2026-10-27T21:59:00Z"), SP)).toBe(true); // 18:59
    expect(isInSendWindow("WHATSAPP", "DUE_D1", at("2026-10-27T22:00:00Z"), SP)).toBe(false); // 19:00
  });

  it("WhatsApp no domingo: só suspensão e cancelamento; as demais etapas vão para segunda 09h", () => {
    const sunday = at("2026-11-01T15:00:00Z"); // domingo 12:00
    expect(isInSendWindow("WHATSAPP", "SUSPENDED", sunday, SP)).toBe(true);
    expect(isInSendWindow("WHATSAPP", "CANCEL_WARN_1", sunday, SP)).toBe(true);
    expect(isInSendWindow("WHATSAPP", "AUTO_CANCELED", sunday, SP)).toBe(true);
    expect(isInSendWindow("WHATSAPP", "DUE_D0", sunday, SP)).toBe(false);
    expect(nextSendableAt("WHATSAPP", "DUE_D0", sunday, SP).toISOString()).toBe("2026-11-02T12:00:00.000Z");
    expect(isInSendWindow("EMAIL", "DUE_D0", sunday, SP)).toBe(true);
  });

  it("pagamento confirmado ignora a janela", () => {
    expect(isInSendWindow("WHATSAPP", "PAYMENT_CONFIRMED", at("2026-11-01T05:00:00Z"), SP)).toBe(true);
  });

  it("espera crescente: 5 min, 30 min, 2 h, 6 h", () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelayMinutes)).toEqual([5, 30, 120, 360, 360, 360]);
  });

  it("toda etapa tem política e as críticas chamam o OWNER", () => {
    for (const step of DUNNING_STEPS) expect(STEP_POLICY[step]).toBeDefined();
    expect(STEP_POLICY.DUE_D0.critical).toBe(true);
    expect(STEP_POLICY.DUE_D1.critical).toBe(false);
  });
});
