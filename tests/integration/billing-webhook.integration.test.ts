/**
 * Idempotência do webhook do Mercado Pago (docs/arquitetura.md §6.10, §7.1) contra Postgres
 * real: o MESMO evento entregue 2x só aplica o pagamento 1 vez (não soma 2 meses, não paga a
 * fatura "de novo"). `sendMail` mockado (não precisamos de SMTP real).
 */
import { randomUUID } from "node:crypto";
import crypto from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import { encryptSecret } from "@/lib/crypto";

vi.mock("@/lib/email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
  return { ...actual, sendMail: vi.fn(async () => ({ sent: true })) };
});

const { handleMercadoPagoWebhook, WebhookIgnored } = await import("@/modules/billing/webhook");
const { MercadoPagoApiError } = await import("@/modules/billing/mercadopago");

const prisma = getPrisma();
const WEBHOOK_SECRET = "it-webhook-secret";

/** Par de PRODUÇÃO ativo com o segredo do teste (o webhook valida com o segredo do ambiente ativo). */
async function seedWebhookSecret() {
  const data = { mpEnvironment: "PRODUCTION" as const, mpProdWebhookSecretEnc: encryptSecret(WEBHOOK_SECRET), mercadoPagoWebhookSecret: null };
  await prisma.platformSettings.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
}

function signManifest(dataId: string, requestId: string, ts: string) {
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${ts};`;
  const v1 = crypto.createHmac("sha256", WEBHOOK_SECRET).update(manifest).digest("hex");
  return `ts=${ts},v1=${v1}`;
}

async function makeSubscriptionWithOpenInvoice(label: string) {
  const slug = `it-${label}-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const tenant = await prisma.tenant.create({ data: { slug, name: `Webhook ${label}`, timezone: "UTC" } });
  const plan = await prisma.plan.create({
    data: { code: `${slug}-plan`, name: "Plano IT", priceCents: 5000, maxWhatsappNumbers: 1, maxProfessionals: 1, active: false, sortOrder: 999 },
  });
  const currentPeriodEnd = new Date();
  const subscription = await prisma.subscription.create({
    data: { tenantId: tenant.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd },
  });
  const invoice = await prisma.invoice.create({
    data: { subscriptionId: subscription.id, amountCents: 5000, periodStart: new Date(0), periodEnd: currentPeriodEnd, dueAt: currentPeriodEnd, status: "OPEN" },
  });
  return { tenant, plan, subscription, invoice };
}

const cleanupTenantIds: string[] = [];

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: cleanupTenantIds } } });
  await prisma.$disconnect();
});

describe("handleMercadoPagoWebhook — idempotência (§6.10)", () => {
  it("rejeita assinatura inválida (401, sem tocar no banco)", async () => {
    const { tenant, invoice } = await makeSubscriptionWithOpenInvoice("bad-sig");
    cleanupTenantIds.push(tenant.id);
    await seedWebhookSecret();

    const dataId = "pay_bad_sig";
    await expect(
      handleMercadoPagoWebhook({ xSignature: "ts=123,v1=deadbeef", xRequestId: "req-1", dataId }),
    ).rejects.toThrow();

    const reloaded = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(reloaded.status).toBe("OPEN");
  });

  it("o MESMO evento processado 2x só dá baixa 1 vez (não avança 2 meses)", async () => {
    const { tenant, subscription, invoice } = await makeSubscriptionWithOpenInvoice("dup-event");
    cleanupTenantIds.push(tenant.id);
    await seedWebhookSecret();

    const dataId = `pay_${invoice.id}`;
    const requestId = "req-dup";
    const ts = String(Math.floor(Date.now() / 1000));
    const xSignature = signManifest(dataId, requestId, ts);

    const paidAt = new Date();
    const gateway = {
      createPixPayment: vi.fn(),
      cancelPayment: vi.fn(), getPayment: vi.fn().mockResolvedValue({ id: dataId, status: "approved", dateApproved: paidAt, externalReference: invoice.id, transactionAmountCents: invoice.amountCents }),
    };

    const first = await handleMercadoPagoWebhook({ xSignature, xRequestId: requestId, dataId, gateway });
    expect(first.status).toBe("processed");

    const afterFirst = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(afterFirst.status).toBe("ACTIVE");
    const firstPeriodEnd = afterFirst.currentPeriodEnd.getTime();

    // Mercado Pago reentrega a MESMA notificação (mesmo data.id).
    const second = await handleMercadoPagoWebhook({ xSignature, xRequestId: requestId, dataId, gateway });
    expect(second.status).toBe("already_processed");

    const afterSecond = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(afterSecond.currentPeriodEnd.getTime()).toBe(firstPeriodEnd); // não avançou de novo

    const reloadedInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(reloadedInvoice.status).toBe("PAID");
    expect(gateway.getPayment).toHaveBeenCalledTimes(2); // reconsulta sempre, mas só aplica 1x
  });

  it("2 webhooks concorrentes para o MESMO evento: 1 efeito, nenhum 500 (revisão 2026-09-28, achado MÉDIA)", async () => {
    const { tenant, subscription, invoice } = await makeSubscriptionWithOpenInvoice("concurrent");
    cleanupTenantIds.push(tenant.id);
    await seedWebhookSecret();

    const dataId = `pay_${invoice.id}_concurrent`;
    const requestId = "req-concurrent";
    const ts = String(Math.floor(Date.now() / 1000));
    const xSignature = signManifest(dataId, requestId, ts);

    const paidAt = new Date();
    const gateway = {
      createPixPayment: vi.fn(),
      cancelPayment: vi.fn(), getPayment: vi.fn().mockResolvedValue({ id: dataId, status: "approved", dateApproved: paidAt, externalReference: invoice.id, transactionAmountCents: invoice.amountCents }),
    };

    // Duas "entregas" do MESMO webhook batendo praticamente ao mesmo tempo — simula o retry de
    // rede do Mercado Pago (ou 2 notificações do mesmo pagamento chegando quase juntas).
    const [first, second] = await Promise.all([
      handleMercadoPagoWebhook({ xSignature, xRequestId: requestId, dataId, gateway }),
      handleMercadoPagoWebhook({ xSignature, xRequestId: requestId, dataId, gateway }),
    ]);

    // Nenhuma das duas deve ter lançado (o que a route.ts converteria em 500) — `await` acima já
    // garantiria isso (rejeição faria o teste falhar). Qual das duas fica com "processed" vs.
    // "already_processed" depende de timing real da corrida (não é determinístico: a
    // idempotência de `ProviderEvent` só evita o `create` duplicado, mas as duas podem chegar a
    // `applyInvoicePayment` antes de qualquer uma marcar `processedAt` — e `applyInvoicePayment`
    // tem sua PRÓPRIA idempotência, por isso o efeito final abaixo continua único) — o que
    // importa é nenhuma delas ter sido rejeitada e o efeito final ser único.
    expect(first.status).not.toBe("ignored");
    expect(second.status).not.toBe("ignored");

    const reloadedInvoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(reloadedInvoice.status).toBe("PAID");

    const expectedNextPeriodEnd = new Date(subscription.currentPeriodEnd);
    expectedNextPeriodEnd.setMonth(expectedNextPeriodEnd.getMonth() + 1);
    const reloadedSubscription = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    // Avançou o período UMA vez só — se a corrida tivesse escapado (2 `create` bem-sucedidos em
    // paralelo), `applyInvoicePayment` teria rodado 2x e avançado 2 meses em vez de 1.
    expect(reloadedSubscription.currentPeriodEnd.getTime()).toBe(expectedNextPeriodEnd.getTime());
  });

  it("pagamento aprovado de fatura VOID (teste cancelado) NÃO reativa: evento registrado, status ignored", async () => {
    const { tenant, subscription, invoice } = await makeSubscriptionWithOpenInvoice("void-payment");
    cleanupTenantIds.push(tenant.id);
    await prisma.subscription.update({ where: { id: subscription.id }, data: { status: "CANCELED", canceledAt: new Date() } });
    await prisma.invoice.update({ where: { id: invoice.id }, data: { status: "VOID", isTrialConversion: true } });
    await seedWebhookSecret();

    const dataId = `pay_void_${invoice.id}`;
    const requestId = "req-void";
    const ts = String(Math.floor(Date.now() / 1000));
    const gateway = {
      createPixPayment: vi.fn(),
      cancelPayment: vi.fn(), getPayment: vi.fn().mockResolvedValue({ id: dataId, status: "approved", dateApproved: new Date(), externalReference: invoice.id, transactionAmountCents: invoice.amountCents }),
    };

    const result = await handleMercadoPagoWebhook({ xSignature: signManifest(dataId, requestId, ts), xRequestId: requestId, dataId, gateway });
    expect(result.status).toBe("ignored");

    expect((await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).status).toBe("VOID");
    expect((await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } })).status).toBe("CANCELED");
    const event = await prisma.providerEvent.findUniqueOrThrow({
      where: { provider_providerEventId: { provider: "mercadopago", providerEventId: dataId } },
    });
    expect(event.processedAt).not.toBeNull();
    expect(event.payload).toMatchObject({ voidedInvoicePayment: true });
  });

  it("pagamento inexistente no MP (404 — ex.: 'Simular notificação' com data.id=123456) vira ignored, nunca 500", async () => {
    const { tenant } = await makeSubscriptionWithOpenInvoice("payment-404");
    cleanupTenantIds.push(tenant.id);
    await seedWebhookSecret();

    const dataId = "123456";
    const requestId = "req-404";
    const ts = String(Math.floor(Date.now() / 1000));
    const gateway = {
      createPixPayment: vi.fn(),
      cancelPayment: vi.fn(), getPayment: vi.fn().mockRejectedValue(new MercadoPagoApiError("Mercado Pago recusou a consulta do pagamento (404).", 404)),
    };

    await expect(
      handleMercadoPagoWebhook({ xSignature: signManifest(dataId, requestId, ts), xRequestId: requestId, dataId, gateway }),
    ).rejects.toBeInstanceOf(WebhookIgnored);
  });

  it("notificação com type diferente de 'payment' (ex.: merchant_order) é ignorada SEM reconsultar o gateway (conferido contra o Parque das Feiras)", async () => {
    const { tenant, invoice } = await makeSubscriptionWithOpenInvoice("merchant-order");
    cleanupTenantIds.push(tenant.id);
    await seedWebhookSecret();

    const dataId = "merchant_order_999";
    const requestId = "req-mo";
    const ts = String(Math.floor(Date.now() / 1000));
    const xSignature = signManifest(dataId, requestId, ts);
    const gateway = { createPixPayment: vi.fn(), cancelPayment: vi.fn(), getPayment: vi.fn() };

    const result = await handleMercadoPagoWebhook({ xSignature, xRequestId: requestId, dataId, type: "merchant_order", gateway });

    expect(result.status).toBe("ignored");
    expect(gateway.getPayment).not.toHaveBeenCalled();

    const reloaded = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(reloaded.status).toBe("OPEN");
  });

  it("chamar applyInvoicePayment de novo (fora do webhook) também é idempotente", async () => {
    const { tenant, subscription, invoice } = await makeSubscriptionWithOpenInvoice("direct-apply");
    cleanupTenantIds.push(tenant.id);

    const { applyInvoicePayment } = await import("@/modules/billing/service");
    const first = await applyInvoicePayment(invoice.id, new Date());
    expect(first.alreadyProcessed).toBe(false);
    const second = await applyInvoicePayment(invoice.id, new Date());
    expect(second.alreadyProcessed).toBe(true);

    const reloaded = await prisma.subscription.findUniqueOrThrow({ where: { id: subscription.id } });
    expect(reloaded.status).toBe("ACTIVE");
  });
});
