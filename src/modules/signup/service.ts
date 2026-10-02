import crypto from "node:crypto";
import { getPrisma } from "@/lib/db/prisma";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { hashPassword } from "@/modules/auth/service";
import { forgetSessionVersion } from "@/modules/auth/session-version";
import { isUniqueViolation } from "@/lib/db/prisma-errors";
import { sendMail, loadEmailContext, verificationEmail, passwordResetEmail, teamInviteEmail } from "@/lib/email";
import { getPublicBaseUrl } from "@/lib/public-url";
import type { MembershipRole } from "@/lib/db/types";
import { slugify, validateSlug, type SlugValidationError } from "@/core/signup/slug";
import { effectiveCycle, planOffersAnnual, priceInvoice, validateCpfCnpj, type BillingCycle } from "@/core/billing";
import { adoptCouponInTx, consumeCouponCycleInTx } from "@/modules/billing/coupons";
import { normalizeBrPhoneToE164 } from "@/core/contact/br-phone";
import {
  billingUrlFor,
  findBillingRecipientEmail,
  generateInvoiceDescription,
  getDefaultSignupPlan,
  newTrialEndsAt,
  sendInvoiceGeneratedEmail,
  tryAttachPix,
} from "@/modules/billing/service";
import type { MercadoPagoGateway } from "@/modules/billing/mercadopago";
import { recordBillingEvent } from "@/modules/billing/dunning/events";
import { maskEmail, recordInlineInvoiceNotice } from "@/modules/billing/dunning/outbox";

/**
 * Cadastro público + conta (docs/arquitetura.md §7.3, docs/contratos.md). Separado de
 * `src/modules/auth/service.ts` (login) e de `src/modules/billing/service.ts` (fatura/Pix) —
 * este módulo é quem ORQUESTRA os dois na hora do cadastro.
 */

// ---------------------------------------------------------------------------
// Tokens de uso único (verificação de e-mail, redefinição de senha, convite)
// ---------------------------------------------------------------------------

const TOKEN_BYTES = 32;
const VERIFY_EMAIL_TTL_MS = 48 * 60 * 60 * 1000; // 48h — sem regra explícita do dono; folgado o bastante para não frustrar quem não abre o e-mail no mesmo dia.
const RESET_PASSWORD_TTL_MS = 60 * 60 * 1000; // 1h (§7.3 regra 5)
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias (§7.3 regra 6)

function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

async function createAuthToken(userId: string, type: "VERIFY_EMAIL" | "RESET_PASSWORD" | "INVITE", ttlMs: number) {
  const rawToken = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMs);
  await getPrisma().authToken.create({
    data: { userId, type, tokenHash: hashToken(rawToken), expiresAt },
  });
  return { rawToken, expiresAt };
}

/**
 * Consome um token de uso único: valida tipo + validade + `usedAt` nulo, marca como usado numa
 * `update` condicional (`usedAt: null` no `where`) para que duas requisições simultâneas com o
 * MESMO token nunca consumam as duas — a segunda sempre perde a corrida e recebe
 * `TOKEN_INVALID`, nunca aplica o efeito duas vezes.
 */
async function consumeAuthToken(rawToken: string, type: "VERIFY_EMAIL" | "RESET_PASSWORD" | "INVITE"): Promise<{ userId: string }> {
  const tokenHash = hashToken(rawToken);
  const prisma = getPrisma();

  const token = await prisma.authToken.findUnique({ where: { tokenHash } });
  if (!token || token.type !== type || token.usedAt || token.expiresAt < new Date()) {
    throw new DomainError("TOKEN_INVALID", "Link inválido ou expirado.");
  }

  const result = await prisma.authToken.updateMany({
    where: { id: token.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (result.count === 0) {
    // Perdeu a corrida para outra requisição com o mesmo token — mesma resposta de "inválido".
    throw new DomainError("TOKEN_INVALID", "Link inválido ou expirado.");
  }

  return { userId: token.userId };
}

// ---------------------------------------------------------------------------
// Cadastro público
// ---------------------------------------------------------------------------

export type SignUpInput = {
  companyName: string;
  slug: string;
  segment: string | null;
  ownerName: string;
  email: string;
  password: string;
  termsVersion: string;
  // CPF/CNPJ da empresa (docs/contratos.md, "Cadastro público" — OBRIGATÓRIO desde
  // 2026-09-29: a primeira fatura já nasce no cadastro e o Mercado Pago exige
  // `payer.identification` para gerar o Pix dela; sem o documento, aquele Pix nunca saía de
  // verdade — ver `tryAttachPix`). Aceita formatado ou só dígitos (`validateCpfCnpj` normaliza).
  document: string;
  /**
   * Telefone do dono (WhatsApp de cobrança, decisão do dono 2026-10-01): opcional, com máscara e DDI opcional.
   * É normalizado para só dígitos com DDI (`558499998888`) em `Tenant.billingWhatsappE164`.
   */
  phone?: string | null;
  /** Cobrança escolhida no cadastro; vale a partir da primeira fatura (a do fim do teste). Padrão: mensal. */
  billingCycle?: BillingCycle;
  /** Cupom digitado no cadastro (opcional). Inválido ou esgotado = erro `COUPON_*` e o cadastro não acontece. */
  couponCode?: string;
};

export type SignUpResult = {
  tenantSlug: string;
  userId: string;
};

function slugErrorMessage(error: SlugValidationError): string {
  switch (error) {
    case "TOO_SHORT":
      return "O endereço da empresa precisa ter pelo menos 3 caracteres.";
    case "TOO_LONG":
      return "O endereço da empresa é muito longo.";
    case "INVALID_FORMAT":
      return "O endereço da empresa só pode ter letras minúsculas, números e hífen (sem espaços ou acentos).";
    case "RESERVED":
      return "Este endereço é reservado pelo sistema. Escolha outro.";
  }
}

/**
 * Cria `User(OWNER)` + `Tenant` + `Membership` + `Subscription(TRIALING, +3 dias — `TRIAL_DAYS`)` + a primeira
 * fatura (§7.3 regra 1) numa única transação — se qualquer passo falhar (ex.: e-mail duplicado
 * detectado por uma corrida), nada fica pela metade. O Pix da primeira fatura e os e-mails
 * (verificação + fatura gerada) são efeitos colaterais DEPOIS da transação confirmar: chamada de
 * rede (Mercado Pago/SMTP) dentro de uma transação de banco arrisca prender a conexão em i/o
 * externo — e se falhar, não deve desfazer o cadastro (a conta existe, o Pix pode ser gerado
 * depois na tela de Assinatura).
 *
 * Compartilhado pelos dois cadastros (senha e Google): a única diferença é como o usuário nasce
 * (`passwordHash` x `googleSub` + e-mail já verificado) — a lógica de empresa/trial/fatura é UMA só.
 */
type CreateAccountInput = {
  email: string;
  ownerName: string;
  companyName: string;
  slug: string;
  segment: string | null;
  documentDigits: string;
  termsVersion: string;
  /** Cadastro por senha: hash. Cadastro por Google: `null` (conta sem senha). */
  passwordHash: string | null;
  /** Cadastro por Google: `sub` da conta Google — já grava o vínculo. */
  googleSub?: string;
  /** Google só passa com `email_verified` = true, então a conta já nasce verificada. */
  emailVerified: boolean;
  /** Plano escolhido (código de um plano ATIVO). Sem ele, vale o plano padrão de cadastro. */
  planCode?: string;
  /** WhatsApp de cobrança já normalizado (só dígitos com DDI), ou `null`. */
  billingWhatsappE164?: string | null;
  billingCycle?: BillingCycle;
  couponCode?: string;
};

/**
 * Telefone do cadastro -> só dígitos com DDI, ou `null` se não veio. Telefone informado e inválido é
 * `INVALID_PHONE` (antes era validado e descartado; agora vira o número de aviso de cobrança).
 */
export function normalizeSignupPhone(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const e164 = normalizeBrPhoneToE164(trimmed);
  if (!e164) throw new DomainError("INVALID_PHONE", "Informe o telefone com DDD, por exemplo (84) 99999-8888.");
  return e164;
}

async function resolveSignupPlan(planCode: string | undefined) {
  if (!planCode) return getDefaultSignupPlan();
  const plan = await getPrisma().plan.findFirst({ where: { code: planCode, active: true } });
  if (!plan) throw new DomainError("INVALID_PLAN", "Plano indisponível. Escolha outro plano.");
  return plan;
}

async function createAccount(input: CreateAccountInput, gateway?: MercadoPagoGateway): Promise<SignUpResult> {
  const prisma = getPrisma();
  const now = new Date();
  const trialEndsAt = newTrialEndsAt(now);
  const plan = await resolveSignupPlan(input.planCode);
  if (input.billingCycle === "ANNUAL" && !planOffersAnnual(plan)) {
    throw new DomainError("INVALID_CYCLE", "Este plano não tem cobrança anual. Escolha a mensal.");
  }
  const cycle = effectiveCycle(plan, input.billingCycle ?? "MONTHLY");
  const email = input.email;
  const slug = input.slug;

  const created = await prisma.$transaction(async (tx) => {
    const existingEmail = await tx.user.findUnique({ where: { email } });
    if (existingEmail) {
      throw new DomainError("EMAIL_TAKEN", "Este e-mail já está em uso.");
    }
    const existingSlug = await tx.tenant.findUnique({ where: { slug } });
    if (existingSlug) {
      throw new DomainError("SLUG_TAKEN", "Este endereço de empresa já está em uso.");
    }

    const user = await tx.user.create({
      data: {
        email,
        passwordHash: input.passwordHash,
        googleSub: input.googleSub ?? null,
        emailVerifiedAt: input.emailVerified ? now : null,
        name: input.ownerName.trim(),
        termsAcceptedAt: now,
        termsVersion: input.termsVersion,
      },
    });

    const tenant = await tx.tenant.create({
      data: {
        slug,
        name: input.companyName.trim(),
        segment: input.segment?.trim() || null,
        document: input.documentDigits,
        // Aviso de cobrança por WhatsApp (D5: ativo para todos; o dono desliga na tela Assinatura).
        billingWhatsappE164: input.billingWhatsappE164 ?? null,
        timezone: "America/Sao_Paulo", // único fuso suportado na v1 (docs/arquitetura.md §14)
      },
    });

    await tx.membership.create({ data: { userId: user.id, tenantId: tenant.id, role: "OWNER" } });

    // Cupom: o resgate (único por empresa) e o uso atômico acontecem aqui dentro; cupom inválido derruba o cadastro inteiro.
    const adopted = input.couponCode ? await adoptCouponInTx(tx, { code: input.couponCode, tenantId: tenant.id, planId: plan.id, cycle, now }) : null;

    const subscription = await tx.subscription.create({
      data: {
        tenantId: tenant.id,
        planId: plan.id,
        status: "TRIALING",
        trialEndsAt,
        currentPeriodEnd: trialEndsAt, // o trial É o primeiro período (§7.3)
        billingCycle: cycle,
        couponId: adopted?.couponId ?? null,
        couponCyclesRemaining: adopted?.cyclesRemaining ?? null,
      },
    });

    // A fatura do fim do teste já nasce no ciclo escolhido e com o cupom aplicado (valor líquido).
    const pricing = priceInvoice(plan, cycle, adopted ? { kind: adopted.kind, value: adopted.value } : null);
    const invoice = await tx.invoice.create({
      data: {
        subscriptionId: subscription.id,
        amountCents: pricing.netCents,
        discountCents: pricing.discountCents,
        couponCode: adopted && pricing.discountCents > 0 ? adopted.code : null,
        cycle: pricing.cycle,
        periodStart: now,
        periodEnd: trialEndsAt,
        dueAt: trialEndsAt,
        status: "OPEN",
        isTrialConversion: true, // fatura do teste: fora de "a receber"/"vencido" no Admin → Cobrança
      },
    });
    if (adopted) {
      await consumeCouponCycleInTx(tx, { subscriptionId: subscription.id, tenantId: tenant.id, couponId: adopted.couponId, invoiceId: invoice.id, discountCents: pricing.discountCents });
    }

    return { user, tenant, invoice };
  });

  // Fora da transação: rede externa (MP + SMTP), nunca desfaz o cadastro se falhar. A fatura JÁ
  // existe (criada dentro da transação acima) — usamos `tryAttachPix` direto, não
  // `createInvoiceForPeriod`/`createInvoiceForPeriodTracked` (que trataria esta fatura recém-
  // criada como "já existe" pelo check de idempotência e nunca chamaria o Mercado Pago).
  const invoiceWithPix = await tryAttachPix(created.invoice.id, email, generateInvoiceDescription(created.tenant.name, cycle), gateway);

  await recordBillingEvent({
    tenantId: created.tenant.id,
    subscriptionId: created.invoice.subscriptionId,
    invoiceId: created.invoice.id,
    type: "INVOICE_CREATED",
    metadata: { amountCents: created.invoice.amountCents, trial: true, cycle, discountCents: created.invoice.discountCents },
  });
  const invoiceEmailSent = await sendInvoiceGeneratedEmail({
    toEmail: email,
    tenantName: created.tenant.name,
    tenantSlug: created.tenant.slug,
    amountCents: created.invoice.amountCents,
    dueAt: created.invoice.dueAt,
    pixCopyPaste: invoiceWithPix?.pixCopyPaste ?? null,
    timezone: created.tenant.timezone,
    annual: cycle === "ANNUAL",
  });
  // O envio imediato do cadastro entra no outbox como `SENT`, para a régua não repetir "Sua fatura chegou".
  // Se o SMTP falhou, nenhuma linha é gravada e a etapa INVOICE_CREATED da régua reenvia na próxima rodada.
  if (invoiceEmailSent) {
    await recordInlineInvoiceNotice({
      tenantId: created.tenant.id,
      subscriptionId: created.invoice.subscriptionId,
      invoiceId: created.invoice.id,
      expiresAt: created.invoice.dueAt,
      recipientMasked: maskEmail(email),
      recipient: email,
    }).catch((error) => {
      logger.warn("signup.invoice_notice_record_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    });
  }

  if (!input.emailVerified) await sendVerificationEmail(created.user.id, email);

  logger.info("signup.completed", { tenantId: created.tenant.id, method: input.googleSub ? "google" : "password" });

  return { tenantSlug: created.tenant.slug, userId: created.user.id };
}

export async function signUp(input: SignUpInput, gateway?: MercadoPagoGateway): Promise<SignUpResult> {
  const email = input.email.trim().toLowerCase();
  const slug = input.slug.trim().toLowerCase();

  const slugError = validateSlug(slug);
  if (slugError) {
    throw new DomainError("INVALID_SLUG", slugErrorMessage(slugError), { rule: slugError });
  }

  const validatedDocument = validateCpfCnpj(input.document);
  if (!validatedDocument.valid) {
    throw new DomainError("INVALID_DOCUMENT", "CPF ou CNPJ inválido. Confira os dígitos.");
  }

  const billingWhatsappE164 = normalizeSignupPhone(input.phone);
  const passwordHash = await hashPassword(input.password);

  return createAccount(
    {
      email,
      ownerName: input.ownerName,
      companyName: input.companyName,
      slug,
      segment: input.segment,
      documentDigits: validatedDocument.digits,
      termsVersion: input.termsVersion,
      passwordHash,
      emailVerified: false,
      billingWhatsappE164,
      billingCycle: input.billingCycle,
      couponCode: input.couponCode,
    },
    gateway,
  );
}

export type GoogleSignUpInput = {
  email: string;
  googleSub: string;
  ownerName: string;
  companyName: string;
  document: string;
  termsVersion: string;
  planCode?: string;
  /** Telefone do dono (mesma regra do cadastro por senha). */
  phone?: string | null;
  billingCycle?: BillingCycle;
  couponCode?: string;
};

/**
 * Cadastro de empresa por conta Google (sem senha, e-mail já verificado). O endereço (slug) é
 * derivado do nome da empresa — o cadastro por Google não pergunta — e ganha sufixo numérico se
 * já existir. Quem chama (`src/modules/google-auth/`) prova a conta Google (token assinado).
 */
export async function signUpWithGoogle(input: GoogleSignUpInput, gateway?: MercadoPagoGateway): Promise<SignUpResult> {
  const validatedDocument = validateCpfCnpj(input.document);
  if (!validatedDocument.valid) {
    throw new DomainError("INVALID_DOCUMENT", "CPF ou CNPJ inválido. Confira os dígitos.");
  }
  const billingWhatsappE164 = normalizeSignupPhone(input.phone);
  const email = input.email.trim().toLowerCase();
  const slug = await pickAvailableSlug(input.companyName);

  return createAccount(
    {
      email,
      ownerName: input.ownerName,
      companyName: input.companyName,
      slug,
      segment: null,
      documentDigits: validatedDocument.digits,
      termsVersion: input.termsVersion,
      passwordHash: null,
      googleSub: input.googleSub,
      emailVerified: true,
      planCode: input.planCode,
      billingWhatsappE164,
      billingCycle: input.billingCycle,
      couponCode: input.couponCode,
    },
    gateway,
  );
}

/** Slug livre a partir do nome: base, depois base-2, base-3... (a transação ainda confere a corrida). */
async function pickAvailableSlug(companyName: string): Promise<string> {
  let base = slugify(companyName);
  if (base.length < 3) base = `empresa-${base}`.replace(/-$/, "");
  if (validateSlug(base) === "RESERVED") base = `${base}-clinica`;
  const prisma = getPrisma();
  for (let n = 1; n <= 50; n += 1) {
    const candidate = n === 1 ? base : `${base.slice(0, 55)}-${n}`;
    if (validateSlug(candidate)) continue;
    const taken = await prisma.tenant.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!taken) return candidate;
  }
  throw new DomainError("SLUG_TAKEN", "Não foi possível gerar um endereço para a empresa. Tente outro nome.");
}

/** Gera um token novo de verificação e envia o e-mail. Falha de SMTP só loga: nunca desfaz o fluxo. */
async function sendVerificationEmail(userId: string, email: string): Promise<void> {
  const { rawToken } = await createAuthToken(userId, "VERIFY_EMAIL", VERIFY_EMAIL_TTL_MS);
  const verifyUrl = `${await getPublicBaseUrl()}/verificar-email?token=${rawToken}`;
  const { subject, html, text } = verificationEmail({ verifyUrl, ctx: await loadEmailContext() });
  await sendMail({ to: email, subject, html, text }).catch((error) => {
    logger.error("signup.verification_email.failed", { errorMessage: error instanceof Error ? error.message : String(error) });
  });
}

/**
 * Reenvio pedido pelo próprio usuário logado (tela WhatsApp/onboarding, quando falta confirmar o
 * e-mail). Já verificado → não envia nada e informa, para a tela parar de oferecer o botão.
 */
export async function resendVerificationEmail(userId: string): Promise<{ alreadyVerified: boolean }> {
  const user = await getPrisma().user.findUnique({ where: { id: userId }, select: { email: true, emailVerifiedAt: true } });
  if (!user) throw new DomainError("NOT_FOUND", "Usuário não encontrado.");
  if (user.emailVerifiedAt) return { alreadyVerified: true };
  await sendVerificationEmail(userId, user.email);
  return { alreadyVerified: false };
}

export async function verifyEmail(rawToken: string): Promise<{ tenantSlug: string | null }> {
  const { userId } = await consumeAuthToken(rawToken, "VERIFY_EMAIL");
  await getPrisma().user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });

  const membership = await getPrisma().membership.findFirst({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { tenant: { select: { slug: true } } },
  });
  return { tenantSlug: membership?.tenant.slug ?? null };
}

// ---------------------------------------------------------------------------
// Esqueci a senha
// ---------------------------------------------------------------------------

/**
 * Nunca revela se o e-mail existe (mesma lógica de `verifyCredentials` — sem enumeration): se
 * não encontrar o usuário, só não envia nada e devolve normalmente.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const user = await getPrisma().user.findUnique({ where: { email: normalized } });
  if (!user) {
    logger.info("password_reset.requested_unknown_email");
    return;
  }

  const { rawToken } = await createAuthToken(user.id, "RESET_PASSWORD", RESET_PASSWORD_TTL_MS);
  const resetUrl = `${await getPublicBaseUrl()}/redefinir-senha?token=${rawToken}`;
  const { subject, html, text } = passwordResetEmail({ resetUrl, ctx: await loadEmailContext() });
  await sendMail({ to: normalized, subject, html, text }).catch((error) => {
    logger.error("password_reset.email.failed", { errorMessage: error instanceof Error ? error.message : String(error) });
  });
}

export async function resetPassword(rawToken: string, newPassword: string): Promise<void> {
  const { userId } = await consumeAuthToken(rawToken, "RESET_PASSWORD");
  const passwordHash = await hashPassword(newPassword);
  // `sessionVersion` sobe no mesmo update: quem redefine a senha (ex.: por suspeita de invasão)
  // derruba as sessões que já estavam abertas.
  await getPrisma().user.update({ where: { id: userId }, data: { passwordHash, sessionVersion: { increment: 1 } } });
  forgetSessionVersion(userId);
}

// ---------------------------------------------------------------------------
// Convite de equipe (§7.3 regra 6)
// ---------------------------------------------------------------------------

export async function inviteTeamMember(params: { tenantId: string; tenantName: string; email: string; role: MembershipRole }): Promise<void> {
  const email = params.email.trim().toLowerCase();
  const prisma = getPrisma();

  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    // Senha aleatória e inutilizável até o convite ser aceito (`acceptInvite` a troca) — a
    // conta "existe" (tem id, pode receber Membership) mas ninguém consegue entrar com ela
    // antes de definir a própria senha.
    const placeholderPasswordHash = await hashPassword(crypto.randomBytes(24).toString("base64url"));
    user = await prisma.user.create({ data: { email, passwordHash: placeholderPasswordHash } });
  }

  const existingMembership = await prisma.membership.findUnique({
    where: { userId_tenantId: { userId: user.id, tenantId: params.tenantId } },
  });
  if (existingMembership) {
    throw new DomainError("ALREADY_MEMBER", "Este e-mail já faz parte da equipe.");
  }

  await prisma.membership.create({ data: { userId: user.id, tenantId: params.tenantId, role: params.role } });

  const { rawToken } = await createAuthToken(user.id, "INVITE", INVITE_TTL_MS);
  const inviteUrl = `${await getPublicBaseUrl()}/convite?token=${rawToken}`;
  const { subject, html, text } = teamInviteEmail({ tenantName: params.tenantName, inviteUrl, ctx: await loadEmailContext() });
  await sendMail({ to: email, subject, html, text }).catch((error) => {
    logger.error("invite.email.failed", { errorMessage: error instanceof Error ? error.message : String(error) });
  });
}

export async function acceptInvite(rawToken: string, password: string, name: string): Promise<{ tenantSlug: string | null }> {
  const { userId } = await consumeAuthToken(rawToken, "INVITE");
  const passwordHash = await hashPassword(password);
  await getPrisma().user.update({ where: { id: userId }, data: { passwordHash, name: name.trim(), emailVerifiedAt: new Date() } });

  const membership = await getPrisma().membership.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { tenant: { select: { slug: true } } },
  });
  return { tenantSlug: membership?.tenant.slug ?? null };
}

/**
 * Aceite de convite de equipe pelo Google. O e-mail da conta Google (já verificado) TEM de ser o
 * do convite — senão `INVITE_EMAIL_MISMATCH` e o token NÃO é consumido. Vincula o `googleSub`,
 * marca o e-mail como verificado e consome o convite (uso único, mesma corrida protegida do
 * `consumeAuthToken`). ATÔMICO (revisão do Órion I2): o claim do convite e o `update` do usuário
 * rodam na MESMA transação — se o `sub` já é de outro usuário (checado antes e, na corrida, pela
 * unicidade de `googleSub` -> P2002 -> `GOOGLE_ACCOUNT_MISMATCH`), tudo é desfeito e o convite
 * continua válido. Conta ainda não verificada perde a senha e ganha `sessionVersion`+1. Não cria senha: a conta passa a ser só-Google (pode definir uma em "esqueci
 * a senha"). Admin da plataforma nunca entra por aqui.
 */
export async function acceptInviteWithGoogle(
  rawToken: string,
  google: { sub: string; email: string; name?: string | null },
): Promise<{ userId: string; tenantSlug: string | null }> {
  const prisma = getPrisma();
  const tokenHash = hashToken(rawToken);
  const token = await prisma.authToken.findUnique({ where: { tokenHash }, include: { user: true } });
  if (!token || token.type !== "INVITE" || token.usedAt || token.expiresAt < new Date()) {
    throw new DomainError("TOKEN_INVALID", "Convite inválido ou expirado.");
  }
  const user = token.user;
  if (user.isPlatformAdmin) throw new DomainError("FORBIDDEN", "Contas de administrador da plataforma não entram pelo Google.");
  if (user.email !== google.email.trim().toLowerCase()) {
    throw new DomainError("INVITE_EMAIL_MISMATCH", "O e-mail da conta Google não é o do convite.");
  }
  if (user.googleSub && user.googleSub !== google.sub) {
    throw new DomainError("GOOGLE_ACCOUNT_MISMATCH", "Este usuário já está ligado a outra conta Google.");
  }

  try {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.authToken.updateMany({ where: { id: token.id, usedAt: null }, data: { usedAt: new Date() } });
      if (claimed.count === 0) throw new DomainError("TOKEN_INVALID", "Convite inválido ou expirado.");

      const owner = await tx.user.findUnique({ where: { googleSub: google.sub }, select: { id: true } });
      if (owner && owner.id !== user.id) {
        throw new DomainError("GOOGLE_ACCOUNT_MISMATCH", "Esta conta Google já está ligada a outro usuário.");
      }

      await tx.user.update({
        where: { id: user.id },
        data: {
          googleSub: google.sub,
          emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
          // Conta ainda NÃO verificada: a senha (provisória do convite ou pré-definida por terceiro)
          // não prova nada — descarta e derruba sessões já abertas. Quem já verificou o e-mail
          // mantém a própria senha e as sessões.
          ...(user.emailVerifiedAt ? {} : { passwordHash: null, sessionVersion: { increment: 1 } }),
          ...(user.name ? {} : google.name?.trim() ? { name: google.name.trim().slice(0, 80) } : {}),
        },
      });
    });
  } catch (error) {
    // Corrida com outro vínculo do mesmo `sub`: a unicidade do banco é a trava final (a transação
    // já foi desfeita, então o convite NÃO foi consumido).
    if (isUniqueViolation(error)) {
      throw new DomainError("GOOGLE_ACCOUNT_MISMATCH", "Esta conta Google já está ligada a outro usuário.");
    }
    throw error;
  }
  if (!user.emailVerifiedAt) forgetSessionVersion(user.id);

  const membership = await prisma.membership.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: { tenant: { select: { slug: true } } },
  });
  return { userId: user.id, tenantSlug: membership?.tenant.slug ?? null };
}

export { billingUrlFor, findBillingRecipientEmail };
