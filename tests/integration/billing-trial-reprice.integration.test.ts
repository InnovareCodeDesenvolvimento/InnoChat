/**
 * Reprecificação da fatura do teste (cadastro enxuto, F2) e documento na hora de pagar, contra Postgres real.
 *
 * Quem troca de ciclo, aplica cupom ou muda de plano DURANTE o teste que ainda não pagou tem a fatura aberta do fim do teste
 * ANULADA e recriada com o preço de agora (nunca editada no lugar). Aqui: anular + cancelar o Pix velho, cupom que não se
 * perde, Pix velho pago depois que não dá 12 meses, aviso "fatura chegou" sem spam, corrida entre pagamento e troca,
 * e `saveDocumentAndGeneratePixAction` (OWNER sim, STAFF não, MP fora do ar mantém o documento).
 * `sendMail` é mockado; o relógio do teste é o real (nenhum tick global roda aqui).
 */
import { randomUUID } from "node:crypto";
import { addMonths } from "date-fns";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import type { TenantContext } from "@/lib/auth/guards";

const sentEmails: { to: string; subject: string; text: string }[] = [];
vi.mock("@/lib/email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
  return {
    ...actual,
    sendMail: vi.fn(async (input: { to: string; subject: string; text: string }) => {
      sentEmails.push(input);
      return { sent: true };
    }),
  };
});

const session: { ctx: TenantContext | null } = { ctx: null };
vi.mock("@/lib/auth/guards", () => ({
  requireTenantMember: async (slug: string, roles?: string[]) => {
    const { DomainError } = await import("@/lib/errors");
    if (!session.ctx || session.ctx.tenant.slug !== slug) throw new DomainError("NOT_FOUND", "Empresa não encontrada.");
    if (roles && roles.length > 0 && !roles.includes(session.ctx.membership.role)) throw new DomainError("FORBIDDEN", "Sem permissão para esta ação.");
    return session.ctx;
  },
}));

const { signUp } = await import("@/modules/signup/service");
const { createMockMercadoPagoGateway } = await import("@/modules/billing/mercadopago.mock");
const { MercadoPagoApiError } = await import("@/modules/billing/mercadopago");
const { applyInvoicePayment, changePlan } = await import("@/modules/billing/service");
const { changeBillingCycle } = await import("@/modules/billing/billing-cycle");
const { repriceTrialInvoice, retryPendingPixCancellations } = await import("@/modules/billing/trial-reprice");
const coupons = await import("@/modules/billing/coupons");
const { saveDocumentAndGeneratePixAction } = await import("@/modules/billing/actions");

const prisma = getPrisma();
const tenantIds: string[] = [];
const userIds: string[] = [];
const couponIds: string[] = [];
const planIds: string[] = [];
const RUN = randomUUID().slice(0, 6);
let seq = 0;
const uniq = (label: string) => `${label}-${RUN}-${++seq}`;

beforeEach(() => {
  sentEmails.length = 0;
  session.ctx = null;
});
afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.coupon.deleteMany({ where: { id: { in: couponIds } } });
  await prisma.plan.deleteMany({ where: { id: { in: planIds } } });
  await prisma.$disconnect();
});

/** Plano padrão do cadastro (o ativo de menor `sortOrder`) com os 4 ciclos. */
let basePlanId: string | null = null;
async function ensureBasePlan() {
  if (basePlanId) return basePlanId;
  const plan = await prisma.plan.create({
    data: {
      code: uniq("it-reprice-base"),
      name: "Plano Reprice IT",
      priceCents: 5900,
      quarterlyPriceCents: 16800,
      semiannualPriceCents: 31900,
      annualPriceCents: 59000,
      maxWhatsappNumbers: 1,
      maxProfessionals: 1,
      active: true,
      sortOrder: -9000,
    },
  });
  planIds.push(plan.id);
  basePlanId = plan.id;
  return plan.id;
}

async function makeCoupon(over: Partial<Parameters<typeof coupons.createCoupon>[0]> = {}) {
  const coupon = await coupons.createCoupon({ code: uniq("CUPREP").toUpperCase(), kind: "PERCENT", value: 10, duration: "ONCE", ...over }, null);
  couponIds.push(coupon.id);
  return coupon;
}

type Mp = ReturnType<typeof createMockMercadoPagoGateway>;

/** Cadastra uma empresa em teste (com ou sem CPF) e devolve o que os testes precisam. */
async function signup(options: { document?: string | null; couponCode?: string; billingCycle?: "MONTHLY" | "ANNUAL" | "QUARTERLY" | "SEMIANNUAL"; mp?: Mp } = {}) {
  await ensureBasePlan();
  const mp = options.mp ?? createMockMercadoPagoGateway();
  const label = uniq("it-reprice");
  const email = `${label}@example.com`;
  const result = await signUp(
    {
      companyName: `Reprice ${label}`,
      ownerName: "Dona",
      email,
      password: "senha-forte-123",
      phone: "(84) 99999-8888",
      termsVersion: "v1",
      document: options.document === undefined ? "529.982.247-25" : options.document,
      couponCode: options.couponCode,
      billingCycle: options.billingCycle,
    },
    mp.gateway,
  );
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: result.tenantSlug } });
  tenantIds.push(tenant.id);
  userIds.push(result.userId);
  const sub = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenant.id } });
  const invoice = await prisma.invoice.findFirstOrThrow({ where: { subscriptionId: sub.id } });
  return { mp, tenant, sub, invoice, email, result };
}

const invoicesOf = (subscriptionId: string) => prisma.invoice.findMany({ where: { subscriptionId }, orderBy: { periodStart: "asc" } });
const openOf = (subscriptionId: string) => prisma.invoice.findMany({ where: { subscriptionId, status: "OPEN" } });

describe("trocar o ciclo durante o teste", () => {
  it("com CPF: anula a fatura velha, cancela o Pix velho, cria a nova no ciclo com Pix novo e o mesmo vencimento", async () => {
    const s = await signup();
    expect(s.invoice.mpPaymentId).toBeTruthy();
    expect(sentEmails.some((e) => e.subject.includes("Fatura"))).toBe(true);

    const result = await changeBillingCycle(s.tenant.id, "ANNUAL", s.mp.gateway);
    expect(result).toMatchObject({ billingCycle: "ANNUAL", trialInvoiceRepriced: true, openInvoiceKeepsOldCycle: false });

    const all = await invoicesOf(s.sub.id);
    expect(all).toHaveLength(2);
    const old = all.find((i) => i.id === s.invoice.id)!;
    const fresh = all.find((i) => i.id !== s.invoice.id)!;
    expect(old.status).toBe("VOID");
    expect(s.mp.cancelledPaymentIds).toContain(s.invoice.mpPaymentId);
    expect(fresh).toMatchObject({ status: "OPEN", isTrialConversion: true, cycle: "ANNUAL", amountCents: 59000, discountCents: 0 });
    expect(fresh.dueAt.getTime()).toBe(s.invoice.dueAt.getTime());
    expect(fresh.periodEnd.getTime()).toBe(s.invoice.periodEnd.getTime());
    expect(fresh.periodStart.getTime()).toBeGreaterThan(s.invoice.periodStart.getTime());
    expect(fresh.mpPaymentId).toBeTruthy();
    expect(fresh.mpPaymentId).not.toBe(s.invoice.mpPaymentId);
    expect(fresh.pixCopyPaste).toBeTruthy();
    expect(await openOf(s.sub.id)).toHaveLength(1);

    // O histórico registra a recriação.
    const event = await prisma.billingEvent.findFirstOrThrow({ where: { subscriptionId: s.sub.id, invoiceId: fresh.id, type: "INVOICE_CREATED" } });
    expect(event.metadata).toMatchObject({ trial: true, repriced: true, replacedInvoiceId: s.invoice.id, cycle: "ANNUAL" });

    // "Sua fatura chegou" já foi avisada na fatura anterior: a nova nasce com o aviso tratado (nada de spam por clique).
    const notice = await prisma.billingNotice.findFirstOrThrow({ where: { invoiceId: fresh.id, step: "INVOICE_CREATED", channel: "EMAIL" } });
    expect(notice).toMatchObject({ status: "SKIPPED", skippedReason: "STATUS_CHANGED" });
  });

  it("cancelamento do Pix velho que o MP recusou na hora fica pendente e o tick tenta de novo até dar certo", async () => {
    const s = await signup();
    const oldPayment = s.invoice.mpPaymentId!;
    const cancel = vi.spyOn(s.mp.gateway, "cancelPayment").mockRejectedValueOnce(new Error("MP fora do ar"));
    await changeBillingCycle(s.tenant.id, "ANNUAL", s.mp.gateway);
    expect(s.mp.cancelledPaymentIds).not.toContain(oldPayment);
    const pending = await prisma.providerEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: "pix-cancel", providerEventId: oldPayment } } });
    expect(pending.processedAt).toBeNull();

    const outcome = await retryPendingPixCancellations(new Date(), s.mp.gateway);
    expect(outcome.cancelled).toBeGreaterThanOrEqual(1);
    expect(s.mp.cancelledPaymentIds).toContain(oldPayment);
    expect((await prisma.providerEvent.findUniqueOrThrow({ where: { id: pending.id } })).processedAt).not.toBeNull();
    cancel.mockRestore();
    // Já processado: não tenta de novo.
    const again = await retryPendingPixCancellations(new Date(), s.mp.gateway);
    expect(s.mp.cancelledPaymentIds.filter((id) => id === oldPayment)).toHaveLength(1);
  });

  it("pagar a fatura NOVA (anual) dá 12 meses; pagar o Pix VELHO depois só marca paidWhileVoidAt (nunca 12 meses por 1 mensal)", async () => {
    const s = await signup();
    const oldPaymentId = s.invoice.mpPaymentId!;
    await changeBillingCycle(s.tenant.id, "ANNUAL", s.mp.gateway);
    const fresh = (await openOf(s.sub.id))[0]!;

    // O Pix velho (mensal) é pago numa corrida: nada baixa, a fatura anulada só fica marcada para o admin decidir o estorno.
    const late = await applyInvoicePayment(s.invoice.id, new Date(), oldPaymentId);
    expect(late).toMatchObject({ voided: true });
    const stillTrial = await prisma.subscription.findUniqueOrThrow({ where: { id: s.sub.id } });
    expect(stillTrial.status).toBe("TRIALING");
    expect(stillTrial.firstPaidAt).toBeNull();
    expect(stillTrial.currentPeriodEnd.getTime()).toBe(s.sub.currentPeriodEnd.getTime());
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoice.id } })).paidWhileVoidAt).not.toBeNull();

    // A fatura anual paga soma 12 meses ao fim do teste.
    await applyInvoicePayment(fresh.id, new Date(), fresh.mpPaymentId!);
    const paid = await prisma.subscription.findUniqueOrThrow({ where: { id: s.sub.id } });
    expect(paid.status).toBe("ACTIVE");
    expect(paid.currentPeriodEnd.getTime()).toBe(addMonths(s.sub.currentPeriodEnd, 12).getTime());
  });

  it("sem CPF: nova fatura sem Pix, nada a cancelar, e o aviso da fatura continua PENDENTE (sai com o Pix quando o documento entrar)", async () => {
    const s = await signup({ document: null });
    expect(s.invoice.mpPaymentId).toBeNull();
    const result = await changeBillingCycle(s.tenant.id, "QUARTERLY", s.mp.gateway);
    expect(result.trialInvoiceRepriced).toBe(true);

    const fresh = (await openOf(s.sub.id))[0]!;
    expect(fresh).toMatchObject({ cycle: "QUARTERLY", amountCents: 16800, mpPaymentId: null, pixCopyPaste: null });
    expect(s.mp.cancelledPaymentIds).toHaveLength(0);
    expect(await prisma.billingNotice.count({ where: { subscriptionId: s.sub.id, step: "INVOICE_CREATED" } })).toBe(0);
    expect(sentEmails.some((e) => e.subject.includes("Fatura"))).toBe(false);
  });

  it("mesmo ciclo (nada muda) não anula nem recria a fatura; a repetição de repriceTrialInvoice também não (UNCHANGED)", async () => {
    const s = await signup();
    const result = await changeBillingCycle(s.tenant.id, "MONTHLY", s.mp.gateway);
    expect(result).toMatchObject({ trialInvoiceRepriced: false, openInvoiceKeepsOldCycle: true });
    expect(await repriceTrialInvoice(s.tenant.id, { gateway: s.mp.gateway })).toEqual({ repriced: false, reason: "UNCHANGED" });
    const all = await invoicesOf(s.sub.id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: s.invoice.id, status: "OPEN", mpPaymentId: s.invoice.mpPaymentId });
    expect(s.mp.cancelledPaymentIds).toHaveLength(0);
  });

  it("vai e volta várias vezes: sempre uma única fatura aberta, e cada Pix velho é cancelado", async () => {
    const s = await signup();
    await changeBillingCycle(s.tenant.id, "ANNUAL", s.mp.gateway);
    await changeBillingCycle(s.tenant.id, "SEMIANNUAL", s.mp.gateway);
    await changeBillingCycle(s.tenant.id, "MONTHLY", s.mp.gateway);
    const all = await invoicesOf(s.sub.id);
    expect(all).toHaveLength(4);
    expect(all.filter((i) => i.status === "OPEN")).toHaveLength(1);
    expect(all.filter((i) => i.status === "VOID")).toHaveLength(3);
    expect(all.find((i) => i.status === "OPEN")).toMatchObject({ cycle: "MONTHLY", amountCents: 5900 });
    expect(s.mp.cancelledPaymentIds).toHaveLength(3);
    // O aviso foi tratado uma vez por fatura nova e nunca virou e-mail extra.
    expect(sentEmails.filter((e) => e.subject.includes("Fatura"))).toHaveLength(1); // só o do cadastro
  });

  it("depois do primeiro pagamento a regra volta a ser 'a partir da próxima fatura' (nada é recriado)", async () => {
    const s = await signup();
    await applyInvoicePayment(s.invoice.id, new Date(), s.invoice.mpPaymentId!);
    const before = await invoicesOf(s.sub.id);
    expect(await repriceTrialInvoice(s.tenant.id, { gateway: s.mp.gateway })).toEqual({ repriced: false, reason: "NOT_TRIAL" });
    const result = await changeBillingCycle(s.tenant.id, "ANNUAL", s.mp.gateway);
    expect(result.trialInvoiceRepriced).toBe(false);
    expect(await invoicesOf(s.sub.id)).toHaveLength(before.length);
  });
});

describe("cupom e a fatura do teste", () => {
  it("cupom do cadastro (ONCE) + troca de ciclo: o ciclo gasto volta e é gasto de novo na fatura nova; o uso do cupom não dobra", async () => {
    const coupon = await makeCoupon({ kind: "PERCENT", value: 10, duration: "ONCE" });
    const s = await signup({ couponCode: coupon.code });
    expect(s.invoice).toMatchObject({ discountCents: 590, amountCents: 5310, couponCode: coupon.code });
    expect(s.sub.couponId).toBeNull(); // ONCE: já gasto na fatura do teste

    await changeBillingCycle(s.tenant.id, "ANNUAL", s.mp.gateway);
    const fresh = (await openOf(s.sub.id))[0]!;
    expect(fresh).toMatchObject({ cycle: "ANNUAL", discountCents: 5900, amountCents: 53100, couponCode: coupon.code });
    const redemption = await prisma.couponRedemption.findUniqueOrThrow({ where: { couponId_tenantId: { couponId: coupon.id, tenantId: s.tenant.id } } });
    expect(redemption).toMatchObject({ invoiceId: fresh.id, discountCents: 5900 });
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: s.sub.id } });
    expect(sub).toMatchObject({ couponId: null, couponCyclesRemaining: null });
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).redemptionsCount).toBe(1);
  });

  it("cupom só do mensal: no anual a fatura sai cheia e o cupom fica GUARDADO; ao voltar para o mensal ele é gasto de novo", async () => {
    const coupon = await makeCoupon({ kind: "PERCENT", value: 10, duration: "ONCE", appliesToCycles: ["MONTHLY"] });
    const s = await signup({ couponCode: coupon.code });
    expect(s.invoice.discountCents).toBe(590);

    await changeBillingCycle(s.tenant.id, "ANNUAL", s.mp.gateway);
    const annual = (await openOf(s.sub.id))[0]!;
    expect(annual).toMatchObject({ cycle: "ANNUAL", discountCents: 0, amountCents: 59000, couponCode: null });
    const parked = await prisma.subscription.findUniqueOrThrow({ where: { id: s.sub.id } });
    expect(parked).toMatchObject({ couponId: coupon.id, couponCyclesRemaining: 1 }); // devolvido e guardado
    expect((await prisma.couponRedemption.findUniqueOrThrow({ where: { couponId_tenantId: { couponId: coupon.id, tenantId: s.tenant.id } } })).invoiceId).toBeNull();

    await changeBillingCycle(s.tenant.id, "MONTHLY", s.mp.gateway);
    const monthly = (await openOf(s.sub.id))[0]!;
    expect(monthly).toMatchObject({ cycle: "MONTHLY", discountCents: 590, amountCents: 5310, couponCode: coupon.code });
    const spent = await prisma.subscription.findUniqueOrThrow({ where: { id: s.sub.id } });
    expect(spent).toMatchObject({ couponId: null, couponCyclesRemaining: null });
    expect((await prisma.couponRedemption.findUniqueOrThrow({ where: { couponId_tenantId: { couponId: coupon.id, tenantId: s.tenant.id } } })).invoiceId).toBe(monthly.id);
    expect((await prisma.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).redemptionsCount).toBe(1);
  });

  it("cupom de 3 ciclos já em uso: a troca devolve 1 ciclo e gasta 1 (o contador não anda)", async () => {
    const coupon = await makeCoupon({ kind: "PERCENT", value: 10, duration: "N_CYCLES", durationCycles: 3 });
    const s = await signup({ couponCode: coupon.code });
    expect(s.sub).toMatchObject({ couponId: coupon.id, couponCyclesRemaining: 2 });
    await changeBillingCycle(s.tenant.id, "QUARTERLY", s.mp.gateway);
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: s.sub.id } });
    expect(sub).toMatchObject({ couponId: coupon.id, couponCyclesRemaining: 2 });
    expect((await openOf(s.sub.id))[0]).toMatchObject({ cycle: "QUARTERLY", discountCents: 1680, amountCents: 15120 });
  });

  it("aplicar um cupom no teste (tela Assinatura) recria a fatura já com o desconto", async () => {
    const coupon = await makeCoupon({ kind: "AMOUNT", value: 1000, duration: "ONCE" });
    const s = await signup();
    const applied = await coupons.applyCouponToSubscription(s.tenant.id, coupon.code.toLowerCase(), new Date(), s.mp.gateway);
    expect(applied.trialInvoiceRepriced).toBe(true);
    const all = await invoicesOf(s.sub.id);
    expect(all.filter((i) => i.status === "VOID")).toHaveLength(1);
    const fresh = (await openOf(s.sub.id))[0]!;
    expect(fresh).toMatchObject({ discountCents: 1000, amountCents: 4900, couponCode: coupon.code, cycle: "MONTHLY" });
    expect((await prisma.couponRedemption.findUniqueOrThrow({ where: { couponId_tenantId: { couponId: coupon.id, tenantId: s.tenant.id } } })).invoiceId).toBe(fresh.id);
    expect(s.mp.cancelledPaymentIds).toContain(s.invoice.mpPaymentId);
  });

  it("cupom recusado na tela não mexe na fatura do teste", async () => {
    const s = await signup();
    await expect(coupons.applyCouponToSubscription(s.tenant.id, "NAO-EXISTE-XYZ", new Date(), s.mp.gateway)).rejects.toMatchObject({ code: "COUPON_INVALID" });
    const all = await invoicesOf(s.sub.id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: s.invoice.id, status: "OPEN" });
    expect(s.mp.cancelledPaymentIds).toHaveLength(0);
  });
});

describe("trocar de plano durante o teste", () => {
  it("upgrade imediato: a fatura do teste sai no preço do plano novo", async () => {
    const s = await signup();
    const higher = await prisma.plan.create({
      data: { code: uniq("it-reprice-up"), name: "Plano maior IT", priceCents: 9990, maxWhatsappNumbers: 9, maxProfessionals: 9, active: true, sortOrder: 9100 },
    });
    planIds.push(higher.id);
    const result = await changePlan(s.tenant.id, higher.id, s.mp.gateway);
    expect(result).toMatchObject({ appliedImmediately: true, trialInvoiceRepriced: true });
    expect((await invoicesOf(s.sub.id)).filter((i) => i.status === "VOID")).toHaveLength(1);
    expect((await openOf(s.sub.id))[0]).toMatchObject({ amountCents: 9990, cycle: "MONTHLY" });
  });
});

describe("corrida entre pagamento e troca de ciclo", () => {
  it("pagamento e troca ao mesmo tempo: ou a fatura foi paga (nada recriado) ou foi anulada e o pagamento só marca paidWhileVoidAt; nunca as duas coisas", async () => {
    const s = await signup();
    const [payment, change] = await Promise.allSettled([
      applyInvoicePayment(s.invoice.id, new Date(), s.invoice.mpPaymentId!),
      changeBillingCycle(s.tenant.id, "ANNUAL", s.mp.gateway),
    ]);
    expect(payment.status).toBe("fulfilled");
    expect(change.status).toBe("fulfilled");

    const old = await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoice.id } });
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: s.sub.id } });
    const open = await openOf(s.sub.id);
    if (old.status === "PAID") {
      // O pagamento ganhou: a assinatura virou ACTIVE e a troca vale "a partir da próxima fatura".
      expect(sub.status).toBe("ACTIVE");
      expect(old.paidWhileVoidAt).toBeNull();
      expect(open.filter((i) => i.isTrialConversion)).toHaveLength(0);
    } else {
      // A troca ganhou: a velha foi anulada, o dinheiro marcado para o admin, e a assinatura NÃO virou ACTIVE por ela.
      expect(old.status).toBe("VOID");
      expect(old.paidWhileVoidAt).not.toBeNull();
      expect(sub.status).toBe("TRIALING");
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ cycle: "ANNUAL", amountCents: 59000 });
    }
  });

  it("duas trocas de ciclo ao mesmo tempo: terminam em UMA fatura aberta e as demais anuladas", async () => {
    const s = await signup();
    await Promise.all([changeBillingCycle(s.tenant.id, "ANNUAL", s.mp.gateway), changeBillingCycle(s.tenant.id, "QUARTERLY", s.mp.gateway)]);
    const all = await invoicesOf(s.sub.id);
    expect(all.filter((i) => i.status === "OPEN")).toHaveLength(1);
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { id: s.sub.id } });
    expect(all.find((i) => i.status === "OPEN")!.cycle).toBe(sub.billingCycle); // a fatura aberta é a do ciclo que ficou
  });
});

describe("saveDocumentAndGeneratePixAction (documento na hora de pagar)", () => {
  function ctxFor(s: Awaited<ReturnType<typeof signup>>, role: "OWNER" | "STAFF"): TenantContext {
    return {
      tenant: { id: s.tenant.id, slug: s.tenant.slug, name: s.tenant.name, timezone: s.tenant.timezone },
      membership: { id: "m-1", role },
      user: { id: s.result.userId },
    };
  }

  it("OWNER: grava o CPF (só dígitos), gera o Pix da fatura aberta e registra auditoria sem o número", async () => {
    const s = await signup({ document: null });
    session.ctx = ctxFor(s, "OWNER");
    // O gateway real não está configurado nos testes: a action usa o que `getMercadoPagoGateway` entrega, então injetamos via módulo.
    const mpModule = await import("@/modules/billing/mercadopago");
    const spy = vi.spyOn(mpModule, "getMercadoPagoGateway").mockResolvedValue(s.mp.gateway);
    try {
      const result = await saveDocumentAndGeneratePixAction(s.tenant.slug, { document: "529.982.247-25" });
      expect(result).toMatchObject({ ok: true, data: { invoiceId: s.invoice.id } });
      if (!result.ok) throw new Error("esperado ok");
      expect(result.data.pixCopyPaste).toBeTruthy();

      expect((await prisma.tenant.findUniqueOrThrow({ where: { id: s.tenant.id } })).document).toBe("52998224725");
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoice.id } });
      expect(invoice.pixCopyPaste).toBe(result.data.pixCopyPaste);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { tenantId: s.tenant.id, action: "settings.document_changed" } });
      expect(JSON.stringify(audit)).not.toContain("52998224725");
      expect(JSON.stringify(audit)).toContain("final 25");

      // Segunda chamada com Pix vigente: devolve o mesmo, sem gerar outro QR.
      const again = await saveDocumentAndGeneratePixAction(s.tenant.slug, { document: "52998224725" });
      expect(again).toMatchObject({ ok: true, data: { invoiceId: s.invoice.id, pixCopyPaste: result.data.pixCopyPaste } });
    } finally {
      spy.mockRestore();
    }
  });

  it("STAFF não pode (FORBIDDEN) e o documento não é gravado", async () => {
    const s = await signup({ document: null });
    session.ctx = ctxFor(s, "STAFF");
    const result = await saveDocumentAndGeneratePixAction(s.tenant.slug, { document: "529.982.247-25" });
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: s.tenant.id } })).document).toBeNull();
  });

  it("documento inválido: INVALID_DOCUMENT e nada é gravado", async () => {
    const s = await signup({ document: null });
    session.ctx = ctxFor(s, "OWNER");
    expect(await saveDocumentAndGeneratePixAction(s.tenant.slug, { document: "111.111.111-11" })).toMatchObject({ ok: false, error: { code: "INVALID_DOCUMENT" } });
    expect(await saveDocumentAndGeneratePixAction(s.tenant.slug, { document: "" })).toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: s.tenant.id } })).document).toBeNull();
  });

  it("Mercado Pago fora do ar: o documento FICA salvo e o erro é MERCADOPAGO_* (a tela oferece gerar de novo)", async () => {
    const s = await signup({ document: null });
    session.ctx = ctxFor(s, "OWNER");
    const mpModule = await import("@/modules/billing/mercadopago");
    const failing = {
      createPixPayment: vi.fn().mockRejectedValue(new MercadoPagoApiError("fora do ar", 503, "unavailable")),
      cancelPayment: vi.fn(),
      getPayment: vi.fn(),
    };
    const spy = vi.spyOn(mpModule, "getMercadoPagoGateway").mockResolvedValue(failing);
    try {
      const result = await saveDocumentAndGeneratePixAction(s.tenant.slug, { document: "529.982.247-25" });
      expect(result).toMatchObject({ ok: false, error: { code: "MERCADOPAGO_UNAVAILABLE" } });
      expect((await prisma.tenant.findUniqueOrThrow({ where: { id: s.tenant.id } })).document).toBe("52998224725");
      expect((await prisma.invoice.findUniqueOrThrow({ where: { id: s.invoice.id } })).pixCopyPaste).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("empresa de OUTRA conta não chega aqui: o slug do guard decide a empresa (nunca um id do cliente)", async () => {
    const a = await signup({ document: null });
    const b = await signup({ document: null });
    session.ctx = ctxFor(a, "OWNER");
    const result = await saveDocumentAndGeneratePixAction(b.tenant.slug, { document: "529.982.247-25" });
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: b.tenant.id } })).document).toBeNull();
  });
});
