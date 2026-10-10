/**
 * F2 da régua de cobrança (docs/regua-de-cobranca.md §2.2, §2.3.1, §2.3.2): a régua COMPLETA de ponta a ponta
 * contra Postgres real, com o relógio injetado em cada rodada do tick. Pagante: D-5 até o cancelamento
 * automático. Teste grátis: dia 1, véspera, fim, suspensão e cancelamento, com dados reais de uso. SMTP e
 * WhatsApp da plataforma são dublês; o Mercado Pago é o mock.
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
  // Todo envio de WhatsApp da cobrança (tick e "pagamento confirmado" imediato) passa pelo dublê.
  return { ...original, sendPlatformWhatsapp: helpers.fakeSendWhatsapp };
});

const h = await import("./dunning.helpers");
const { runBillingTick } = await import("@/modules/billing/tick");
const { applyInvoicePayment } = await import("@/modules/billing/service");
const { createMockMercadoPagoGateway } = await import("@/modules/billing/mercadopago.mock");
const { loadBillingBellItems } = await import("@/modules/billing/dunning/bell");

const { prisma, at } = h;
const fixtures = h.newFixtures();
const { gateway } = createMockMercadoPagoGateway();

beforeEach(() => {
  h.resetMail();
  h.resetWhatsapp();
});
// Cada teste começa sem as empresas dos anteriores: o tick é global e, com o relógio saltando semanas, eles
// continuariam recebendo etapas e misturariam as contagens.
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

const tick = (now: Date) => runBillingTick(now, gateway, { dispatch: h.tickDispatch });
const mails = (email: string) => h.sentEmails.filter((m) => m.to === email);

describe("régua de quem paga: D-5 até o cancelamento automático (America/Sao_Paulo)", () => {
  it("cada etapa sai uma vez, pelo canal e no dia certos, e a conta é encerrada no fim", async () => {
    const { tenant, email } = await h.makeTenant(fixtures, "ladder");
    // Vence quarta 28/10/2026 07:00 (SP). Fatura criada 5 dias antes (sexta 23/10).
    const periodEnd = at("2026-10-28T10:00:00Z");
    const sub = await h.makePayingSubscription(fixtures, tenant.id, "ladder", { currentPeriodEnd: periodEnd });
    const invoice = await h.makeOpenInvoice(sub.id, { periodStart: periodEnd, dueAt: periodEnd, createdAt: at("2026-10-23T13:00:00Z") });

    const steps: Array<{ now: string; label: string; emails: string[]; whatsapps: number }> = [
      { now: "2026-10-23T15:00:00Z", label: "D-5 fatura gerada", emails: ["Fatura do InnoChat"], whatsapps: 2 }, // texto + Pix
      { now: "2026-10-25T15:00:00Z", label: "D-3 so no sino", emails: [], whatsapps: 0 },
      { now: "2026-10-27T15:00:00Z", label: "D-1", emails: ["vence amanhã"], whatsapps: 2 },
      { now: "2026-10-28T15:00:00Z", label: "D (vence hoje)", emails: ["vence hoje"], whatsapps: 2 },
      { now: "2026-10-29T15:00:00Z", label: "D+1 carencia", emails: ["Sua fatura venceu ontem"], whatsapps: 2 },
      { now: "2026-10-30T15:00:00Z", label: "D+2 carencia (so e-mail)", emails: ["segue em aberto"], whatsapps: 0 },
      { now: "2026-10-31T15:00:00Z", label: "D+3 ultimo dia", emails: ["Último dia para pagar"], whatsapps: 2 },
      { now: "2026-11-01T15:00:00Z", label: "suspensao (domingo: WhatsApp ok)", emails: ["suspenso"], whatsapps: 2 },
      { now: "2026-11-04T15:00:00Z", label: "S+3", emails: ["parado há 3 dias"], whatsapps: 0 },
      { now: "2026-11-09T15:00:00Z", label: "S+7 (domingo adia o WhatsApp para segunda)", emails: ["parado há 8 dias"], whatsapps: 1 },
      { now: "2026-11-16T15:00:00Z", label: "S+15", emails: ["parado há 15 dias"], whatsapps: 0 },
      { now: "2026-12-01T15:00:00Z", label: "S+30", emails: ["parado há 30 dias"], whatsapps: 1 },
      { now: "2026-12-16T15:00:00Z", label: "S+45", emails: ["parado há 45 dias"], whatsapps: 0 },
      { now: "2026-12-24T15:00:00Z", label: "C-7", emails: ["será encerrada em 7 dias"], whatsapps: 1 },
      { now: "2026-12-30T15:00:00Z", label: "C-1", emails: ["será encerrada amanhã"], whatsapps: 1 },
      { now: "2026-12-31T15:00:00Z", label: "cancelamento automatico", emails: ["foi encerrada"], whatsapps: 1 },
    ];

    for (const step of steps) {
      h.sentEmails.length = 0;
      h.whatsapp.sent.length = 0;
      await tick(at(step.now));
      const got = mails(email).map((m) => m.subject);
      expect(got.length, `${step.label}: e-mails ${JSON.stringify(got)}`).toBe(step.emails.length);
      step.emails.forEach((fragment) => expect(got.some((s) => s.includes(fragment)), `${step.label}: faltou "${fragment}" em ${JSON.stringify(got)}`).toBe(true));
      // "whatsapps" conta MENSAGENS (a fatura leva o Pix numa mensagem separada).
      expect(h.whatsapp.sent.length, `${step.label}: WhatsApp`).toBe(step.whatsapps);
    }

    const rows = await h.noticesOf(sub.id);
    // Uma linha por (etapa, canal): nada duplicado e tudo enviado.
    expect(new Set(rows.map((r) => `${r.cycleKey}|${r.step}|${r.channel}`)).size).toBe(rows.length);
    expect(rows.every((r) => r.status === "SENT")).toBe(true);
    const emailSteps = rows.filter((r) => r.channel === "EMAIL").map((r) => r.step);
    expect(emailSteps).toEqual(
      expect.arrayContaining(["INVOICE_CREATED", "DUE_D1", "DUE_D0", "GRACE_D1", "GRACE_D2", "GRACE_LAST", "SUSPENDED", "SUSP_3", "SUSP_7", "SUSP_15", "SUSP_30", "SUSP_45", "CANCEL_WARN_7", "CANCEL_WARN_1", "AUTO_CANCELED"]),
    );
    expect(emailSteps).not.toContain("DUE_D3");
    // WhatsApp: só nas etapas combinadas (D9 e §2.2), com remetente gravado.
    const waSteps = rows.filter((r) => r.channel === "WHATSAPP").map((r) => r.step).sort();
    expect(waSteps).toEqual(["AUTO_CANCELED", "CANCEL_WARN_1", "CANCEL_WARN_7", "DUE_D0", "DUE_D1", "GRACE_D1", "GRACE_LAST", "INVOICE_CREATED", "SUSPENDED", "SUSP_30", "SUSP_7"].sort());
    expect(rows.filter((r) => r.channel === "WHATSAPP").every((r) => r.platformConnectionId !== null && r.senderPhoneE164 === "5584900000000")).toBe(true);
    expect(rows.filter((r) => r.channel === "EMAIL").every((r) => /^[a-z0-9-]{2}\*\*\*@example\.com$/.test(r.recipientMasked ?? ""))).toBe(true);
    expect(rows.filter((r) => r.channel === "WHATSAPP").every((r) => r.recipientMasked === "+55 84 9****-0001")).toBe(true);

    // O ciclo termina cancelado, com efeitos e histórico.
    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } });
    expect(after.status).toBe("CANCELED");
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("VOID");
    const events = await prisma.billingEvent.findMany({ where: { subscriptionId: sub.id }, orderBy: { createdAt: "asc" } });
    expect(events.filter((e) => e.type === "STATUS_CHANGED").map((e) => `${e.fromStatus}>${e.toStatus}`)).toEqual(["ACTIVE>PAST_DUE", "PAST_DUE>SUSPENDED"]);
    const canceled = events.find((e) => e.type === "CANCELED");
    expect(canceled).toMatchObject({ fromStatus: "SUSPENDED", toStatus: "CANCELED", actorType: "SYSTEM" });
    expect(canceled?.metadata).toMatchObject({ cancelSource: "AUTO_SUSPENDED" });
  });

  it("textos de WhatsApp levam valor, vencimento e link; o Pix vai sozinho em mensagem separada; sem travessão", async () => {
    const { tenant } = await h.makeTenant(fixtures, "wa-text");
    const periodEnd = at("2026-10-28T10:00:00Z");
    const sub = await h.makePayingSubscription(fixtures, tenant.id, "wa-text", { currentPeriodEnd: periodEnd });
    await h.makeOpenInvoice(sub.id, { periodStart: periodEnd, dueAt: periodEnd, createdAt: at("2026-10-23T13:00:00Z") });
    const mine = () => h.whatsapp.sent.filter((m) => m.tenantId === tenant.id).map((m) => m.text);

    await tick(at("2026-10-23T15:00:00Z")); // D-5
    const created = mine();
    expect(created).toHaveLength(2);
    expect(created[0]).toContain("Oi, Ana!");
    expect(created[0]).toContain("28/10/2026");
    expect(created[0]).toContain("49,90");
    expect(created[0]).toContain(`/${tenant.slug}/assinatura`);
    expect(created[0]).toContain("Responda SAIR"); // primeira mensagem da empresa
    expect(created[1]).toBe("00020126PIXCOPIAECOLA");

    h.whatsapp.sent.length = 0;
    await tick(at("2026-10-27T15:00:00Z")); // D-1
    const d1 = mine();
    expect(d1).toHaveLength(2);
    expect(d1[0]).toContain("vence amanhã");
    expect(d1[0]).not.toContain("Responda SAIR"); // só na primeira
    expect(d1[1]).toBe("00020126PIXCOPIAECOLA");

    h.whatsapp.sent.length = 0;
    await tick(at("2026-10-28T15:00:00Z")); // D
    expect(mine()[0]).toContain("vence hoje");
    expect([...created, ...d1, ...mine()].join(" | ")).not.toMatch(/—/);
  });

  it("sino: acompanha a etapa atual da régua (D-3, D, carência, suspensão) e some quando a fatura é paga", async () => {
    const { tenant } = await h.makeTenant(fixtures, "bell");
    const periodEnd = at("2026-10-28T10:00:00Z");
    const sub = await h.makePayingSubscription(fixtures, tenant.id, "bell", { currentPeriodEnd: periodEnd });
    const invoice = await h.makeOpenInvoice(sub.id, { periodStart: periodEnd, dueAt: periodEnd, createdAt: at("2026-10-23T13:00:00Z") });
    const bell = async (iso: string) => (await loadBillingBellItems({ id: tenant.id, timezone: tenant.timezone }, at(iso)))[0];

    expect(await bell("2026-10-25T15:00:00Z")).toMatchObject({ kind: "INVOICE_OPEN", severity: "info", title: "Sua fatura vence em 3 dias" });
    expect(await bell("2026-10-28T15:00:00Z")).toMatchObject({ kind: "INVOICE_DUE", title: "Sua fatura vence hoje" });
    expect(await bell("2026-10-29T15:00:00Z")).toMatchObject({ kind: "INVOICE_OVERDUE", severity: "danger" });
    expect(await bell("2026-11-02T15:00:00Z")).toMatchObject({ kind: "SUBSCRIPTION_SUSPENDED" });
    expect(await bell("2026-12-24T15:00:00Z")).toMatchObject({ kind: "CANCEL_WARNING" });
    const first = await bell("2026-10-27T15:00:00Z");
    const second = await bell("2026-10-28T15:00:00Z");
    expect(first!.id).not.toBe(second!.id); // cada etapa volta como não lida
    expect(first!.id).toMatch(/^bill:[A-Za-z0-9]+:DUE_D1:[0-9]+$/);

    await applyInvoicePayment(invoice.id, at("2026-10-28T16:00:00Z"));
    expect(await bell("2026-10-29T15:00:00Z")).toBeUndefined();
  });
});

describe("sequência de conversão do teste grátis (§2.3.1): dados reais de uso", () => {
  async function makeTrial(label: string, opts: { whatsappE164?: string | null } = {}) {
    const { tenant, email } = await h.makeTenant(fixtures, label, { billingWhatsappE164: opts.whatsappE164 });
    // Cadastro quinta 01/10/2026 12:00 (SP); teste de 3 dias vai até domingo 04/10 12:00.
    const trialEndsAt = at("2026-10-04T15:00:00Z");
    const plan = await h.makePlan(fixtures, label);
    const sub = await prisma.subscription.create({
      data: { tenantId: tenant.id, planId: plan.id, status: "TRIALING", trialEndsAt, currentPeriodEnd: trialEndsAt, firstPaidAt: null, createdAt: at("2026-10-01T15:00:00Z") },
    });
    const invoice = await h.makeOpenInvoice(sub.id, { periodStart: at("2026-10-01T15:00:00Z"), dueAt: trialEndsAt, createdAt: at("2026-10-01T15:00:00Z"), isTrialConversion: true });
    return { tenant, email, sub, invoice };
  }

  async function addUsage(tenantId: string) {
    const prismaTenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    const instance = await prisma.whatsappInstance.create({
      data: { tenantId, instanceName: `inst-${prismaTenant.slug}`, label: "Principal", status: "CONNECTED", phoneE164: "+5584911110000", webhookToken: `wt-${prismaTenant.slug}` },
    });
    const service = await prisma.service.create({ data: { tenantId, name: "Corte", durationMin: 30 } });
    const professional = await prisma.professional.create({ data: { tenantId, name: "Bia" } });
    const c1 = await prisma.contact.create({ data: { tenantId, waJid: "5584911111111@s.whatsapp.net", name: "Cliente 1" } });
    const c2 = await prisma.contact.create({ data: { tenantId, waJid: "5584922222222@s.whatsapp.net", name: "Cliente 2" } });
    const c3 = await prisma.contact.create({ data: { tenantId, waJid: "5584933333333@s.whatsapp.net", name: "Cliente 3" } });
    const mk = (contactId: string, day: number, extra: Record<string, unknown> = {}) =>
      prisma.appointment.create({
        data: {
          tenantId,
          contactId,
          serviceId: service.id,
          professionalId: professional.id,
          whatsappInstanceId: instance.id,
          startsAt: new Date(Date.UTC(2026, 9, 10 + day, 13)),
          endsAt: new Date(Date.UTC(2026, 9, 10 + day, 14)),
          blockEndsAt: new Date(Date.UTC(2026, 9, 10 + day, 14)),
          source: "WHATSAPP",
          createdAt: at("2026-10-02T13:00:00Z"),
          ...extra,
        },
      });
    await mk(c1.id, 0, { reminderSentAt: at("2026-10-03T13:00:00Z") });
    await mk(c1.id, 2); // o mesmo cliente voltou a marcar
    await mk(c2.id, 4);
    await mk(c3.id, 6, { source: "PANEL" }); // marcado no painel: não é do bot
    // Conversas respondidas pelo bot: respostas de saída para 3 clientes distintos (uma pelo painel, que não conta).
    for (const [i, c] of [c1, c2, c3].entries()) {
      await prisma.chatMessage.create({ data: { tenantId, contactId: c.id, whatsappInstanceId: instance.id, direction: "OUTBOUND", body: "oi", createdAt: new Date(Date.UTC(2026, 9, 2, 14, i)) } });
    }
    await prisma.chatMessage.create({ data: { tenantId, contactId: c3.id, direction: "OUTBOUND", body: "da recepção", authorUserId: (await prisma.user.findFirstOrThrow({ where: { memberships: { some: { tenantId } } } })).id, createdAt: at("2026-10-02T15:00:00Z") } });
  }

  it("dia seguinte ao cadastro: o resumo cita horários marcados, conversas respondidas e lembretes REAIS do tenant", async () => {
    const { tenant, email, sub } = await makeTrial("trial-real");
    await addUsage(tenant.id);

    await tick(at("2026-10-02T15:00:00Z")); // sexta 12:00 SP
    const mail = mails(email).find((m) => m.subject.includes("primeiro dia"));
    expect(mail, JSON.stringify(h.sentEmails.map((m) => m.subject))).toBeDefined();
    expect(mail!.text).toContain("o Inno marcou 3 horários, respondeu 3 conversas, mandou 1 lembrete e fez 1 cliente voltar a marcar");
    const wa = h.whatsapp.sent.find((m) => m.tenantId === tenant.id);
    expect(wa?.text).toContain("o Inno já marcou 3 horários, respondeu 3 conversas, mandou 1 lembrete e fez 1 cliente voltar a marcar");
    expect(wa?.text).toContain("04/10/2026");

    // Rodar de novo não repete nada.
    h.sentEmails.length = 0;
    h.whatsapp.sent.length = 0;
    await tick(at("2026-10-02T15:30:00Z"));
    expect(mails(email).filter((m) => m.subject.includes("primeiro dia"))).toHaveLength(0);
    expect(h.whatsapp.sent.filter((m) => m.tenantId === tenant.id)).toHaveLength(0);
    expect((await h.noticesOf(sub.id)).filter((r) => r.step === "TRIAL_DAY1")).toHaveLength(2);
  });

  it("sem nenhum resultado: variação 'falta pouco' (conectar o WhatsApp), sem cobrar e sem inventar número", async () => {
    const { tenant, email } = await makeTrial("trial-zero");
    await tick(at("2026-10-02T15:00:00Z"));
    const mail = mails(email).find((m) => m.subject.includes("Falta pouco"));
    expect(mail?.text).toContain("O que falta: conectar o número de WhatsApp da empresa");
    expect(mail?.text).not.toMatch(/marcou|respondeu/);
    // Sem número do bot conectado, o resumo do 1º dia não vai por WhatsApp (§2.3.1: "sim, se conectou").
    expect(h.whatsapp.sent.filter((m) => m.tenantId === tenant.id)).toHaveLength(0);
  });

  it("véspera, dia do fim e suspensão: e-mail e WhatsApp com o Pix, e o teste suspenso fala dos clientes que marcaram", async () => {
    const { tenant, email, sub } = await makeTrial("trial-flow");
    await addUsage(tenant.id);

    await tick(at("2026-10-03T15:00:00Z")); // sábado 12:00
    expect(mails(email).some((m) => m.subject.includes("termina amanhã"))).toBe(true);
    const t1 = h.whatsapp.sent.filter((m) => m.tenantId === tenant.id);
    expect(t1[0]!.text).toContain("termina amanhã às 12:00");
    expect(t1[0]!.text).toContain("Até agora o Inno marcou 3 horários");
    expect(t1[1]!.text).toBe("00020126PIXCOPIAECOLA");

    h.sentEmails.length = 0;
    await tick(at("2026-10-04T14:00:00Z")); // domingo 11:00 SP, antes do fim (12:00): e-mail sai; WhatsApp só em etapa de suspensão/cancelamento
    expect(mails(email).some((m) => m.subject.includes("termina hoje às 12:00"))).toBe(true);

    h.sentEmails.length = 0;
    h.whatsapp.sent.length = 0;
    await tick(at("2026-10-05T16:00:00Z")); // segunda 13:00: carência de 1 dia acabou, suspenso
    expect(mails(email).some((m) => m.subject.includes("Seu teste terminou"))).toBe(true);
    expect(mails(email).find((m) => m.subject.includes("Seu teste terminou"))!.text).toContain("2 clientes que marcaram pelo WhatsApp vão ficar sem resposta");
    expect(h.whatsapp.sent.find((m) => m.tenantId === tenant.id)?.text).toContain("2 clientes que marcaram pelo WhatsApp vão ficar sem resposta");

    h.sentEmails.length = 0;
    await tick(at("2026-10-08T15:00:00Z")); // S+3
    expect(mails(email).some((m) => m.subject.includes("segue parado"))).toBe(true);
    h.sentEmails.length = 0;
    h.whatsapp.sent.length = 0;
    await tick(at("2026-10-10T15:00:00Z")); // 2 dias antes de encerrar (sábado)
    expect(mails(email).some((m) => m.subject.includes("será encerrada em 2 dias"))).toBe(true);
    expect(h.whatsapp.sent.some((m) => m.tenantId === tenant.id && m.text.includes("será encerrada em 2 dias"))).toBe(true);

    const sentSteps = (await h.noticesOf(sub.id)).filter((r) => r.status === "SENT").map((r) => r.step);
    // Esta empresa de teste não tem CPF/CNPJ (cadastro enxuto): "Sua fatura chegou" do teste espera o documento entrar
    // (coberto em billing-dunning-signup-contact), então não aparece aqui; o resto da sequência sai normalmente.
    expect(sentSteps).toEqual(expect.arrayContaining(["TRIAL_T1", "TRIAL_T0", "SUSPENDED", "TRIAL_SUSP_3", "TRIAL_CANCEL_WARN"]));
    expect(sentSteps).not.toContain("INVOICE_CREATED");
  });

  it("pagou no meio: a sequência para na hora e sai o 'Pagamento confirmado' (bem-vindo) por e-mail e WhatsApp", async () => {
    const { tenant, email, sub, invoice } = await makeTrial("trial-paid");
    await tick(at("2026-10-03T15:00:00Z")); // véspera enviada
    h.sentEmails.length = 0;
    h.whatsapp.sent.length = 0;

    await applyInvoicePayment(invoice.id, at("2026-10-03T16:00:00Z"));
    const confirmed = mails(email).find((m) => m.subject.includes("Pagamento confirmado"));
    expect(confirmed).toBeDefined();
    const wa = h.whatsapp.sent.filter((m) => m.tenantId === tenant.id);
    expect(wa).toHaveLength(1);
    expect(wa[0]!.text).toContain("Bem-vindo ao InnoChat");

    h.sentEmails.length = 0;
    h.whatsapp.sent.length = 0;
    await tick(at("2026-10-04T14:00:00Z")); // dia do fim do teste: nada de "termina hoje"
    expect(h.sentEmails.filter((m) => m.to === email)).toHaveLength(0);
    expect(h.whatsapp.sent.filter((m) => m.tenantId === tenant.id)).toHaveLength(0);
    const rows = await h.noticesOf(sub.id);
    expect(rows.filter((r) => r.step === "TRIAL_T0")).toHaveLength(0);
    expect(rows.filter((r) => r.step === "PAYMENT_CONFIRMED" && r.status === "SENT")).toHaveLength(2);
  });
});
