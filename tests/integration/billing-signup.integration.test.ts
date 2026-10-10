/**
 * Cadastro público ponta a ponta (docs/arquitetura.md §7.3, src/modules/signup/service.ts)
 * contra Postgres real. `sendMail` é mockado (não precisamos de SMTP configurado para provar a
 * lógica de negócio) — capturamos o texto do e-mail para extrair o token de verificação, já que
 * `signUp` nunca devolve o token em texto puro fora do e-mail (mesma régua de segredo de uso
 * único do resto do projeto).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";

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

const { signUp, verifyEmail, resendVerificationEmail, pickAvailableSlug } = await import("@/modules/signup/service");
const { createMockMercadoPagoGateway } = await import("@/modules/billing/mercadopago.mock");

const prisma = getPrisma();
const createdTenantIds: string[] = [];
const createdUserIds: string[] = [];

beforeEach(() => {
  sentEmails.length = 0;
});

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

function uniqueSlug(label: string) {
  return `it-${label}-${Date.now()}-${randomUUID().slice(0, 6)}`;
}

function signupInput(overrides: Partial<Parameters<typeof signUp>[0]> = {}) {
  const slug = uniqueSlug("signup");
  return {
    companyName: "Estúdio Integração",
    slug,
    segment: "Salão",
    ownerName: "Dona da Empresa",
    email: `${slug}@example.com`,
    password: "senha-forte-123",
    // CPF válido: desde 2026-10-10 o documento é OPCIONAL no cadastro (pedido na hora de pagar), mas a maioria
    // dos testes segue o caminho com documento (Pix já na primeira fatura). O caminho sem documento tem teste próprio.
    document: "529.982.247-25",
    // WhatsApp é obrigatório (DDD existente).
    phone: "(84) 99999-8888",
    termsVersion: "v1",
    ...overrides,
  };
}

describe("signUp — cadastro público completo", () => {
  it("cria User(OWNER) + Tenant(document preenchido) + Subscription(TRIALING) + primeira fatura COM Pix (documento obrigatório desde 2026-09-29)", async () => {
    const { gateway } = createMockMercadoPagoGateway();
    const input = signupInput();

    const result = await signUp(input, gateway);
    createdTenantIds.push((await prisma.tenant.findUniqueOrThrow({ where: { slug: result.tenantSlug } })).id);
    createdUserIds.push(result.userId);

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: result.tenantSlug } });
    expect(tenant.document).toBe("52998224725");

    const subscription = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenant.id }, include: { plan: true } });
    expect(subscription.status).toBe("TRIALING");
    expect(subscription.trialEndsAt).not.toBeNull();
    expect(subscription.currentPeriodEnd.getTime()).toBe(subscription.trialEndsAt!.getTime());

    const invoice = await prisma.invoice.findFirstOrThrow({ where: { subscriptionId: subscription.id } });
    expect(invoice.status).toBe("OPEN");
    expect(invoice.isTrialConversion).toBe(true);
    expect(subscription.firstPaidAt).toBeNull();
    expect(invoice.amountCents).toBe(subscription.plan.priceCents);
    expect(invoice.dueAt.getTime()).toBe(subscription.trialEndsAt!.getTime());
    // Com `Tenant.document` já preenchido no cadastro, o Pix da primeira fatura sai de fato
    // (antes desta mudança, `/cadastro` não coletava CPF/CNPJ e a fatura nascia sempre sem Pix).
    expect(invoice.pixCopyPaste).toBeTruthy();

    const membership = await prisma.membership.findFirstOrThrow({ where: { tenantId: tenant.id } });
    expect(membership.role).toBe("OWNER");
    expect(membership.userId).toBe(result.userId);

    // 2 e-mails: fatura gerada + verificação.
    expect(sentEmails.some((e) => e.subject.includes("Fatura"))).toBe(true);
    expect(sentEmails.some((e) => e.subject.includes("Confirme seu e-mail"))).toBe(true);
  });

  it("rejeita CPF/CNPJ com dígito verificador inválido (INVALID_DOCUMENT)", async () => {
    const { gateway } = createMockMercadoPagoGateway();
    await expect(signUp(signupInput({ document: "111.111.111-11" }), gateway)).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
  });

  it("sem CPF/CNPJ (cadastro enxuto): a conta nasce, a fatura do teste fica OPEN SEM Pix, o MP não é chamado e nenhum e-mail de fatura sai no dia 0", async () => {
    const { gateway } = createMockMercadoPagoGateway();
    const createPix = vi.spyOn(gateway, "createPixPayment");
    const result = await signUp(signupInput({ document: undefined }), gateway);
    createdTenantIds.push((await prisma.tenant.findUniqueOrThrow({ where: { slug: result.tenantSlug } })).id);
    createdUserIds.push(result.userId);

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: result.tenantSlug } });
    expect(tenant.document).toBeNull();
    const subscription = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { subscriptionId: subscription.id } });
    expect(invoice).toMatchObject({ status: "OPEN", isTrialConversion: true, pixCopyPaste: null, mpPaymentId: null });
    expect(createPix).not.toHaveBeenCalled();
    expect(sentEmails.some((e) => e.subject.includes("Fatura"))).toBe(false);
    expect(sentEmails.some((e) => e.subject.includes("Confirme seu e-mail"))).toBe(true); // a verificação segue saindo
  });

  it("documento vazio (espaços) vale como ausente; preenchido e inválido segue recusado", async () => {
    const { gateway } = createMockMercadoPagoGateway();
    const result = await signUp(signupInput({ document: "   " }), gateway);
    createdTenantIds.push((await prisma.tenant.findUniqueOrThrow({ where: { slug: result.tenantSlug } })).id);
    createdUserIds.push(result.userId);
    expect((await prisma.tenant.findUniqueOrThrow({ where: { slug: result.tenantSlug } })).document).toBeNull();
    await expect(signUp(signupInput({ document: "123" }), gateway)).rejects.toMatchObject({ code: "INVALID_DOCUMENT" });
  });

  it("o endereço (slug) é sempre automático: o 'slug' legado é ignorado e nome reservado ganha sufixo seguro", async () => {
    const { gateway } = createMockMercadoPagoGateway();
    const legacy = await signUp(signupInput({ slug: "admin", companyName: `Studio Legado ${randomUUID().slice(0, 6)}` }), gateway);
    createdTenantIds.push((await prisma.tenant.findUniqueOrThrow({ where: { slug: legacy.tenantSlug } })).id);
    createdUserIds.push(legacy.userId);
    expect(legacy.tenantSlug).not.toBe("admin");
    expect(legacy.tenantSlug).toMatch(/^studio-legado-/);

    const reserved = await signUp(signupInput({ companyName: "Admin" }), gateway);
    createdTenantIds.push((await prisma.tenant.findUniqueOrThrow({ where: { slug: reserved.tenantSlug } })).id);
    createdUserIds.push(reserved.userId);
    expect(reserved.tenantSlug).toMatch(/^admin-clinica/);
  });

  it("rejeita e-mail duplicado (EMAIL_TAKEN)", async () => {
    const { gateway } = createMockMercadoPagoGateway();
    const email = `${uniqueSlug("dup-email")}@example.com`;

    const first = await signUp(signupInput({ email }), gateway);
    createdTenantIds.push((await prisma.tenant.findUniqueOrThrow({ where: { slug: first.tenantSlug } })).id);
    createdUserIds.push(first.userId);

    await expect(signUp(signupInput({ email }), gateway)).rejects.toMatchObject({ code: "EMAIL_TAKEN" });
  });

  it("nome de empresa repetido NÃO é erro: o endereço ganha sufixo (-2, -3)", async () => {
    const { gateway } = createMockMercadoPagoGateway();
    const companyName = `Mesmo Nome ${randomUUID().slice(0, 8)}`;

    const first = await signUp(signupInput({ companyName }), gateway);
    const second = await signUp(signupInput({ companyName }), gateway);
    const third = await signUp(signupInput({ companyName }), gateway);
    for (const created of [first, second, third]) {
      createdTenantIds.push((await prisma.tenant.findUniqueOrThrow({ where: { slug: created.tenantSlug } })).id);
      createdUserIds.push(created.userId);
    }
    expect(second.tenantSlug).toBe(`${first.tenantSlug}-2`);
    expect(third.tenantSlug).toBe(`${first.tenantSlug}-3`);
  });

  it("três cadastros SIMULTÂNEOS do mesmo nome: os três nascem (a corrida do endereço refaz com outro sufixo)", async () => {
    const { gateway } = createMockMercadoPagoGateway();
    const companyName = `Corrida Slug ${randomUUID().slice(0, 8)}`;
    const results = await Promise.all([signUp(signupInput({ companyName }), gateway), signUp(signupInput({ companyName }), gateway), signUp(signupInput({ companyName }), gateway)]);
    for (const created of results) {
      createdTenantIds.push((await prisma.tenant.findUniqueOrThrow({ where: { slug: created.tenantSlug } })).id);
      createdUserIds.push(created.userId);
    }
    expect(new Set(results.map((r) => r.tenantSlug)).size).toBe(3);
  });

  it("dois cadastros SIMULTÂNEOS do mesmo e-mail: um nasce, o outro recebe EMAIL_TAKEN (nunca erro de endereço, nunca conta pela metade)", async () => {
    const { gateway } = createMockMercadoPagoGateway();
    const email = `${uniqueSlug("dup-race")}@example.com`;
    const settled = await Promise.allSettled([
      signUp(signupInput({ email, companyName: `Race A ${randomUUID().slice(0, 6)}` }), gateway),
      signUp(signupInput({ email, companyName: `Race B ${randomUUID().slice(0, 6)}` }), gateway),
    ]);
    const ok = settled.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof signUp>>> => r.status === "fulfilled");
    const failed = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toMatchObject({ code: "EMAIL_TAKEN" });
    createdTenantIds.push((await prisma.tenant.findUniqueOrThrow({ where: { slug: ok[0]!.value.tenantSlug } })).id);
    createdUserIds.push(ok[0]!.value.userId);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it("pickAvailableSlug: nomes curtos, acentuados, só símbolos, reservados e muito longos geram endereço válido", async () => {
    const { validateSlug } = await import("@/core/signup/slug");
    const names = ["Ab", "Salão da Ação", "!!!", "Admin", "Login", "x".repeat(200), `${"a".repeat(54)}-${"b".repeat(10)}`];
    for (const name of names) {
      const slug = await pickAvailableSlug(name);
      expect(validateSlug(slug), `${name.slice(0, 20)} -> ${slug}`).toBeNull();
    }
    expect(await pickAvailableSlug("Salão da Ação")).toBe("salao-da-acao");
  });

  it("verificação de e-mail: consome o token uma única vez", async () => {
    const { gateway } = createMockMercadoPagoGateway();
    const result = await signUp(signupInput(), gateway);
    createdTenantIds.push((await prisma.tenant.findUniqueOrThrow({ where: { slug: result.tenantSlug } })).id);
    createdUserIds.push(result.userId);

    const verificationEmail = sentEmails.find((e) => e.subject.includes("Confirme seu e-mail"));
    const token = verificationEmail?.text.match(/token=([\w-]+)/)?.[1];
    expect(token).toBeTruthy();

    await verifyEmail(token!);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: result.userId } });
    expect(user.emailVerifiedAt).not.toBeNull();

    // Reuso do mesmo token falha (uso único).
    await expect(verifyEmail(token!)).rejects.toMatchObject({ code: "TOKEN_INVALID" });
  });

  it("segue sem quebrar mesmo se o Mercado Pago falhar ao gerar o Pix (fatura fica OPEN sem Pix)", async () => {
    const failingGateway = {
      createPixPayment: vi.fn().mockRejectedValue(new Error("MP fora do ar")),
      cancelPayment: vi.fn(), getPayment: vi.fn(),
    };
    const input = signupInput();
    const result = await signUp(input, failingGateway);
    createdTenantIds.push((await prisma.tenant.findUniqueOrThrow({ where: { slug: result.tenantSlug } })).id);
    createdUserIds.push(result.userId);

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: result.tenantSlug } });
    const subscription = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { subscriptionId: subscription.id } });
    expect(invoice.status).toBe("OPEN");
    expect(invoice.pixCopyPaste).toBeNull();
  });
});

describe("resendVerificationEmail — reenvio pelo usuário logado", () => {
  it("usuário não verificado recebe um novo link; depois de verificado, não envia mais", async () => {
    const result = await signUp(signupInput(), createMockMercadoPagoGateway().gateway);
    createdTenantIds.push((await prisma.tenant.findUniqueOrThrow({ where: { slug: result.tenantSlug } })).id);
    createdUserIds.push(result.userId);
    sentEmails.length = 0;

    const first = await resendVerificationEmail(result.userId);
    expect(first).toEqual({ alreadyVerified: false });
    expect(sentEmails).toHaveLength(1);
    const token = sentEmails[0].text.match(/verificar-email\?token=([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeTruthy();

    await verifyEmail(token!);
    sentEmails.length = 0;
    const second = await resendVerificationEmail(result.userId);
    expect(second).toEqual({ alreadyVerified: true });
    expect(sentEmails).toHaveLength(0);
  });
});
