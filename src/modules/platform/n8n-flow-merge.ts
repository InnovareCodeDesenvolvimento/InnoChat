import { DomainError } from "@/lib/errors";
import type { N8nNode, N8nWorkflow } from "./n8n-client";
import { CONFIG_NODE_NAME } from "./n8n-flow-hash";

/**
 * Monta o corpo do PUT: `nodes`/`connections` vêm da fonte (JSON do build ou snapshot), e o que
 * pertence à INSTALAÇÃO viva é preservado — `webhookId` do Webhook e do "Esperar" (mudar o id
 * troca a rota registrada no n8n e derruba o bot), credenciais, URLs do nó Config e
 * `settings.errorWorkflow`. As funções de credencial e de Config são cópias das de `n8n-sync.ts`
 * (D-1 não edita aquele arquivo); se a sync mudar a regra, mude aqui também.
 */

export const CRED_PAINEL_NAME = "InnoChat Painel (Bearer)";
export const CRED_EVOLUTION_NAME = "Evolution API (apikey)";
export const CRED_N8N_API_NAME = "n8n API (X-N8N-API-KEY)";

const WEBHOOK_NODE_TYPE = "n8n-nodes-base.webhook";
const WAIT_NODE_TYPE = "n8n-nodes-base.wait";

export type CredentialIds = { painel: string; evolution: string; n8n: string };

export type MergeInput = {
  source: { nodes: N8nNode[]; connections: Record<string, unknown> };
  live: Pick<N8nWorkflow, "name" | "nodes" | "settings">;
  credentialIds: CredentialIds;
  painelUrl: string;
  evolutionUrl: string;
  n8nApiUrl: string;
  errosWorkflowId: string;
};

export type MergedFlow = Pick<N8nWorkflow, "name" | "nodes" | "connections" | "settings">;

function classifyCredentialGroup(node: N8nNode): "painel" | "evolution" | "n8n" | null {
  if (node.type !== "n8n-nodes-base.httpRequest") return null;
  const params = (node.parameters ?? {}) as Record<string, unknown>;
  if (params.authentication !== "genericCredentialType" || params.genericAuthType !== "httpHeaderAuth") return null;
  const url = String(params.url ?? "");
  if (url.includes("evolutionUrl")) return "evolution";
  if (url.includes("n8nApiUrl")) return "n8n";
  if (url.includes("painelUrl")) return "painel";
  return null;
}

function setConfigAssignment(node: N8nNode, name: string, value: string): void {
  const params = (node.parameters ?? {}) as { assignments?: { assignments?: Array<{ name: string; value: unknown }> } };
  const assignment = params.assignments?.assignments?.find((a) => a.name === name);
  if (assignment) assignment.value = value;
}

function rebindHttpCredentials(nodes: N8nNode[], ids: CredentialIds): void {
  for (const node of nodes) {
    const group = classifyCredentialGroup(node);
    if (!group) continue;
    const id = ids[group];
    const name = group === "painel" ? CRED_PAINEL_NAME : group === "evolution" ? CRED_EVOLUTION_NAME : CRED_N8N_API_NAME;
    node.credentials = { httpHeaderAuth: { id, name } };
  }
}

function webhookPath(nodes: N8nNode[]): string | null {
  const node = nodes.find((n) => n.type === WEBHOOK_NODE_TYPE);
  if (!node) return null;
  return String((node.parameters as { path?: unknown } | undefined)?.path ?? "").replace(/^\/+|\/+$/g, "");
}

export function mergeFlow(input: MergeInput): MergedFlow {
  const nodes = structuredClone(input.source.nodes);
  const liveByName = new Map(input.live.nodes.map((n) => [n.name, n]));

  // Rota do webhook: trocar o `path` muda a URL que a Evolution chama — bloqueia antes de escrever.
  const sourcePath = webhookPath(nodes);
  const livePath = webhookPath(input.live.nodes);
  if (sourcePath !== null && livePath !== null && sourcePath !== livePath) {
    throw new DomainError(
      "WEBHOOK_PATH_CHANGED",
      `O path do Webhook mudou (${livePath} → ${sourcePath}). Publicar quebraria o recebimento de mensagens; ajuste o JSON ou reaponte os números antes.`,
      { livePath, newPath: sourcePath },
    );
  }

  for (const node of nodes) {
    const liveNode = liveByName.get(node.name);
    if (node.type === WEBHOOK_NODE_TYPE || node.type === WAIT_NODE_TYPE || "webhookId" in node) {
      if (typeof liveNode?.webhookId === "string" && liveNode.webhookId) node.webhookId = liveNode.webhookId;
    }
  }

  const configNode = nodes.find((n) => n.name === CONFIG_NODE_NAME);
  if (configNode) {
    setConfigAssignment(configNode, "painelUrl", input.painelUrl);
    setConfigAssignment(configNode, "evolutionUrl", input.evolutionUrl);
    setConfigAssignment(configNode, "n8nApiUrl", input.n8nApiUrl);
  }

  rebindHttpCredentials(nodes, input.credentialIds);
  // Nó que a regra acima não reconhece mas tem credencial no vivo (ex.: ligada à mão): não perde.
  for (const node of nodes) {
    if (node.credentials) continue;
    const liveCreds = liveByName.get(node.name)?.credentials;
    if (liveCreds) node.credentials = structuredClone(liveCreds);
  }

  return {
    name: input.live.name,
    nodes,
    connections: structuredClone(input.source.connections ?? {}),
    settings: { ...(input.live.settings ?? {}), errorWorkflow: input.errosWorkflowId },
  };
}
