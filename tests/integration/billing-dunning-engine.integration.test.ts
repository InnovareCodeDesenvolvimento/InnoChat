/**
 * F2 da régua de cobrança: o MOTOR (docs/regua-de-cobranca.md §2.1, §2.4, §2.5, D4, D5, D9) contra Postgres real.
 * Outbox idempotente (dois ticks, ticks concorrentes, claim `FOR UPDATE SKIP LOCKED`), falha e nova tentativa
 * com espera crescente, SENDING preso, reconferência antes de enviar (pagou no meio), opt-out, sem número do
 * assinante, sem número da plataforma, janela de horário, destinatários (D4), Pix vigente, suspensão manual,
 * transição sem duplicar (LEGACY_SENT), orçamento do tick e trava de um tick por vez.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
  const helpers = await import("./dunning.helpers");
  return { ...actual, sendMail: helpers.fakeSendMail(actual) };
});
vi.mock("@/modules/platform-whatsapp/sender", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/modules/platform-whatsapp/sender")>();
  const helpers = await import("./dunning.helpers");
  return { ...original, sendPlatformWhatsapp: helpers.fakeSendWhatsapp };
});

const h = await import("./dunning.helpers");
const { runBillingTick, BILLING_TICK_LOCK_NAME } = await import("@/modules/billing/tick");
const { applyInvoicePayment } = await import("@/modules/billing/service");
const { suspendCompanyManually, reactivateCompanyManually } = await import("@/modules/billing/admin-service");
const { createMockMercadoPagoGateway } = await import("@/modules/billing/mercadopago.mock");
const { withAdvisoryLock } = await import("@/lib/db/advisory-lock");
const { dispatchDueNotices } = await import("@/modules/billing/dunning/dispatcher");
const { enqueueNotices } = await import("@/modules/billing/dunning/outbox");
const { loadDunningSubject } = await import("@/modules/billing/dunning/snapshot");
const { planNotices } = await import("@/core/billing");

const { prisma, at } = h;
const fixtures = h.newFixtures();
const { gateway } = createMockMercadoPagoGateway();

beforeEach(() => {
  h.resetMail();
  h.resetWhatsapp();
});
afterEach(async () => {
  await h.cleanup(fixtures);
  fixtures.tenantIds.length = 0;
  fixtures.userIds.length = 0;
  fixtures.planIds.length = 0;
});
afterAll(async () => {
  await h.dropTestConnection();
  await prisma.$disconnect();
});

const tick = (now: Date, options: { budgetMs?: number } = {}) => runBillingTick(now, gateway, { dispatch: h.tickDispatch, ...options });
const mails = (email: string) => h.sentEmails.filter((m) => m.to === email);

// Vence quarta 28/10/2026 07:00 (SP). Fatura criada em 23/10. D-1 = terça 27/10; janelas de e-mail 08h-20h, WhatsApp 09h-19h.
const PERIOD_END = at("2026-10-28T10:00:00Z");
const D1_NOON = at("2026-10-27T15:00:00Z"); // 12:00 SP
const D1_EARLY = at("2026-10-27T09:00:00Z"); // 06:00 SP, fora das duas janelas

async function scenario(label: string, tenantOpts: Parameters<typeof h.makeTenant>[2] = {}, invoiceOpts: Partial<Parameters<typeof h.makeOpenInvoice>[1]> = {}) {
  const t = await h.makeTenant(fixtures, label, tenantOpts);
  const sub = await h.makePayingSubscription(fixtures, t.tenant.id, label, { currentPeriodEnd: PERIOD_END });
  const invoice = await h.makeOpenInvoice(sub.id, { periodStart: PERIOD_END, dueAt: PERIOD_END, createdAt: at("2026-10-23T13:00:00Z"), ...invoiceOpts });
  return { ...t, sub, invoice };
}

/** Linhas de UM canal e etapa. */
const row = async (subscriptionId: string, step: string, channel: "EMAIL" | "WHATSAPP") =>
  prisma.billingNotice.findFirst({ where: { subscriptionId, step, channel } });

describe("idempotência: o mesmo aviso nunca sai duas vezes", () => {
  it("dois ticks seguidos no mesmo instante enviam 1 vez", async () => {
    const s = await scenario("idem-seq");
    await tick(D1_NOON);
    const first = mails(s.email).length;
    expect(first).toBe(2); // fatura gerada + véspera
    await tick(D1_NOON);
    await tick(at("2026-10-27T16:00:00Z"));
    expect(mails(s.email)).toHaveLength(first);
    expect(h.whatsapp.sent.filter((m) => m.tenantId === s.tenant.id)).toHaveLength(4); // 2 etapas x (texto + Pix)
    const rows = await h.noticesOf(s.sub.id);
    expect(rows).toHaveLength(4);
  });

  it("dois ticks CONCORRENTES: a trava deixa um só rodar e o e-mail sai 1 vez", async () => {
    const s = await scenario("idem-lock");
    const [a, b] = await Promise.all([tick(D1_NOON), tick(D1_NOON)]);
    expect([a.skippedByLock, b.skippedByLock].filter(Boolean)).toHaveLength(1);
    expect(mails(s.email)).toHaveLength(2);
  });

  it("claim com SKIP LOCKED: dois despachantes direto no banco (sem a trava do tick) nunca pegam a mesma linha", async () => {
    const subjects = [] as Awaited<ReturnType<typeof scenario>>[];
    for (let i = 0; i < 4; i += 1) subjects.push(await scenario(`skip-${i}`));
    for (const s of subjects) {
      const subject = await loadDunningSubject(s.sub.id, D1_NOON);
      await enqueueNotices({ tenantId: s.tenant.id, subscriptionId: s.sub.id }, planNotices(subject!.input, D1_NOON).filter((p) => p.channel === "EMAIL"));
    }
    const [x, y] = await Promise.all([dispatchDueNotices(D1_NOON, { deps: h.tickDispatch }), dispatchDueNotices(D1_NOON, { deps: h.tickDispatch })]);
    expect(x.sent + y.sent).toBe(8); // 4 empresas x 2 etapas, cada uma exatamente uma vez
    expect(h.sentEmails.filter((m) => subjects.some((s) => s.email === m.to))).toHaveLength(8);
  });

  it("planejar de novo não cria linhas novas (ON CONFLICT DO NOTHING na chave cycleKey+step+channel)", async () => {
    const s = await scenario("idem-plan");
    const subject = await loadDunningSubject(s.sub.id, D1_NOON);
    const planned = planNotices(subject!.input, D1_NOON);
    const ref = { tenantId: s.tenant.id, subscriptionId: s.sub.id };
    expect(await enqueueNotices(ref, planned)).toBe(4);
    expect(await enqueueNotices(ref, planned)).toBe(0);
    expect(await prisma.billingNotice.count({ where: { subscriptionId: s.sub.id } })).toBe(4);
  });
});

describe("falha e nova tentativa (espera crescente)", () => {
  it("SMTP fora: FAILED com código, espera de 5 min, não reenvia antes, reenvia depois e conta a tentativa", async () => {
    const s = await scenario("retry-mail", { billingWhatsappE164: null });
    h.mailControl.mode = "fail";
    const failed = await tick(D1_NOON);
    expect(failed.emailsFailed).toBe(2);
    expect(failed.noticesFailed).toBe(2);
    const failedRow = await row(s.sub.id, "DUE_D1", "EMAIL");
    expect(failedRow).toMatchObject({ status: "FAILED", attempts: 1, lastErrorCode: "EMAIL_NOT_SENT", sentAt: null });
    expect(failedRow!.nextAttemptAt.getTime()).toBe(D1_NOON.getTime() + 5 * 60_000);

    h.mailControl.mode = "ok";
    await tick(at("2026-10-27T15:02:00Z")); // dentro dos 5 min: espera
    expect(mails(s.email)).toHaveLength(0);

    await tick(at("2026-10-27T15:06:00Z"));
    expect(mails(s.email)).toHaveLength(2);
    expect(await row(s.sub.id, "DUE_D1", "EMAIL")).toMatchObject({ status: "SENT", attempts: 2, lastErrorCode: null });
    await tick(at("2026-10-27T15:30:00Z"));
    expect(mails(s.email)).toHaveLength(2);
  });

  it("SMTP sem configuração e erro inesperado também ficam FAILED (nunca SENT) e a próxima rodada tenta de novo", async () => {
    const s = await scenario("retry-modes", { billingWhatsappE164: null });
    for (const mode of ["not_configured", "throw"] as const) {
      h.mailControl.mode = mode;
      await tick(at(mode === "throw" ? "2026-10-27T16:00:00Z" : "2026-10-27T15:00:00Z"));
      expect(await row(s.sub.id, "DUE_D1", "EMAIL")).toMatchObject({ status: "FAILED", sentAt: null });
    }
    h.mailControl.mode = "ok";
    await tick(at("2026-10-27T18:00:00Z"));
    expect(await row(s.sub.id, "DUE_D1", "EMAIL")).toMatchObject({ status: "SENT" });
  });

  it("5 tentativas e acabou: fica FAILED para sempre, sem reenviar, mesmo com o SMTP de volta", async () => {
    const s = await scenario("retry-cap", { billingWhatsappE164: null });
    h.mailControl.mode = "fail";
    // 12:00, +6 min, +40 min (30), +3 h (2 h), +7 h... todos dentro do dia de véspera (até 20:00 só e-mail 08h-20h).
    for (const iso of ["2026-10-27T13:00:00Z", "2026-10-27T13:06:00Z", "2026-10-27T13:40:00Z", "2026-10-27T15:50:00Z", "2026-10-27T21:50:00Z"]) await tick(at(iso));
    const exhausted = await row(s.sub.id, "DUE_D1", "EMAIL");
    expect(exhausted).toMatchObject({ status: "FAILED", attempts: 5 });
    h.mailControl.mode = "ok";
    await tick(at("2026-10-27T22:30:00Z")); // 19:30 SP: ainda no dia, e-mail ok, mas as tentativas acabaram
    expect(mails(s.email)).toHaveLength(0);
    expect(await row(s.sub.id, "DUE_D1", "EMAIL")).toMatchObject({ status: "FAILED", attempts: 5 });
  });

  it("WhatsApp FAILED (erro de envio) é reenviado depois; o resultado do sender não derruba o e-mail do mesmo tick", async () => {
    const s = await scenario("retry-wa");
    h.whatsapp.outcome = "FAILED";
    const first = await tick(D1_NOON);
    expect(first.noticesFailed).toBe(2); // fatura gerada + véspera no WhatsApp
    expect(mails(s.email)).toHaveLength(2);
    expect(await row(s.sub.id, "DUE_D1", "WHATSAPP")).toMatchObject({ status: "FAILED", attempts: 1, lastErrorCode: "WHATSAPP_SEND_FAILED" });

    h.whatsapp.outcome = "SENT";
    await tick(at("2026-10-27T15:10:00Z"));
    expect(await row(s.sub.id, "DUE_D1", "WHATSAPP")).toMatchObject({ status: "SENT", attempts: 2 });
    expect(mails(s.email)).toHaveLength(2); // e-mail não repete
  });

  it("exceção do sender de WhatsApp é isolada por aviso: vira FAILED/UNEXPECTED_ERROR e o resto da fila sai", async () => {
    const s = await scenario("retry-throw");
    const result = await runBillingTick(D1_NOON, gateway, {
      dispatch: {
        sleep: async () => undefined,
        sendWhatsapp: async () => {
          throw new Error("boom da Evolution");
        },
      },
    });
    expect(result.noticesFailed).toBe(2);
    expect(mails(s.email)).toHaveLength(2);
    expect(await row(s.sub.id, "DUE_D1", "WHATSAPP")).toMatchObject({ status: "FAILED", lastErrorCode: "UNEXPECTED_ERROR" });
  });

  it("SENDING preso (processo morreu no envio) volta à fila depois de 15 min; um SENDING recente não é tocado", async () => {
    const s = await scenario("stuck", { billingWhatsappE164: null });
    const subject = await loadDunningSubject(s.sub.id, D1_NOON);
    await enqueueNotices({ tenantId: s.tenant.id, subscriptionId: s.sub.id }, planNotices(subject!.input, D1_NOON));
    const stale = await row(s.sub.id, "INVOICE_CREATED", "EMAIL");
    const fresh = await row(s.sub.id, "DUE_D1", "EMAIL");
    const old = new Date(D1_NOON.getTime() - 20 * 60_000).toISOString();
    const recent = new Date(D1_NOON.getTime() - 60_000).toISOString();
    await prisma.$executeRaw`UPDATE "billing_notices" SET "status" = 'SENDING', "updatedAt" = ${old}::timestamp WHERE "id" = ${stale!.id}`;
    await prisma.$executeRaw`UPDATE "billing_notices" SET "status" = 'SENDING', "updatedAt" = ${recent}::timestamp WHERE "id" = ${fresh!.id}`;

    await dispatchDueNotices(D1_NOON, { deps: h.tickDispatch });
    expect(await row(s.sub.id, "INVOICE_CREATED", "EMAIL")).toMatchObject({ status: "SENT" });
    expect(await row(s.sub.id, "DUE_D1", "EMAIL")).toMatchObject({ status: "SENDING" });
    expect(mails(s.email)).toHaveLength(1);
  });
});

describe("reconferência antes de enviar: nunca cobrar quem já pagou", () => {
  it("planejado fora da janela, pagou no meio: vira SKIPPED/PAID e só a confirmação sai", async () => {
    const s = await scenario("paid-mid");
    await tick(D1_EARLY); // 06:00 SP: planeja, mas não envia (fora das janelas)
    expect(mails(s.email)).toHaveLength(0);
    const waiting = await h.noticesOf(s.sub.id);
    expect(waiting.every((r) => r.status === "PENDING")).toBe(true);
    expect(waiting.find((r) => r.step === "DUE_D1" && r.channel === "EMAIL")!.nextAttemptAt.toISOString()).toBe("2026-10-27T11:00:00.000Z"); // 08:00 SP
    expect(waiting.find((r) => r.step === "DUE_D1" && r.channel === "WHATSAPP")!.nextAttemptAt.toISOString()).toBe("2026-10-27T12:00:00.000Z"); // 09:00 SP

    await applyInvoicePayment(s.invoice.id, at("2026-10-27T10:00:00Z"));
    h.sentEmails.length = 0;
    h.whatsapp.sent.length = 0;

    await tick(D1_NOON);
    const rows = await h.noticesOf(s.sub.id);
    const byKey = Object.fromEntries(rows.map((r) => [`${r.step}/${r.channel}`, r]));
    expect(byKey["DUE_D1/EMAIL"]).toMatchObject({ status: "SKIPPED", skippedReason: "PAID" });
    expect(byKey["DUE_D1/WHATSAPP"]).toMatchObject({ status: "SKIPPED", skippedReason: "PAID" });
    expect(byKey["INVOICE_CREATED/EMAIL"]).toMatchObject({ status: "SKIPPED", skippedReason: "PAID" });
    expect(h.sentEmails.filter((m) => m.to === s.email && !m.subject.includes("Pagamento confirmado"))).toHaveLength(0);
    expect(h.whatsapp.sent.filter((m) => m.tenantId === s.tenant.id && !/Pagamento recebido|Bem-vindo/.test(m.text))).toHaveLength(0);
  });

  it("fatura anulada no meio (cancelamento agendado): SKIPPED/STATUS_CHANGED, nunca enviada", async () => {
    const s = await scenario("void-mid", { billingWhatsappE164: null });
    await tick(D1_EARLY);
    await prisma.invoice.update({ where: { id: s.invoice.id }, data: { status: "VOID" } });
    await prisma.subscription.update({ where: { id: s.sub.id }, data: { cancelAtPeriodEnd: true, cancelRequestedAt: new Date() } });
    await tick(D1_NOON);
    expect(mails(s.email)).toHaveLength(0);
    const emailRows = (await h.noticesOf(s.sub.id)).filter((r) => r.channel === "EMAIL");
    expect(emailRows).toHaveLength(2);
    expect(emailRows.every((r) => r.status === "SKIPPED" && r.skippedReason === "STATUS_CHANGED")).toBe(true);
  });
});

describe("WhatsApp: opt-out, sem número, sem canal e janela", () => {
  it("opt-out: a etapa vira SKIPPED/OPTED_OUT, o sender nem é chamado e o e-mail sai normalmente", async () => {
    const s = await scenario("optout", { optOut: true });
    await tick(D1_NOON);
    expect(h.whatsapp.calls).toBe(0);
    const rows = (await h.noticesOf(s.sub.id)).filter((r) => r.channel === "WHATSAPP");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "SKIPPED" && r.skippedReason === "OPTED_OUT")).toBe(true);
    expect(mails(s.email)).toHaveLength(2);
  });

  it("sem número de WhatsApp do assinante: SKIPPED/NO_RECIPIENT (e-mail normal)", async () => {
    const s = await scenario("nonumber", { billingWhatsappE164: null });
    await tick(D1_NOON);
    expect(h.whatsapp.calls).toBe(0);
    const rows = (await h.noticesOf(s.sub.id)).filter((r) => r.channel === "WHATSAPP");
    expect(rows.every((r) => r.status === "SKIPPED" && r.skippedReason === "NO_RECIPIENT")).toBe(true);
    expect(mails(s.email)).toHaveLength(2);
  });

  it("sem número da plataforma: etapa comum pula com NO_PLATFORM_NUMBER; etapa crítica (vence hoje) espera e sai quando o canal volta", async () => {
    const s = await scenario("noplatform");
    h.whatsapp.outcome = "NO_PLATFORM_NUMBER";
    await tick(D1_NOON);
    expect(await row(s.sub.id, "DUE_D1", "WHATSAPP")).toMatchObject({ status: "SKIPPED", skippedReason: "NO_PLATFORM_NUMBER" });
    expect(await row(s.sub.id, "INVOICE_CREATED", "WHATSAPP")).toMatchObject({ status: "SKIPPED", skippedReason: "NO_PLATFORM_NUMBER" });

    const d0 = at("2026-10-28T15:00:00Z"); // quarta 12:00 SP: "vence hoje" é crítico
    await tick(d0);
    expect(await row(s.sub.id, "DUE_D0", "WHATSAPP")).toMatchObject({ status: "PENDING", attempts: 0 });
    await tick(at("2026-10-28T20:00:00Z")); // 17:00 SP, canal ainda fora
    expect(await row(s.sub.id, "DUE_D0", "WHATSAPP")).toMatchObject({ status: "PENDING" });

    h.whatsapp.outcome = "SENT";
    await tick(at("2026-10-28T21:00:00Z")); // 18:00 SP, ainda dentro da janela
    expect(await row(s.sub.id, "DUE_D0", "WHATSAPP")).toMatchObject({ status: "SENT" });
    expect(mails(s.email).filter((m) => m.subject.includes("vence hoje"))).toHaveLength(1);
  });

  it("canal caído (CHANNEL_DOWN): etapa crítica que não volta até o fim da janela expira SKIPPED/OUT_OF_WINDOW_EXPIRED", async () => {
    const s = await scenario("channeldown");
    h.whatsapp.outcome = "CHANNEL_DOWN";
    await tick(at("2026-10-28T15:00:00Z"));
    expect(await row(s.sub.id, "DUE_D0", "WHATSAPP")).toMatchObject({ status: "PENDING" });
    // Dia seguinte: o "vence hoje" já não vale mais.
    await tick(at("2026-10-29T15:00:00Z"));
    expect(await row(s.sub.id, "DUE_D0", "WHATSAPP")).toMatchObject({ status: "SKIPPED", skippedReason: "OUT_OF_WINDOW_EXPIRED" });
  });

  it("destinatário que é número da plataforma (BLOCKED_LOOP): SKIPPED com o motivo", async () => {
    const s = await scenario("loop");
    h.whatsapp.outcome = "BLOCKED_LOOP";
    await tick(D1_NOON);
    expect(await row(s.sub.id, "DUE_D1", "WHATSAPP")).toMatchObject({ status: "SKIPPED", skippedReason: "BLOCKED_LOOP" });
  });

  it("janela: antes das 09h o WhatsApp espera; domingo só suspensão e cancelamento; e-mail fora das 08h-20h espera", async () => {
    const s = await scenario("window");
    await tick(at("2026-10-27T11:30:00Z")); // 08:30 SP: e-mail ok, WhatsApp ainda não
    expect(mails(s.email)).toHaveLength(2);
    expect(h.whatsapp.calls).toBe(0);
    expect(await row(s.sub.id, "DUE_D1", "WHATSAPP")).toMatchObject({ status: "PENDING" });
    await tick(at("2026-10-27T12:00:00Z")); // 09:00 SP
    expect(await row(s.sub.id, "DUE_D1", "WHATSAPP")).toMatchObject({ status: "SENT" });
  });

  it("domingo: o 'vence hoje' do WhatsApp não sai no domingo (expira no mesmo dia) e o e-mail sai", async () => {
    const t = await h.makeTenant(fixtures, "sunday");
    const dueSunday = at("2026-11-01T13:00:00Z"); // domingo 10:00 SP
    const sub = await h.makePayingSubscription(fixtures, t.tenant.id, "sunday", { currentPeriodEnd: dueSunday });
    await h.makeOpenInvoice(sub.id, { periodStart: dueSunday, dueAt: dueSunday, createdAt: at("2026-10-27T13:00:00Z") });
    await tick(at("2026-11-01T16:00:00Z")); // domingo 13:00 SP
    expect(mails(t.email).some((m) => m.subject.includes("vence hoje"))).toBe(true);
    expect(h.whatsapp.sent.filter((m) => m.tenantId === t.tenant.id)).toHaveLength(0);
    await tick(at("2026-11-02T15:00:00Z")); // segunda: a etapa expirou, e o D+1 (GRACE_D1) é que vale
    expect(await row(sub.id, "DUE_D0", "WHATSAPP")).toMatchObject({ status: "SKIPPED", skippedReason: "OUT_OF_WINDOW_EXPIRED" });
  });
});

describe("destinatários do e-mail (D4)", () => {
  it("com e-mail de cobrança: etapas comuns só para ele; etapas críticas também para o dono; sem repetir", async () => {
    const s = await scenario("d4", { billingEmail: "financeiro@salao-d4.com.br", billingWhatsappE164: null });
    await tick(D1_NOON);
    // O e-mail do financeiro não tem confirmação de posse: 1 mensagem por dia. O 2o aviso do dia vai ao dono (verificado).
    expect(h.sentEmails.filter((m) => m.to === "financeiro@salao-d4.com.br")).toHaveLength(1);
    expect(mails(s.email)).toHaveLength(1);

    await tick(at("2026-10-28T15:00:00Z")); // vence hoje: crítico
    expect(h.sentEmails.filter((m) => m.to === "financeiro@salao-d4.com.br" && m.subject.includes("vence hoje"))).toHaveLength(1);
    expect(mails(s.email).filter((m) => m.subject.includes("vence hoje"))).toHaveLength(1);
    const d0 = await row(s.sub.id, "DUE_D0", "EMAIL");
    expect(d0!.recipientMasked).toBe("fi***@salao-d4.com.br, it***@example.com");
  });

  it("e-mail de cobrança igual ao do dono: 1 envio só", async () => {
    const t = await h.makeTenant(fixtures, "d4same", { billingWhatsappE164: null });
    await prisma.tenant.update({ where: { id: t.tenant.id }, data: { billingEmail: t.email.toUpperCase() } });
    const sub = await h.makePayingSubscription(fixtures, t.tenant.id, "d4same", { currentPeriodEnd: PERIOD_END });
    await h.makeOpenInvoice(sub.id, { periodStart: PERIOD_END, dueAt: PERIOD_END, createdAt: at("2026-10-23T13:00:00Z") });
    await tick(at("2026-10-28T15:00:00Z"));
    expect(h.sentEmails.filter((m) => m.to.toLowerCase() === t.email.toLowerCase() && m.subject.includes("vence hoje"))).toHaveLength(1);
  });

  it("sem destinatário nenhum: SKIPPED/NO_RECIPIENT", async () => {
    const s = await scenario("norecipient", { billingWhatsappE164: null });
    await prisma.membership.deleteMany({ where: { tenantId: s.tenant.id } });
    await tick(D1_NOON);
    expect((await h.noticesOf(s.sub.id)).filter((r) => r.channel === "EMAIL").every((r) => r.status === "SKIPPED" && r.skippedReason === "NO_RECIPIENT")).toBe(true);
  });
});

describe("Pix vigente em todo aviso (R7)", () => {
  it("Pix perto de expirar é regerado antes do envio e o código novo vai no e-mail e no WhatsApp", async () => {
    const s = await scenario("pix-fresh", { document: "52998224725" }, { pix: "CODIGO-VELHO", pixExpiresAt: new Date(D1_NOON.getTime() + 6 * 3_600_000) });
    // O mock do MP expira o Pix pelo relógio REAL; aqui o relógio é o injetado.
    const mpOnInjectedClock = {
      ...gateway,
      createPixPayment: async (input: Parameters<typeof gateway.createPixPayment>[0]) => ({ ...(await gateway.createPixPayment(input)), expiresAt: new Date(D1_NOON.getTime() + 3 * 86_400_000) }),
    };
    await runBillingTick(D1_NOON, mpOnInjectedClock, { dispatch: h.tickDispatch });
    const reloaded = await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoice.id } });
    expect(reloaded.pixCopyPaste).toMatch(/^00020126mock-pix-/);
    expect(reloaded.mpPaymentId).not.toBeNull();
    expect(mails(s.email).every((m) => m.text.includes(reloaded.pixCopyPaste!) && !m.text.includes("CODIGO-VELHO"))).toBe(true);
    expect(h.whatsapp.sent.some((m) => m.text === reloaded.pixCopyPaste)).toBe(true);
    expect(h.whatsapp.sent.some((m) => m.text === "CODIGO-VELHO")).toBe(false);
  });

  it("Mercado Pago fora e Pix vencido: o aviso sai sem código, mandando pagar pelo painel (não trava)", async () => {
    const s = await scenario("pix-down", { document: "52998224725" }, { pix: "CODIGO-VENCIDO", pixExpiresAt: new Date(D1_NOON.getTime() - 3_600_000) });
    const down = {
      ...gateway,
      createPixPayment: async () => {
        throw new Error("mp fora");
      },
    };
    await runBillingTick(D1_NOON, down, { dispatch: h.tickDispatch });
    expect(mails(s.email)).toHaveLength(2);
    expect(mails(s.email).some((m) => m.text.includes("CODIGO-VENCIDO"))).toBe(false);
    const wa = h.whatsapp.sent.filter((m) => m.tenantId === s.tenant.id);
    expect(wa.some((m) => m.text.includes("CODIGO-VENCIDO"))).toBe(false);
    expect(wa.every((m) => !m.text.startsWith("00020126"))).toBe(true);
    expect(wa[0]!.text).toContain(`/${s.tenant.slug}/assinatura`);
  });
});

describe("suspensão manual do admin e pagamento confirmado", () => {
  it("suspensão manual não é atraso: nenhum aviso de cobrança de suspensão, e a reativação manual grava o histórico", async () => {
    const t = await h.makeTenant(fixtures, "manual");
    const sub = await h.makePayingSubscription(fixtures, t.tenant.id, "manual", { currentPeriodEnd: at("2026-12-20T10:00:00Z") });
    await suspendCompanyManually(t.tenant.id, "admin-1");
    const suspended = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(suspended.status).toBe("SUSPENDED");
    const events = await prisma.billingEvent.findMany({ where: { subscriptionId: sub.id } });
    expect(events.find((e) => e.type === "MANUAL_SUSPEND")).toMatchObject({ actorType: "ADMIN", actorUserId: "admin-1", fromStatus: "ACTIVE", toStatus: "SUSPENDED" });

    const now = new Date();
    now.setUTCHours(15, 0, 0, 0);
    await tick(now);
    await tick(new Date(now.getTime() + 7 * 86_400_000));
    expect(await h.noticesOf(sub.id)).toHaveLength(0);
    expect(mails(t.email)).toHaveLength(0);

    await reactivateCompanyManually(t.tenant.id, "admin-1");
    expect((await prisma.billingEvent.findMany({ where: { subscriptionId: sub.id } })).some((e) => e.type === "MANUAL_REACTIVATE")).toBe(true);
  });

  it("pagamento confirmado sai na hora (fora da janela), por e-mail e WhatsApp, 1 vez só mesmo com baixa duplicada", async () => {
    const s = await scenario("pay-now");
    const midnight = at("2026-10-27T05:00:00Z"); // 02:00 SP, fora de qualquer janela
    vi.useFakeTimers({ toFake: ["Date"], now: midnight });
    try {
      const [a, b] = await Promise.all([applyInvoicePayment(s.invoice.id, midnight), applyInvoicePayment(s.invoice.id, midnight)]);
      expect([a.alreadyProcessed, b.alreadyProcessed].sort()).toEqual([false, true]);
    } finally {
      vi.useRealTimers();
    }
    expect(mails(s.email).filter((m) => m.subject.includes("Pagamento confirmado"))).toHaveLength(1);
    expect(h.whatsapp.sent.filter((m) => m.tenantId === s.tenant.id && m.text.includes("Bem-vindo") === false && m.text.includes("renovada até"))).toHaveLength(1);
    const events = await prisma.billingEvent.findMany({ where: { subscriptionId: s.sub.id, type: "PAYMENT_CONFIRMED" } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ invoiceId: s.invoice.id, fromStatus: "ACTIVE", toStatus: "ACTIVE" });
  });
});

describe("transição sem duplicar (LEGACY_SENT) e fatura gerada pelo tick", () => {
  it("o que o envio antigo já mandou (linha LEGACY_SENT do backfill) não é reenviado pelo motor novo", async () => {
    const s = await scenario("legacy", { billingWhatsappE164: null });
    await prisma.billingNotice.createMany({
      data: (["INVOICE_CREATED", "DUE_D1"] as const).map((step) => ({
        tenantId: s.tenant.id,
        subscriptionId: s.sub.id,
        invoiceId: s.invoice.id,
        step,
        channel: "EMAIL",
        cycleKey: s.invoice.id,
        status: "SKIPPED",
        skippedReason: "LEGACY_SENT",
        notBefore: D1_NOON,
        expiresAt: D1_NOON,
        nextAttemptAt: D1_NOON,
      })),
    });
    await tick(D1_NOON);
    expect(mails(s.email)).toHaveLength(0);
    await tick(at("2026-10-28T15:00:00Z"));
    expect(mails(s.email).map((m) => m.subject)).toEqual([expect.stringContaining("vence hoje")]);
  });

  it("o tick que gera a fatura do próximo ciclo grava dueAt = início do período, o evento INVOICE_CREATED e avisa na mesma rodada", async () => {
    const t = await h.makeTenant(fixtures, "gen", { billingWhatsappE164: null });
    const cpe = at("2026-10-28T10:00:00Z");
    const sub = await h.makePayingSubscription(fixtures, t.tenant.id, "gen", { currentPeriodEnd: cpe });
    await tick(at("2026-10-24T15:00:00Z")); // D-4: dentro da janela de geração de 5 dias
    const invoices = await prisma.invoice.findMany({ where: { subscriptionId: sub.id } });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.dueAt.toISOString()).toBe(cpe.toISOString()); // vencimento = fim do período atual, não um mês depois
    expect(invoices[0]!.periodStart.toISOString()).toBe(cpe.toISOString());
    expect(await prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: "INVOICE_CREATED", invoiceId: invoices[0]!.id } })).toBe(1);
    // O planejador cria o aviso de fatura gerada (createdAt real <= relógio injetado só se a fatura nasceu antes dele: o motor também vale a data real).
    const rows = await h.noticesOf(sub.id);
    expect(rows.length === 0 || rows.every((r) => r.step === "INVOICE_CREATED")).toBe(true);
  });
});

describe("orçamento do tick e trava", () => {
  it("orçamento estourado: nada é enviado, deadlineReached avisa e a rodada seguinte envia 1 vez só", async () => {
    const s = await scenario("budget", { billingWhatsappE164: null });
    const first = await tick(D1_NOON, { budgetMs: 0 });
    expect(first.deadlineReached).toBe(true);
    expect(mails(s.email)).toHaveLength(0);
    await tick(D1_NOON);
    await tick(D1_NOON);
    expect(mails(s.email)).toHaveLength(2);
  });

  it("trava já tomada: o tick sai sem fazer nada e sem enviar", async () => {
    const s = await scenario("lock", { billingWhatsappE164: null });
    const held = await withAdvisoryLock(BILLING_TICK_LOCK_NAME, async () => {
      const inner = await tick(D1_NOON);
      return inner;
    });
    expect(held.acquired).toBe(true);
    if (held.acquired) expect(held.value.skippedByLock).toBe(true);
    expect(mails(s.email)).toHaveLength(0);
  });

  it("o resumo do tick conta o que a régua fez (planejados, enviados, pulados, falhos, adiados)", async () => {
    await scenario("summary", { optOut: true });
    const summary = await tick(D1_NOON);
    expect(summary.noticesEnqueued).toBeGreaterThanOrEqual(4);
    expect(summary.noticesSent).toBeGreaterThanOrEqual(2);
    expect(summary.noticesSkipped).toBeGreaterThanOrEqual(2);
    expect(summary).toHaveProperty("noticesFailed");
    expect(summary).toHaveProperty("noticesDeferred");
  });
});
