#!/usr/bin/env node
// Compila o motor do bot v2 (src/core/bot/engine) e injeta nos Code nodes de n8n/innochat-bot.json.
//
//   node scripts/n8n-build-flow.mjs           reescreve o JSON (bundle do motor + cola comum)
//   node scripts/n8n-build-flow.mjs --check   não escreve; sai com código 1 se o JSON estiver desatualizado (CI)
//
// Marcadores nos Code nodes:
//   /* @engine:begin */ ... /* @engine:end */   bundle IIFE do motor (global `InnoEngine`): Interpretar, Montar mensagem
//   /* @glue:begin */   ... /* @glue:end */     cola comum dos ramos (helpers pequenos, sem motor)
// Tudo fora dos marcadores é escrito à mão no próprio nó (edite no n8n ou no JSON).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FLOW_PATH = join(root, "n8n", "innochat-bot.json");
const ENGINE_ENTRY = join(root, "src", "core", "bot", "engine", "index.ts");
const check = process.argv.includes("--check");

// Cola comum dos ramos. Cada nó define `const B = ...` (base: { ctx, prefix }) depois deste bloco.
const GLUE = String.raw`// Cola comum dos Code nodes do bot v2 (gerada por scripts/n8n-build-flow.mjs; não editar dentro do n8n).
// Cada nó define "const B = ..." (base: { ctx, prefix }) DEPOIS deste bloco; as funções só o leem quando chamadas.
const I = $('Interpretar').first().json;
const claim = I.claim || {};
const texts = claim.texts || {};
const tenant = claim.tenant || {};
const contact = claim.contact || {};
const WD = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const WDL = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const dow = (iso) => new Date(iso + 'T12:00:00Z').getUTCDay();
const dayLabel = (iso) => (iso ? WD[dow(iso)] + ' ' + iso.slice(8, 10) + '/' + iso.slice(5, 7) : '');
const longDay = (iso) => (iso ? WDL[dow(iso)] + ', ' + iso.slice(8, 10) + '/' + iso.slice(5, 7) : '');
const proName = (c) => c.professionalName || texts.LABEL_ANY_PROFESSIONAL || 'Qualquer profissional';
const isOk = (r) => !r.error && Number(r.statusCode) >= 200 && Number(r.statusCode) < 300;
const statusOf = (r) => (r.error ? 0 : Number(r.statusCode));
const errOf = (r) => ((r.body || {}).error || {});
const merge = (base, patch) => {
  const c = Object.assign({}, base);
  const p = patch || {};
  for (const k of Object.keys(p)) { if (p[k] === null) delete c[k]; else c[k] = p[k]; }
  return c;
};
// Saída final (vai para o "Montar mensagem"): estado, contexto completo e blocos de texto.
const out = (nextState, context, blocks, extra) => [{ json: Object.assign({ goto: 'MENSAGEM', nextState, context, blocks, invalidCount: Number(I.invalidCount) || 0, handoff: false }, extra || {}) }];
const done = (nextState, blocks, patch, extra) => out(nextState, merge(B.ctx, patch), (B.prefix || []).concat(blocks), extra);
// Aviso antes da mensagem principal (ex.: ITEM_UNAVAILABLE + a lista nova).
const notice = (key) => (B.prefix || []).concat([{ key }]);
// Desvio: vai para o "Preparar passo" e depois para o Switch "Ir para".
const go = (goto, patch, extra) => [{ json: Object.assign({ goto, patch: patch || {}, ctx: B.ctx, prefix: B.prefix || [] }, extra || {}) }];
const SERVICE_KEYS = ['serviceId', 'serviceName', 'durationLabel', 'priceLabel'];
const PRO_KEYS = ['professionalId', 'professionalName', 'professionalSkipped'];
const DAY_KEYS = ['date', 'dataLonga', 'period', 'startsAt', 'hora'];
const nulls = (keys) => { const p = {}; for (const k of keys) p[k] = null; return p; };
const svcPatch = (o) => Object.assign(nulls(PRO_KEYS.concat(DAY_KEYS)), { serviceId: o.id, serviceName: o.name || o.label, durationLabel: o.durationLabel || null, priceLabel: o.priceLabel || null });
// Quem está em alguma lista de espera vê "Minha lista de espera" por último (os números 1 a 3 não mudam). noWaitlist = não mostrar.
const menuBlock = (noWaitlist) => {
  const options = [{ id: 'BOOK', titleKey: 'LABEL_MENU_BOOK' }, { id: 'MY', titleKey: 'LABEL_MENU_MY' }, { id: 'HUMAN', titleKey: 'LABEL_MENU_HUMAN' }];
  if (!noWaitlist && Number(contact.waitlistCount) > 0) options.push({ id: 'WAITLIST', titleKey: 'LABEL_MENU_WAITLIST' });
  return { key: 'MENU_PROMPT', options, footer: 'MENU_HINT' };
};
const postBlock = () => ({ key: 'POST_ACTION_MENU', options: [{ id: 'BOOK', titleKey: 'LABEL_BOOK_ANOTHER' }, { id: 'MY', titleKey: 'LABEL_MENU_MY' }, { id: 'FINISH', titleKey: 'LABEL_FINISH' }], footer: 'FOOTER_HINT' });
// Pós-ação em mensagem PRÓPRIA (a confirmação vai sozinha; o "Posso ajudar em algo mais?" vem logo depois).
const postAlone = () => Object.assign(postBlock(), { newMessage: true });
// Página de uma lista em memória (no máximo 9 opções por mensagem, contando fixas). Cabe tudo => sem paginar; senão
// 1ª página = cap - fixas - 1 (+ Ver mais), do meio = cap - 2 (+ mais + anteriores), última = o que sobrar (+ anteriores).
// "cap" = opções que sobram para a lista (9 menos as fixas do fim); "leading" = fixas no começo (só na 1ª página).
const pageOf = (list, page, cap, leading) => {
  const total = list.length;
  let start = 0;
  let idx = 0;
  for (;;) {
    const lead = idx === 0 ? (leading || 0) : 0;
    const remaining = total - start;
    let size;
    if (idx === 0) size = remaining + lead <= cap ? remaining : cap - lead - 1;
    else size = remaining + 1 <= cap ? remaining : cap - 2;
    if (idx >= (Number(page) || 0) || start + size >= total) return { page: idx, items: list.slice(start, start + size), hasMore: start + size < total, hasPrev: idx > 0 };
    start += size;
    idx++;
  }
};`;

async function bundleEngine() {
  const result = await build({
    entryPoints: [ENGINE_ENTRY],
    bundle: true,
    format: "iife",
    globalName: "InnoEngine",
    target: "es2020",
    minify: false,
    write: false,
    legalComments: "none",
    logLevel: "silent",
  });
  return exportsAsPlainObject(result.outputFiles[0].text.replace(/\r\n/g, "\n").trimEnd());
}

/**
 * O task runner de Code node do n8n NÃO preserva getters (provado em produção em 2026-09-30:
 * `Object.defineProperty(o, "g", { get })` devolve `undefined` lá dentro). O IIFE do esbuild
 * expõe os exports por getters (`__export` + `__toCommonJS`), então `InnoEngine.x` vinha
 * `undefined` no n8n real — embora funcionasse no Node/vm do simulador. Aqui trocamos o
 * `return __toCommonJS(index_exports)` por um objeto literal com as funções diretas.
 */
export function exportsAsPlainObject(bundle) {
  const block = bundle.match(/__export\(index_exports, \{([\s\S]*?)\n\s*\}\);/);
  if (!block) throw new Error("build:flow: bloco __export(index_exports) não encontrado no bundle");
  const names = [...block[1].matchAll(/^\s*([A-Za-z_$][\w$]*): \(\) => /gm)].map((m) => m[1]);
  if (names.length === 0) throw new Error("build:flow: nenhum export encontrado no bundle");
  const tail = "return __toCommonJS(index_exports);";
  if (!bundle.includes(tail)) throw new Error("build:flow: fim do IIFE inesperado (sem __toCommonJS)");
  return bundle.replace(tail, `return { ${names.map((n) => `${n}: ${n}`).join(", ")} };`);
}

/** Troca o miolo entre os marcadores. Devolve null se o nó não tem o par de marcadores. */
export function inject(code, tag, body) {
  const begin = `/* @${tag}:begin */`;
  const end = `/* @${tag}:end */`;
  const i = code.indexOf(begin);
  const j = code.indexOf(end);
  if (i < 0 || j < 0 || j < i) return null;
  return code.slice(0, i + begin.length) + "\n" + body.trimEnd() + "\n" + code.slice(j);
}

async function main() {
  const flow = JSON.parse(readFileSync(FLOW_PATH, "utf8"));
  const engine = await bundleEngine();
  const stale = [];
  let touched = 0;
  for (const node of flow.nodes) {
    if (node.type !== "n8n-nodes-base.code") continue;
    const before = node.parameters.jsCode;
    let code = before;
    for (const [tag, body] of [["engine", engine], ["glue", GLUE]]) {
      const next = inject(code, tag, body);
      if (next !== null) code = next;
    }
    if (code !== before) {
      stale.push(node.name);
      node.parameters.jsCode = code;
    }
    if (/@(engine|glue):begin/.test(code)) touched++;
  }
  if (check) {
    if (stale.length > 0) {
      console.error(`n8n/innochat-bot.json desatualizado (${stale.length} nó(s)): ${stale.join(", ")}`);
      console.error("Rode: npm run build:flow");
      process.exit(1);
    }
    console.log(`ok: motor e cola embutidos em ${touched} Code nodes estão atualizados`);
    return;
  }
  writeFileSync(FLOW_PATH, JSON.stringify(flow, null, 2) + "\n");
  console.log(`n8n/innochat-bot.json: ${stale.length} nó(s) atualizado(s) de ${touched} com marcadores (motor ${engine.length} bytes)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
