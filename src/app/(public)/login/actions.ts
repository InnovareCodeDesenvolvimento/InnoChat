"use server";

import { redirect } from "next/navigation";
import { AuthError } from "next-auth";
import { isDomainError } from "@/lib/errors";
import { signIn } from "@/lib/auth";
import { clientIp } from "@/lib/http/client-ip";
import { startPasswordLogin } from "@/modules/two-factor/login";

/** `challenge` preenchido = senha certa, falta o código da verificação em 2 etapas. */
export type LoginState = { error: string | null; challenge?: string | null };
export type TwoFactorLoginState = { error: string | null; expired?: boolean };

const EXPIRED_ERROR = "A verificação expirou. Entre com a senha de novo.";
const GENERIC_ERROR = "E-mail ou senha inválidos.";
// Conta criada só pelo Google (sem senha) — `src/lib/auth.ts#GoogleAccountSignin`.
const GOOGLE_ACCOUNT_ERROR = "Esta conta usa login com Google. Entre com o Google, ou use “Esqueci minha senha” para definir uma senha.";

/**
 * Verificado empiricamente (Playwright, não só lendo o código de
 * `next-auth/lib/actions.js`): `signIn("credentials", { redirect: false })`
 * do Auth.js v5-beta.32 LANÇA `CredentialsSignin` (subclasse de `AuthError`)
 * quando `authorize()` devolve `null` (`src/modules/auth/service.ts`) — não
 * devolve uma URL com `?error=`. `next-auth`/`AuthError` reexporta o
 * suficiente para o `instanceof` funcionar aqui; qualquer outro erro
 * propaga (vira a tela de erro do Next, não uma mensagem genérica de
 * "senha errada").
 *
 * O destino pós-login (tenant do usuário ou admin da plataforma) é resolvido
 * em `/pos-login`, depois que o cookie de sessão já foi gravado — evita
 * duplicar a consulta de `Membership` aqui.
 */
export async function loginAction(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: GENERIC_ERROR };
  }

  try {
    // A senha é conferida AQUI (uma vez, com o rate limit de sempre). Sem 2FA, a prova assinada
    // abre a sessão pelo provedor `verified-login`; com 2FA, sai um desafio e a sessão só nasce em
    // `verifyTwoFactorLoginAction`.
    const outcome = await startPasswordLogin({ email, password, ip: await clientIp() });
    if (!outcome) return { error: GENERIC_ERROR };
    if (outcome.kind === "challenge") return { error: null, challenge: outcome.challenge };
    await signIn("verified-login", { proof: outcome.proof, redirect: false });
  } catch (err) {
    if (err instanceof AuthError) return { error: GENERIC_ERROR };
    if (isDomainError(err) && err.code === "GOOGLE_ONLY_ACCOUNT") return { error: GOOGLE_ACCOUNT_ERROR };
    throw err;
  }

  redirect("/pos-login");
}

/** Segundo passo do login: desafio (hidden) + código do app ou de recuperação. */
export async function verifyTwoFactorLoginAction(_prev: TwoFactorLoginState, formData: FormData): Promise<TwoFactorLoginState> {
  const challenge = String(formData.get("challenge") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  if (!challenge) return { error: EXPIRED_ERROR, expired: true };
  if (!code) return { error: "Digite o código do app." };

  try {
    await signIn("two-factor", { challenge, code, redirect: false });
  } catch (err) {
    if (err instanceof AuthError) {
      const kind = (err as { code?: string }).code;
      if (kind === "challenge_invalid") return { error: EXPIRED_ERROR, expired: true };
      if (kind === "rate_limited") return { error: "Muitas tentativas. Espere alguns minutos e tente de novo." };
      return { error: "Código errado, vencido ou já usado. Confira no app e tente de novo." };
    }
    throw err;
  }

  redirect("/pos-login");
}
