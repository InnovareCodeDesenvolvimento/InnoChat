/**
 * Telefone brasileiro com DDD -> E.164 (só dígitos, sem "+": `558431132584`), e o inverso para
 * exibição. Puro, sem I/O. Usado pelo WhatsApp comercial da plataforma (botão "Tirar dúvidas"
 * da landing, link `https://wa.me/<e164>`), que exige DDI + DDD + número, sem máscara.
 *
 * Aceita máscara e DDI opcional: "(84) 3113-2584", "84 3113-2584", "+55 84 3113-2584",
 * "084 3113-2584" (tronco 0), "(84) 99999-8888". Rejeita o que não dá para ter certeza:
 * DDD inexistente (começa com 0 ou 1 como segundo...), celular antigo sem o 9º dígito, tamanho errado.
 */

/** Os 67 DDDs em uso no Brasil (Anatel). Usado onde o número precisa existir de verdade (cadastro). */
export const VALID_BR_DDDS: ReadonlySet<string> = new Set([
  "11", "12", "13", "14", "15", "16", "17", "18", "19",
  "21", "22", "24", "27", "28",
  "31", "32", "33", "34", "35", "37", "38",
  "41", "42", "43", "44", "45", "46", "47", "48", "49",
  "51", "53", "54", "55",
  "61", "62", "63", "64", "65", "66", "67", "68", "69",
  "71", "73", "74", "75", "77", "79",
  "81", "82", "83", "84", "85", "86", "87", "88", "89",
  "91", "92", "93", "94", "95", "96", "97", "98", "99",
]);

export function isValidBrDdd(ddd: string): boolean {
  return VALID_BR_DDDS.has(ddd);
}

/**
 * Igual a `normalizeBrPhoneToE164`, mas também recusa DDD que não existe (ex.: 20, 23, 29). Só o cadastro usa:
 * contatos e outros usos seguem com a regra mais frouxa para não recusar número que já está salvo.
 */
export function normalizeBrPhoneStrict(raw: string): string | null {
  const e164 = normalizeBrPhoneToE164(raw);
  if (!e164) return null;
  return isValidBrDdd(e164.slice(2, 4)) ? e164 : null;
}

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
