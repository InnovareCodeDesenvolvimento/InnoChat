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

/**
 * Versão para download: sem credenciais (nem os ids), sem `pinData` (dados de teste podem trazer
 * conteúdo de conversas), sem `staticData` e sem os campos de estado do n8n.
 */
export function sanitizeFlowForDownload(workflow: {
  name: string;
  nodes: N8nNode[];
  connections: Record<string, unknown>;
  settings?: Record<string, unknown>;
}): { name: string; nodes: N8nNode[]; connections: Record<string, unknown>; settings: Record<string, unknown> } {
  const nodes = structuredClone(workflow.nodes).map((node) => {
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
