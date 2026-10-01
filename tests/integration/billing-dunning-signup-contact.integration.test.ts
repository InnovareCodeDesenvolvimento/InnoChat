/**
 * F2 da régua de cobrança: telefone do dono salvo no cadastro (senha e Google), aviso "fatura gerada" do cadastro
 * dentro do outbox, ações do contato de cobrança (OWNER escreve, STAFF lê), `BillingEvent` (transições e eventos,
 * append-only, `cancelSource`) e os e-mails de cancelamento automático. Postgres real; SMTP, WhatsApp e MP são dublês.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/lib/auth/guards";

const session: { ctx: TenantContext | null } = { ctx: null };
vi.mock("@/lib/auth/guards", () => ({
  requireTenantMember: async (slug: string, roles?: string[]) => {
    const { DomainError } = await import("@/lib/errors");
    if (!session.ctx || session.ctx.tenant.slug !== slug) throw new DomainError("NOT_FOUND", "Empresa não encontrada.");
    if (roles && roles.length > 0 && !roles.includes(session.ctx.membership.role)) throw new DomainError("FORBIDDEN", "Sem permissão para esta ação.");
    return session.ctx;
  },
}));
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
const { signUp, signUpWithGoogle } = await import("@/modules/signup/service");
const { getBillingContactAction, updateBillingContactAction } = await import("@/modules/billing/contact-actions");
const { runBillingTick } = await import("@/modules/billing/tick");
const { requestCancellation, undoCancellation, startReactivation } = await import("@/modules/billing/cancellation");
const { changePlan, applyInvoicePayment } = await import("@/modules/billing/service");
const { markInvoicePaidManually } = await import("@/modules/billing/admin-service");
const { createMockMercadoPagoGateway } = await import("@/modules/billing/mercadopago.mock");

const { prisma, at } = h;
const fixtures = h.newFixtures();
const { gateway } = createMockMercadoPagoGateway();

beforeEach(() => {
  h.resetMail();
  h.resetWhatsapp();
  session.ctx = null;
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

const mails = (email: string) => h.sentEmails.filter((m) => m.to === email);

function signupInput(overrides: Record<string, unknown> = {}) {
  const slug = `it-dsc-${Date.now()}-${randomUUID().slice(0, 6)}`;
  return {
    companyName: "Studio Régua",
    slug,
    segment: "Salão",
    ownerName: "Dona Régua",
    email: `${slug}@example.com`,
    password: "senha-forte-123",
    document: "529.982.247-25",
    termsVersion: "v1",
    ...overrides,
  } as Parameters<typeof signUp>[0];
}

async function track(slug: string, userId: string) {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug } });
  fixtures.tenantIds.push(tenant.id);
  fixtures.userIds.push(userId);
  return tenant;
}

describe("telefone do dono salvo no cadastro", () => {
  it("senha: o telefone (com máscara) vira só dígitos com DDI em Tenant.billingWhatsappE164", async () => {
    const result = await signUp(signupInput({ phone: "(84) 99999-8888" }), gateway);
    const tenant = await track(result.tenantSlug, result.userId);
    expect(tenant.billingWhatsappE164).toBe("5584999998888");
    expect(tenant.billingWhatsappOptOutAt).toBeNull(); // D5: ligado para todos
    expect(tenant.billingEmail).toBeNull();
  });

  it("aceita +55 e DDI colado; sem telefone grava null; telefone inválido recusa o cadastro (INVALID_PHONE) sem criar nada", async () => {
    const withDdi = await signUp(signupInput({ phone: "+55 84 3113-2584" }), gateway);
    expect((await track(withDdi.tenantSlug, withDdi.userId)).billingWhatsappE164).toBe("558431132584");

    const none = await signUp(signupInput({ phone: "   " }), gateway);
    expect((await track(none.tenantSlug, none.userId)).billingWhatsappE164).toBeNull();

    const bad = signupInput({ phone: "12345" });
    await expect(signUp(bad, gateway)).rejects.toMatchObject({ code: "INVALID_PHONE" });
    expect(await prisma.tenant.findUnique({ where: { slug: bad.slug } })).toBeNull();
    expect(await prisma.user.findUnique({ where: { email: bad.email } })).toBeNull();
  });

  it("Google: o telefone informado na conclusão do cadastro também é salvo", async () => {
    const slugBase = `it-dsc-g-${Date.now()}-${randomUUID().slice(0, 6)}`;
    const result = await signUpWithGoogle(
      { email: `${slugBase}@example.com`, googleSub: `sub-${randomUUID()}`, ownerName: "Dono Google", companyName: `Google ${slugBase}`, document: "529.982.247-25", termsVersion: "v1", phone: "84 98888-7777" },
      gateway,
    );
    const tenant = await track(result.tenantSlug, result.userId);
    expect(tenant.billingWhatsappE164).toBe("5584988887777");
  });

  it("a fatura gerada do cadastro entra no outbox como SENT e o tick não a reenvia; se o SMTP falhou, a régua reenvia", async () => {
    const ok = await signUp(signupInput({ phone: "84 99999-0001" }), gateway);
    const okTenant = await track(ok.tenantSlug, ok.userId);
    const okSub = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: okTenant.id } });
    const row = await prisma.billingNotice.findFirstOrThrow({ where: { subscriptionId: okSub.id, step: "INVOICE_CREATED", channel: "EMAIL" } });
    expect(row).toMatchObject({ status: "SENT" });
    expect(row.recipientMasked).toMatch(/\*\*\*@example\.com$/);
    expect(await prisma.billingEvent.count({ where: { subscriptionId: okSub.id, type: "INVOICE_CREATED" } })).toBe(1);
    expect(mails(`${ok.tenantSlug}@example.com`).filter((m) => m.subject.includes("Fatura do InnoChat"))).toHaveLength(1);

    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(15, 0, 0, 0);
    await runBillingTick(tomorrow, gateway, { dispatch: h.tickDispatch });
    expect(mails(`${ok.tenantSlug}@example.com`).filter((m) => m.subject.includes("Fatura do InnoChat"))).toHaveLength(1);

    // SMTP fora no cadastro: nenhuma linha, e o tick manda o aviso.
    h.mailControl.mode = "fail";
    const failing = await signUp(signupInput(), gateway);
    const failTenant = await track(failing.tenantSlug, failing.userId);
    const failSub = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: failTenant.id } });
    expect(await prisma.billingNotice.count({ where: { subscriptionId: failSub.id, step: "INVOICE_CREATED" } })).toBe(0);
    h.mailControl.mode = "ok";
    h.sentEmails.length = 0;
    await runBillingTick(tomorrow, gateway, { dispatch: h.tickDispatch });
    expect(mails(`${failing.tenantSlug}@example.com`).filter((m) => m.subject.includes("Fatura do InnoChat"))).toHaveLength(1);
    expect(await prisma.billingNotice.count({ where: { subscriptionId: failSub.id, step: "INVOICE_CREATED", channel: "EMAIL", status: "SENT" } })).toBe(1);
  });
});

describe("contato de cobrança: getBillingContactAction / updateBillingContactAction", () => {
  async function world(label: string) {
    const t = await h.makeTenant(fixtures, label, { billingWhatsappE164: null });
    const staffUser = await prisma.user.create({ data: { email: `staff-${t.slug}@example.com`, passwordHash: "x", emailVerifiedAt: new Date() } });
    fixtures.userIds.push(staffUser.id);
    const ownerM = await prisma.membership.findFirstOrThrow({ where: { tenantId: t.tenant.id, userId: t.user.id } });
    const staffM = await prisma.membership.create({ data: { userId: staffUser.id, tenantId: t.tenant.id, role: "STAFF" } });
    const ctx = (userId: string, role: "OWNER" | "STAFF", membershipId: string): TenantContext => ({
      tenant: { id: t.tenant.id, slug: t.tenant.slug, name: t.tenant.name, timezone: t.tenant.timezone },
      membership: { id: membershipId, role },
      user: { id: userId },
    });
    return { ...t, asOwner: ctx(t.user.id, "OWNER", ownerM.id), asStaff: ctx(staffUser.id, "STAFF", staffM.id) };
  }

  it("OWNER e STAFF leem: e-mail de cobrança, número formatado, opt-out e e-mail do dono", async () => {
    const w = await world("read");
    session.ctx = w.asStaff;
    const empty = await getBillingContactAction(w.slug);
    expect(empty).toEqual({ ok: true, data: { billingEmail: null, billingWhatsappE164: null, billingWhatsappDisplay: null, optedOut: false, ownerEmail: w.email } });

    await prisma.tenant.update({ where: { id: w.tenant.id }, data: { billingEmail: "fin@x.com.br", billingWhatsappE164: "5584999998888" } });
    session.ctx = w.asOwner;
    const filled = await getBillingContactAction(w.slug);
    expect(filled).toMatchObject({ ok: true, data: { billingEmail: "fin@x.com.br", billingWhatsappE164: "5584999998888", billingWhatsappDisplay: "(84) 99999-8888", optedOut: false } });
  });

  it("STAFF não escreve (FORBIDDEN) e nada muda", async () => {
    const w = await world("staff");
    session.ctx = w.asStaff;
    const result = await updateBillingContactAction(w.slug, { billingEmail: "fin@x.com.br" });
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: w.tenant.id } })).billingEmail).toBeNull();
  });

  it("OWNER grava e-mail (minúsculo), WhatsApp (só dígitos) e opt-out; campo ausente não mexe no resto", async () => {
    const w = await world("write");
    session.ctx = w.asOwner;
    const saved = await updateBillingContactAction(w.slug, { billingEmail: "  Financeiro@Salao.COM.br ", billingWhatsapp: "+55 (84) 99999-8888" });
    expect(saved).toMatchObject({ ok: true, data: { billingEmail: "financeiro@salao.com.br", billingWhatsappE164: "5584999998888", billingWhatsappDisplay: "(84) 99999-8888", optedOut: false } });

    const optedOut = await updateBillingContactAction(w.slug, { optOut: true });
    expect(optedOut).toMatchObject({ ok: true, data: { optedOut: true, billingEmail: "financeiro@salao.com.br", billingWhatsappE164: "5584999998888" } });
    const firstDate = (await prisma.tenant.findUniqueOrThrow({ where: { id: w.tenant.id } })).billingWhatsappOptOutAt;
    expect(firstDate).not.toBeNull();

    // Desligar de novo mantém a data do primeiro pedido (prova do consentimento retirado).
    await updateBillingContactAction(w.slug, { optOut: true });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: w.tenant.id } })).billingWhatsappOptOutAt?.getTime()).toBe(firstDate!.getTime());

    const back = await updateBillingContactAction(w.slug, { optOut: false });
    expect(back).toMatchObject({ ok: true, data: { optedOut: false } });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: w.tenant.id } })).billingWhatsappOptOutAt).toBeNull();
  });

  it("null ou vazio apaga (o e-mail volta a ser o do dono); e-mail e telefone inválidos têm erro próprio", async () => {
    const w = await world("clear");
    session.ctx = w.asOwner;
    await updateBillingContactAction(w.slug, { billingEmail: "fin@x.com.br", billingWhatsapp: "84999998888" });
    const cleared = await updateBillingContactAction(w.slug, { billingEmail: null, billingWhatsapp: "" });
    expect(cleared).toMatchObject({ ok: true, data: { billingEmail: null, billingWhatsappE164: null, billingWhatsappDisplay: null, ownerEmail: w.email } });

    expect(await updateBillingContactAction(w.slug, { billingEmail: "sem-arroba" })).toMatchObject({ ok: false, error: { code: "INVALID_EMAIL" } });
    expect(await updateBillingContactAction(w.slug, { billingWhatsapp: "123" })).toMatchObject({ ok: false, error: { code: "INVALID_PHONE" } });
    expect(await updateBillingContactAction(w.slug, { whatever: 1 })).toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });
    // Falha de validação não grava nada pela metade.
    const after = await prisma.tenant.findUniqueOrThrow({ where: { id: w.tenant.id } });
    expect(after.billingEmail).toBeNull();
    expect(after.billingWhatsappE164).toBeNull();
  });

  it("limite de 10 alterações por hora por empresa (RATE_LIMITED)", async () => {
    const w = await world("rate");
    session.ctx = w.asOwner;
    for (let i = 0; i < 10; i += 1) expect(await updateBillingContactAction(w.slug, { optOut: i % 2 === 0 })).toMatchObject({ ok: true });
    expect(await updateBillingContactAction(w.slug, { optOut: false })).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
  });

  it("o e-mail de cobrança recebe a régua e o opt-out desliga o WhatsApp (efeito ponta a ponta)", async () => {
    const w = await world("e2e");
    session.ctx = w.asOwner;
    await updateBillingContactAction(w.slug, { billingEmail: "financeiro@salao-e2e.com.br", billingWhatsapp: "84 99999-0002", optOut: true });
    const periodEnd = at("2026-10-28T10:00:00Z");
    const sub = await h.makePayingSubscription(fixtures, w.tenant.id, "e2e", { currentPeriodEnd: periodEnd });
    await h.makeOpenInvoice(sub.id, { periodStart: periodEnd, dueAt: periodEnd, createdAt: at("2026-10-23T13:00:00Z") });
    await runBillingTick(at("2026-10-27T15:00:00Z"), gateway, { dispatch: h.tickDispatch });
    expect(h.sentEmails.filter((m) => m.to === "financeiro@salao-e2e.com.br")).toHaveLength(2);
    expect(mails(w.email)).toHaveLength(0);
    expect(h.whatsapp.calls).toBe(0);
    expect((await h.noticesOf(sub.id)).filter((r) => r.channel === "WHATSAPP").every((r) => r.skippedReason === "OPTED_OUT")).toBe(true);
  });
});

describe("BillingEvent: transições e eventos (append-only)", () => {
  it("cancelamento pedido pelo dono: CANCEL_REQUESTED (agendado), CANCEL_UNDONE e CANCELED com cancelSource OWNER (imediato)", async () => {
    const t = await h.makeTenant(fixtures, "ev-owner", { billingWhatsappE164: null });
    const sub = await h.makePayingSubscription(fixtures, t.tenant.id, "ev-owner", { currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000) });
    await requestCancellation(t.tenant.id, { reason: "pausa" });
    await undoCancellation(t.tenant.id);
    await prisma.subscription.update({ where: { id: sub.id }, data: { status: "SUSPENDED", currentPeriodEnd: new Date(Date.now() - 10 * 86_400_000) } });
    await requestCancellation(t.tenant.id, {});

    const events = await prisma.billingEvent.findMany({ where: { subscriptionId: sub.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.type)).toEqual(["CANCEL_REQUESTED", "CANCEL_UNDONE", "CANCELED"]);
    expect(events[0]).toMatchObject({ actorType: "OWNER" });
    expect(events[0]!.metadata).toMatchObject({ mode: "SCHEDULED", hasReason: true });
    expect(events[2]).toMatchObject({ fromStatus: "SUSPENDED", toStatus: "CANCELED", actorType: "OWNER" });
    expect(events[2]!.metadata).toMatchObject({ cancelSource: "OWNER", mode: "IMMEDIATE" });
  });

  it("cancelamento agendado que vence = voluntário (OWNER); teste não convertido = TRIAL_NOT_CONVERTED; suspensa = AUTO_SUSPENDED", async () => {
    const now = at("2026-10-15T15:00:00Z");
    const scheduled = await h.makeTenant(fixtures, "ev-sched", { billingWhatsappE164: null });
    const subScheduled = await h.makePayingSubscription(fixtures, scheduled.tenant.id, "ev-sched", { currentPeriodEnd: at("2026-10-12T10:00:00Z") });
    await prisma.subscription.update({ where: { id: subScheduled.id }, data: { cancelAtPeriodEnd: true, cancelRequestedAt: at("2026-10-01T10:00:00Z") } });

    const trial = await h.makeTenant(fixtures, "ev-trial", { billingWhatsappE164: null });
    const planTrial = await h.makePlan(fixtures, "ev-trial");
    const subTrial = await prisma.subscription.create({
      data: { tenantId: trial.tenant.id, planId: planTrial.id, status: "TRIALING", trialEndsAt: at("2026-10-01T10:00:00Z"), currentPeriodEnd: at("2026-10-01T10:00:00Z"), firstPaidAt: null, createdAt: at("2026-09-28T10:00:00Z") },
    });

    const auto = await h.makeTenant(fixtures, "ev-auto", { billingWhatsappE164: null });
    const subAuto = await h.makePayingSubscription(fixtures, auto.tenant.id, "ev-auto", { currentPeriodEnd: at("2026-08-01T10:00:00Z"), status: "SUSPENDED" });

    await runBillingTick(now, gateway, { dispatch: h.tickDispatch });
    const source = async (subscriptionId: string) => (await prisma.billingEvent.findFirstOrThrow({ where: { subscriptionId, type: "CANCELED" } })).metadata;
    expect(await source(subScheduled.id)).toMatchObject({ cancelSource: "OWNER" });
    expect(await source(subTrial.id)).toMatchObject({ cancelSource: "TRIAL_NOT_CONVERTED" });
    expect(await source(subAuto.id)).toMatchObject({ cancelSource: "AUTO_SUSPENDED" });
    // O agendado já avisou no pedido: sem aviso de encerramento automático.
    expect(await h.noticesOf(subScheduled.id)).toHaveLength(0);
  });

  it("pagamento (automático e manual), reativação pelo dono e troca de plano viram evento", async () => {
    const t = await h.makeTenant(fixtures, "ev-misc", { billingWhatsappE164: null });
    const sub = await h.makePayingSubscription(fixtures, t.tenant.id, "ev-misc", { currentPeriodEnd: new Date(Date.now() + 2 * 86_400_000) });
    const inv1 = await h.makeOpenInvoice(sub.id, { periodStart: new Date(Date.now() + 2 * 86_400_000), dueAt: new Date(Date.now() + 2 * 86_400_000), createdAt: new Date() });
    await applyInvoicePayment(inv1.id, new Date());
    const inv2 = await h.makeOpenInvoice(sub.id, { periodStart: new Date(Date.now() + 40 * 86_400_000), dueAt: new Date(Date.now() + 40 * 86_400_000), createdAt: new Date() });
    await markInvoicePaidManually(inv2.id, "admin-1", "pagou por fora");

    const higher = await prisma.plan.create({ data: { code: `it-dsc-up-${randomUUID().slice(0, 6)}`, name: "Plano maior", priceCents: 9990, maxWhatsappNumbers: 99, maxProfessionals: 99, active: true, sortOrder: 5000 } });
    fixtures.planIds.push(higher.id);
    await changePlan(t.tenant.id, higher.id);

    const types = (await prisma.billingEvent.findMany({ where: { subscriptionId: sub.id }, orderBy: { createdAt: "asc" } })).map((e) => e.type);
    expect(types).toEqual(["PAYMENT_CONFIRMED", "PAYMENT_CONFIRMED", "MANUAL_PAYMENT", "PLAN_CHANGED"]);
    const manual = await prisma.billingEvent.findFirstOrThrow({ where: { subscriptionId: sub.id, type: "MANUAL_PAYMENT" } });
    expect(manual).toMatchObject({ actorType: "ADMIN", actorUserId: "admin-1", invoiceId: inv2.id });
  });

  it("o histórico é append-only: o banco recusa UPDATE de um evento (o código só usa create)", async () => {
    const t = await h.makeTenant(fixtures, "ev-append", { billingWhatsappE164: null });
    const sub = await h.makePayingSubscription(fixtures, t.tenant.id, "ev-append", { currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000) });
    await requestCancellation(t.tenant.id, {});
    const event = await prisma.billingEvent.findFirstOrThrow({ where: { subscriptionId: sub.id } });
    await expect(prisma.billingEvent.update({ where: { id: event.id }, data: { type: "ADULTERADO" } })).rejects.toThrow();
    expect((await prisma.billingEvent.findUniqueOrThrow({ where: { id: event.id } })).type).toBe("CANCEL_REQUESTED");
  });
});

describe("cancelamento automático: e-mail com dados guardados, reativação e CSV", () => {
  it("60 dias suspensa: e-mail de conta encerrada; rodar de novo não repete", async () => {
    const t = await h.makeTenant(fixtures, "auto-60", { billingWhatsappE164: null });
    await h.makePayingSubscription(fixtures, t.tenant.id, "auto-60", { currentPeriodEnd: at("2026-08-01T10:00:00Z"), status: "SUSPENDED" });
    const now = at("2026-10-15T15:00:00Z");
    await runBillingTick(now, gateway, { dispatch: h.tickDispatch });
    const mail = mails(t.email).find((m) => m.subject.includes("foi encerrada"));
    expect(mail).toBeDefined();
    expect(mail!.text).toContain("60 dias sem pagamento");
    expect(mail!.text).toContain("Seus dados ficam guardados por 90 dias, até 13/01/2027");
    expect(mail!.text).toContain("CSV");
    expect(mail!.text).toContain(`/${t.slug}/assinatura`);
    await runBillingTick(new Date(now.getTime() + 11 * 60_000), gateway, { dispatch: h.tickDispatch });
    expect(mails(t.email).filter((m) => m.subject.includes("foi encerrada"))).toHaveLength(1);
  });

  it("teste não convertido (7 dias): texto de teste; SMTP fora no cancelamento reenvia depois, 1 vez só", async () => {
    const t = await h.makeTenant(fixtures, "auto-trial", { billingWhatsappE164: null });
    const plan = await h.makePlan(fixtures, "auto-trial");
    await prisma.subscription.create({
      data: { tenantId: t.tenant.id, planId: plan.id, status: "TRIALING", trialEndsAt: at("2026-10-01T10:00:00Z"), currentPeriodEnd: at("2026-10-01T10:00:00Z"), firstPaidAt: null, createdAt: at("2026-09-28T10:00:00Z") },
    });
    const now = at("2026-10-15T15:00:00Z");
    h.mailControl.mode = "fail";
    await runBillingTick(now, gateway, { dispatch: h.tickDispatch });
    expect(mails(t.email)).toHaveLength(0);
    h.mailControl.mode = "ok";
    await runBillingTick(new Date(now.getTime() + 6 * 60_000), gateway, { dispatch: h.tickDispatch });
    const mail = mails(t.email).find((m) => m.subject.includes("foi encerrada"));
    expect(mail!.text).toContain("o teste terminou e a assinatura não foi paga em 7 dias");
    await runBillingTick(new Date(now.getTime() + 60 * 60_000), gateway, { dispatch: h.tickDispatch });
    expect(mails(t.email).filter((m) => m.subject.includes("foi encerrada"))).toHaveLength(1);
  });

  it("quem pediu a reativação (announce:false) não recebe 'conta encerrada'", async () => {
    const t = await h.makeTenant(fixtures, "auto-react", { billingWhatsappE164: null, document: "52998224725" });
    const sub = await h.makePayingSubscription(fixtures, t.tenant.id, "auto-react", { currentPeriodEnd: at("2026-08-01T10:00:00Z"), status: "SUSPENDED" });
    const now = at("2026-10-15T15:00:00Z");
    await startReactivation(t.tenant.id, { now, gateway });
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: sub.id } })).status).toBe("CANCELED");
    await runBillingTick(now, gateway, { dispatch: h.tickDispatch });
    expect(mails(t.email).filter((m) => m.subject.includes("foi encerrada"))).toHaveLength(0);
    const auto = (await h.noticesOf(sub.id)).filter((r) => r.step === "AUTO_CANCELED");
    expect(auto.every((r) => r.status === "SKIPPED")).toBe(true);
    expect(await prisma.billingEvent.count({ where: { subscriptionId: sub.id, type: "REACTIVATION_STARTED" } })).toBe(1);
  });
});
