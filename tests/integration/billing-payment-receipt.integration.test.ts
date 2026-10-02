/**
 * Recibo "Pagamento confirmado" (`paymentConfirmedEmail`) enviado por `applyInvoicePayment` —
 * ponto único de baixa (webhook, conciliação e baixa manual passam por ele): sai UMA vez, só na
 * primeira baixa, fora da transação, e falha de e-mail nunca desfaz o pagamento. Postgres real,
 * `sendMail` mockado.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";

type Sent = { to: string; subject: string; html: string; text: string };
const sent: Sent[] = [];
let failSend = false;

vi.mock("@/lib/email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
  return {
    ...actual,
    sendMail: vi.fn(async (input: Sent) => {
      if (failSend) throw new Error("smtp down");
      sent.push(input);
      return { sent: true };
    }),
  };
});

const { applyInvoicePayment } = await import("@/modules/billing/service");
const { markInvoicePaidManually } = await import("@/modules/billing/admin-service");

const prisma = getPrisma();
const cleanupTenantIds: string[] = [];

beforeEach(() => {
  sent.length = 0;
  failSend = false;
});

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: cleanupTenantIds } } });
  await prisma.$disconnect();
});

async function makeOpenInvoice(label: string, opts: { status?: "OPEN" | "VOID"; withOwner?: boolean } = {}) {
  const slug = `it-receipt-${label}-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const tenant = await prisma.tenant.create({ data: { slug, name: `Recibo <b>${label}</b>`, timezone: "UTC" } });
  cleanupTenantIds.push(tenant.id);
  const email = `${slug}@example.com`;
  if (opts.withOwner !== false) {
    const user = await prisma.user.create({ data: { email, passwordHash: "x", emailVerifiedAt: new Date() } });
    await prisma.membership.create({ data: { userId: user.id, tenantId: tenant.id, role: "OWNER" } });
  }
  const plan = await prisma.plan.create({
    data: { code: `${slug}-plan`, name: "Plano IT", priceCents: 12990, maxWhatsappNumbers: 1, maxProfessionals: 1, active: false, sortOrder: 999 },
  });
  const currentPeriodEnd = new Date("2026-10-05T12:00:00Z");
  const subscription = await prisma.subscription.create({ data: { tenantId: tenant.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd } });
  const invoice = await prisma.invoice.create({
    data: { subscriptionId: subscription.id, amountCents: 12990, periodStart: new Date(0), periodEnd: currentPeriodEnd, dueAt: currentPeriodEnd, status: opts.status ?? "OPEN" },
  });
  return { tenant, subscription, invoice, email };
}

describe("recibo de pagamento", () => {
  it("primeira baixa envia 1 recibo ao OWNER, com valor, data e validade corretos e nome escapado", async () => {
    const { invoice, email } = await makeOpenInvoice("first");
    const result = await applyInvoicePayment(invoice.id, new Date("2026-10-04T15:00:00Z"));

    expect(result).toEqual({ alreadyProcessed: false });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(email);
    expect(sent[0]!.subject).toMatch(/^Pagamento confirmado [(]/);
    expect(sent[0]!.text).toContain("129,90");
    expect(sent[0]!.text).toContain("04/10/2026");
    expect(sent[0]!.text).toContain("05/11/2026");
    expect(sent[0]!.html).not.toContain("<b>");
  });

  it("baixas repetidas e concorrentes não reenviam (alreadyProcessed)", async () => {
    const { invoice } = await makeOpenInvoice("idem");
    const results = await Promise.all([applyInvoicePayment(invoice.id, new Date()), applyInvoicePayment(invoice.id, new Date())]);
    await applyInvoicePayment(invoice.id, new Date());

    expect(results.filter((r) => !r.alreadyProcessed)).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("baixa manual: envia 1 vez; repetir a baixa manual não reenvia", async () => {
    const { invoice } = await makeOpenInvoice("manual");
    const admin = await prisma.user.create({ data: { email: `adm-${randomUUID()}@example.com`, passwordHash: "x", isPlatformAdmin: true, totpSecretEnc: "enc:v1:x", totpEnabledAt: new Date() } });
    try {
      await markInvoicePaidManually(invoice.id, admin.id, "pagou por fora");
      await markInvoicePaidManually(invoice.id, admin.id, "pagou por fora");
      expect(sent).toHaveLength(1);
    } finally {
      await prisma.providerEvent.deleteMany({ where: { provider: "manual", providerEventId: invoice.id } });
      await prisma.user.delete({ where: { id: admin.id } });
    }
  });

  it("fatura VOID não envia recibo", async () => {
    const { invoice } = await makeOpenInvoice("void", { status: "VOID" });
    const result = await applyInvoicePayment(invoice.id, new Date());
    expect(result.voided).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("falha do SMTP não desfaz a baixa nem lança", async () => {
    failSend = true;
    const { invoice, subscription } = await makeOpenInvoice("smtpfail");
    await expect(applyInvoicePayment(invoice.id, new Date())).resolves.toEqual({ alreadyProcessed: false });

    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("PAID");
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).status).toBe("ACTIVE");
    expect(sent).toHaveLength(0);
  });

  it("empresa sem OWNER: baixa ok, sem e-mail", async () => {
    const { invoice } = await makeOpenInvoice("noowner", { withOwner: false });
    await expect(applyInvoicePayment(invoice.id, new Date())).resolves.toEqual({ alreadyProcessed: false });
    expect(sent).toHaveLength(0);
  });
});
