import { cookies } from "next/headers";

/**
 * Cookie da sessão de suporte / impersonação temporária do admin da plataforma.
 *
 * Nome prefixado por `__Secure-` em produção (obrigatório se HTTPS) e sem prefixo em dev/test.
 * HttpOnly, SameSite=Lax (permite a navegação top-level vinda de /admin/empresas/[id] para /[slug]/dashboard),
 * Path=/, Max-Age=3600 (1 hora).
 */
export const SUPPORT_COOKIE_NAME =
  process.env.NODE_ENV === "production" ? "__Secure-innochat.support" : "innochat.support";

export const SUPPORT_COOKIE_MAX_AGE_S = 60 * 60; // 1 hora (3600 segundos)

export async function setSupportCookie(cookieValue: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SUPPORT_COOKIE_NAME, cookieValue, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SUPPORT_COOKIE_MAX_AGE_S,
  });
}

export async function getSupportCookieValue(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    return cookieStore.get(SUPPORT_COOKIE_NAME)?.value ?? null;
  } catch {
    // Fora de contexto de requisição (ex.: tarefas offline ou testes sem mock de headers)
    return null;
  }
}

export async function clearSupportCookie(): Promise<void> {
  try {
    const cookieStore = await cookies();
    cookieStore.delete(SUPPORT_COOKIE_NAME);
  } catch {
    // Fora de contexto de requisição
  }
}
