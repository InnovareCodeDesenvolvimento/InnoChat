import { cookies } from "next/headers";
import { isValidCouponCode, normalizeCouponCode } from "@/core/billing";

/**
 * Cupom do link de campanha (`/cadastro?cupom=CODIGO`) durante o cadastro com Google.
 *
 * O visitante sai do site para o Google e volta; a query não sobrevive (e o Pixel ainda limpa a URL). O botão manda o
 * cupom para `signInWithGoogleAction`, que o guarda neste cookie httpOnly (30 min, SameSite=Lax: o retorno do
 * Google é uma navegação top-level GET). `completeGoogleSignUpAction` lê no SERVIDOR e apaga: o cliente nunca
 * decide o cupom do cadastro Google. O cookie só carrega o código; quem vale ou não é a conferência de sempre.
 */

export const SIGNUP_COUPON_COOKIE = "innochat_signup_coupon";
export const SIGNUP_COUPON_COOKIE_MAX_AGE_S = 30 * 60;

/** Código normalizado (maiúsculo) se tiver o formato de cupom; `null` para qualquer lixo. */
export function sanitizeCouponCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = normalizeCouponCode(raw);
  return isValidCouponCode(code) ? code : null;
}

export async function setSignupCouponCookie(raw: unknown): Promise<boolean> {
  const code = sanitizeCouponCode(raw);
  if (!code) return false;
  (await cookies()).set(SIGNUP_COUPON_COOKIE, code, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SIGNUP_COUPON_COOKIE_MAX_AGE_S,
  });
  return true;
}

export async function readSignupCouponCookie(): Promise<string | null> {
  return sanitizeCouponCode((await cookies()).get(SIGNUP_COUPON_COOKIE)?.value);
}

export async function clearSignupCouponCookie(): Promise<void> {
  try {
    (await cookies()).delete(SIGNUP_COUPON_COOKIE);
  } catch {
    // fora de escopo de requisição — nada a limpar
  }
}
