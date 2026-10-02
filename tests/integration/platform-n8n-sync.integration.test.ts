/**
 * `syncN8n`/`activateBotWorkflow`/`deactivateBotWorkflow` (docs/contratos.md,
 * `src/modules/platform/n8n-sync.ts`) contra Postgres real, com `fetch` mockado simulando a
 * API pública do n8n em duas versões: uma "moderna" (PATCH de credencial, publish/unpublish) e
 * uma "antiga" (só POST/DELETE de credencial, só activate/deactivate) — para provar que
 * `n8n-client.ts` tenta o caminho novo e cai para o antigo em 404/405, nos dois casos, sem
 * quebrar em nenhuma das duas versões. Não temos uma instância n8n real disponível nesta sessão
 * (ver PENDÊNCIA em `n8n-client.ts`/`docs/contratos.md`).
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import type { N8nNode, N8nWorkflow } from "@/modules/platform/n8n-client";

const prisma = getPrisma();

const N8N_BASE_URL = "https://n8n.example.test";
const EVOLUTION_URL = "https://evolution.example.test";

type WebhookNodeOptions = { path: string; webhookId?: string | null } | "absent";

function makeBotWorkflow(
  webhook: WebhookNodeOptions = { path: "innochat/evolution/:token", webhookId: "b12d5bcf-6ca4-4d91-b0d7-d255d196cfd5" },
): N8nWorkflow {
  const nodes: N8nNode[] = [
    ...(webhook === "absent"
      ? []
      : [
          {
            name: "Webhook",
            type: "n8n-nodes-base.webhook",
            parameters: { httpMethod: "POST", path: webhook.path },
            ...(webhook.webhookId ? { webhookId: webhook.webhookId } : {}),
          } as N8nNode,
        ]),
    {
      name: "Config",
      type: "n8n-nodes-base.set",
      parameters: {
        assignments: {
          assignments: [
            { id: "painelUrl", name: "painelUrl", value: "https://PAINEL_A_DEFINIR/api/internal/v1", type: "string" },
            { id: "evolutionUrl", name: "evolutionUrl", value: "https://EVOLUTION_A_DEFINIR", type: "string" },
          ],
        },
      },
    },
    {
      name: "Claim",
      type: "n8n-nodes-base.httpRequest",
      parameters: { authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth", url: "={{ $('Config').first().json.painelUrl }}/messages/claim" },
    },
    {
      name: "Enviar pela Evolution",
      type: "n8n-nodes-base.httpRequest",
      parameters: { authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth", url: "={{ $('Config').first().json.evolutionUrl }}/message/sendText/x" },
    },
  ];
  return { id: "levHnMSXf1dOR3gS", name: "innochat-bot", active: false, nodes, connections: {} };
}

function makeErrosWorkflow(): N8nWorkflow {
  const nodes: N8nNode[] = [
    {
      name: "Config erros",
      type: "n8n-nodes-base.set",
      parameters: { assignments: { assignments: [{ id: "n8nApiUrl", name: "n8nApiUrl", value: "https://N8N_A_DEFINIR/api/v1", type: "string" }] } },
    },
    {
      name: "Buscar execução com falha",
      type: "n8n-nodes-base.httpRequest",
      parameters: { authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth", url: "={{ $('Config erros').first().json.n8nApiUrl }}/executions/1" },
    },
    {
      name: "Liberar trava",
      type: "n8n-nodes-base.httpRequest",
      parameters: { authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth", url: "={{ $('Config erros').first().json.painelUrl }}/sessions/unlock" },
    },
  ];
  return { id: "GZSwTNgvVt4LYnwW", name: "innochat-erros", active: false, nodes, connections: {} };
}

function makeCronWorkflow(): N8nWorkflow {
  const nodes: N8nNode[] = [
    {
      name: "Config cron",
      type: "n8n-nodes-base.set",
      parameters: {
        assignments: { assignments: [{ id: "painelUrl", name: "painelUrl", value: "https://PAINEL_A_DEFINIR/api/internal/v1", type: "string" }] },
      },
    },
    {
      name: "Chamar billing/tick",
      type: "n8n-nodes-base.httpRequest",
      parameters: { authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth", url: "={{ $('Config cron').first().json.painelUrl }}/billing/tick" },
    },
  ];
  return { id: "dPMhT4MqGglCpFSw", name: "innochat-cron", active: false, nodes, connections: {} };
}

type FakeServerOptions = {
  /** `true` = instância nova (tem `PATCH /credentials/{id}`); `false` = instância antiga (só POST/DELETE). */
  supportsCredentialPatch: boolean;
  /** `true` = instância nova (tem `publish`/`unpublish`); `false` = instância antiga (só `activate`/`deactivate`, deprecated). */
  supportsPublish: boolean;
  /** `false` = `innochat-cron` não existe nesta instância (mission: sync não falha, só avisa). Padrão `true`. */
  hasCronWorkflow?: boolean;
  /** `true` = n8n antigo que recusa `allowedHttpRequestDomains`/`allowedDomains` ("additional property"). */
  rejectsDomainFields?: boolean;
  /** Nó Webhook do bot (padrão: path com `:token` + webhookId de produção). */
  webhook?: WebhookNodeOptions;
  /** Evolution: nomes de instância cujo `POST /webhook/set` deve falhar (500). */
  failingEvolutionInstances?: string[];
};

/** Simula a API pública do n8n, com as duas superfícies possíveis controladas por `options` — ver cabeçalho do arquivo. */
function createFakeN8nServer(options: FakeServerOptions) {
  let credentialCounter = 0;
  const deletedCredentialIds = new Set<string>();
  const createdCredentials: Array<{ id: string; name: string; type: string; data: Record<string, string> }> = [];
  const patchedCredentialIds: string[] = [];
  const activateCalls: Array<{ id: string; route: "publish" | "unpublish" | "activate" | "deactivate" }> = [];
  const evolutionWebhookCalls: Array<{ instanceName: string; url: string }> = [];
  const workflows = new Map<string, N8nWorkflow>();
  workflows.set("levHnMSXf1dOR3gS", makeBotWorkflow(options.webhook));
  workflows.set("GZSwTNgvVt4LYnwW", makeErrosWorkflow());
  if (options.hasCronWorkflow !== false) {
    workflows.set("dPMhT4MqGglCpFSw", makeCronWorkflow());
  }

  function jsonResponse(status: number, body: unknown = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname;

    if (url.origin === EVOLUTION_URL) {
      const setMatch = path.match(/^\/webhook\/set\/([^/]+)$/);
      if (setMatch && method === "POST") {
        const instanceName = decodeURIComponent(setMatch[1]!);
        const body = JSON.parse(String(init?.body)) as { webhook: { url: string } };
        if (options.failingEvolutionInstances?.includes(instanceName)) return jsonResponse(500, { message: "boom" });
        evolutionWebhookCalls.push({ instanceName, url: body.webhook.url });
        return jsonResponse(200, {});
      }
      throw new Error(`fake evolution: rota não simulada ${method} ${path}`);
    }

    if (path === "/api/v1/credentials" && method === "POST") {
      credentialCounter += 1;
      const body = JSON.parse(String(init?.body)) as { name: string; type: string; data: Record<string, string> };
      const hasDomainFields = "allowedDomains" in body.data || "allowedHttpRequestDomains" in body.data;
      if (options.rejectsDomainFields && hasDomainFields) {
        return jsonResponse(400, { message: "request.body.data is not allowed to have the additional property \"allowedDomains\"" });
      }
      if (!options.rejectsDomainFields && !hasDomainFields) {
        return jsonResponse(400, { message: "request.body.data requires property \"allowedDomains\"" });
      }
      const id = `cred-${credentialCounter}`;
      createdCredentials.push({ id, ...body });
      return jsonResponse(200, { id, name: body.name });
    }

    const credentialByIdMatch = path.match(/^\/api\/v1\/credentials\/([^/]+)$/);
    if (credentialByIdMatch && method === "DELETE") {
      deletedCredentialIds.add(credentialByIdMatch[1]!);
      return jsonResponse(200, {});
    }
    if (credentialByIdMatch && method === "PATCH") {
      if (!options.supportsCredentialPatch) return jsonResponse(404, {}); // instância antiga: rota não existe
      const id = credentialByIdMatch[1]!;
      const body = JSON.parse(String(init?.body)) as { name: string; type: string; data: Record<string, string> };
      patchedCredentialIds.push(id);
      return jsonResponse(200, { id, name: body.name });
    }

    if (path === "/api/v1/workflows" && method === "GET") {
      return jsonResponse(200, { data: Array.from(workflows.values()), nextCursor: null });
    }

    const workflowMatch = path.match(/^\/api\/v1\/workflows\/([^/]+)$/);
    if (workflowMatch && method === "GET") {
      const wf = workflows.get(workflowMatch[1]!);
      return wf ? jsonResponse(200, wf) : jsonResponse(404, {});
    }
    if (workflowMatch && method === "PUT") {
      const id = workflowMatch[1]!;
      const body = JSON.parse(String(init?.body)) as Pick<N8nWorkflow, "name" | "nodes" | "connections" | "settings">;
      // `n8n-client.ts#updateWorkflow` deve filtrar para só estes 4 campos — se algum campo
      // readOnly (id/active/tags/etc.) vier no corpo, é bug do cliente, não da simulação.
      const allowedKeys = new Set(["name", "nodes", "connections", "settings"]);
      const extraKeys = Object.keys(body).filter((k) => !allowedKeys.has(k));
      if (extraKeys.length > 0) return jsonResponse(400, { message: `campos readOnly no corpo: ${extraKeys.join(",")}` });
      const existing = workflows.get(id);
      if (!existing) return jsonResponse(404, {});
      const updated: N8nWorkflow = { ...existing, ...body };
      workflows.set(id, updated);
      return jsonResponse(200, updated);
    }

    const activationMatch = path.match(/^\/api\/v1\/workflows\/([^/]+)\/(publish|unpublish|activate|deactivate)$/);
    if (activationMatch && method === "POST") {
      const [, id, route] = activationMatch as unknown as [string, string, "publish" | "unpublish" | "activate" | "deactivate"];
      const isNewRoute = route === "publish" || route === "unpublish";
      if (isNewRoute && !options.supportsPublish) return jsonResponse(405, { message: "POST method not allowed" }); // instância antiga (visto em produção: 405, não 404)
      activateCalls.push({ id, route });
      const wf = workflows.get(id);
      if (wf) wf.active = route === "publish" || route === "activate";
      return jsonResponse(200, {});
    }

    throw new Error(`fake n8n server: rota não simulada ${method} ${path}`);
  });

  return { fetchMock, evolutionWebhookCalls, createdCredentials, deletedCredentialIds, patchedCredentialIds, activateCalls, workflows };
}

const createdUserIds: string[] = [];

beforeEach(async () => {
  await prisma.platformSettings.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      n8nBaseUrl: N8N_BASE_URL,
      n8nApiKey: "fake-n8n-key",
      evolutionApiUrl: EVOLUTION_URL,
      evolutionApiKey: "fake-evolution-key",
      n8nCredPainelId: null,
      n8nCredEvolutionId: null,
      n8nCredApiId: null,
      n8nWorkflowBotId: null,
      n8nWorkflowErrosId: null,
      n8nWorkflowCronId: null,
    },
    update: {
      n8nBaseUrl: N8N_BASE_URL,
      n8nApiKey: "fake-n8n-key",
      evolutionApiUrl: EVOLUTION_URL,
      evolutionApiKey: "fake-evolution-key",
      n8nCredPainelId: null,
      n8nCredEvolutionId: null,
      n8nCredApiId: null,
      n8nWorkflowBotId: null,
      n8nWorkflowErrosId: null,
      n8nWorkflowCronId: null,
    },
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

async function makeAdminUser() {
  const email = `it-n8n-sync-${Date.now()}-${randomUUID().slice(0, 6)}@example.com`;
  const admin = await prisma.user.create({ data: { email, passwordHash: "x", isPlatformAdmin: true, totpSecretEnc: "enc:v1:x", totpEnabledAt: new Date() } });
  createdUserIds.push(admin.id);
  return admin;
}

describe("syncN8n — sincronização idempotente com o n8n (instância moderna: PATCH + publish/unpublish)", () => {
  it("cria as 3 credenciais, atualiza os dois workflows (só 4 campos no PUT) e reata a credencial certa em cada nó HTTP", async () => {
    const { syncN8n } = await import("@/modules/platform/n8n-sync");
    const admin = await makeAdminUser();
    const server = createFakeN8nServer({ supportsCredentialPatch: true, supportsPublish: true });
    vi.stubGlobal("fetch", server.fetchMock);

    const summary = await syncN8n(admin.id);

    expect(summary.botWorkflowId).toBe("levHnMSXf1dOR3gS");
    expect(summary.errosWorkflowId).toBe("GZSwTNgvVt4LYnwW");
    expect(summary.credentialsRotated).toBe(3);
    expect(server.createdCredentials).toHaveLength(3); // 1ª sync: sem id anterior, sempre cria
    expect(server.createdCredentials.map((c) => c.name).sort()).toEqual(
      ["Evolution API (apikey)", "InnoChat Painel (Bearer)", "n8n API (X-N8N-API-KEY)"].sort(),
    );

    const botWorkflow = server.workflows.get("levHnMSXf1dOR3gS")!;
    const claimNode = botWorkflow.nodes.find((n) => n.name === "Claim")!;
    const evolutionNode = botWorkflow.nodes.find((n) => n.name === "Enviar pela Evolution")!;
    const painelCred = server.createdCredentials.find((c) => c.name === "InnoChat Painel (Bearer)")!;
    const evolutionCred = server.createdCredentials.find((c) => c.name === "Evolution API (apikey)")!;
    expect(claimNode.credentials?.httpHeaderAuth.id).toBe(painelCred.id);
    expect(evolutionNode.credentials?.httpHeaderAuth.id).toBe(evolutionCred.id);

    const errosWorkflow = server.workflows.get("GZSwTNgvVt4LYnwW")!;
    const execNode = errosWorkflow.nodes.find((n) => n.name === "Buscar execução com falha")!;
    const n8nCred = server.createdCredentials.find((c) => c.name === "n8n API (X-N8N-API-KEY)")!;
    expect(execNode.credentials?.httpHeaderAuth.id).toBe(n8nCred.id);

    const configNode = botWorkflow.nodes.find((n) => n.name === "Config")!;
    const painelUrlAssignment = (configNode.parameters as { assignments: { assignments: Array<{ name: string; value: unknown }> } }).assignments
      .assignments.find((a) => a.name === "painelUrl")!;
    expect(String(painelUrlAssignment.value)).toContain("/api/internal/v1");

    const settings = await prisma.platformSettings.findUnique({ where: { id: 1 } });
    expect(settings?.n8nCredPainelId).toBe(painelCred.id);
    expect(settings?.n8nWorkflowBotId).toBe("levHnMSXf1dOR3gS");
  });

  it("rodar 2x não duplica credencial — a 2ª sync usa PATCH (mesmo id, sem criar nem deletar)", async () => {
    const { syncN8n } = await import("@/modules/platform/n8n-sync");
    const admin = await makeAdminUser();
    const server = createFakeN8nServer({ supportsCredentialPatch: true, supportsPublish: true });
    vi.stubGlobal("fetch", server.fetchMock);

    await syncN8n(admin.id);
    const firstPainelCredId = (await prisma.platformSettings.findUnique({ where: { id: 1 } }))!.n8nCredPainelId;

    await syncN8n(admin.id);
    const secondPainelCredId = (await prisma.platformSettings.findUnique({ where: { id: 1 } }))!.n8nCredPainelId;

    // Instância moderna: a 2ª sync faz PATCH (mesmo id) em vez de delete+create.
    expect(server.createdCredentials).toHaveLength(3); // só a 1ª sync criou
    expect(server.patchedCredentialIds).toContain(firstPainelCredId);
    expect(server.deletedCredentialIds.size).toBe(0);
    expect(secondPainelCredId).toBe(firstPainelCredId);

    // Workflow nunca é recriado — mesmo id nas duas rodadas (bot + erros + cron, padrão do fake server).
    expect(server.workflows.size).toBe(3);
  });

  it("nunca ativa nenhum workflow na sync (fica sempre `active: false`)", async () => {
    const { syncN8n } = await import("@/modules/platform/n8n-sync");
    const admin = await makeAdminUser();
    const server = createFakeN8nServer({ supportsCredentialPatch: true, supportsPublish: true });
    vi.stubGlobal("fetch", server.fetchMock);

    await syncN8n(admin.id);

    expect(server.workflows.get("levHnMSXf1dOR3gS")!.active).toBe(false);
    expect(server.workflows.get("GZSwTNgvVt4LYnwW")!.active).toBe(false);
    expect(server.activateCalls).toHaveLength(0);
  });

  it("activateBotWorkflow/deactivateBotWorkflow usam publish/unpublish", async () => {
    const { syncN8n, activateBotWorkflow, deactivateBotWorkflow } = await import("@/modules/platform/n8n-sync");
    const admin = await makeAdminUser();
    const server = createFakeN8nServer({ supportsCredentialPatch: true, supportsPublish: true });
    vi.stubGlobal("fetch", server.fetchMock);

    await syncN8n(admin.id);
    await activateBotWorkflow();
    await deactivateBotWorkflow();

    // `activateBotWorkflow`/`deactivateBotWorkflow` publicam/despublicam o cron JUNTO com o bot.
    expect(server.activateCalls).toEqual([
      { id: "levHnMSXf1dOR3gS", route: "publish" },
      { id: "dPMhT4MqGglCpFSw", route: "publish" },
      { id: "levHnMSXf1dOR3gS", route: "unpublish" },
      { id: "dPMhT4MqGglCpFSw", route: "unpublish" },
    ]);
  });
});

describe("syncN8n — innochat-cron (opcional)", () => {
  it("sincroniza o painelUrl do 'Config cron' e reata a credencial do painel no nó HTTP", async () => {
    const { syncN8n } = await import("@/modules/platform/n8n-sync");
    const admin = await makeAdminUser();
    const server = createFakeN8nServer({ supportsCredentialPatch: true, supportsPublish: true });
    vi.stubGlobal("fetch", server.fetchMock);

    const summary = await syncN8n(admin.id);

    expect(summary.cronWorkflowId).toBe("dPMhT4MqGglCpFSw");
    expect(summary.warnings).toEqual([]);

    const cronWorkflow = server.workflows.get("dPMhT4MqGglCpFSw")!;
    const configCronNode = cronWorkflow.nodes.find((n) => n.name === "Config cron")!;
    const painelUrlAssignment = (configCronNode.parameters as { assignments: { assignments: Array<{ name: string; value: unknown }> } }).assignments
      .assignments.find((a) => a.name === "painelUrl")!;
    expect(String(painelUrlAssignment.value)).toContain("/api/internal/v1");

    const tickNode = cronWorkflow.nodes.find((n) => n.name === "Chamar billing/tick")!;
    const painelCred = server.createdCredentials.find((c) => c.name === "InnoChat Painel (Bearer)")!;
    expect(tickNode.credentials?.httpHeaderAuth.id).toBe(painelCred.id);

    const settings = await prisma.platformSettings.findUnique({ where: { id: 1 } });
    expect(settings?.n8nWorkflowCronId).toBe("dPMhT4MqGglCpFSw");
  });

  it("não falha quando innochat-cron não existe — só avisa no resumo, sem perder bot/erros", async () => {
    const { syncN8n } = await import("@/modules/platform/n8n-sync");
    const admin = await makeAdminUser();
    const server = createFakeN8nServer({ supportsCredentialPatch: true, supportsPublish: true, hasCronWorkflow: false });
    vi.stubGlobal("fetch", server.fetchMock);

    const summary = await syncN8n(admin.id);

    expect(summary.cronWorkflowId).toBeNull();
    expect(summary.warnings).toHaveLength(1);
    expect(summary.warnings[0]).toContain("innochat-cron");
    expect(summary.botWorkflowId).toBe("levHnMSXf1dOR3gS");
    expect(summary.errosWorkflowId).toBe("GZSwTNgvVt4LYnwW");

    const settings = await prisma.platformSettings.findUnique({ where: { id: 1 } });
    expect(settings?.n8nWorkflowCronId).toBeNull();
  });

  it("activateBotWorkflow não falha quando o cron nunca foi sincronizado (pula silenciosamente)", async () => {
    const { syncN8n, activateBotWorkflow } = await import("@/modules/platform/n8n-sync");
    const admin = await makeAdminUser();
    const server = createFakeN8nServer({ supportsCredentialPatch: true, supportsPublish: true, hasCronWorkflow: false });
    vi.stubGlobal("fetch", server.fetchMock);

    await syncN8n(admin.id);
    await expect(activateBotWorkflow()).resolves.toBeUndefined();

    expect(server.activateCalls).toEqual([{ id: "levHnMSXf1dOR3gS", route: "publish" }]);
  });
});

describe("syncN8n — compatibilidade com instância antiga (sem PATCH, sem publish/unpublish)", () => {
  it("credencial cai para delete+create quando a instância não tem PATCH (404)", async () => {
    const { syncN8n } = await import("@/modules/platform/n8n-sync");
    const admin = await makeAdminUser();
    const server = createFakeN8nServer({ supportsCredentialPatch: false, supportsPublish: false });
    vi.stubGlobal("fetch", server.fetchMock);

    await syncN8n(admin.id);
    const firstPainelCredId = (await prisma.platformSettings.findUnique({ where: { id: 1 } }))!.n8nCredPainelId;

    await syncN8n(admin.id);
    const secondPainelCredId = (await prisma.platformSettings.findUnique({ where: { id: 1 } }))!.n8nCredPainelId;

    expect(server.createdCredentials).toHaveLength(6); // 3 na 1ª sync + 3 recriadas na 2ª (delete+create)
    expect(server.patchedCredentialIds).toHaveLength(0);
    expect(server.deletedCredentialIds.has(firstPainelCredId!)).toBe(true);
    expect(secondPainelCredId).not.toBe(firstPainelCredId);
  });

  it("activateBotWorkflow/deactivateBotWorkflow caem para activate/deactivate quando publish/unpublish não existem (404)", async () => {
    const { syncN8n, activateBotWorkflow, deactivateBotWorkflow } = await import("@/modules/platform/n8n-sync");
    const admin = await makeAdminUser();
    const server = createFakeN8nServer({ supportsCredentialPatch: false, supportsPublish: false });
    vi.stubGlobal("fetch", server.fetchMock);

    await syncN8n(admin.id);
    await activateBotWorkflow();
    await deactivateBotWorkflow();

    expect(server.activateCalls).toEqual([
      { id: "levHnMSXf1dOR3gS", route: "activate" },
      { id: "dPMhT4MqGglCpFSw", route: "activate" },
      { id: "levHnMSXf1dOR3gS", route: "deactivate" },
      { id: "dPMhT4MqGglCpFSw", route: "deactivate" },
    ]);
    expect(server.workflows.get("levHnMSXf1dOR3gS")!.active).toBe(false); // deactivate foi a última chamada
  });
});

describe("syncN8n — restrição de domínio das credenciais (allowedDomains)", () => {
  it("n8n recente: cada credencial vai restrita ao host que ela chama", async () => {
    const { syncN8n } = await import("@/modules/platform/n8n-sync");
    const admin = await makeAdminUser();
    const server = createFakeN8nServer({ supportsCredentialPatch: true, supportsPublish: true });
    vi.stubGlobal("fetch", server.fetchMock);

    await syncN8n(admin.id);

    expect(server.createdCredentials).toHaveLength(3);
    for (const cred of server.createdCredentials) {
      expect(cred.data.allowedHttpRequestDomains).toBe("domains");
      expect(cred.data.allowedDomains).toMatch(/^[a-z0-9.-]+$/i);
    }
  });

  it("n8n antigo que recusa os campos: reenvia sem eles e a sync termina", async () => {
    const { syncN8n } = await import("@/modules/platform/n8n-sync");
    const admin = await makeAdminUser();
    const server = createFakeN8nServer({ supportsCredentialPatch: false, supportsPublish: false, rejectsDomainFields: true });
    vi.stubGlobal("fetch", server.fetchMock);

    await syncN8n(admin.id);

    expect(server.createdCredentials).toHaveLength(3);
    for (const cred of server.createdCredentials) {
      expect(cred.data).not.toHaveProperty("allowedDomains");
    }
  });
});

describe("syncN8n — URL de webhook derivada do nó Webhook do bot", () => {
  it("path com parâmetro (:token): base = <n8n>/webhook/<webhookId>/<path sem :token>, gravada em n8nWebhookBaseUrl", async () => {
    const { syncN8n } = await import("@/modules/platform/n8n-sync");
    const admin = await makeAdminUser();
    await prisma.platformSettings.update({ where: { id: 1 }, data: { n8nWebhookBaseUrl: "https://valor-manual.example.test/webhook" } });
    const server = createFakeN8nServer({ supportsCredentialPatch: true, supportsPublish: true });
    vi.stubGlobal("fetch", server.fetchMock);

    const summary = await syncN8n(admin.id);

    const expected = `${N8N_BASE_URL}/webhook/b12d5bcf-6ca4-4d91-b0d7-d255d196cfd5/innochat/evolution`;
    expect(summary.webhookBaseUrl).toBe(expected);
    const settings = await prisma.platformSettings.findUnique({ where: { id: 1 } });
    expect(settings?.n8nWebhookBaseUrl).toBe(expected); // sobrescreve o valor manual
  });

  it("path sem parâmetro: base = <n8n>/webhook/<path>, sem webhookId", async () => {
    const { syncN8n } = await import("@/modules/platform/n8n-sync");
    const admin = await makeAdminUser();
    const server = createFakeN8nServer({ supportsCredentialPatch: true, supportsPublish: true, webhook: { path: "innochat/evolution" } });
    vi.stubGlobal("fetch", server.fetchMock);

    const summary = await syncN8n(admin.id);

    expect(summary.webhookBaseUrl).toBe(`${N8N_BASE_URL}/webhook/innochat/evolution`);
  });

  it("nó Webhook ausente: DomainError legível", async () => {
    const { syncN8n } = await import("@/modules/platform/n8n-sync");
    const admin = await makeAdminUser();
    const server = createFakeN8nServer({ supportsCredentialPatch: true, supportsPublish: true, webhook: "absent" });
    vi.stubGlobal("fetch", server.fetchMock);

    await expect(syncN8n(admin.id)).rejects.toMatchObject({ code: "N8N_WEBHOOK_NODE_NOT_FOUND" });
  });

  it("path com parâmetro mas sem webhookId: DomainError legível", async () => {
    const { syncN8n } = await import("@/modules/platform/n8n-sync");
    const admin = await makeAdminUser();
    const server = createFakeN8nServer({
      supportsCredentialPatch: true,
      supportsPublish: true,
      webhook: { path: "innochat/evolution/:token", webhookId: null },
    });
    vi.stubGlobal("fetch", server.fetchMock);

    await expect(syncN8n(admin.id)).rejects.toMatchObject({ code: "N8N_WEBHOOK_ID_MISSING" });
  });
});

describe("syncN8n — reapontamento dos webhooks das instâncias na Evolution", () => {
  const tenantIds: string[] = [];

  afterEach(async () => {
    await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    tenantIds.length = 0;
  });

  it("reaponta cada instância viva para <base>/<webhookToken>; falha numa não derruba a sync e é contada", async () => {
    const { syncN8n } = await import("@/modules/platform/n8n-sync");
    const admin = await makeAdminUser();
    const tag = randomUUID().slice(0, 8);
    const tenant = await prisma.tenant.create({ data: { slug: `it-sync-${tag}`, name: `IT sync ${tag}`, timezone: "UTC" } });
    tenantIds.push(tenant.id);
    const ok = `it-ok-${tag}`;
    const bad = `it-bad-${tag}`;
    const gone = `it-gone-${tag}`;
    const okToken = `tok-${randomUUID()}`;
    for (const [instanceName, webhookToken, deletedAt] of [
      [ok, okToken, null],
      [bad, `tok-${randomUUID()}`, null],
      [gone, `tok-${randomUUID()}`, new Date()],
    ] as const) {
      await prisma.whatsappInstance.create({ data: { tenantId: tenant.id, instanceName, label: instanceName, webhookToken, deletedAt } });
    }
    const server = createFakeN8nServer({ supportsCredentialPatch: true, supportsPublish: true, failingEvolutionInstances: [bad] });
    vi.stubGlobal("fetch", server.fetchMock);

    const summary = await syncN8n(admin.id);

    const base = `${N8N_BASE_URL}/webhook/b12d5bcf-6ca4-4d91-b0d7-d255d196cfd5/innochat/evolution`;
    const mine = server.evolutionWebhookCalls.filter((c) => c.instanceName.endsWith(tag));
    expect(mine).toEqual([{ instanceName: ok, url: `${base}/${okToken}` }]); // removida não é tocada; falha não entra
    expect(summary.webhooksFalhos).toBeGreaterThanOrEqual(1);
    expect(summary.webhooksReapontados).toBeGreaterThanOrEqual(1);
    expect(summary.warnings.some((w) => w.includes("reapontado"))).toBe(true);
    expect(summary.botWorkflowId).toBe("levHnMSXf1dOR3gS"); // a sync terminou mesmo com a falha
  });

  it("NÃO reaponta a instância do WhatsApp da plataforma (cobrança) para o bot", async () => {
    const { syncN8n } = await import("@/modules/platform/n8n-sync");
    const admin = await makeAdminUser();
    const tag = randomUUID().slice(0, 8);
    const platformInstance = `innochat-plataforma-${tag}`;
    await prisma.platformWhatsappConnection.deleteMany({});
    const connection = await prisma.platformWhatsappConnection.create({
      data: {
        instanceName: platformInstance,
        webhookTokenHash: `hash-${randomUUID()}`,
        label: "Cobrança",
        status: "CONNECTED",
        role: "ACTIVE",
        phoneE164: "5584991110077",
        activatedAt: new Date(),
      },
    });
    const server = createFakeN8nServer({ supportsCredentialPatch: true, supportsPublish: true });
    vi.stubGlobal("fetch", server.fetchMock);

    try {
      await syncN8n(admin.id);
      expect(server.evolutionWebhookCalls.filter((c) => c.instanceName === platformInstance)).toEqual([]);
    } finally {
      await prisma.platformWhatsappConnection.delete({ where: { id: connection.id } });
    }
  });
});
