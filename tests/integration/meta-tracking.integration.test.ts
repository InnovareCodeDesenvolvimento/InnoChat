/**
 * Pixel do Meta + API de Conversões (melhoria 5). Postgres real, `fetch` da Meta simulado.
 * Garante: config cifrada e sem vazar o token; CompleteRegistration com o event_id do navegador;
 * Purchase só no PRIMEIRO pagamento, só para quem aceitou o aviso, uma única vez; e que falha da
 * Meta nunca derruba a baixa da fatura (o que o webhook do Mercado Pago aciona).
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import { sha256Hex } from "@/modules/meta/capi";

vi.mock("@/lib/email", async () => {
  const actual = await vi.importActual<typeof import("@/lib/email")>("@/lib/email");
  return { ...actual, sendMail: vi.fn(async () => ({ sent: true })) };
});

const { getMetaConfig, getMetaRuntimeConfig, getPublicPixelId, invalidateMetaConfigCache, removeMetaCapiToken, saveMetaConfig } = await import("@/modules/meta/config");
const { trackCompleteRegistration, trackPurchase } = await import("@/modules/meta/tracking");
const { applyInvoicePayment } = await import("@/modules/billing/service");

const prisma = getPrisma();
const TOKEN = "EAAG-token-de-teste-bem-longo-0123456789";
const cleanupTenantIds: string[] = [];
let adminId = "";
let originalSettings: { metaPixelId: string | null; metaCapiTokenEnc: string | null; metaTestEventCode: string | null; metaEnabled: boolean } | null = null;

type SentEvent = {
  event_name: string;
  event_id: string;
  event_time: number;
  custom_data?: Record<string, unknown>;
  user_data: Record<string, unknown>;
};
type Call = { url: string; body: { data: SentEvent[]; access_token: string; test_event_code?: string } };
const calls: Call[] = [];
let metaFails = false;

function stubMeta() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      if (metaFails) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ events_received: 1 }), { status: 200 });
    }),
  );
}

/** O envio é fire-and-forget: espera a fila de microtarefas esvaziar antes de olhar `calls`. */
async function settle() {
  await new Promise((r) => setTimeout(r, 50));
}

beforeAll(async () => {
  const admin = await prisma.user.create({ data: { email: `adm-meta-${randomUUID()}@example.com`, passwordHash: "x", isPlatformAdmin: true } });
  adminId = admin.id;
  const row = await prisma.platformSettings.findUnique({ where: { id: 1 } });
  originalSettings = row ? { metaPixelId: row.metaPixelId, metaCapiTokenEnc: row.metaCapiTokenEnc, metaTestEventCode: row.metaTestEventCode, metaEnabled: row.metaEnabled } : null;
});

beforeEach(async () => {
  calls.length = 0;
  metaFails = false;
  stubMeta();
  await prisma.platformSettings.update({ where: { id: 1 }, data: { metaPixelId: null, metaCapiTokenEnc: null, metaTestEventCode: null, metaEnabled: false } });
  invalidateMetaConfigCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  if (originalSettings) await prisma.platformSettings.update({ where: { id: 1 }, data: originalSettings });
  invalidateMetaConfigCache();
  await prisma.tenant.deleteMany({ where: { id: { in: cleanupTenantIds } } });
  await prisma.providerEvent.deleteMany({ where: { provider: { in: ["meta-signup", "meta-capi"] }, providerEventId: { in: cleanupTenantIds } } });
  await prisma.user.deleteMany({ where: { id: adminId } });
  await prisma.$disconnect();
});

async function makeTenant(label: string) {
  const slug = `it-meta-${label}-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const tenant = await prisma.tenant.create({ data: { slug, name: `Meta ${label}`, timezone: "UTC", billingWhatsappE164: "5584999998888" } });
  cleanupTenantIds.push(tenant.id);
  const email = `${slug}@example.com`;
  const user = await prisma.user.create({ data: { email, passwordHash: "x", emailVerifiedAt: new Date() } });
  await prisma.membership.create({ data: { userId: user.id, tenantId: tenant.id, role: "OWNER" } });
  const plan = await prisma.plan.create({
    data: { code: `${slug}-plan`, name: "Plano IT", priceCents: 12990, maxWhatsappNumbers: 1, maxProfessionals: 1, active: false, sortOrder: 999 },
  });
  const end = new Date("2026-10-05T12:00:00Z");
  const subscription = await prisma.subscription.create({ data: { tenantId: tenant.id, planId: plan.id, status: "TRIALING", trialEndsAt: end, currentPeriodEnd: end } });
  const invoice = await prisma.invoice.create({
    data: { subscriptionId: subscription.id, amountCents: 12990, periodStart: new Date(0), periodEnd: end, dueAt: end, status: "OPEN" },
  });
  return { tenant, user, email, subscription, invoice };
}

async function turnOn(withToken = true, testEventCode = "") {
  await saveMetaConfig({ pixelId: "1234567890123456", ...(withToken ? { capiToken: TOKEN } : {}), testEventCode, enabled: true }, adminId);
}

describe("configuração", () => {
  it("salva cifrado, nunca devolve o token e só liga com ID", async () => {
    await expect(saveMetaConfig({ enabled: true }, adminId)).rejects.toMatchObject({ code: "META_CONFIG_INCOMPLETE" });
    await expect(saveMetaConfig({ pixelId: "abc" }, adminId)).rejects.toMatchObject({ code: "INVALID_PIXEL_ID" });
    await expect(saveMetaConfig({ capiToken: "curto" }, adminId)).rejects.toMatchObject({ code: "INVALID_CAPI_TOKEN" });
    await expect(saveMetaConfig({ testEventCode: "TEST 1" }, adminId)).rejects.toMatchObject({ code: "INVALID_TEST_EVENT_CODE" });

    const view = await saveMetaConfig({ pixelId: " 1234 5678 9012 3456 ", capiToken: TOKEN, testEventCode: "TEST12345", enabled: true }, adminId);
    expect(view).toEqual({ enabled: true, pixelId: "1234567890123456", capiTokenSaved: true, testEventCode: "TEST12345" });
    expect(JSON.stringify(view)).not.toContain(TOKEN);

    const row = await prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 } });
    expect(row.metaCapiTokenEnc).toMatch(/^enc:v1:/);
    expect(row.metaCapiTokenEnc).not.toContain(TOKEN);

    const runtime = await getMetaRuntimeConfig();
    expect(runtime).toEqual({ pixelId: "1234567890123456", capiToken: TOKEN, testEventCode: "TEST12345" });
    expect(await getPublicPixelId()).toBe("1234567890123456");
  });

  it("em branco mantém o token; remover apaga só o token; desligar tira o ID do HTML público", async () => {
    await turnOn();
    const kept = await saveMetaConfig({ capiToken: "" }, adminId);
    expect(kept.capiTokenSaved).toBe(true);
    expect((await removeMetaCapiToken(adminId)).capiTokenSaved).toBe(false);
    expect((await getMetaConfig()).pixelId).toBe("1234567890123456");
    expect((await getMetaRuntimeConfig())?.capiToken).toBeNull();

    await saveMetaConfig({ enabled: false }, adminId);
    expect(await getPublicPixelId()).toBeNull();
  });
});

describe("CompleteRegistration (CAPI com o mesmo event_id do navegador)", () => {
  it("grava o aceite e envia o evento com hash e o event_id recebido", async () => {
    await turnOn(true, "TEST999");
    const { tenant, user, email } = await makeTenant("cr");
    const eventId = randomUUID();
    await trackCompleteRegistration({
      tenantSlug: tenant.slug,
      userId: user.id,
      eventId,
      client: { ip: "203.0.113.7", userAgent: "Mozilla/5.0 teste", fbp: "fb.1.1.1", fbc: "fb.1.1.2" },
    });
    await settle();

    expect(calls).toHaveLength(1);
    const sent = calls[0]!.body.data[0]!;
    expect(sent.event_name).toBe("CompleteRegistration");
    expect(sent.event_id).toBe(eventId);
    expect(sent.user_data.em).toEqual([sha256Hex(email)]);
    expect(sent.user_data.fbp).toBe("fb.1.1.1");
    expect(calls[0]!.body.test_event_code).toBe("TEST999");
    expect(JSON.stringify(calls[0]!.body.data)).not.toContain(email);
    expect(calls[0]!.url).not.toContain(TOKEN);

    const consent = await prisma.providerEvent.findUnique({ where: { provider_providerEventId: { provider: "meta-signup", providerEventId: tenant.id } } });
    expect(consent).not.toBeNull();
  });

  it("sem event_id (visitante recusou) não grava nem envia nada", async () => {
    await turnOn();
    const { tenant, user } = await makeTenant("cr-recusou");
    await trackCompleteRegistration({ tenantSlug: tenant.slug, userId: user.id, eventId: undefined, client: {} });
    await settle();
    expect(calls).toHaveLength(0);
    expect(await prisma.providerEvent.count({ where: { provider: "meta-signup", providerEventId: tenant.id } })).toBe(0);
  });

  it("Pixel desligado: nada é gravado; falha da Meta não lança", async () => {
    const { tenant, user } = await makeTenant("cr-off");
    await trackCompleteRegistration({ tenantSlug: tenant.slug, userId: user.id, eventId: randomUUID(), client: {} });
    expect(calls).toHaveLength(0);
    expect(await prisma.providerEvent.count({ where: { provider: "meta-signup", providerEventId: tenant.id } })).toBe(0);

    await turnOn();
    metaFails = true;
    await expect(trackCompleteRegistration({ tenantSlug: tenant.slug, userId: user.id, eventId: randomUUID(), client: {} })).resolves.toBeUndefined();
  });
});

describe("Purchase (primeiro pagamento, pelo servidor)", () => {
  async function signedUp(label: string) {
    const made = await makeTenant(label);
    await trackCompleteRegistration({ tenantSlug: made.tenant.slug, userId: made.user.id, eventId: randomUUID(), client: { ip: "203.0.113.7", userAgent: "UA", fbp: "fb.1.1.1" } });
    await settle();
    calls.length = 0;
    return made;
  }

  it("a baixa da fatura dispara 1 Purchase com valor, dedup por fatura e dados com hash", async () => {
    await turnOn();
    const { invoice, email } = await signedUp("purchase");
    await applyInvoicePayment(invoice.id, new Date("2026-10-04T15:00:00Z"), "mp-pay-1");
    await settle();

    expect(calls).toHaveLength(1);
    const sent = calls[0]!.body.data[0]!;
    expect(sent.event_name).toBe("Purchase");
    expect(sent.event_id).toBe(`purchase-${invoice.id}`);
    expect(sent.custom_data).toEqual({ currency: "BRL", value: 129.9 });
    expect(sent.event_time).toBe(Math.floor(new Date("2026-10-04T15:00:00Z").getTime() / 1000));
    expect(sent.user_data.em).toEqual([sha256Hex(email)]);
    expect(sent.user_data.client_ip_address).toBe("203.0.113.7");
  });

  it("reentrega do webhook e segunda fatura não geram outro Purchase", async () => {
    await turnOn();
    const { invoice, subscription } = await signedUp("purchase-once");
    await applyInvoicePayment(invoice.id, new Date(), "mp-pay-2");
    await applyInvoicePayment(invoice.id, new Date(), "mp-pay-2");
    await settle();
    expect(calls).toHaveLength(1);

    const second = await prisma.invoice.create({
      data: { subscriptionId: subscription.id, amountCents: 12990, periodStart: new Date(), periodEnd: new Date(Date.now() + 86_400_000), dueAt: new Date(), status: "OPEN" },
    });
    await applyInvoicePayment(second.id, new Date(), "mp-pay-3");
    await settle();
    expect(calls).toHaveLength(1); // só o PRIMEIRO pagamento da assinatura
  });

  it("quem não aceitou o aviso no cadastro nunca é enviado", async () => {
    await turnOn();
    const { invoice } = await makeTenant("purchase-sem-aceite");
    await applyInvoicePayment(invoice.id, new Date(), "mp-pay-4");
    await settle();
    expect(calls).toHaveLength(0);
  });

  it("sem token da CAPI não envia; falha da Meta nunca desfaz a baixa", async () => {
    await turnOn(false);
    const a = await signedUp("purchase-sem-token");
    await applyInvoicePayment(a.invoice.id, new Date(), "mp-pay-5");
    await settle();
    expect(calls).toHaveLength(0);

    await turnOn(true);
    metaFails = true;
    const b = await signedUp("purchase-meta-fora");
    const result = await applyInvoicePayment(b.invoice.id, new Date(), "mp-pay-6");
    await settle();
    expect(result.alreadyProcessed).toBe(false);
    const paid = await prisma.invoice.findUniqueOrThrow({ where: { id: b.invoice.id } });
    expect(paid.status).toBe("PAID");
  });

  it("trackPurchase direto não lança mesmo sem nada configurado", async () => {
    await expect(trackPurchase({ tenantId: "nao-existe", invoiceId: "x", amountCents: 100, paidAt: new Date() })).resolves.toBeUndefined();
  });
});
