"use server";

import { z, ZodError } from "zod";
import { requireSessionUser, requireTenantMember } from "@/lib/auth/guards";
import { runAction, type Result } from "@/lib/result";
import { DomainError, isDomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { slugify } from "@/core/signup/slug";
import { checkRateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/http/client-ip";
import { BILLING_CYCLES } from "@/core/billing";
import { userNameSchema } from "@/lib/validation/user-name";
import { assertCurrentTermsVersion, TERMS_VERSION } from "@/lib/legal";
import { getGoogleSignUpPrefill, completeGoogleSignUp } from "@/modules/google-auth/signup";
import { signGoogleToken, verifyGoogleToken } from "@/modules/google-auth/tokens";
import { assertGoogleSignupCookie, clearGoogleSignupCookie } from "@/modules/google-auth/signup-cookie";
import { clearSignupCouponCookie, readSignupCouponCookie } from "@/modules/google-auth/signup-coupon-cookie";
import { maskEmail } from "@/modules/billing/dunning/outbox";
import { memberActor, recordAudit } from "@/modules/audit/record";
import { readMetaClientContext } from "@/modules/meta/request-context";
import { trackCompleteRegistration } from "@/modules/meta/tracking";
import { acceptInvite, inviteTeamMember, requestPasswordReset, resendVerificationEmail, resetPassword, signUp, verifyEmail } from "./service";

/**
 * Server Actions do cadastro público e fluxos de conta (docs/contratos.md). Rate limit por IP
 * (§7.3 regra 4) fica AQUI, não em `service.ts` — é uma preocupação de "borda HTTP" (de onde
 * vem a requisição), enquanto `service.ts` é regra de negócio pura de I/O.
 */

function assertRateLimit(scope: string, ip: string, limit: number, windowMs: number) {
  const result = checkRateLimit(`${scope}:${ip}`, limit, windowMs);
  if (!result.allowed) {
    throw new DomainError("RATE_LIMITED", "Muitas tentativas. Tente de novo daqui a alguns minutos.", {
      retryAfterMs: result.retryAfterMs,
    });
  }
}

// Nome do usuário: campo `name` (2 a 80). `ownerName` (nome antigo do campo) continua aceito como
// alias para não quebrar um formulário em cache durante a transição.
const signUpSchema = z.preprocess(
  (raw) => {
    if (raw && typeof raw === "object" && !("name" in raw) && "ownerName" in raw) {
      const { ownerName, ...rest } = raw as Record<string, unknown>;
      return { ...rest, name: ownerName };
    }
    return raw;
  },
  z.object({
    companyName: z.string().trim().min(2).max(120),
    name: userNameSchema,
    email: z.string().trim().email().max(255),
    password: z.string().min(8).max(200),
    // WhatsApp do responsável: OBRIGATÓRIO (vira o WhatsApp de cobrança). Ausente ou vazio chega ao serviço como "" e vira
    // `INVALID_PHONE` (a tela sabe tratar); número mal formado ou com DDD inexistente também.
    phone: z.string().trim().max(30).default(""),
    termsVersion: z.string().min(1).max(50),
    acceptedTerms: z.boolean().refine((v) => v === true, { message: "É preciso aceitar os termos." }),
    // Cupom vindo do link de campanha (`?cupom=`). Inválido NÃO derruba o cadastro (resposta `couponDropped`).
    couponCode: z.string().trim().max(40).optional(),
    // Só vem quando o visitante aceitou o Pixel do Meta: é o event_id que o navegador usou, para a API
    // de Conversões mandar o mesmo evento e a Meta descartar a duplicata. Ausente = sem rastreio.
    metaEventId: z.string().max(64).optional(),
    // Isca para robô (campo escondido que gente nunca preenche). Preenchido = sucesso falso, nada é criado.
    // Nome que o autofill do navegador não reconhece (`website` era preenchido por alguns gerenciadores de senha). `website` segue
    // aceito como nome legado (aba antiga em cache).
    hp_confirm_field: z.string().max(200).optional(),
    website: z.string().max(200).optional(),
    // LEGADO (aba antiga em cache durante o deploy): aceitos e opcionais. `slug` é ignorado (o endereço é automático).
    slug: z.string().max(120).optional(),
    segment: z.string().trim().max(80).optional(),
    document: z.string().trim().max(40).optional(),
    billingCycle: z.enum(BILLING_CYCLES).optional(),
  }),
);

const SIGNUP_LIMIT = 5;
const SIGNUP_WINDOW_MS = 60 * 60 * 1000; // 5 cadastros/hora por IP

export type SignUpActionData = {
  tenantSlug: string;
  /** `true` = a sessão já está aberta (o cliente segue para `/pos-login`). `false` = mostrar "Confirme seu e-mail". */
  sessionStarted: boolean;
  /** `true` = veio um cupom que não pôde ser aplicado; a conta foi criada sem ele. */
  couponDropped: boolean;
};

/**
 * Abre a sessão logo depois do cadastro pelo provedor `verified-login` (prova assinada de 60 s que nasce e é
 * consumida aqui, nunca vai ao cliente). Falhou: a conta continua criada e a tela cai no "Confirme seu e-mail".
 * Import dinâmico de `@/lib/auth` (Auth.js), como no cadastro do Google: os testes de integração não dependem dele.
 */
async function startSessionAfterSignUp(userId: string): Promise<boolean> {
  try {
    const proof = signGoogleToken("login-verified", { userId }, 60_000);
    const { signIn } = await import("@/lib/auth");
    await signIn("verified-login", { proof, redirect: false });
    return true;
  } catch (error) {
    logger.warn("signup.session_start_failed", { errorName: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}

export async function signUpAction(input: unknown): Promise<Result<SignUpActionData>> {
  return runAction(async () => {
    try {
      const ip = await clientIp();
      assertRateLimit("signup", ip, SIGNUP_LIMIT, SIGNUP_WINDOW_MS);

      const data = signUpSchema.parse(input);

      // Robô que preencheu a isca: responde como se tivesse dado certo e não cria nada (não dá pista de que foi barrado).
      const trap = [data.hp_confirm_field, data.website].find((value) => value && value.trim() !== "");
      if (trap) {
        // Contagem acumulada no processo: um salto depois de mexer no formulário indica falso positivo (autofill), não robô.
        const state = globalThis as { __signupHoneypotHits?: number };
        state.__signupHoneypotHits = (state.__signupHoneypotHits ?? 0) + 1;
        logger.info("signup.honeypot", { hits: state.__signupHoneypotHits, field: data.hp_confirm_field ? "hp_confirm_field" : "website" });
        return { tenantSlug: slugify(data.companyName) || "empresa", sessionStarted: false, couponDropped: false };
      }

      // O client manda `TERMS_VERSION` (src/lib/legal.ts) junto do formulário — conferimos contra
      // a MESMA constante aqui, em vez de gravar o que veio do client sem checar (decisão do
      // dono, 2026-09-29): um aceite versionado só vale alguma coisa se provar que a pessoa
      // aceitou a redação que está NO AR agora. Uma aba antiga em cache mandando uma versão velha
      // teria seu aceite gravado como se fosse da redação atual — e ninguém teria de fato lido o
      // texto vigente. Rejeitar com uma mensagem clara ("atualize a página") é melhor que aceitar
      // silenciosamente ou do que sobrescrever pela constante sem avisar (a pessoa então "aceitaria"
      // um texto que nunca viu). `signUp` sempre recebe `TERMS_VERSION` (a constante do SERVIDOR,
      // não `data.termsVersion`) — mesmo já validados iguais, isso garante que o valor persistido
      // é sempre o canônico.
      assertCurrentTermsVersion(data.termsVersion);

      const result = await signUp({
        companyName: data.companyName,
        segment: data.segment ?? null,
        ownerName: data.name,
        email: data.email,
        password: data.password,
        document: data.document ?? null,
        phone: data.phone,
        termsVersion: TERMS_VERSION,
        billingCycle: data.billingCycle,
        couponCode: data.couponCode || undefined,
      });
      // Nunca atrasa nem derruba o cadastro: `trackCompleteRegistration` captura os próprios erros.
      if (data.metaEventId) {
        await trackCompleteRegistration({
          tenantSlug: result.tenantSlug,
          userId: result.userId,
          eventId: data.metaEventId,
          client: await readMetaClientContext().catch(() => ({})),
        });
      }
      const sessionStarted = await startSessionAfterSignUp(result.userId);
      return { tenantSlug: result.tenantSlug, sessionStarted, couponDropped: result.couponDropped };
    } catch (error) {
      // Só o código (nunca e-mail, telefone ou nome): mostra onde as pessoas travam na próxima campanha.
      if (isDomainError(error)) logger.info("signup.rejected", { code: error.code });
      else if (error instanceof ZodError) logger.info("signup.rejected", { code: "INVALID_PAYLOAD", fields: error.issues.map((i) => i.path.join(".")).slice(0, 5) });
      throw error;
    }
  });
}

const verifyEmailSchema = z.object({ token: z.string().min(1) });

export async function verifyEmailAction(input: unknown): Promise<Result<{ tenantSlug: string | null }>> {
  return runAction(async () => {
    const data = verifyEmailSchema.parse(input);
    return verifyEmail(data.token);
  });
}

const requestPasswordResetSchema = z.object({ email: z.string().trim().email() });
const RESET_REQUEST_LIMIT = 5;
const RESET_REQUEST_WINDOW_MS = 60 * 60 * 1000;

const RESEND_VERIFICATION_LIMIT = 3;
const RESEND_VERIFICATION_WINDOW_MS = 60 * 60 * 1000; // 3 reenvios/hora por usuário

/** Reenvia o e-mail de confirmação para o usuário logado (docs/contratos.md, "Fase 7"). */
export async function resendVerificationEmailAction(): Promise<Result<{ alreadyVerified: boolean }>> {
  return runAction(async () => {
    const user = await requireSessionUser();
    assertRateLimit("resend-verification", user.id, RESEND_VERIFICATION_LIMIT, RESEND_VERIFICATION_WINDOW_MS);
    return resendVerificationEmail(user.id);
  });
}

export async function requestPasswordResetAction(input: unknown): Promise<Result<{ requested: true }>> {
  return runAction(async () => {
    const ip = await clientIp();
    assertRateLimit("password-reset", ip, RESET_REQUEST_LIMIT, RESET_REQUEST_WINDOW_MS);

    const data = requestPasswordResetSchema.parse(input);
    await requestPasswordReset(data.email);
    return { requested: true };
  });
}

const resetPasswordSchema = z.object({ token: z.string().min(1), password: z.string().min(8).max(200) });

export async function resetPasswordAction(input: unknown): Promise<Result<{ done: true }>> {
  return runAction(async () => {
    const data = resetPasswordSchema.parse(input);
    await resetPassword(data.token, data.password);
    return { done: true };
  });
}

const inviteSchema = z.object({
  email: z.string().trim().email(),
  role: z.enum(["OWNER", "STAFF"]),
});

/** Só OWNER convida (§9, tela de equipe — fora do escopo desta fase, mas a Server Action já existe). */
export async function inviteTeamMemberAction(tenantSlug: string, input: unknown): Promise<Result<{ invited: true }>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug, ["OWNER"]);
    const { tenant } = ctx;
    const data = inviteSchema.parse(input);
    await inviteTeamMember({ tenantId: tenant.id, tenantName: tenant.name, email: data.email, role: data.role });
    await recordAudit({
      tenantId: tenant.id,
      actor: memberActor(ctx),
      action: "team.invited",
      targetType: "membership",
      summary: `Convidou ${maskEmail(data.email)} com o papel ${data.role === "OWNER" ? "Dono" : "Equipe"}.`,
      changes: { papel: { de: null, para: data.role } },
    });
    return { invited: true };
  });
}

const acceptInviteSchema = z.object({ token: z.string().min(1), password: z.string().min(8).max(200), name: userNameSchema });

export async function acceptInviteAction(input: unknown): Promise<Result<{ tenantSlug: string | null }>> {
  return runAction(async () => {
    const data = acceptInviteSchema.parse(input);
    return acceptInvite(data.token, data.password, data.name);
  });
}

/** Usada pela tela de "reenviar verificação" (se existir) — exige sessão, não token de convite. */
export async function currentUserIdAction(): Promise<Result<{ userId: string }>> {
  return runAction(async () => {
    const user = await requireSessionUser();
    return { userId: user.id };
  });
}

// ---------------------------------------------------------------------------
// Cadastro depois do Google (`/cadastro/google?t=...`) — docs/contratos.md "Login com Google"
// ---------------------------------------------------------------------------

/** Dados para pré-preencher a tela. Erros: `TOKEN_INVALID`, `TOKEN_EXPIRED`, `ALREADY_REGISTERED`. */
export async function getGoogleSignUpPrefillAction(input: unknown): Promise<Result<{ email: string; name: string }>> {
  return runAction(async () => {
    const data = z.object({ token: z.string().min(1).max(2000) }).parse(input);
    // O token na URL não basta: o cookie httpOnly do mesmo navegador precisa bater (S1).
    await assertGoogleSignupCookie(data.token);
    return getGoogleSignUpPrefill(data.token);
  });
}

const completeGoogleSignUpSchema = z.object({
  token: z.string().min(1).max(2000),
  tenantName: z.string().trim().min(2).max(120),
  // LEGADO (aba antiga): opcional. O CPF/CNPJ é pedido na hora de pagar, na tela Assinatura.
  document: z.string().trim().max(40).optional(),
  // WhatsApp obrigatório: ausente ou vazio chega ao serviço como "" e vira `INVALID_PHONE`.
  phone: z.string().trim().max(30).default(""),
  planCode: z.string().trim().max(60).optional(),
  // LEGADO: ciclo e cupom vindos do cliente. O cupom de verdade vem do cookie `innochat_signup_coupon` (servidor);
  // `couponCode` do cliente só vale se não houver cookie.
  billingCycle: z.enum(BILLING_CYCLES).optional(),
  couponCode: z.string().trim().max(40).optional(),
  acceptTerms: z.boolean().refine((v) => v === true, { message: "É preciso aceitar os termos." }),
  metaEventId: z.string().max(64).optional(),
});

const GOOGLE_SIGNUP_LIMIT = 5;
const GOOGLE_SIGNUP_WINDOW_MS = 60 * 60 * 1000;

/**
 * Cria empresa + usuário (sem senha, e-mail verificado) + trial — a MESMA lógica de `signUp`
 * (`createAccount`) — e abre a sessão. `phone` (OBRIGATÓRIO) vira o WhatsApp de cobrança
 * (`Tenant.billingWhatsappE164`, normalizado para só dígitos com DDI). Cupom: cookie do servidor.
 */
export async function completeGoogleSignUpAction(input: unknown): Promise<Result<{ redirectTo: string; couponDropped: boolean }>> {
  return runAction(async () => {
    const ip = await clientIp();
    assertRateLimit("google-signup", ip, GOOGLE_SIGNUP_LIMIT, GOOGLE_SIGNUP_WINDOW_MS);

    const data = completeGoogleSignUpSchema.parse(input);
    await assertGoogleSignupCookie(data.token);
    // Limite também por conta Google (sub): IPs rotativos não liberam tentativas em série.
    const claims = verifyGoogleToken<{ sub: string }>("google-signup", data.token);
    assertRateLimit("google-signup-sub", claims.sub, GOOGLE_SIGNUP_LIMIT, GOOGLE_SIGNUP_WINDOW_MS);

    const couponCode = (await readSignupCouponCookie()) ?? (data.couponCode || undefined);
    const created = await completeGoogleSignUp({
      token: data.token,
      tenantName: data.tenantName,
      document: data.document || null,
      phone: data.phone,
      planCode: data.planCode || undefined,
      billingCycle: data.billingCycle,
      couponCode,
      termsVersion: TERMS_VERSION,
    });

    if (data.metaEventId) {
      await trackCompleteRegistration({
        tenantSlug: created.tenantSlug,
        userId: created.userId,
        eventId: data.metaEventId,
        client: await readMetaClientContext().catch(() => ({})),
      });
    }

    // Prova de 60 s gerada AQUI e consumida AQUI (nunca vai ao cliente) — abre a sessão sem senha.
    const proof = signGoogleToken("google-login", { userId: created.userId }, 60_000);
    // Import dinâmico: `@/lib/auth` (Auth.js) só é carregado quando este caminho roda — os demais
    // fluxos deste arquivo (e os testes de integração que os importam) não dependem do Auth.js.
    const { signIn } = await import("@/lib/auth");
    await signIn("google-signup", { proof, redirect: false });
    await clearGoogleSignupCookie();
    await clearSignupCouponCookie();
    return { redirectTo: "/pos-login", couponDropped: created.couponDropped };
  });
}
