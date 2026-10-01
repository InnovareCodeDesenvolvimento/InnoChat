/**
 * Telefone brasileiro com DDD -> E.164 (só dígitos, sem "+": `558431132584`), e o inverso para
 * exibição. Puro, sem I/O. Usado pelo WhatsApp comercial da plataforma (botão "Tirar dúvidas"
 * da landing, link `https://wa.me/<e164>`), que exige DDI + DDD + número, sem máscara.
 *
 * Aceita máscara e DDI opcional: "(84) 3113-2584", "84 3113-2584", "+55 84 3113-2584",
 * "084 3113-2584" (tronco 0), "(84) 99999-8888". Rejeita o que não dá para ter certeza:
 * DDD inexistente (começa com 0 ou 1 como segundo...), celular antigo sem o 9º dígito, tamanho errado.
 */

export function normalizeBrPhoneToE164(raw: string): string | null {
  let digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  // DDI 55: só se o resto couber como número nacional (10 ou 11 dígitos). Um "55" no começo de
  // um número de 10/11 dígitos é o DDD de Santa Maria/RS etc., não o DDI.
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) {
    digits = digits.slice(2);
  } else if (digits.startsWith("0") && (digits.length === 11 || digits.length === 12)) {
    // Prefixo de tronco "0" antes do DDD ("084 3113-2584").
    digits = digits.slice(1);
  }

  if (digits.length !== 10 && digits.length !== 11) return null;

  // DDD: 2 dígitos, nenhum zero (11..99).
  if (digits[0] === "0" || digits[1] === "0") return null;

  const subscriber = digits.slice(2);
  if (subscriber.length === 9) {
    // Celular: 9 dígitos começando em 9.
    if (subscriber[0] !== "9") return null;
  } else if (!/^[2-5]/.test(subscriber)) {
    // Fixo (8 dígitos) começa em 2-5. Começar em 6-9 com 8 dígitos é celular antigo sem o 9º
    // dígito — o WhatsApp não acha esse número, então não aceitamos por engano.
    return null;
  }

  return `55${digits}`;
}

/** `558431132584` (ou com "+") -> `(84) 3113-2584`. Valor fora do padrão BR volta como veio. */
export function formatBrPhoneDisplay(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  if (!(digits.startsWith("55") && (digits.length === 12 || digits.length === 13))) return e164;
  const ddd = digits.slice(2, 4);
  const sub = digits.slice(4);
  const cut = sub.length === 9 ? 5 : 4;
  return `(${ddd}) ${sub.slice(0, cut)}-${sub.slice(cut)}`;
}
