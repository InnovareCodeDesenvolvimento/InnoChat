import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Estrutura do workflow do bot v2 (`n8n/innochat-bot.json`), plano §3.7 e §4/W-1.
 * O simulador (`scripts/bot-sim`) executa só os tipos de nó e operadores abaixo; o "Publicar fluxo"
 * (D-1) depende dos nomes e dos `webhookId`; o `innochat-erros` lê os nós `Claim` e `Config`.
 */

type Condition = { leftValue?: unknown; operator?: { type: string; operation: string }; rightValue?: unknown };
type Params = {
  conditions?: { conditions: Condition[] };
  rules?: { values: { conditions: { conditions: Condition[] } }[] };
  options?: { fallbackOutput?: string; timeout?: number; response?: { response?: Record<string, unknown> } };
  assignments?: { assignments: { name: string; value: string }[] };
  headerParameters?: { parameters: { name: string; value: string }[] };
  jsCode?: string;
  path?: string;
  method?: string;
};
type FlowNode = {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  webhookId?: string;
  credentials?: unknown;
  onError?: string;
  retryOnFail?: boolean;
  parameters: Params;
};
type Flow = {
  nodes: FlowNode[];
  connections: Record<string, { main: { node: string }[][] }>;
  settings: Record<string, unknown>;
  pinData?: unknown;
};

const root = join(__dirname, "..", "..", "..");
const flow = JSON.parse(readFileSync(join(root, "n8n", "innochat-bot.json"), "utf8")) as Flow;
const byName = new Map(flow.nodes.map((n) => [n.name, n]));
const type = (n: FlowNode) => n.type.replace("n8n-nodes-base.", "");
const ofType = (t: string) => flow.nodes.filter((n) => type(n) === t);

const ALLOWED_TYPES = ["webhook", "set", "switch", "if", "code", "httpRequest", "wait", "noOp", "splitOut", "stopAndError", "stickyNote"];
const ALLOWED_OPERATORS = ["string.equals", "string.notEquals", "boolean.true", "number.equals", "number.gte"];

const WEBHOOK_ID = "b12d5bcf-6ca4-4d91-b0d7-d255d196cfd5";
const WAIT_ID = "73c95f8e-01e9-4be4-b95c-1cb83314ed02";

function conditionsOf(node: FlowNode): Condition[] {
  if (type(node) === "if") return node.parameters.conditions?.conditions ?? [];
  if (type(node) === "switch") return (node.parameters.rules?.values ?? []).flatMap((r) => r.conditions.conditions);
  return [];
}

/** Quantas saídas o nó tem (Switch: regras + fallback; IF: 2). */
function outputCount(node: FlowNode): number {
  if (type(node) === "if") return 2;
  const rules = node.parameters.rules?.values.length ?? 0;
  return rules + (node.parameters.options?.fallbackOutput === "extra" ? 1 : 0);
}

/** Todo `jsCode` com o trecho gerado do motor removido (o motor é código do repositório, não do fluxo). */
function handwritten(node: FlowNode): string {
  return String(node.parameters.jsCode ?? "").replace(/\/\* @engine:begin \*\/[\s\S]*?\/\* @engine:end \*\//, "");
}

describe("n8n/innochat-bot.json (workflow v2)", () => {
  it("usa só os tipos de nó que o simulador executa", () => {
    const bad = flow.nodes.filter((n) => !ALLOWED_TYPES.includes(type(n))).map((n) => `${n.name} (${n.type})`);
    expect(bad).toEqual([]);
  });

  it("usa só os operadores de condição permitidos", () => {
    const used = flow.nodes.flatMap((n) => conditionsOf(n).map((c) => `${c.operator?.type}.${c.operator?.operation}`));
    expect(used.length).toBeGreaterThan(20);
    expect(used.filter((u) => !ALLOWED_OPERATORS.includes(u))).toEqual([]);
  });

  it("nomes de nós únicos e conexões só entre nós que existem", () => {
    expect(new Set(flow.nodes.map((n) => n.name)).size).toBe(flow.nodes.length);
    for (const [from, c] of Object.entries(flow.connections)) {
      expect(byName.has(from), `origem inexistente: ${from}`).toBe(true);
      for (const outs of c.main) for (const t of outs) expect(byName.has(t.node), `${from} → ${t.node}`).toBe(true);
    }
  });

  it("toda saída de Switch e de IF está conectada (senão a conversa some em silêncio)", () => {
    const loose: string[] = [];
    for (const node of [...ofType("switch"), ...ofType("if")]) {
      const outs = flow.connections[node.name]?.main ?? [];
      for (let i = 0; i < outputCount(node); i++) if (!outs[i] || outs[i].length === 0) loose.push(`${node.name}[${i}]`);
    }
    expect(loose).toEqual([]);
  });

  it("todo nó (menos as notas) é alcançável a partir do Webhook", () => {
    const seen = new Set<string>(["Webhook"]);
    const queue = ["Webhook"];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const outs of flow.connections[cur]?.main ?? []) for (const t of outs) if (!seen.has(t.node)) { seen.add(t.node); queue.push(t.node); }
    }
    const orphans = flow.nodes.filter((n) => type(n) !== "stickyNote" && !seen.has(n.name)).map((n) => n.name);
    expect(orphans).toEqual([]);
  });

  it("todo $('Nome') citado em expressão ou código existe como nó", () => {
    const texts: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === "string") texts.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    flow.nodes.forEach((n) => walk(n.parameters));
    const names = new Set<string>();
    for (const t of texts) for (const m of t.matchAll(/\$\(\s*['"]([^'"]+)['"]\s*\)/g)) names.add(m[1]);
    expect(names.size).toBeGreaterThan(3);
    const missing = [...names].filter((n) => !byName.has(n));
    expect(missing).toEqual([]);
  });

  it("não tem credenciais nem pinData (segredos e dados de cliente ficam fora do repositório)", () => {
    expect(flow.pinData).toBeUndefined();
    expect(flow.nodes.filter((n) => n.credentials !== undefined).map((n) => n.name)).toEqual([]);
  });

  it("Config com placeholders, flowVersion 2.0.0 e os campos que a sincronização escreve", () => {
    const cfg = byName.get("Config")!;
    const values = Object.fromEntries((cfg.parameters.assignments?.assignments ?? []).map((a) => [a.name, a.value]));
    expect(values.painelUrl).toBe("https://PAINEL_A_DEFINIR/api/internal/v1");
    expect(values.evolutionUrl).toBe("https://EVOLUTION_A_DEFINIR");
    expect(values.n8nApiUrl).toBe("https://N8N_A_DEFINIR/api/v1");
    expect(values.flowVersion).toBe("2.0.0");
    for (const k of ["token", "event", "payload"]) expect(values[k]).toBeDefined();
  });

  it("mantém os nomes e os webhookIds de que o painel depende", () => {
    for (const n of ["Webhook", "Config", "Claim", "Esperar", "Salvar sessão", "Enviar pela Evolution", "Interpretar", "Montar mensagem"]) {
      expect(byName.has(n), n).toBe(true);
    }
    const webhook = byName.get("Webhook")!;
    expect(webhook.webhookId).toBe(WEBHOOK_ID);
    expect(webhook.parameters.path).toBe("innochat/evolution/:token");
    expect(byName.get("Esperar")!.webhookId).toBe(WAIT_ID);
    expect(flow.nodes.filter((n) => n.webhookId).map((n) => n.name).sort()).toEqual(["Esperar", "Webhook"]);
  });

  it("todo HTTP do painel manda X-InnoChat-Flow: 2 (a Evolution não)", () => {
    const http = ofType("httpRequest");
    expect(http.length).toBeGreaterThan(10);
    for (const n of http) {
      const headers = n.parameters.headerParameters?.parameters ?? [];
      const flowHeader = headers.find((h) => h.name === "X-InnoChat-Flow");
      if (n.name === "Enviar pela Evolution") expect(flowHeader, n.name).toBeUndefined();
      else expect(flowHeader?.value, n.name).toBe("2");
    }
  });

  it("HTTP do painel: timeout 10 s; fullResponse + neverError (menos o Claim); retry só em GET e no Claim", () => {
    for (const n of ofType("httpRequest")) {
      if (n.name === "Enviar pela Evolution") continue;
      expect(n.parameters.options?.timeout, n.name).toBe(10000);
      const response = n.parameters.options?.response?.response;
      if (n.name === "Claim") expect(response, "o innochat-erros lê o corpo do Claim direto").toBeUndefined();
      else expect(response, n.name).toMatchObject({ fullResponse: true, neverError: true });
      const isGet = n.parameters.method === "GET";
      if (n.name === "Claim") expect(n.retryOnFail).toBe(true);
      else expect(Boolean(n.retryOnFail), n.name).toBe(isGet);
    }
  });

  it("consultas e escritas ao painel (com o resultado tratado no fluxo) seguem em frente quando dá timeout", () => {
    const handled = ["Buscar serviços", "Buscar profissionais", "Buscar dias", "Buscar próximos horários", "Buscar horários", "Buscar agendamentos", "Reservar horário", "Remarcar agendamento", "Cancelar agendamento"];
    for (const name of handled) expect(byName.get(name)?.onError, name).toBe("continueRegularOutput");
  });

  it("todo Code node compila e não usa relógio do sistema nem require", () => {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => unknown;
    const codeNodes = ofType("code");
    expect(codeNodes.length).toBeGreaterThan(40);
    for (const n of codeNodes) {
      const code = String(n.parameters.jsCode);
      expect(() => new AsyncFunction("$input", "$", "$json", "$runIndex", "$now", code), n.name).not.toThrow();
      const own = handwritten(n);
      expect(own, `${n.name}: relógio do sistema`).not.toMatch(/Date\.now\(|new Date\(\)/);
      expect(own, `${n.name}: require/import`).not.toMatch(/\brequire\(|\bimport\s/);
    }
  });

  it("Interpretar e Montar mensagem carregam o motor; os demais Code nodes com cola não", () => {
    for (const name of ["Interpretar", "Montar mensagem"]) {
      const code = String(byName.get(name)!.parameters.jsCode);
      expect(code, name).toContain("/* @engine:begin */");
      expect(code, name).toContain("var InnoEngine");
    }
    const withEngine = ofType("code").filter((n) => String(n.parameters.jsCode).includes("/* @engine:begin */")).map((n) => n.name);
    expect(withEngine.sort()).toEqual(["Interpretar", "Montar mensagem"]);
  });

  it("o bundle do motor embutido está atualizado (npm run build:flow -- --check)", () => {
    // Sai com código 1 (e a execução lança) se o fonte do motor mudou e o JSON não foi regenerado.
    const out = execFileSync(process.execPath, [join(root, "scripts", "n8n-build-flow.mjs"), "--check"], { cwd: root, encoding: "utf8" });
    expect(out).toContain("ok");
  }, 60_000);

  it("guarda o errorWorkflow atual e o Publicar fluxo é quem o troca", () => {
    expect(typeof flow.settings.errorWorkflow).toBe("string");
  });

  // Regressão (produção, 2026-09-30): o task runner do n8n não preserva getters, então o motor
  // exposto por `__toCommonJS` (getters do esbuild) chegava com `InnoEngine.x === undefined`.
  it("o motor embutido expõe as funções num objeto literal, sem depender de getters", async () => {
    const vm = await import("node:vm");
    for (const name of ["Interpretar", "Montar mensagem"]) {
      const code = String(flow.nodes.find((n) => n.name === name)?.parameters?.jsCode ?? "");
      const bundle = code.slice(0, code.indexOf("/* @engine:end */"));
      expect(bundle).not.toContain("return __toCommonJS(index_exports);");
      // Simula o runner: getters definidos por defineProperty não sobrevivem.
      const broken = bundle.replace(
        "var __defProp = Object.defineProperty;",
        "var __defProp = function (o, k, d) { if (d && d.get) { o[k] = undefined; return o; } return Object.defineProperty(o, k, d); };",
      );
      const engine = vm.runInNewContext(`${broken}\nInnoEngine;`) as Record<string, unknown>;
      for (const fn of ["interpret", "routeFor", "isResumable", "renderMessage", "renderMessages", "normalizeText"]) {
        expect(typeof engine[fn], `${name}: ${fn}`).toBe("function");
      }
    }
  });

  // Pedido do dono: a confirmação vai sozinha e o "Posso ajudar em algo mais?" numa 2ª mensagem.
  it("BOOKED, RESCHEDULED e CANCELED mandam o pós-ação em mensagem própria; Montar mensagem envia uma por mensagem", () => {
    const code = (name: string) => String(flow.nodes.find((n) => n.name === name)?.parameters?.jsCode ?? "");
    expect(code("Resultado reserva")).toContain("{ key: 'BOOKED', vars }, postAlone()");
    expect(code("Resultado remarcação")).toContain("{ key: 'RESCHEDULED', vars }, postAlone()");
    expect(code("Resultado cancelamento")).toContain("postAlone()]");
    const montar = code("Montar mensagem");
    expect(montar).toContain("E.renderMessages(blocks, texts)");
    expect(montar).toContain("outbound: messages,");
    expect(montar).toContain("messages.map((text) => ({ number: claim.to, text }))");
    const envio = flow.nodes.find((n) => n.name === "Enviar pela Evolution");
    const batch = (envio?.parameters as { options?: { batching?: { batch?: { batchSize?: number; batchInterval?: number } } } }).options?.batching?.batch;
    expect(batch).toEqual({ batchSize: 1, batchInterval: 800 });
  });

  // Melhoria 7: lista de espera. Os estados novos precisam chegar ao ramo certo e as chamadas ao painel precisam estar ligadas.
  describe("lista de espera", () => {
    const outputsOf = (name: string): string[] => (flow.connections[name]?.main ?? []).map((o) => o.map((c) => c.node).join(","));
    const keyOfRules = (name: string) => (byName.get(name)?.parameters.rules?.values ?? []).map((r) => String((r as { outputKey?: string }).outputKey));

    it("Responder passo leva WAITLIST_INVITE, WAITLIST_OFFER e WAITLIST_VIEW ao ramo da lista de espera", () => {
      const keys = keyOfRules("Responder passo");
      const outs = outputsOf("Responder passo");
      for (const state of ["WAITLIST_INVITE", "WAITLIST_OFFER", "WAITLIST_VIEW"]) {
        expect(outs[keys.indexOf(state)], state).toBe("Responder lista de espera");
      }
      // A saída "estado desconhecido" (fallback) continua sendo a última, ligada à falha técnica.
      expect(outs[outs.length - 1]).toBe("Falha técnica");
    });

    it("a opção 'lista de espera' do menu e os destinos WAITLIST_GET/POST do hub estão ligados", () => {
      const menu = keyOfRules("Menu: opção");
      expect(outputsOf("Menu: opção")[menu.indexOf("lista de espera")]).toBe("Responder lista de espera");
      const hub = keyOfRules("Ir para");
      expect(outputsOf("Ir para")[hub.indexOf("WAITLIST_GET")]).toBe("Lista de espera: consultar");
      expect(outputsOf("Ir para")[hub.indexOf("WAITLIST_POST")]).toBe("Lista de espera: enviar");
      expect(outputsOf("Lista de espera: consultar")).toEqual(["Resultado lista de espera"]);
      expect(outputsOf("Lista de espera: enviar")).toEqual(["Resultado lista de espera"]);
      expect(outputsOf("Resultado lista de espera")).toEqual(["Preparar passo"]);
      expect(outputsOf("Responder lista de espera")).toEqual(["Preparar passo"]);
    });

    it("as chamadas ao painel usam as rotas da API interna da lista de espera", () => {
      const responder = String(byName.get("Responder lista de espera")?.parameters.jsCode ?? "");
      expect(responder).toContain("'/waitlist'");
      expect(responder).toContain("/respond'");
      expect(responder).toContain("/leave'");
      expect(responder).toContain("/waitlist'");
      const post = byName.get("Lista de espera: enviar");
      expect(post?.parameters.method).toBe("POST");
    });

    it("o convite à lista só aparece quando o dia está cheio (reason FULL), antes de sugerir outros dias", () => {
      const code = String(byName.get("Resultado horários")?.parameters.jsCode ?? "");
      const invite = code.indexOf("done('WAITLIST_INVITE'");
      const nextDay = code.indexOf("body.nextDay && body.nextDay.id");
      expect(invite).toBeGreaterThan(-1);
      expect(invite).toBeLessThan(nextDay);
      expect(code).toContain("body.reason === 'FULL'");
      expect(code).toContain("wlPeriod");
    });

    it("o menu e o Interpretar mostram 'Minha lista de espera' só para quem tem fila (e sempre por último)", () => {
      const interp = String(byName.get("Interpretar")?.parameters.jsCode ?? "");
      expect(interp).toContain("waitlistCount");
      expect(interp).toContain("'WAITLIST_OFFER'");
      const glue = String(byName.get("Mostrar menu")?.parameters.jsCode ?? "");
      expect(glue).toContain("options.push({ id: 'WAITLIST', titleKey: 'LABEL_MENU_WAITLIST' })");
    });
  });
});
