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
import { slugify, validateSlug } from "@/core/signup/slug";
import { isDisposableEmail } from "@/core/signup/disposable-email";
import { cycleLabel, effectiveCycle, planOffersCycle, priceInvoice, validateCpfCnpj, type BillingCycle } from "@/core/billing";
import { adoptCouponInTx, consumeCouponCycleInTx, previewCoupon, PUBLIC_COUPON_REFUSAL } from "@/modules/billing/coupons";
import { normalizeBrPhoneStrict } from "@/core/contact/br-phone";
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
import { ensureRescueLead } from "@/modules/rescue/service";

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
  ownerName: string;
  email: string;
  password: string;
  termsVersion: string;
  /**
   * WhatsApp do responsável (OBRIGATÓRIO desde 2026-10-10): com máscara e DDI opcional, DDD tem que existir. É normalizado
   * para só dígitos com DDI (`558499998888`) em `Tenant.billingWhatsappE164`. Inválido ou vazio = `INVALID_PHONE`.
   */
  phone: string;
  /** LEGADO (aba antiga em cache): IGNORADO. O endereço (slug) é sempre gerado a partir do nome da empresa. */
  slug?: string;
  /** LEGADO: se vier, grava; o formulário novo não pergunta. */
  segment?: string | null;
  /**
   * CPF/CNPJ da empresa. Opcional desde 2026-10-10 (o documento é pedido na hora de pagar, na tela Assinatura).
   * Se vier não vazio, é validado (`INVALID_DOCUMENT`) e grava; sem ele a fatura do teste nasce sem Pix.
   */
  document?: string | null;
  /** Cobrança escolhida; vale a partir da primeira fatura (a do fim do teste). Padrão: mensal. */
  billingCycle?: BillingCycle;
  /** Cupom do link de campanha (opcional). Inválido ou esgotado NÃO derruba o cadastro: a conta nasce sem cupom (`couponDropped`). */
  couponCode?: string;
};

export type SignUpResult = {
  tenantSlug: string;
  userId: string;
  /** `true` se veio um cupom e ele não pôde ser aplicado (venceu, esgotou, outro plano ou ciclo). */
  couponDropped: boolean;
};

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
 *
 * Sem CPF/CNPJ (cadastro enxuto): a fatura do teste nasce `OPEN` sem Pix, o MP nem é chamado e o e-mail
 * "Sua fatura chegou" NÃO sai no dia 0 (a régua o manda, com o Pix, quando o documento entrar).
 */
type CreateAccountInput = {
  email: string;
  ownerName: string;
  companyName: string;
  segment: string | null;
  /** Só dígitos, já validado, ou `null` (documento pedido depois, na hora de pagar). */
  documentDigits: string | null;
  termsVersion: string;
  /** Cadastro por senha: hash. Cadastro por Google: `null` (conta sem senha). */
  passwordHash: string | null;
  /** Cadastro por Google: `sub` da conta Google — já grava o vínculo. */
  googleSub?: string;
  /** Google só passa com `email_verified` = true, então a conta já nasce verificada. */
  emailVerified: boolean;
  /** Plano escolhido (código de um plano ATIVO). Sem ele, vale o plano padrão de cadastro. */
  planCode?: string;
  /** WhatsApp de cobrança já normalizado (só dígitos com DDI). */
  billingWhatsappE164: string;
  billingCycle?: BillingCycle;
  couponCode?: string;
};

/**
 * Telefone do cadastro -> só dígitos com DDI. OBRIGATÓRIO: vazio, mal formado ou com DDD inexistente é `INVALID_PHONE`
 * (é o número da régua de cobrança e o melhor sinal de cadastro real).
 */
export function normalizeSignupPhone(raw: string | null | undefined): string {
  const e164 = raw?.trim() ? normalizeBrPhoneStrict(raw.trim()) : null;
  if (!e164) throw new DomainError("INVALID_PHONE", "Informe o WhatsApp com DDD, por exemplo (84) 99999-8888.");
  return e164;
}

/** CPF/CNPJ opcional do cadastro: vazio = `null`; preenchido e inválido = `INVALID_DOCUMENT`. */
function optionalSignupDocument(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const validated = validateCpfCnpj(trimmed);
  if (!validated.valid) throw new DomainError("INVALID_DOCUMENT", "CPF ou CNPJ inválido. Confira os dígitos.");
  return validated.digits;
}

async function resolveSignupPlan(planCode: string | undefined) {
  if (!planCode) return getDefaultSignupPlan();
  const plan = await getPrisma().plan.findFirst({ where: { code: planCode, active: true } });
  if (!plan) throw new DomainError("INVALID_PLAN", "Plano indisponível. Escolha outro plano.");
  return plan;
}

function isCouponRefusal(error: unknown): boolean {
  return error instanceof DomainError && error.code.startsWith("COUPON_");
}

/** O cupom vale para este plano e ciclo agora? Qualquer recusa (inclusive erro inesperado de leitura) = não vale; o cadastro segue. */
async function couponIsUsable(code: string, planId: string, cycle: BillingCycle, now: Date): Promise<boolean> {
  try {
    await previewCoupon({ code, planId, cycle, now });
    return true;
  } catch (error) {
    if (!isCouponRefusal(error)) logger.warn("signup.coupon_preview_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}

type PersistedAccount = Awaited<ReturnType<typeof persistAccount>>;

/** A transação do cadastro. Lança `EMAIL_TAKEN`/`SLUG_TAKEN`/`COUPON_INVALID` ou o erro de unicidade do Prisma (corrida). */
async function persistAccount(
  input: CreateAccountInput,
  ctx: { slug: string; couponCode: string | undefined; plan: Awaited<ReturnType<typeof resolveSignupPlan>>; cycle: BillingCycle; now: Date; trialEndsAt: Date },
) {
  const { slug, couponCode, plan, cycle, now, trialEndsAt } = ctx;
  return getPrisma().$transaction(async (tx) => {
    const existingEmail = await tx.user.findUnique({ where: { email: input.email } });
    if (existingEmail) {
      throw new DomainError("EMAIL_TAKEN", "Este e-mail já está em uso.");
    }
    const existingSlug = await tx.tenant.findUnique({ where: { slug } });
    if (existingSlug) {
      throw new DomainError("SLUG_TAKEN", "Este endereço de empresa já está em uso.");
    }

    const user = await tx.user.create({
      data: {
        email: input.email,
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
        billingWhatsappE164: input.billingWhatsappE164,
        timezone: "America/Sao_Paulo", // único fuso suportado na v1 (docs/arquitetura.md §14)
      },
    });

    await tx.membership.create({ data: { userId: user.id, tenantId: tenant.id, role: "OWNER" } });

    // Cupom: o resgate (único por empresa) e o uso atômico acontecem aqui dentro. Recusa na corrida (esgotou entre a
    // prévia e a transação) desfaz a transação inteira; quem chama refaz sem cupom (o cadastro não cai por causa de cupom).
    const adopted = couponCode
      ? await adoptCouponInTx(tx, { code: couponCode, tenantId: tenant.id, planId: plan.id, cycle, now }).catch((error: unknown) => {
          if (isCouponRefusal(error)) throw new DomainError("COUPON_INVALID", PUBLIC_COUPON_REFUSAL);
          throw error;
        })
      : null;

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
}

/** Corridas seguidas de endereço (slug) que o cadastro tolera antes de desistir. */
const MAX_SLUG_RETRIES = 3;

async function createAccount(input: CreateAccountInput, gateway?: MercadoPagoGateway): Promise<SignUpResult> {
  const now = new Date();
  const trialEndsAt = newTrialEndsAt(now);
  const plan = await resolveSignupPlan(input.planCode);
  if (input.billingCycle && !planOffersCycle(plan, input.billingCycle)) {
    throw new DomainError("INVALID_CYCLE", `Este plano não tem cobrança ${cycleLabel(input.billingCycle)}. Escolha outra.`);
  }
  const cycle = effectiveCycle(plan, input.billingCycle ?? "MONTHLY");
  const email = input.email;

  // Cupom que não vale (venceu, esgotou, outro plano) não derruba o cadastro: a conta nasce sem ele.
  let couponCode = input.couponCode;
  let couponDropped = false;
  if (couponCode && !(await couponIsUsable(couponCode, plan.id, cycle, now))) {
    couponCode = undefined;
    couponDropped = true;
  }

  // Endereço (slug) sempre automático. Corrida (alguém levou o mesmo endereço entre a consulta e a transação):
  // refaz com outro endereço (até MAX_SLUG_RETRIES vezes: cadastros simultâneos do mesmo nome podem escolher o mesmo sufixo).
  // Corrida do cupom (esgotou no meio): refaz UMA vez sem cupom.
  let slug = await pickAvailableSlug(input.companyName);
  let slugRetries = 0;
  let created: PersistedAccount | null = null;
  while (!created) {
    try {
      created = await persistAccount(input, { slug, couponCode, plan, cycle, now, trialEndsAt });
    } catch (error) {
      if (couponCode && isCouponRefusal(error)) {
        couponCode = undefined;
        couponDropped = true;
        continue;
      }
      const uniqueViolation = isUniqueViolation(error);
      const slugCollision = (error instanceof DomainError && error.code === "SLUG_TAKEN") || uniqueViolation;
      if (!slugCollision) throw error;
      if (uniqueViolation) {
        // A unicidade pode ser do e-mail (dois cadastros iguais ao mesmo tempo) ou do `sub` do Google, não do endereço.
        const prisma = getPrisma();
        const [byEmail, bySub] = await Promise.all([
          prisma.user.findUnique({ where: { email }, select: { id: true } }),
          input.googleSub ? prisma.user.findUnique({ where: { googleSub: input.googleSub }, select: { id: true } }) : Promise.resolve(null),
        ]);
        if (input.googleSub && (byEmail || bySub)) throw error; // o cadastro do Google traduz para ALREADY_REGISTERED
        if (byEmail) throw new DomainError("EMAIL_TAKEN", "Este e-mail já está em uso.");
      }
      if (slugRetries >= MAX_SLUG_RETRIES) throw new DomainError("SLUG_TAKEN", "Não foi possível criar a conta agora. Tente de novo em instantes.");
      slugRetries += 1;
      slug = await pickAvailableSlug(input.companyName);
    }
  }

  // Fora da transação: rede externa (MP + SMTP), nunca desfaz o cadastro se falhar. A fatura JÁ
  // existe (criada dentro da transação acima) — usamos `tryAttachPix` direto, não
  // `createInvoiceForPeriod`/`createInvoiceForPeriodTracked` (que trataria esta fatura recém-
  // criada como "já existe" pelo check de idempotência e nunca chamaria o Mercado Pago).
  const hasDocument = input.documentDigits !== null;
  const invoiceWithPix = hasDocument ? await tryAttachPix(created.invoice.id, email, generateInvoiceDescription(created.tenant.name, cycle), gateway) : null;

  await recordBillingEvent({
    tenantId: created.tenant.id,
    subscriptionId: created.invoice.subscriptionId,
    invoiceId: created.invoice.id,
    type: "INVOICE_CREATED",
    metadata: { amountCents: created.invoice.amountCents, trial: true, cycle, discountCents: created.invoice.discountCents, hasDocument },
  });
  if (hasDocument) {
    const invoiceEmailSent = await sendInvoiceGeneratedEmail({
      toEmail: email,
      tenantName: created.tenant.name,
      tenantSlug: created.tenant.slug,
      amountCents: created.invoice.amountCents,
      dueAt: created.invoice.dueAt,
      pixCopyPaste: invoiceWithPix?.pixCopyPaste ?? null,
      timezone: created.tenant.timezone,
      cycle,
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
  }

  if (!input.emailVerified) await sendVerificationEmail(created.user.id, email);

  if (input.billingWhatsappE164) {
    await ensureRescueLead(created.user.id, created.tenant.id, input.billingWhatsappE164, now).catch((err) => {
      logger.warn("signup.ensure_rescue_lead_failed", {
        userId: created.user.id,
        tenantId: created.tenant.id,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    });
  }

  logger.info("signup.completed", { tenantId: created.tenant.id, method: input.googleSub ? "google" : "password", hasDocument, couponDropped });

  return { tenantSlug: created.tenant.slug, userId: created.user.id, couponDropped };
}

export async function signUp(input: SignUpInput, gateway?: MercadoPagoGateway): Promise<SignUpResult> {
  const email = input.email.trim().toLowerCase();
  if (isDisposableEmail(email)) {
    throw new DomainError("DISPOSABLE_EMAIL", "Use um e-mail que você acessa sempre: é por ele que chegam os avisos da conta.");
  }
  const billingWhatsappE164 = normalizeSignupPhone(input.phone);
  const documentDigits = optionalSignupDocument(input.document);
  const passwordHash = await hashPassword(input.password);

  return createAccount(
    {
      email,
      ownerName: input.ownerName,
      companyName: input.companyName,
      segment: input.segment ?? null,
      documentDigits,
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
  /** LEGADO: opcional (o documento é pedido na hora de pagar). */
  document?: string | null;
  termsVersion: string;
  planCode?: string;
  /** WhatsApp do dono (mesma regra do cadastro por senha): OBRIGATÓRIO. */
  phone: string;
  billingCycle?: BillingCycle;
  couponCode?: string;
};

/**
 * Cadastro de empresa por conta Google (sem senha, e-mail já verificado). O endereço (slug) é
 * derivado do nome da empresa — o cadastro por Google não pergunta — e ganha sufixo numérico se
 * já existir. Quem chama (`src/modules/google-auth/`) prova a conta Google (token assinado).
 */
export async function signUpWithGoogle(input: GoogleSignUpInput, gateway?: MercadoPagoGateway): Promise<SignUpResult> {
  const documentDigits = optionalSignupDocument(input.document);
  const billingWhatsappE164 = normalizeSignupPhone(input.phone);
  const email = input.email.trim().toLowerCase();

  return createAccount(
    {
      email,
      ownerName: input.ownerName,
      companyName: input.companyName,
      segment: null,
      documentDigits,
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
export async function pickAvailableSlug(companyName: string): Promise<string> {
  let base = slugify(companyName);
  if (base.length < 3) base = `empresa-${base}`.replace(/-$/, "");
  if (validateSlug(base) === "RESERVED") base = `${base}-clinica`;
  const prisma = getPrisma();
  for (let n = 1; n <= 50; n += 1) {
    // O corte do prefixo não pode terminar em hífen ("aaa-" + "-2" daria "aaa--2", slug inválido em toda tentativa).
    const candidate = n === 1 ? base : `${base.slice(0, 55).replace(/-+$/, "")}-${n}`;
    if (validateSlug(candidate)) continue;
    const taken = await prisma.tenant.findUnique({ where: { slug: candidate }, select: { id: true } });
    if (!taken) return candidate;
  }
  throw new DomainError("SLUG_TAKEN", "Não foi possível criar a conta agora. Tente de novo em instantes.");
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
  } else if (!user.emailVerifiedAt) {
    // Conta que ninguém provou ser dona do e-mail (pode ser um pré-registro de terceiro com senha que ele conhece): antes
    // de ligá-la a esta empresa, a senha é descartada e as sessões abertas caem. Quem aceitar o convite define a própria senha.
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash: null, sessionVersion: { increment: 1 } } });
    forgetSessionVersion(user.id);
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
  const before = await getPrisma().user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } });
  const wasUnverified = !before?.emailVerifiedAt;
  await getPrisma().user.update({
    where: { id: userId },
    // Conta não verificada: sessões abertas antes (por quem conhecia a senha antiga) caem.
    data: { passwordHash, name: name.trim(), emailVerifiedAt: new Date(), ...(wasUnverified ? { sessionVersion: { increment: 1 } } : {}) },
  });
  if (wasUnverified) forgetSessionVersion(userId);

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
