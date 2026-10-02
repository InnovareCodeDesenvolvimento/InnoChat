import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238) com HOTP (RFC 4226) sobre `node:crypto`: SHA-1, 6 dígitos, passo de 30 s —
 * os padrões que Google Authenticator, Microsoft Authenticator, Authy e 1Password aceitam.
 * Funções puras (o relógio entra por parâmetro), sem banco e sem log.
 */

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_S = 30;
/** Tolera 1 passo para trás e 1 para frente (relógio do celular levemente fora). */
export const TOTP_WINDOW = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Devolve `null` para qualquer caractere fora do alfabeto base32 (aceita minúsculas, espaços e `=`). */
export function base32Decode(input: string): Buffer | null {
  const clean = input.replace(/[\s=]/g, "").toUpperCase();
  if (!clean) return null;
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Segredo novo: 20 bytes aleatórios (160 bits, o tamanho do SHA-1) em base32. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** HOTP de RFC 4226: `counter` é inteiro de até 2^53. */
export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", secret).update(msg).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary =
    ((hmac[offset]! & 0x7f) << 24) | ((hmac[offset + 1]! & 0xff) << 16) | ((hmac[offset + 2]! & 0xff) << 8) | (hmac[offset + 3]! & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/** Passo (contador) de 30 s que contém o instante `nowMs`. */
export function totpStepAt(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_S);
}

/** Código do passo informado (ou do atual). Usado nos testes e na fixture do E2E. */
export function totpCode(secretBase32: string, nowMs = Date.now()): string {
  const key = base32Decode(secretBase32);
  if (!key) throw new Error("Segredo TOTP inválido.");
  return hotp(key, totpStepAt(nowMs));
}

/** Só 6 dígitos: tira espaços e hífens que o usuário digita ("123 456"). Outra coisa => `null`. */
export function normalizeTotpInput(input: string): string | null {
  const clean = input.replace(/[\s-]/g, "");
  return /^\d{6}$/.test(clean) ? clean : null;
}

/**
 * Procura, na janela ±`TOTP_WINDOW`, o passo cujo código bate com o digitado e que seja MAIOR que
 * `lastUsedStep` (anti-replay: o mesmo passo, ou um mais antigo, nunca entra de novo). Devolve o
 * passo aceito ou `null`. Compara em tempo constante e percorre a janela inteira sempre.
 */
export function matchTotpStep(secretBase32: string, input: string, lastUsedStep: number | null, nowMs = Date.now()): number | null {
  const code = normalizeTotpInput(input);
  const key = base32Decode(secretBase32);
  if (!code || !key) return null;
  const given = Buffer.from(code, "utf8");
  const current = totpStepAt(nowMs);
  let matched: number | null = null;
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
    const expected = Buffer.from(hotp(key, step), "utf8");
    if (timingSafeEqual(expected, given) && (lastUsedStep === null || step > lastUsedStep)) {
      if (matched === null || step > matched) matched = step;
    }
  }
  return matched;
}

/** URI `otpauth://` que o QR carrega. `issuer` aparece no app; o e-mail identifica a conta. */
export function buildOtpauthUri(input: { issuer: string; account: string; secretBase32: string }): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const params = new URLSearchParams({
    secret: input.secretBase32,
    issuer: input.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_S),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Chave para digitar à mão: blocos de 4 ("ABCD EFGH ..."). */
export function formatSecretForHumans(secretBase32: string): string {
  return secretBase32.replace(/(.{4})/g, "$1 ").trim();
}
