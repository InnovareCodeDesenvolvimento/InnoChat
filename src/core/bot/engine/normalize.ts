/**
 * Normalização de texto do cliente (spec §2.4.2): minúsculas, sem acento (NFD), espaços
 * colapsados, pontuação final `.,!?;:` removida, keycaps viram dígitos e modificadores de tom
 * de pele / seletores de variação saem. Emojis de sim/não são preservados (não removemos
 * símbolos), para o reconhecimento de 👍 ✅ 👌 ❌ 👎.
 */
export const MAX_NORMALIZE_CHARS = 4000;

const TRAILING_PUNCTUATION = new Set([".", ",", "!", "?", ";", ":", " "]);

/** Corta o texto do cliente antes de qualquer regex: nenhuma mensagem legítima do bot passa disso. */
export function capInput(raw: string): string {
  const s = String(raw ?? "");
  return s.length > MAX_NORMALIZE_CHARS ? s.slice(0, MAX_NORMALIZE_CHARS) : s;
}

export function normalizeText(raw: string): string {
  let s = capInput(raw);
  s = s
    .replace(/([0-9])️?⃣/g, "$1")
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "")
    .replace(/[️​-‍﻿]/g, "");
  s = s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  // Laço linear (uma regex `[...]+$` é quadrática em "!!!!…!a" — ReDoS).
  let end = s.length;
  while (end > 0 && TRAILING_PUNCTUATION.has(s[end - 1])) end--;
  const stripped = s.slice(0, end);
  // "?" e ".." sozinhos continuam existindo ("?" é o comando de ajuda).
  return stripped === "" ? s : stripped;
}

/** Remove marcações do WhatsApp e chaves de um VALOR (nome de serviço, cliente...). */
export function sanitizeValue(value: string): string {
  return value
    .replace(/[*_~`{}]/g, "")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
