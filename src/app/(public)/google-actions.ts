"use server";

import { cookies } from "next/headers";
import { signIn } from "@/lib/auth";
import { GOOGLE_INVITE_COOKIE } from "@/modules/google-auth/invite-cookie";
import { clearSignupCouponCookie, setSignupCouponCookie } from "@/modules/google-auth/signup-coupon-cookie";

/**
 * Inicia o login/cadastro com Google. `signIn` lança o redirect (NEXT_REDIRECT) para o Google —
 * por isso não há `try/catch` aqui: o Next precisa deixar o redirect propagar. Quem decide o que
 * acontece na volta (entrar, vincular ou mandar para `/cadastro/google`) é o backend.
 *
 * Recebe o `FormData` do `<form action>`. Campo opcional `coupon`: cupom do link de campanha
 * (`/cadastro?cupom=`); vira um cookie httpOnly de 30 min que o cadastro depois do Google lê no servidor.
 * Sem cupom válido o cookie antigo é apagado (cupom esquecido de outra visita não pode vazar para este cadastro).
 */
export async function signInWithGoogleAction(formData?: FormData): Promise<void> {
  // Login normal: um cookie de convite esquecido (aba de convite abandonada) NÃO pode ser
  // aplicado a este login — descarta antes de ir ao Google (revisão do Órion S2).
  (await cookies()).delete(GOOGLE_INVITE_COOKIE);
  const coupon = formData?.get("coupon");
  if (!(await setSignupCouponCookie(coupon))) await clearSignupCouponCookie();
  await signIn("google", { redirectTo: "/pos-login" });
}
