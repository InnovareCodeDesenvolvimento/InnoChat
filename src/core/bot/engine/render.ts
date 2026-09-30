import { sanitizeValue } from "./normalize";
import { keycap } from "./options";
import type { Block, Texts, Vars } from "./types";

const HAS_CONTENT = /[\p{L}\p{N}]/u;

function valueOf(vars: Vars, name: string): string {
  const v = vars[name];
  if (v === null || v === undefined) return "";
  const clean = sanitizeValue(String(v));
  // Valor só de pontuação/símbolos (pushName "." ou "~") equivale a vazio.
  return HAS_CONTENT.test(clean) ? clean : "";
}

/**
 * Renderizador v2 (spec §5.2): variável ausente/vazia vira string vazia; linha que ficou só com
 * o rótulo ("*Valor:*") some; pontuação órfã é limpa; valores perdem `* _ ~ \``.
 */
export function renderTemplateV2(template: string, vars: Vars): string {
  const safeVars: Vars = vars ?? {};
  let out = String(template ?? "").replace(/\{(\w+)\}/g, (_m, name: string) => valueOf(safeVars, name));

  out = out
    .split("\n")
    .filter((line) => !/^\s*\*[^*\n]+:\*\s*$/.test(line))
    .map((line) => {
      let l = line;
      l = l.replace(/\(\s*\)/g, "");
      l = l.replace(/\s*·\s*·\s*/g, " · ");
      l = l.replace(/^([_*~]*)\s*·\s*/, "$1");
      l = l.replace(/\s*·\s*(?=[_*~]*\s*$)/, "");
      l = l.replace(/,[ \t]*([!?.;:])/g, "$1");
      l = l.replace(/[ \t]+([,;:.!?])/g, "$1");
      l = l.replace(/(^|\s)([_*~])\2(?=\s|$)/g, "$1");
      l = l.replace(/[ \t]{2,}/g, " ");
      return l.replace(/[ \t]+$/g, "");
    })
    .join("\n");

  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function optionLine(o: { n: number; title: string; detail?: string | null }): string {
  const title = sanitizeValue(o.title);
  const detail = o.detail ? sanitizeValue(o.detail) : "";
  return detail ? `${keycap(o.n)} ${title} — _${detail}_` : `${keycap(o.n)} ${title}`;
}

/** Uma mensagem só: blocos separados por 1 linha em branco, rodapé por último. */
function renderOne(blocks: Block[], texts: Texts): string {
  const parts: string[] = [];
  const footers: string[] = [];
  for (const block of blocks) {
    const template = texts[block.key];
    if (typeof template !== "string") throw new Error(`Texto ausente: ${block.key}`);
    const body = renderTemplateV2(template, block.vars ?? {});
    if (body) parts.push(body);
    if (block.options && block.options.length > 0) {
      parts.push(block.options.map(optionLine).join("\n"));
    }
    if (block.footer) {
      const footerTemplate = texts[block.footer];
      if (typeof footerTemplate !== "string") throw new Error(`Texto ausente: ${block.footer}`);
      const footer = renderTemplateV2(footerTemplate, block.vars ?? {});
      if (footer && !footers.includes(footer)) footers.push(footer);
    }
  }
  return [...parts, ...footers].join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Monta as mensagens da resposta. `newMessage: true` num bloco abre uma mensagem nova; sem nenhum
 * `newMessage` sai uma só (comportamento de sempre). Cada mensagem tem seu próprio rodapé. Mensagem
 * que ficou vazia é descartada. Chave ausente em `texts` lança: o fluxo de erro do n8n avisa o
 * cliente em vez de mandar mensagem em branco. Sem getters/Proxy: roda no task runner do n8n.
 */
export function renderMessages(blocks: Block[], texts: Texts): string[] {
  const groups: Block[][] = [];
  for (const block of blocks) {
    if (block.newMessage === true && groups.length > 0) groups.push([block]);
    else if (groups.length === 0) groups.push([block]);
    else groups[groups.length - 1].push(block);
  }
  return groups.map((g) => renderOne(g, texts)).filter((m) => m.length > 0);
}

/** Todas as mensagens numa string só (prévia do painel): junta com 1 linha em branco. */
export function renderMessage(blocks: Block[], texts: Texts): string {
  return renderMessages(blocks, texts).join("\n\n");
}
