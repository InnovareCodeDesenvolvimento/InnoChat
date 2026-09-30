// Mini-executor do workflow n8n `innochat-bot.json`: roda o JS EXATO dos Code nodes, avalia as
// expressões `={{ ... }}`, segue as conexões do JSON e chama a API interna REAL do painel.
// A Evolution DO WORKFLOW é falsa: `sendText` só captura a mensagem (o que o PAINEL envia, no release,
// vai para `fake-evolution.mjs`). Não reproduz: timeout real do n8n (simula por falha injetada), credenciais;
// retry só simples de 5xx nos nós com retryOnFail.
//
// Injeção de falhas (I-0), por execução: `engine.run(webhook, { faults })` (ou `chat.say(txt, { faults })`)
//   { urlRe: /availability\/slots/, status: 500 }         o painel "responde" 500 (não chega a chamar o painel)
//   { urlRe: /availability\/slots/, status: "timeout" }   o nó HTTP estoura o timeout
//   { node: "Montar mensagem", crash: true }              o nó lança erro ao executar (a execução morre)
//   opcionais: method: "GET", times: N (só as N primeiras vezes; `used` conta; padrão: sempre)
//
// Tipos de nó suportados (contrato do plano §3.7): webhook, set, switch, if, code, httpRequest, wait, noOp,
// splitOut, stopAndError, stickyNote. Operadores: string.equals/notEquals, boolean.true, number.equals/gte.
import { readFileSync } from "node:fs";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const EVOLUTION_FAKE = "http://evolution.fake";

export class Engine {
  constructor({ workflowPath, painelUrl, secret }) {
    this.wf = JSON.parse(readFileSync(workflowPath, "utf8"));
    this.byName = new Map(this.wf.nodes.map((n) => [n.name, n]));
    this.painelUrl = painelUrl;
    this.secret = secret;
    this.httpLog = [];
  }

  // ---------- expressões ----------
  ev(value, ctx) {
    if (typeof value !== "string" || !value.startsWith("=")) return value;
    const src = value.slice(1);
    const run = (expr) =>
      new Function("$json", "$", "$runIndex", "$input", "$now", `return (${expr.trim()});`)(ctx.json, ctx.$, ctx.runIndex, ctx.$input, new Date());
    const whole = src.match(/^\{\{([\s\S]+)\}\}$/);
    // expressão única => valor tipado; senão template de string
    if (whole && !/\}\}[\s\S]*\{\{/.test(src)) return run(whole[1]);
    return src.replace(/\{\{([\s\S]+?)\}\}/g, (_, e) => {
      const v = run(e);
      return v == null ? "" : String(v);
    });
  }

  async run(webhook /* { token, body } */, opts = {}) {
    const faults = opts.faults || []; // objetos do chamador: `used` conta os usos de `times`
    const nodeOut = new Map(); // nome -> items
    const outbox = []; // mensagens que iriam para a Evolution nesta execução
    const runCount = new Map();
    const trace = [];
    const state = { error: null, release: null };
    const $ = (name) => {
      const items = nodeOut.get(name);
      if (!items) throw new Error(`Node '${name}' não executou`);
      return { first: () => items[0], all: () => items, item: items[0], last: () => items[items.length - 1] };
    };
    const conns = this.wf.connections;
    const queue = [{ node: "Webhook", items: [{ json: { params: { token: webhook.token }, body: webhook.body, headers: {}, query: {} } }] }];
    let guard = 0;
    try {
      while (queue.length) {
        if (++guard > 300) throw new Error("loop guard");
        const { node: name, items } = queue.shift();
        const node = this.byName.get(name);
        if (!node) throw new Error(`conexão para nó inexistente: ${name}`);
        const runIndex = runCount.get(name) || 0;
        runCount.set(name, runIndex + 1);
        trace.push(name);
        if (faults.some((f) => f.node === name && f.crash)) throw new Error(`falha injetada: ${name} morreu`);
        const outs = await this.exec(node, items, { $, runIndex, outbox, faults });
        const flat = outs.flat();
        nodeOut.set(name, flat.length ? flat : nodeOut.get(name) || []);
        const c = conns[name]?.main || [];
        outs.forEach((its, idx) => {
          if (its && its.length) for (const t of c[idx] || []) queue.push({ node: t.node, items: its });
        });
      }
    } catch (e) {
      state.error = e;
      // "error workflow" (innochat-erros): lê session.id / session.lockToken do nó `Claim` e o token do `Config`
      // (é o que o "Extrair trava" do innochat-erros faz) e chama o release. Sem falha injetada.
      try {
        const claim = nodeOut.get("Claim")?.[0]?.json;
        const cfg = nodeOut.get("Config")?.[0]?.json;
        if (claim?.action === "process" && claim.session?.id && claim.session?.lockToken && cfg?.token) {
          const rel = await this.http("POST", `${this.painelUrl}/sessions/${encodeURIComponent(claim.session.id)}/release`, { "x-innochat-instance": cfg.token }, JSON.stringify({ lockToken: claim.session.lockToken }));
          state.release = { status: rel.statusCode, body: rel.body };
        }
      } catch {}
    }
    return { trace, outbox, error: state.error ? String(state.error.message || state.error) : null, nodeOut, release: state.release };
  }

  async http(method, url, headers, body, timeout = 10000) {
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${this.secret}`, ...(body != null ? { "content-type": "application/json" } : {}), ...headers },
      body: body ?? undefined,
      signal: AbortSignal.timeout(timeout),
    });
    const txt = await res.text();
    let json;
    try { json = txt ? JSON.parse(txt) : {}; } catch { json = txt; }
    this.httpLog.push({ method, url: url.replace(this.painelUrl, ""), status: res.status, flow: headers["x-innochat-flow"] ?? null });
    return { statusCode: res.status, headers: Object.fromEntries(res.headers), body: json };
  }

  async exec(node, items, rt) {
    const p = node.parameters || {};
    const type = node.type.replace("n8n-nodes-base.", "");
    const $input = { first: () => items[0], all: () => items, item: items[0] };
    const ctxFor = (item) => ({ json: item.json, $: rt.$, runIndex: rt.runIndex, $input });
    switch (type) {
      case "webhook": return [items];
      case "noOp": return [items];
      case "wait": {
        const secs = Number(this.ev(p.amount, ctxFor(items[0]))) || 0;
        await new Promise((r) => setTimeout(r, secs * 1000)); // espera REAL (o n8n espera de verdade no retry do claim)
        return [items];
      }
      case "stickyNote": return [[]];
      case "set": {
        const json = {};
        for (const a of p.assignments.assignments) json[a.name] = this.ev(a.value, ctxFor(items[0]));
        if (json.painelUrl) json.painelUrl = this.painelUrl;
        if (json.evolutionUrl) json.evolutionUrl = EVOLUTION_FAKE;
        return [[{ json }]];
      }
      case "code": {
        const fn = new AsyncFunction("$input", "$", "$json", "$runIndex", "$now", p.jsCode);
        const res = await fn($input, rt.$, items[0]?.json, rt.runIndex, new Date());
        if (!Array.isArray(res)) throw new Error(`Code node ${node.name} não devolveu array`);
        return [res];
      }
      case "if": {
        const ok = this.cond(p.conditions, ctxFor(items[0]));
        return ok ? [items, []] : [[], items];
      }
      case "switch": {
        const rules = p.rules.values;
        const outs = rules.map(() => []);
        const fallback = p.options?.fallbackOutput === "extra";
        if (fallback) outs.push([]);
        for (const it of items) {
          const idx = rules.findIndex((r) => this.cond(r.conditions, ctxFor(it)));
          if (idx >= 0) outs[idx].push(it);
          else if (fallback) outs[outs.length - 1].push(it);
        }
        return outs;
      }
      case "splitOut": return [items[0].json[p.fieldToSplitOut].map((v) => ({ json: v }))];
      case "stopAndError": throw new Error(String(this.ev(p.errorMessage, ctxFor(items[0]))));
      case "httpRequest": return [await this.httpNode(node, p, items, ctxFor, rt)];
      default: throw new Error(`tipo de nó não suportado: ${type}`);
    }
  }

  cond(c, ctx) {
    const results = c.conditions.map((x) => {
      const l = this.ev(x.leftValue, ctx);
      const r = x.rightValue;
      const { type, operation } = x.operator;
      if (type === "string" && operation === "equals") return String(l) === String(r);
      if (type === "string" && operation === "notEquals") return String(l) !== String(r);
      if (type === "boolean" && operation === "true") return l === true || l === "true";
      if (type === "number" && operation === "equals") return Number(l) === Number(r);
      if (type === "number" && operation === "gte") return Number(l) >= Number(r);
      throw new Error(`operador não suportado ${type}.${operation}`);
    });
    return c.combinator === "or" ? results.some(Boolean) : results.every(Boolean);
  }

  async httpNode(node, p, items, ctxFor, rt) {
    const outs = [];
    const cont = node.onError === "continueRegularOutput";
    for (const item of items) {
      const ctx = ctxFor(item);
      const url = this.ev(p.url, ctx);
      const headers = {};
      for (const h of p.headerParameters?.parameters || []) headers[h.name.toLowerCase()] = String(this.ev(h.value, ctx));
      let full = url;
      if (p.sendQuery) {
        const q = JSON.parse(this.ev(p.jsonQuery, ctx));
        const usp = new URLSearchParams();
        for (const [k, v] of Object.entries(q)) if (v != null) usp.set(k, String(v));
        full += "?" + usp.toString();
      }
      const body = p.sendBody ? String(this.ev(p.jsonBody, ctx)) : null;
      if (url.startsWith(EVOLUTION_FAKE)) {
        rt.outbox.push(JSON.parse(body));
        outs.push({ json: { key: { id: "FAKE" } } });
        continue;
      }
      const respOpt = p.options?.response?.response || {};
      const tries = node.retryOnFail ? node.maxTries || 3 : 1;
      const path = full.replace(this.painelUrl, "");
      let r;
      let netErr = null;
      for (let t = 0; t < tries; t++) {
        netErr = null;
        const fault = (rt.faults || []).find((f) => f.urlRe && f.urlRe.test(path) && (!f.method || f.method === p.method) && (f.times == null || (f.used || 0) < f.times));
        if (fault) {
          fault.used = (fault.used || 0) + 1;
          if (fault.status === "timeout") {
            netErr = new Error("The operation was aborted due to timeout");
            this.httpLog.push({ method: p.method, url: path, status: "timeout", fault: true });
            continue;
          }
          r = { statusCode: fault.status, headers: {}, body: { error: { code: "FAULT", message: "falha injetada" } } };
          this.httpLog.push({ method: p.method, url: path, status: fault.status, fault: true, flow: headers["x-innochat-flow"] ?? null });
        } else {
          try { r = await this.http(p.method, full, headers, body, p.options?.timeout || 10000); }
          catch (e) { netErr = e; continue; }
        }
        if (r.statusCode < 500) break;
      }
      if (netErr) {
        // timeout / rede: com onError=continueRegularOutput vira item { error }; senão a execução morre (como no n8n)
        if (cont) { outs.push({ json: { error: { message: String(netErr.message || netErr), name: netErr.name } } }); continue; }
        throw new Error(`${node.name}: ${netErr.message || netErr}`);
      }
      if (!respOpt.neverError && r.statusCode >= 400) {
        if (cont) { outs.push({ json: { error: { message: `HTTP ${r.statusCode}`, httpCode: r.statusCode } } }); continue; }
        throw new Error(`${node.name}: HTTP ${r.statusCode} ${JSON.stringify(r.body).slice(0, 200)}`);
      }
      if (respOpt.fullResponse) { outs.push({ json: { statusCode: r.statusCode, headers: r.headers, body: r.body } }); continue; }
      if (Array.isArray(r.body)) r.body.forEach((b) => outs.push({ json: b }));
      else outs.push({ json: r.body });
    }
    return outs;
  }
}
