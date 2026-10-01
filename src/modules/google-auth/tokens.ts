import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DomainError } from "@/lib/errors";

/**
 * Tokens curtos e assinados do login com Google — HMAC-SHA256 com uma chave DERIVADA do
 * `AUTH_SECRET` e separada por finalidade (`purpose` entra na chave e no corpo): um token de um
 * tipo nunca serve para o outro, nem para nada do Auth.js (que usa o `AUTH_SECRET` cru).
 *
 * - `google-signup` (15 min): emitido no callback `signIn` quando o Google autenticou alguém que
 *   ainda não tem conta. Carrega `email`/`name`/`sub` para a tela `/cadastro/google` — que NÃO
 *   confia em nada vindo do navegador além deste token.
 * - `google-login` (60 s): prova interna de que o servidor acabou de criar/reconhecer esta conta;
 *   `completeGoogleSignUpAction` a passa ao provedor `google-signup` para abrir a sessão. Nasce e
 *   morre dentro da mesma action — nunca sai para o cliente.
 *
 * Formato: `base64url(json).base64url(hmac)`. Nunca logue o token.
 */

export type GoogleTokenPurpose = "google-signup" | "google-login";

type Claims = { purpose: GoogleTokenPurpose; jti: string; iat: number; exp: number } & Record<string, unknown>;

function keyFor(purpose: GoogleTokenPurpose): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error("AUTH_SECRET ausente ou curto demais para assinar tokens do Google.");
  }
  return createHash("sha256").update(`innochat:google-auth:${purpose}:${secret}`).digest();
}

function sign(purpose: GoogleTokenPurpose, body: string): string {
  return createHmac("sha256", keyFor(purpose)).update(body).digest("base64url");
}

export function signGoogleToken<T extends Record<string, unknown>>(purpose: GoogleTokenPurpose, payload: T, ttlMs: number, nowMs = Date.now()): string {
  const claims: Claims = { ...payload, purpose, jti: randomBytes(12).toString("base64url"), iat: Math.floor(nowMs / 1000), exp: Math.floor((nowMs + ttlMs) / 1000) };
  const body = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${body}.${sign(purpose, body)}`;
}

/** Lança `DomainError` `TOKEN_INVALID` (forma/assinatura/finalidade) ou `TOKEN_EXPIRED`. */
export function verifyGoogleToken<T extends Record<string, unknown>>(purpose: GoogleTokenPurpose, token: string, nowMs = Date.now()): T & Claims {
  const invalid = () => new DomainError("TOKEN_INVALID", "Link inválido. Entre com o Google de novo.");
  if (typeof token !== "string" || token.length > 2000) throw invalid();
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalid();

  const expected = Buffer.from(sign(purpose, parts[0]), "utf8");
  const given = Buffer.from(parts[1], "utf8");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw invalid();

  let claims: Claims;
  try {
    claims = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Claims;
  } catch {
    throw invalid();
  }
  if (claims.purpose !== purpose || typeof claims.exp !== "number") throw invalid();
  if (claims.exp * 1000 <= nowMs) {
    throw new DomainError("TOKEN_EXPIRED", "Este link expirou. Entre com o Google de novo.");
  }
  return claims as T & Claims;
}
