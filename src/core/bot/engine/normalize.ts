/**
 * Normalização de texto do cliente (spec §2.4.2): minúsculas, sem acento (NFD), espaços
 * colapsados, pontuação final `.,!?;:` removida, keycaps viram dígitos e modificadores de tom
 * de pele / seletores de variação saem. Emojis de sim/não são preservados (não removemos
 * símbolos), para o reconhecimento de 👍 ✅ 👌 ❌ 👎.
 */
export function normalizeText(raw: string): string {
  let s = String(raw ?? "");
  s = s
    .replace(/([0-9])️?⃣/g, "$1")
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "")
    .replace(/[️​-‍﻿]/g, "");
  s = s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  const stripped = s.replace(/[.,!?;:\s]+$/g, "");
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
