"use server";

import { z } from "zod";
import { requireSessionUser, requireTenantMember } from "@/lib/auth/guards";
import { runAction, type Result } from "@/lib/result";
import { DomainError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/http/client-ip";
import { userNameSchema } from "@/lib/validation/user-name";
import { assertCurrentTermsVersion, TERMS_VERSION } from "@/lib/legal";
import { getGoogleSignUpPrefill, completeGoogleSignUp } from "@/modules/google-auth/signup";
import { signGoogleToken, verifyGoogleToken } from "@/modules/google-auth/tokens";
import { assertGoogleSignupCookie, clearGoogleSignupCookie } from "@/modules/google-auth/signup-cookie";
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
  slug: z.string().trim().min(3).max(60),
  segment: z.string().trim().max(80).optional(),
  name: userNameSchema,
  email: z.string().trim().email().max(255),
  password: z.string().min(8).max(200),
  // CPF/CNPJ da empresa, formatado ou só dígitos (decisão do dono, 2026-09-29 — ver
  // `src/modules/signup/service.ts#signUp` e docs/contratos.md "Cadastro público"). Só a
  // presença é checada aqui; o dígito verificador é conferido em `signUp` (`INVALID_DOCUMENT`).
  document: z.string().trim().min(1, "Informe o CPF ou CNPJ da empresa."),
  // Telefone do dono: vira o WhatsApp de cobrança (`Tenant.billingWhatsappE164`). Opcional; inválido = INVALID_PHONE.
  phone: z.string().trim().max(30).optional(),
  termsVersion: z.string().min(1).max(50),
  acceptedTerms: z.boolean().refine((v) => v === true, { message: "É preciso aceitar os termos." }),
  // Cobrança escolhida (padrão mensal) e cupom opcional (Melhoria 6). O servidor revalida os dois.
  billingCycle: z.enum(["MONTHLY", "ANNUAL"]).optional(),
  couponCode: z.string().trim().max(40).optional(),
  // Só vem quando o visitante aceitou o Pixel do Meta: é o event_id que o navegador usou, para a API
  // de Conversões mandar o mesmo evento e a Meta descartar a duplicata. Ausente = sem rastreio.
  metaEventId: z.string().max(64).optional(),
  }),
);

const SIGNUP_LIMIT = 5;
const SIGNUP_WINDOW_MS = 60 * 60 * 1000; // 5 cadastros/hora por IP

export async function signUpAction(input: unknown): Promise<Result<{ tenantSlug: string }>> {
  return runAction(async () => {
    const ip = await clientIp();
    assertRateLimit("signup", ip, SIGNUP_LIMIT, SIGNUP_WINDOW_MS);

    const data = signUpSchema.parse(input);
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
      slug: data.slug,
      segment: data.segment ?? null,
      ownerName: data.name,
      email: data.email,
      password: data.password,
      document: data.document,
      phone: data.phone ?? null,
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
    return { tenantSlug: result.tenantSlug };
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
  document: z.string().trim().min(1, "Informe o CPF ou CNPJ da empresa."),
  phone: z
    .string()
    .trim()
    .max(30)
    .refine((v) => v === "" || /^\d{10,13}$/.test(v.replace(/\D/g, "")), "Informe o telefone com DDD.")
    .optional(),
  planCode: z.string().trim().max(60).optional(),
  acceptTerms: z.boolean().refine((v) => v === true, { message: "É preciso aceitar os termos." }),
  metaEventId: z.string().max(64).optional(),
});

const GOOGLE_SIGNUP_LIMIT = 5;
const GOOGLE_SIGNUP_WINDOW_MS = 60 * 60 * 1000;

/**
 * Cria empresa + usuário (sem senha, e-mail verificado) + trial — a MESMA lógica de `signUp`
 * (`createAccount`) — e abre a sessão. `phone` (opcional) vira o WhatsApp de cobrança
 * (`Tenant.billingWhatsappE164`, normalizado para só dígitos com DDI).
 */
export async function completeGoogleSignUpAction(input: unknown): Promise<Result<{ redirectTo: string }>> {
  return runAction(async () => {
    const ip = await clientIp();
    assertRateLimit("google-signup", ip, GOOGLE_SIGNUP_LIMIT, GOOGLE_SIGNUP_WINDOW_MS);

    const data = completeGoogleSignUpSchema.parse(input);
    await assertGoogleSignupCookie(data.token);
    // Limite também por conta Google (sub): IPs rotativos não liberam tentativas em série.
    const claims = verifyGoogleToken<{ sub: string }>("google-signup", data.token);
    assertRateLimit("google-signup-sub", claims.sub, GOOGLE_SIGNUP_LIMIT, GOOGLE_SIGNUP_WINDOW_MS);

    const created = await completeGoogleSignUp({
      token: data.token,
      tenantName: data.tenantName,
      document: data.document,
      phone: data.phone || null,
      planCode: data.planCode || undefined,
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
    return { redirectTo: "/pos-login" };
  });
}
