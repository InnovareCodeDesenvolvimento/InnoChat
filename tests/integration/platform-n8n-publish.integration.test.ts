/**
 * "Publicar fluxo" (src/modules/platform/n8n-publish.ts) contra Postgres real — o armazenamento
 * de versão/hash/snapshot em PlatformSettings — com `fetch` simulando só GET/PUT de workflow.
 * A lógica (drift, rollback, verificação) é coberta em `__tests__/n8n-publish.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import type { N8nNode, N8nWorkflow } from "@/modules/platform/n8n-client";

const prisma = getPrisma();
const N8N_BASE_URL = "https://n8n.example.test";
const WEBHOOK_ID = ["it", "webhook", randomUUID().slice(0, 8)].join("-");

let liveWorkflow: N8nWorkflow;

function stubFetch() {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const match = url.pathname.match(/^\/api\/v1\/workflows\/([^/]+)$/);
    if (!match || match[1] !== "wf-bot-it") throw new Error(`fake n8n: rota não simulada ${method} ${url.pathname}`);
    if (method === "GET") return new Response(JSON.stringify(liveWorkflow), { status: 200 });
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body)) as Pick<N8nWorkflow, "name" | "nodes" | "connections" | "settings">;
      liveWorkflow = { ...liveWorkflow, ...body };
      return new Response(JSON.stringify(liveWorkflow), { status: 200 });
    }
    throw new Error(`fake n8n: método ${method}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(async () => {
  const { loadBundledBuildFlow } = await import("@/modules/platform/n8n-publish");
  const build = loadBundledBuildFlow();
  const nodes = JSON.parse(JSON.stringify(build.nodes)) as N8nNode[];
  for (const n of nodes) if (n.type === "n8n-nodes-base.webhook") n.webhookId = WEBHOOK_ID;
  (nodes.find((n) => n.name === "Claim")!.parameters as Record<string, unknown>).versaoAntiga = true;
  liveWorkflow = { id: "wf-bot-it", name: "innochat-bot", active: false, nodes, connections: build.connections, settings: {} };

  const data = {
    n8nBaseUrl: N8N_BASE_URL,
    n8nApiKey: "fake-n8n-key",
    evolutionApiUrl: "https://evolution.example.test",
    evolutionApiKey: "fake-evolution-key",
    n8nWorkflowBotId: "wf-bot-it",
    n8nWorkflowErrosId: "wf-erros-it",
    n8nCredPainelId: "c-painel",
    n8nCredEvolutionId: "c-evo",
    n8nCredApiId: "c-n8n",
    n8nBotFlowVersion: null,
    n8nBotFlowHash: null,
    n8nBotFlowPublishedAt: null,
    n8nBotFlowPublishedByUserId: null,
  };
  await prisma.platformSettings.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
  await prisma.platformSettings.update({ where: { id: 1 }, data: { n8nBotFlowPrevious: (await import("@prisma/client")).Prisma.JsonNull } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("publicar fluxo — persistência em PlatformSettings", () => {
  it("publica, grava versão/hash/snapshot, detecta edição à mão e volta 1 versão", async () => {
    const { publishBotFlow, rollbackBotFlow, getBotFlowStatus, loadBundledBuildFlow } = await import("@/modules/platform/n8n-publish");
    const { canonicalFlowHash } = await import("@/modules/platform/n8n-flow-hash");
    stubFetch();
    const build = loadBundledBuildFlow();
    const originalHash = canonicalFlowHash(liveWorkflow.nodes, liveWorkflow.connections);
    const admin = await prisma.user.create({ data: { email: `it-publish-${randomUUID().slice(0, 8)}@example.com`, passwordHash: "x", isPlatformAdmin: true, totpSecretEnc: "enc:v1:x", totpEnabledAt: new Date() } });

    try {
      const first = await getBotFlowStatus();
      expect(first).toMatchObject({ firstPublish: true, n8nReachable: true, drift: false, updateAvailable: true });

      const result = await publishBotFlow(admin.id, "PUBLICAR");
      expect(result).toMatchObject({ hash: build.hash, rolledBack: false });
      const row = await prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 } });
      expect(row).toMatchObject({ n8nBotFlowHash: build.hash, n8nBotFlowVersion: build.version, n8nBotFlowPublishedByUserId: admin.id });
      expect((row.n8nBotFlowPrevious as { hash: string }).hash).toBe(originalHash);
      expect(liveWorkflow.nodes.find((n) => n.type === "n8n-nodes-base.webhook")!.webhookId).toBe(WEBHOOK_ID);
      expect(liveWorkflow.settings?.errorWorkflow).toBe("wf-erros-it");

      (liveWorkflow.nodes[1]!.parameters as Record<string, unknown>).editadoAMao = 1;
      expect(await getBotFlowStatus()).toMatchObject({ drift: true, canRollback: true });
      await expect(publishBotFlow(admin.id)).rejects.toMatchObject({ code: "FLOW_DRIFT" });

      const back = await rollbackBotFlow(admin.id);
      expect(back).toMatchObject({ hash: originalHash, rolledBack: true });
      const after = await prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 } });
      expect(after.n8nBotFlowHash).toBe(originalHash);
      expect(after.n8nBotFlowPrevious).toEqual({}); // sem versão anterior
      expect((await getBotFlowStatus()).canRollback).toBe(false);
    } finally {
      await prisma.user.delete({ where: { id: admin.id } });
    }
  });
});
