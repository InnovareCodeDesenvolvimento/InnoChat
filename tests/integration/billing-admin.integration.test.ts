/**
 * Admin → Cobrança (docs/contratos.md, "Admin Cobrança") contra Postgres real:
 * `listInvoicesAdmin` (paginação/filtros), `billingMonthlyTotals`, `listDelinquentCompanies`,
 * `regeneratePixForInvoiceAdmin` e `markInvoicePaidManually` (idempotência + auditoria).
 */
import { randomUUID } from "node:crypto";
import { addMonths } from "date-fns";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";

vi.mock("@/lib/email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
  return { ...actual, sendMail: vi.fn(async () => ({ sent: true })) };
});

const {
  billingMonthlyTotals,
  listDelinquentCompanies,
  listInvoicesAdmin,
  markInvoicePaidManually,
  reactivateCompanyManually,
  regeneratePixForInvoiceAdmin,
} = await import("@/modules/billing/admin-service");
const { applyInvoicePayment, findOwnInvoiceOrThrow, regeneratePixForInvoice } = await import("@/modules/billing/service");
const { createMockMercadoPagoGateway } = await import("@/modules/billing/mercadopago.mock");

const prisma = getPrisma();
const cleanupTenantIds: string[] = [];
const cleanupUserIds: string[] = [];

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: cleanupTenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
  await prisma.$disconnect();
});

async function makePlan(priceCents = 5000) {
  return prisma.plan.create({
    data: {
      code: `it-admin-plan-${Date.now()}-${randomUUID().slice(0, 6)}`,
      name: "Plano IT Admin",
      priceCents,
      maxWhatsappNumbers: 1,
      maxProfessionals: 1,
      active: false,
      sortOrder: 999,
    },
  });
}

async function makeTenantWithSubscriptionAndInvoice(params: {
  label: string;
  document?: string | null;
  subscriptionStatus?: "TRIALING" | "ACTIVE" | "PAST_DUE" | "SUSPENDED" | "CANCELED";
  currentPeriodEnd?: Date;
  invoiceStatus?: "OPEN" | "PAID" | "EXPIRED" | "VOID";
  dueAt?: Date;
  paidAt?: Date | null;
  /** Padrão: já pagou (`now`) salvo TRIALING. Passe `null` para simular teste não convertido. */
  firstPaidAt?: Date | null;
  isTrialConversion?: boolean;
}) {
  const slug = `it-admin-${params.label}-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const tenant = await prisma.tenant.create({
    data: { slug, name: `Admin ${params.label}`, timezone: "UTC", document: params.document ?? "52998224725" },
  });
  cleanupTenantIds.push(tenant.id);

  const user = await prisma.user.create({ data: { email: `${slug}@example.com`, passwordHash: "x", emailVerifiedAt: new Date() } });
  cleanupUserIds.push(user.id);
  await prisma.membership.create({ data: { userId: user.id, tenantId: tenant.id, role: "OWNER" } });

  const plan = await makePlan();
  const now = new Date();
  const currentPeriodEnd = params.currentPeriodEnd ?? addMonths(now, 1);

  const subscription = await prisma.subscription.create({
    data: {
      tenantId: tenant.id,
      planId: plan.id,
      status: params.subscriptionStatus ?? "ACTIVE",
      currentPeriodEnd,
      firstPaidAt: params.firstPaidAt !== undefined ? params.firstPaidAt : params.subscriptionStatus === "TRIALING" ? null : now,
    },
  });

  const invoice = await prisma.invoice.create({
    data: {
      subscriptionId: subscription.id,
      amountCents: plan.priceCents,
      periodStart: now,
      periodEnd: currentPeriodEnd,
      dueAt: params.dueAt ?? currentPeriodEnd,
      status: params.invoiceStatus ?? "OPEN",
      paidAt: params.paidAt ?? null,
      isTrialConversion: params.isTrialConversion ?? false,
    },
  });

  return { tenant, user, plan, subscription, invoice };
}

describe("listInvoicesAdmin", () => {
  it("lista faturas de todas as empresas, filtra por status e pagina por página", async () => {
    const { tenant, invoice } = await makeTenantWithSubscriptionAndInvoice({ label: "list-open", invoiceStatus: "OPEN" });
    const { invoice: paidInvoice } = await makeTenantWithSubscriptionAndInvoice({ label: "list-paid", invoiceStatus: "PAID", paidAt: new Date() });

    const openOnly = await listInvoicesAdmin({ status: "OPEN", tenantId: tenant.id });
    expect(openOnly.items.some((i) => i.id === invoice.id)).toBe(true);
    expect(openOnly.items.every((i) => i.status === "OPEN")).toBe(true);

    const paidOnly = await listInvoicesAdmin({ status: "PAID" });
    expect(paidOnly.items.some((i) => i.id === paidInvoice.id)).toBe(true);

    // Paginação por página: pageSize mínimo de 10; com mais de 1 fatura no total, `totalItems` conta todas.
    const page1 = await listInvoicesAdmin({ page: 1, pageSize: 10 });
    expect(page1.items.length).toBeGreaterThanOrEqual(1);
    expect(page1.totalItems).toBeGreaterThanOrEqual(2);
  });
});

describe("billingMonthlyTotals", () => {
  it("soma recebido (PAID no mês), em aberto (não vencido) e vencido (OPEN vencido), e o MRR de assinaturas ACTIVE", async () => {
    const now = new Date();
    const { plan } = await makeTenantWithSubscriptionAndInvoice({
      label: "totals-paid",
      invoiceStatus: "PAID",
      paidAt: now,
      subscriptionStatus: "ACTIVE",
    });
    await makeTenantWithSubscriptionAndInvoice({
      label: "totals-open",
      invoiceStatus: "OPEN",
      dueAt: addMonths(now, 1),
      subscriptionStatus: "ACTIVE",
    });
    await makeTenantWithSubscriptionAndInvoice({
      label: "totals-overdue",
      invoiceStatus: "OPEN",
      dueAt: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000),
      subscriptionStatus: "PAST_DUE",
    });

    const totals = await billingMonthlyTotals(now);
    expect(totals.receivedCents).toBeGreaterThanOrEqual(plan.priceCents);
    expect(totals.openCents).toBeGreaterThanOrEqual(plan.priceCents);
    expect(totals.overdueCents).toBeGreaterThanOrEqual(plan.priceCents);
    expect(totals.mrrCents).toBeGreaterThanOrEqual(plan.priceCents);
  });
});

describe("Teste não convertido no Admin → Cobrança (decisão do dono, 2026-09-29)", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it("fatura de teste OPEN vai para trialCents e NÃO soma em openCents nem overdueCents (antes ou depois de vencer)", async () => {
    const now = new Date();
    const before = await billingMonthlyTotals(now);
    const { plan } = await makeTenantWithSubscriptionAndInvoice({
      label: "trial-future",
      subscriptionStatus: "TRIALING",
      invoiceStatus: "OPEN",
      isTrialConversion: true,
      dueAt: addMonths(now, 1),
    });
    await makeTenantWithSubscriptionAndInvoice({
      label: "trial-overdue",
      subscriptionStatus: "SUSPENDED",
      firstPaidAt: null,
      invoiceStatus: "OPEN",
      isTrialConversion: true,
      dueAt: new Date(now.getTime() - 2 * DAY_MS),
    });
    const after = await billingMonthlyTotals(now);

    expect(after.trialCents - before.trialCents).toBe(plan.priceCents * 2);
    expect(after.trialCount - before.trialCount).toBe(2);
    expect(after.openCents).toBe(before.openCents);
    expect(after.overdueCents).toBe(before.overdueCents);
    expect(after.mrrCents).toBe(before.mrrCents);
  });

  it("fatura de teste VOID de conta CANCELED não entra em nenhum total", async () => {
    const now = new Date();
    const before = await billingMonthlyTotals(now);
    await makeTenantWithSubscriptionAndInvoice({
      label: "trial-void",
      subscriptionStatus: "CANCELED",
      firstPaidAt: null,
      invoiceStatus: "VOID",
      isTrialConversion: true,
      dueAt: new Date(now.getTime() - 20 * DAY_MS),
    });
    const after = await billingMonthlyTotals(now);
    expect(after).toEqual(before);
  });

  it("lista de faturas identifica a de teste (kind TRIAL) e a anulada aparece com status VOID", async () => {
    const { invoice } = await makeTenantWithSubscriptionAndInvoice({
      label: "trial-kind",
      subscriptionStatus: "CANCELED",
      firstPaidAt: null,
      invoiceStatus: "VOID",
      isTrialConversion: true,
    });
    const { invoice: regular } = await makeTenantWithSubscriptionAndInvoice({ label: "regular-kind", invoiceStatus: "OPEN" });

    const voids = await listInvoicesAdmin({ status: "VOID", pageSize: 100 });
    expect(voids.items.find((i) => i.id === invoice.id)).toMatchObject({ kind: "TRIAL", status: "VOID" });
    const opens = await listInvoicesAdmin({ status: "OPEN", pageSize: 100 });
    expect(opens.items.find((i) => i.id === regular.id)?.kind).toBe("REGULAR");
  });

  it("empresa que nunca pagou (teste não convertido) NÃO aparece como inadimplente; ex-pagante sim", async () => {
    const { tenant: trialTenant } = await makeTenantWithSubscriptionAndInvoice({
      label: "delinq-trial",
      subscriptionStatus: "SUSPENDED",
      firstPaidAt: null,
      currentPeriodEnd: new Date(Date.now() - 3 * DAY_MS),
      isTrialConversion: true,
    });
    const { tenant: payingTenant } = await makeTenantWithSubscriptionAndInvoice({
      label: "delinq-paying",
      subscriptionStatus: "PAST_DUE",
      currentPeriodEnd: new Date(Date.now() - 12 * 60 * 60 * 1000),
    });
    const delinquents = await listDelinquentCompanies(new Date());
    expect(delinquents.some((d) => d.tenantId === trialTenant.id)).toBe(false);
    expect(delinquents.some((d) => d.tenantId === payingTenant.id)).toBe(true);
  });

  it("pagamento de fatura VOID não reativa: applyInvoicePayment devolve voided e nada muda; baixa manual recusa", async () => {
    const { subscription, invoice } = await makeTenantWithSubscriptionAndInvoice({
      label: "void-late-payment",
      subscriptionStatus: "CANCELED",
      firstPaidAt: null,
      invoiceStatus: "VOID",
      isTrialConversion: true,
    });
    const result = await applyInvoicePayment(invoice.id, new Date());
    expect(result).toEqual({ alreadyProcessed: false, voided: true });

    const invoiceAfter = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    const subAfter = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(invoiceAfter.status).toBe("VOID");
    expect(invoiceAfter.paidAt).toBeNull();
    expect(subAfter.status).toBe("CANCELED");
    expect(subAfter.firstPaidAt).toBeNull();

    await expect(markInvoicePaidManually(invoice.id, "admin-x", "cliente pagou")).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("pagamento da fatura de teste com a conta SUSPENDED reativa e grava firstPaidAt (dentro dos 7 dias)", async () => {
    const { subscription, invoice } = await makeTenantWithSubscriptionAndInvoice({
      label: "trial-late-paid",
      subscriptionStatus: "SUSPENDED",
      firstPaidAt: null,
      currentPeriodEnd: new Date(Date.now() - 3 * DAY_MS),
      isTrialConversion: true,
    });
    const paidAt = new Date();
    await applyInvoicePayment(invoice.id, paidAt);

    const subAfter = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(subAfter.status).toBe("ACTIVE");
    expect(subAfter.firstPaidAt?.getTime()).toBe(paidAt.getTime());
  });

  it("reativação manual anula a fatura de teste OPEN (não fica em 'Em teste' para sempre)", async () => {
    const { tenant, invoice } = await makeTenantWithSubscriptionAndInvoice({
      label: "reactivate-voids",
      subscriptionStatus: "SUSPENDED",
      firstPaidAt: null,
      isTrialConversion: true,
    });
    await reactivateCompanyManually(tenant.id);
    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("VOID");
  });
});

describe("listDelinquentCompanies", () => {
  it("lista só PAST_DUE/SUSPENDED, com dias de atraso a partir de currentPeriodEnd", async () => {
    const now = new Date();
    const overdueBy10Days = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    const { tenant } = await makeTenantWithSubscriptionAndInvoice({
      label: "delinquent",
      subscriptionStatus: "SUSPENDED",
      currentPeriodEnd: overdueBy10Days,
    });
    await makeTenantWithSubscriptionAndInvoice({ label: "healthy", subscriptionStatus: "ACTIVE" });

    const delinquents = await listDelinquentCompanies(now);
    const found = delinquents.find((d) => d.tenantId === tenant.id);
    expect(found).toBeTruthy();
    expect(found!.status).toBe("SUSPENDED");
    expect(found!.daysOverdue).toBeGreaterThanOrEqual(10);
    expect(delinquents.every((d) => d.status === "PAST_DUE" || d.status === "SUSPENDED")).toBe(true);
  });
});

describe("regeneratePixForInvoiceAdmin", () => {
  it("resolve o e-mail do OWNER e gera o Pix (mesmo caminho de regeneratePixForInvoice)", async () => {
    const { invoice } = await makeTenantWithSubscriptionAndInvoice({ label: "regen-pix", invoiceStatus: "OPEN" });
    const { gateway } = createMockMercadoPagoGateway();

    const updated = await regeneratePixForInvoiceAdmin(invoice.id, gateway);
    expect(updated.pixCopyPaste).toBeTruthy();
  });

  it("NOT_FOUND para fatura inexistente", async () => {
    await expect(regeneratePixForInvoiceAdmin("invoice-inexistente")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // MISSING_DOCUMENT: o Mercado Pago não pode ser apontado para um servidor HTTP fake local
  // (diferente da Evolution/n8n) — `API_BASE` em `src/modules/billing/mercadopago.ts` é uma
  // constante fixa (`https://api.mercadopago.com`), sem campo equivalente a
  // `n8nBaseUrl`/Evolution em `PlatformSettings`. `regeneratePixForInvoice`/`...Admin` só aceitam
  // o gateway por injeção de dependência (`gateway?: MercadoPagoGateway`) — o mock reproduz a
  // MESMA falha cedo do gateway real quando falta `payerDocument`, o que É o comportamento sob
  // teste aqui (ver `mercadopago.mock.ts`). Reportado no handoff como gap de arquitetura para um
  // futuro `mercadoPagoBaseUrl` opcional, dando ao MP a mesma paridade de teste que Evolution/n8n.
  it("MERCADOPAGO_MISSING_DOCUMENT quando o tenant não tem CPF/CNPJ cadastrado", async () => {
    const { tenant, invoice } = await makeTenantWithSubscriptionAndInvoice({ label: "regen-pix-sem-doc", invoiceStatus: "OPEN" });
    // `document ?? "52998224725"` no helper trata `null` como "não informado" (nullish) e
    // aplicaria o padrão de qualquer jeito — só um UPDATE depois garante `document: null` de
    // verdade no banco.
    await prisma.tenant.update({ where: { id: tenant.id }, data: { document: null } });
    const { gateway } = createMockMercadoPagoGateway();

    await expect(regeneratePixForInvoiceAdmin(invoice.id, gateway)).rejects.toMatchObject({ code: "MERCADOPAGO_MISSING_DOCUMENT" });
  });
});

describe("markInvoicePaidManually", () => {
  it("marca PAID, avança o ciclo e registra auditoria (ProviderEvent provider=manual)", async () => {
    const { invoice, subscription } = await makeTenantWithSubscriptionAndInvoice({ label: "manual-pay", invoiceStatus: "OPEN" });
    const adminId = "admin-fake-id";

    const result = await markInvoicePaidManually(invoice.id, adminId, "Cliente pagou por transferência, fora do Pix.");
    expect(result.alreadyProcessed).toBe(false);

    const updatedInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(updatedInvoice.status).toBe("PAID");
    expect(updatedInvoice.paidAt).not.toBeNull();

    const updatedSubscription = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(updatedSubscription.status).toBe("ACTIVE");

    const audit = await prisma.providerEvent.findUnique({
      where: { provider_providerEventId: { provider: "manual", providerEventId: invoice.id } },
    });
    expect(audit).toBeTruthy();
    expect((audit!.payload as { adminId: string; reason: string }).adminId).toBe(adminId);
    expect((audit!.payload as { adminId: string; reason: string }).reason).toContain("transferência");
  });

  it("idempotente: chamar de novo na mesma fatura não avança o ciclo outra vez nem duplica auditoria", async () => {
    const { invoice, subscription } = await makeTenantWithSubscriptionAndInvoice({ label: "manual-pay-idem", invoiceStatus: "OPEN" });

    const first = await markInvoicePaidManually(invoice.id, "admin-1", "Motivo 1");
    expect(first.alreadyProcessed).toBe(false);
    const subscriptionAfterFirst = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });

    const second = await markInvoicePaidManually(invoice.id, "admin-2", "Motivo 2 (tentativa duplicada)");
    expect(second.alreadyProcessed).toBe(true);

    const subscriptionAfterSecond = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(subscriptionAfterSecond.currentPeriodEnd.getTime()).toBe(subscriptionAfterFirst.currentPeriodEnd.getTime());

    const auditCount = await prisma.providerEvent.count({ where: { provider: "manual", providerEventId: invoice.id } });
    expect(auditCount).toBe(1);
  });

  it("concorrente (duplo clique / duas abas): só uma baixa avança o ciclo", async () => {
    const { invoice, subscription } = await makeTenantWithSubscriptionAndInvoice({ label: "manual-pay-race", invoiceStatus: "OPEN" });
    const before = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });

    const results = await Promise.all([
      markInvoicePaidManually(invoice.id, "admin-1", "Clique 1"),
      markInvoicePaidManually(invoice.id, "admin-1", "Clique 2"),
      markInvoicePaidManually(invoice.id, "admin-2", "Outra aba"),
    ]);
    expect(results.filter((r) => !r.alreadyProcessed)).toHaveLength(1);

    const after = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    const expected = new Date(before.currentPeriodEnd);
    expected.setMonth(expected.getMonth() + 1);
    expect(after.currentPeriodEnd.getTime()).toBe(expected.getTime());
  });

  it("NOT_FOUND para fatura inexistente", async () => {
    await expect(markInvoicePaidManually("invoice-inexistente", "admin-1", "motivo qualquer")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("findOwnInvoiceOrThrow — escopo por tenant (regenerateMyInvoicePixAction, src/modules/billing/actions.ts)", () => {
  it("devolve a fatura quando pertence ao tenant", async () => {
    const { tenant, invoice } = await makeTenantWithSubscriptionAndInvoice({ label: "own-invoice", invoiceStatus: "OPEN" });
    const found = await findOwnInvoiceOrThrow(tenant.id, invoice.id);
    expect(found.id).toBe(invoice.id);
  });

  it("NOT_FOUND quando a fatura pertence a OUTRO tenant — nunca deixa adivinhar um id de outra empresa", async () => {
    const { tenant: ownerTenant } = await makeTenantWithSubscriptionAndInvoice({ label: "guesser" });
    const { invoice: otherInvoice } = await makeTenantWithSubscriptionAndInvoice({ label: "victim" });

    await expect(findOwnInvoiceOrThrow(ownerTenant.id, otherInvoice.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("NOT_FOUND para invoiceId inexistente", async () => {
    const { tenant } = await makeTenantWithSubscriptionAndInvoice({ label: "no-invoice" });
    await expect(findOwnInvoiceOrThrow(tenant.id, "invoice-inexistente")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("regeneratePixForInvoice funciona normalmente depois do escopo confirmar a posse", async () => {
    const { tenant, invoice } = await makeTenantWithSubscriptionAndInvoice({ label: "own-invoice-pix", invoiceStatus: "OPEN" });
    await findOwnInvoiceOrThrow(tenant.id, invoice.id);

    const { gateway } = createMockMercadoPagoGateway();
    const updated = await regeneratePixForInvoice(invoice.id, "owner@example.com", gateway);
    expect(updated.pixCopyPaste).toBeTruthy();
  });
});
