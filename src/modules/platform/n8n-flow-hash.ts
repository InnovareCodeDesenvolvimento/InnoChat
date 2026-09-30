import { createHash } from "node:crypto";
import type { N8nNode } from "./n8n-client";

/**
 * Hash canônico do fluxo do bot (docs/bot-v2-plano.md §3.6). Serve para dois fins: saber se o que
 * está vivo no n8n é o que o painel publicou (detecção de edição manual) e provar que o PUT
 * gravou exatamente o que foi enviado.
 *
 * Só entra no hash o que define o COMPORTAMENTO do fluxo: nome, tipo, versão do tipo e parâmetros
 * de cada nó, mais as conexões. Fica de fora tudo o que o n8n ou a sincronização mexem sem mudar o
 * comportamento: `id`, `position`, `credentials`, `webhookId`, `notes`. No nó `Config`, os valores
 * de `painelUrl`, `evolutionUrl` e `n8nApiUrl` são zerados — mudam por instalação, não por versão.
 */

export const CONFIG_NODE_NAME = "Config";
export const CONFIG_URL_KEYS = ["painelUrl", "evolutionUrl", "n8nApiUrl"] as const;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** `JSON.stringify` com chaves ordenadas em todos os níveis (arrays mantêm a ordem). */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): Json {
  if (Array.isArray(value)) return value.map((v) => sortKeys(v));
  if (value && typeof value === "object") {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  if (value === undefined || typeof value === "function") return null;
  return value as Json;
}

function blankConfigUrls(parameters: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(parameters) as { assignments?: { assignments?: Array<{ name?: string; value?: unknown }> } };
  for (const assignment of copy.assignments?.assignments ?? []) {
    if (assignment.name && (CONFIG_URL_KEYS as readonly string[]).includes(assignment.name)) assignment.value = "";
  }
  return copy;
}

export function canonicalFlowHash(nodes: N8nNode[], connections: Record<string, unknown>): string {
  const canonical = {
    nodes: [...nodes]
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((n) => ({
        name: n.name,
        type: n.type,
        typeVersion: n.typeVersion ?? null,
        parameters: n.name === CONFIG_NODE_NAME ? blankConfigUrls(n.parameters ?? {}) : (n.parameters ?? {}),
      })),
    connections: connections ?? {},
  };
  return createHash("sha256").update(stableStringify(canonical)).digest("hex");
}

/** `Config.flowVersion` (ex.: "2.0.0"). O JSON v1 não tem o campo: vale "1.0.0". */
export function readFlowVersion(nodes: N8nNode[]): string {
  const config = nodes.find((n) => n.name === CONFIG_NODE_NAME);
  const assignments = (config?.parameters as { assignments?: { assignments?: Array<{ name?: string; value?: unknown }> } } | undefined)
    ?.assignments?.assignments;
  const value = assignments?.find((a) => a.name === "flowVersion")?.value;
  return typeof value === "string" && /^\d+\.\d+\.\d+/.test(value.trim()) ? value.trim() : "1.0.0";
}

export const REDACTED = "[REDACTED]";

/** Nomes de header/campo cujo valor é segredo. */
const SENSITIVE_NAME = /^(authorization|apikey|api[-_]?key|x-api-key)$/i;
/** `Bearer <token>` literal (token que NÃO começa com `{{`/`$`, ou seja, não é expressão do n8n). */
const BEARER_LITERAL = /\bBearer\s+(?![{$])[A-Za-z0-9._~+/=-]{6,}/gi;
/** JWT (`eyJ...`.`...`.`...`). */
const JWT_LITERAL = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
/** `"authorization": "valor"` dentro de um JSON de headers escrito como texto. */
const HEADER_IN_TEXT = /((?:authorization|apikey|api[-_]?key|x-api-key)["']?\s*[:=]\s*["'])(?![{$=]|Bearer\s+[{$])([^"'\r\n]{8,})(?=["'])/gi;
/** Valor que é só uma expressão do n8n (`={{ ... }}`): referência, não segredo literal. */
const PURE_EXPRESSION = /^=?\s*\{\{[\s\S]*\}\}\s*$/;

function redactString(text: string): string {
  return text.replace(BEARER_LITERAL, `Bearer ${REDACTED}`).replace(JWT_LITERAL, REDACTED).replace(HEADER_IN_TEXT, `$1${REDACTED}`);
}

function redactDeep(value: unknown, sensitiveKey: boolean): unknown {
  if (typeof value === "string") {
    if (sensitiveKey && !PURE_EXPRESSION.test(value) && value !== "") return REDACTED;
    return redactString(value);
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, sensitiveKey));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // `{ name: "Authorization", value: "..." }` (headerParameters do HTTP Request).
    const pairIsSensitive = typeof record.name === "string" && SENSITIVE_NAME.test(record.name.trim());
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(record)) {
      out[key] = redactDeep(v, SENSITIVE_NAME.test(key) || (pairIsSensitive && key === "value"));
    }
    return out;
  }
  return value;
}

/**
 * Tira segredos literais dos parâmetros dos nós (headers Authorization/apikey/x-api-key, `Bearer …`
 * e JWT `eyJ…`) antes de gravar o snapshot de rollback ou entregar o download. O fluxo do painel
 * usa credenciais do n8n (não parâmetros), então nada disto altera um fluxo não editado à mão;
 * só protege quem colou um token direto num nó. Não altera o original.
 */
export function redactFlowSecrets(nodes: N8nNode[]): N8nNode[] {
  return nodes.map((node) => ({ ...node, parameters: redactDeep(structuredClone(node.parameters ?? {}), false) as N8nNode["parameters"] }));
}

/**
 * Versão para download: sem credenciais (nem os ids), sem `pinData` (dados de teste podem trazer
 * conteúdo de conversas), sem `staticData`, sem segredos literais nos parâmetros e sem os campos
 * de estado do n8n.
 */
export function sanitizeFlowForDownload(workflow: {
  name: string;
  nodes: N8nNode[];
  connections: Record<string, unknown>;
  settings?: Record<string, unknown>;
}): { name: string; nodes: N8nNode[]; connections: Record<string, unknown>; settings: Record<string, unknown> } {
  const nodes = redactFlowSecrets(structuredClone(workflow.nodes)).map((node) => {
    const { credentials: _credentials, pinData: _pinData, ...rest } = node as N8nNode & { pinData?: unknown };
    void _credentials;
    void _pinData;
    return rest as N8nNode;
  });
  return {
    name: workflow.name,
    nodes,
    connections: structuredClone(workflow.connections ?? {}),
    settings: structuredClone(workflow.settings ?? {}),
  };
}
