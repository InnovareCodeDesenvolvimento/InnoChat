/**
 * Formatação de texto do WhatsApp para a prévia: `*negrito*`, `_itálico_`, `~riscado~` e
 * `` `mono` ``. Segue a regra do app: o marcador de abertura vem no começo/depois de não-letra e
 * é seguido de não-espaço; o de fechamento vem depois de não-espaço e antes de não-letra. Assim
 * `snake_case` e `2*3*4` não formatam. Aninhamento funciona (`*negrito _itálico_*`).
 * Puro: sem React, testável.
 */
export type WaSpan = { text: string; bold?: boolean; italic?: boolean; strike?: boolean; mono?: boolean };

type Style = Omit<WaSpan, "text">;

const MARKS: Record<string, keyof Style> = { "*": "bold", _: "italic", "~": "strike", "`": "mono" };

const PATTERN = /(?<![\p{L}\p{N}])([*_~`])(?=\S)((?:(?!\1)[^\n])*?\S)\1(?![\p{L}\p{N}])/u;

function parseInto(text: string, style: Style, out: WaSpan[]): void {
  let rest = text;
  while (rest.length > 0) {
    const match = PATTERN.exec(rest);
    if (!match) break;
    if (match.index > 0) out.push({ text: rest.slice(0, match.index), ...style });
    const inner = match[2];
    const mark = MARKS[match[1]];
    const next: Style = { ...style, [mark]: true };
    // Monoespaçado não formata por dentro (igual ao WhatsApp).
    if (mark === "mono") out.push({ text: inner, ...next });
    else parseInto(inner, next, out);
    rest = rest.slice(match.index + match[0].length);
  }
  if (rest.length > 0) out.push({ text: rest, ...style });
}

/** Uma linha de mensagem → trechos com o estilo de cada um. */
export function parseWhatsAppLine(line: string): WaSpan[] {
  const out: WaSpan[] = [];
  parseInto(line, {}, out);
  return out;
}

/** Mensagem inteira → linhas de trechos (quebras preservadas; linha vazia = `[]`). */
export function parseWhatsAppText(text: string): WaSpan[][] {
  return text.split("\n").map(parseWhatsAppLine);
}
