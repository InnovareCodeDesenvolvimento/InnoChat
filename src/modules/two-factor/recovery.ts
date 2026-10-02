import { createHash, createHmac, randomInt } from "node:crypto";

/**
 * Códigos de recuperação do 2FA: 10 códigos de uso único no formato `abcde-fghij` (10 caracteres de
 * um alfabeto sem 0/O/1/l/i, ~50 bits cada). Só o HASH vai para o banco (HMAC-SHA256 com chave
 * derivada do `AUTH_SECRET`): quem lê o banco não consegue entrar com eles.
 */

export const RECOVERY_CODE_COUNT = 10;
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // sem i, l, o, 0, 1
const GROUP = 5;

export function generateRecoveryCode(): string {
  let raw = "";
  for (let i = 0; i < GROUP * 2; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  return `${raw.slice(0, GROUP)}-${raw.slice(GROUP)}`;
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  while (codes.size < count) codes.add(generateRecoveryCode());
  return [...codes];
}

/** Minúsculas, sem espaço nem hífen. `null` se não parece um código (tamanho/alfabeto). */
export function normalizeRecoveryInput(input: string): string | null {
  const clean = input.toLowerCase().replace(/[\s-]/g, "");
  if (clean.length !== GROUP * 2) return null;
  for (const ch of clean) if (!ALPHABET.includes(ch)) return null;
  return clean;
}

function recoveryKey(): Buffer {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) throw new Error("AUTH_SECRET ausente ou curto demais para proteger os códigos de recuperação.");
  return createHash("sha256").update(`innochat:two-factor:recovery:${secret}`).digest();
}

/** Hash do código JÁ normalizado (use `normalizeRecoveryInput`). */
export function hashRecoveryCode(normalized: string): string {
  return createHmac("sha256", recoveryKey()).update(normalized).digest("hex");
}
