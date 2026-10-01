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

const { signUp, verifyEmail, resendVerificationEmail } = await import("@/modules/signup/service");
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
    // CPF válido (dígito verificador correto) — decisão do dono, 2026-09-29: o documento passou
    // a ser OBRIGATÓRIO no cadastro (ver `signup/service.ts#signUp`), então todo teste que não
    // está testando especificamente a rejeição do documento usa este valor.
    document: "529.982.247-25",
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

  it("rejeita slug reservado (INVALID_SLUG)", async () => {
    const { gateway } = createMockMercadoPagoGateway();
    await expect(signUp(signupInput({ slug: "admin" }), gateway)).rejects.toMatchObject({ code: "INVALID_SLUG" });
  });

  it("rejeita e-mail duplicado (EMAIL_TAKEN)", async () => {
    const { gateway } = createMockMercadoPagoGateway();
    const email = `${uniqueSlug("dup-email")}@example.com`;

    const first = await signUp(signupInput({ email }), gateway);
    createdTenantIds.push((await prisma.tenant.findUniqueOrThrow({ where: { slug: first.tenantSlug } })).id);
    createdUserIds.push(first.userId);

    await expect(signUp(signupInput({ email }), gateway)).rejects.toMatchObject({ code: "EMAIL_TAKEN" });
  });

  it("rejeita slug duplicado (SLUG_TAKEN)", async () => {
    const { gateway } = createMockMercadoPagoGateway();
    const slug = uniqueSlug("dup-slug");

    const first = await signUp(signupInput({ slug }), gateway);
    createdTenantIds.push((await prisma.tenant.findUniqueOrThrow({ where: { slug: first.tenantSlug } })).id);
    createdUserIds.push(first.userId);

    await expect(signUp(signupInput({ slug }), gateway)).rejects.toMatchObject({ code: "SLUG_TAKEN" });
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
