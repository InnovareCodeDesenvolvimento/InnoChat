import { createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { DomainError } from "@/lib/errors";

/**
 * Amarra o token `google-signup` ao NAVEGADOR que fez o login com Google (revisão do Órion S1).
 *
 * O token viaja em `/cadastro/google?t=...` (URL: histórico, log de proxy, Referer). Sem mais nada,
 * quem obtivesse essa URL nos 10 min de validade completaria o cadastro no lugar da vítima e
 * ganharia a sessão. Agora o callback do Google também grava um cookie httpOnly com o SHA-256 do
 * token; `getGoogleSignUpPrefillAction` e `completeGoogleSignUpAction` exigem que o cookie bata.
 * Guarda-se o HASH (não o token) só para o cookie não duplicar o segredo. O cookie é SameSite=Lax
 * (o retorno do Google é uma navegação top-level GET) e Secure em produção.
 */

export const GOOGLE_SIGNUP_COOKIE = "innochat_google_signup";
export const GOOGLE_SIGNUP_COOKIE_MAX_AGE_S = 10 * 60; // mesmo TTL do token (GOOGLE_SIGNUP_TOKEN_TTL_MS)

export function hashSignupToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Grava o cookie de vínculo. Chamar onde o token é emitido (callback `signIn` do Auth.js). */
export async function setGoogleSignupCookie(token: string): Promise<void> {
  (await cookies()).set(GOOGLE_SIGNUP_COOKIE, hashSignupToken(token), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: GOOGLE_SIGNUP_COOKIE_MAX_AGE_S,
  });
}

/** Exige que o cookie do navegador seja o do `token`. Lança `TOKEN_INVALID` se faltar ou não bater. */
export async function assertGoogleSignupCookie(token: string): Promise<void> {
  const invalid = () => new DomainError("TOKEN_INVALID", "Link inválido. Entre com o Google de novo.");
  const given = (await cookies()).get(GOOGLE_SIGNUP_COOKIE)?.value;
  if (!given) throw invalid();
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(hashSignupToken(token), "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw invalid();
}

export async function clearGoogleSignupCookie(): Promise<void> {
  try {
    (await cookies()).delete(GOOGLE_SIGNUP_COOKIE);
  } catch {
    // fora de escopo de requisição — nada a limpar
  }
}
