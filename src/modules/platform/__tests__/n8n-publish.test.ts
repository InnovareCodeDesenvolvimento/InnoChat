import { describe, expect, it } from "vitest";
import { DomainError } from "@/lib/errors";
import type { N8nClient, N8nNode, N8nWorkflow } from "../n8n-client";
import { FLOW_VERSIONS } from "../flow-versions";
import { canonicalFlowHash } from "../n8n-flow-hash";
import {
  createFlowPublisher,
  loadBundledBuildFlow,
  type BuildFlow,
  type FlowSnapshot,
  type PublishContext,
  type PublishStore,
} from "../n8n-publish";

// Ids/segredos falsos, montados por junção (nada que pareça segredo literal no código).
const LIVE_WEBHOOK_ID = ["live", "webhook", "id"].join("-");
const LIVE_WAIT_ID = ["live", "wait", "id"].join("-");
const CRED = { painel: ["cred", "painel"].join("-"), evolution: ["cred", "evo"].join("-"), n8n: ["cred", "n8n"].join("-") };
const ERROS_ID = ["erros", "wf"].join("-");
const PAINEL_URL = "https://painel.example.test/api/internal/v1";
const EVOLUTION_URL = "https://evolution.example.test";
const N8N_API_URL = "https://n8n.example.test/api/v1";

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function setConfig(nodes: N8nNode[], name: string, value: string) {
  const config = nodes.find((n) => n.name === "Config")!;
  const a = (config.parameters as { assignments: { assignments: Array<{ name: string; value: unknown }> } }).assignments.assignments.find((x) => x.name === name)!;
  a.value = value;
}

/** O vivo antes da 1ª publicação: fluxo "velho" (um parâmetro diferente) com as marcas da instalação. */
function makeLive(build: BuildFlow): N8nWorkflow {
  const nodes = clone(build.nodes);
  for (const n of nodes) {
    if (n.type === "n8n-nodes-base.webhook") n.webhookId = LIVE_WEBHOOK_ID;
    if (n.name === "Esperar") n.webhookId = LIVE_WAIT_ID;
    if (n.type === "n8n-nodes-base.httpRequest" && n.parameters?.authentication === "genericCredentialType") {
      n.credentials = { httpHeaderAuth: { id: "velha", name: "velha" } };
    }
  }
  setConfig(nodes, "painelUrl", PAINEL_URL);
  setConfig(nodes, "evolutionUrl", EVOLUTION_URL);
  const claim = nodes.find((n) => n.name === "Claim")!;
  (claim.parameters as Record<string, unknown>).timeoutVelho = 1; // versão antiga do fluxo
  return { id: "wf-bot", name: "innochat-bot", active: true, nodes, connections: clone(build.connections), settings: { executionOrder: "v1", errorWorkflow: "outro" } };
}

type FakeOptions = { corruptOnPut?: (wf: N8nWorkflow, putCount: number) => void; failPutAt?: number };

function createFakeN8n(initial: N8nWorkflow, options: FakeOptions = {}) {
  let wf = clone(initial);
  const puts: Array<{ nodes: N8nNode[]; settings?: Record<string, unknown> }> = [];
  const client: N8nClient = {
    async getWorkflow() {
      return clone(wf);
    },
    async updateWorkflow(_id, body) {
      puts.push(clone(body));
      if (options.failPutAt === puts.length) throw new Error("n8n caiu");
      wf = { ...wf, ...clone(body) };
      options.corruptOnPut?.(wf, puts.length);
      return clone(wf);
    },
    async createCredential() { throw new Error("não usado"); },
    async updateCredential() { throw new Error("não usado"); },
    async deleteCredential() { throw new Error("não usado"); },
    async listWorkflows() { return [clone(wf)]; },
    async activateWorkflow() { throw new Error("não usado"); },
    async deactivateWorkflow() { throw new Error("não usado"); },
  };
  return { client, puts, get live() { return wf; }, edit(fn: (w: N8nWorkflow) => void) { fn(wf); } };
}

function createMemoryStore() {
  const state: { version: string | null; hash: string | null; publishedAt: Date | null; previous: FlowSnapshot | null; userId: string | null } = {
    version: null, hash: null, publishedAt: null, previous: null, userId: null,
  };
  const store: PublishStore = {
    async load() { return { version: state.version, hash: state.hash, publishedAt: state.publishedAt, previous: state.previous ? clone(state.previous) : null }; },
    async setPrevious(s) { state.previous = s ? clone(s) : null; },
    async savePublished(i) { Object.assign(state, { version: i.version, hash: i.hash, publishedAt: i.publishedAt, userId: i.userId, previous: i.previous ? clone(i.previous) : null }); },
  };
  return { store, state };
}

function setup(options: FakeOptions = {}, contextOverride: Partial<PublishContext> = {}) {
  const build = loadBundledBuildFlow();
  const fake = createFakeN8n(makeLive(build), options);
  const mem = createMemoryStore();
  const context: PublishContext = {
    client: fake.client,
    botWorkflowId: "wf-bot",
    errosWorkflowId: ERROS_ID,
    credentialIds: CRED,
    painelUrl: PAINEL_URL,
    evolutionUrl: EVOLUTION_URL,
    n8nApiUrl: N8N_API_URL,
    ...contextOverride,
  };
  const publisher = createFlowPublisher({ store: mem.store, context, build });
  return { build, fake, mem, publisher };
}

async function codeOf(promise: Promise<unknown>): Promise<{ code: string; details?: unknown }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return { code: error.code, details: error.details };
    throw error;
  }
  throw new Error("esperava um DomainError");
}

describe("bundle", () => {
  it("o JSON do bot está empacotado no código (não lido de disco) e tem hash e versão", () => {
    const build = loadBundledBuildFlow();
    expect(build.nodes.some((n) => n.name === "Webhook")).toBe(true);
    expect(build.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(build.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("publicar (CA-46)", () => {
  it("1ª publicação exige PUBLICAR e não escreve nada sem ele", async () => {
    const { publisher, fake, mem } = setup();
    expect((await codeOf(publisher.publish("u1"))).code).toBe("CONFIRMATION_REQUIRED");
    expect(fake.puts).toHaveLength(0);
    expect(mem.state.hash).toBeNull();
  });

  it("merge preserva webhookId (Webhook e Esperar), path, credenciais, Config e errorWorkflow; grava versão/hash/autor e o snapshot", async () => {
    const { publisher, fake, mem, build } = setup();
    const before = fake.live;
    const beforePath = (before.nodes.find((n) => n.name === "Webhook")!.parameters as { path: string }).path;

    const result = await publisher.publish("u1", "PUBLICAR");
    expect(result).toMatchObject({ version: build.version, hash: build.hash, rolledBack: false });

    const after = fake.live;
    const webhook = after.nodes.find((n) => n.name === "Webhook")!;
    expect(webhook.webhookId).toBe(LIVE_WEBHOOK_ID);
    expect((webhook.parameters as { path: string }).path).toBe(beforePath);
    expect(after.nodes.find((n) => n.name === "Esperar")!.webhookId).toBe(LIVE_WAIT_ID);

    const claim = after.nodes.find((n) => n.name === "Claim")!;
    expect(claim.credentials?.httpHeaderAuth.id).toBe(CRED.painel);
    expect(after.nodes.find((n) => n.name === "Enviar pela Evolution")!.credentials?.httpHeaderAuth.id).toBe(CRED.evolution);
    expect((claim.parameters as Record<string, unknown>).timeoutVelho).toBeUndefined(); // fluxo novo aplicado

    const cfg = JSON.stringify(after.nodes.find((n) => n.name === "Config")!.parameters);
    expect(cfg).toContain(PAINEL_URL);
    expect(cfg).toContain(EVOLUTION_URL);
    expect(cfg).not.toContain("A_DEFINIR");
    expect(after.settings?.errorWorkflow).toBe(ERROS_ID);
    expect(after.settings?.executionOrder).toBe("v1"); // resto do settings vivo intocado

    expect(canonicalFlowHash(after.nodes, after.connections)).toBe(build.hash);
    expect(mem.state).toMatchObject({ version: build.version, hash: build.hash, userId: "u1" });
    expect(mem.state.previous).not.toBeNull();
  });

  it("publicar de novo o que já está publicado não regrava (e não apaga o 'voltar')", async () => {
    const { publisher, fake, mem } = setup();
    await publisher.publish("u1", "PUBLICAR");
    const previous = mem.state.previous;
    const putsBefore = fake.puts.length;
    const again = await publisher.publish("u1");
    expect(again.rolledBack).toBe(false);
    expect(fake.puts).toHaveLength(putsBefore);
    expect(mem.state.previous).toEqual(previous);
  });

  it("edição à mão no n8n → FLOW_DRIFT (sem escrever); SOBRESCREVER publica", async () => {
    const { publisher, fake, build, mem } = setup();
    await publisher.publish("u1", "PUBLICAR");
    fake.edit((w) => {
      (w.nodes.find((n) => n.name === "Claim")!.parameters as Record<string, unknown>).editadoAMao = true;
    });
    const putsBefore = fake.puts.length;

    const status = await publisher.getStatus();
    expect(status.drift).toBe(true);
    expect(status.liveHash).not.toBe(status.publishedHash);

    const err = await codeOf(publisher.publish("u1"));
    expect(err.code).toBe("FLOW_DRIFT");
    expect(err.details).toEqual({ liveHash: status.liveHash, publishedHash: build.hash });
    expect((await codeOf(publisher.publish("u1", "PUBLICAR"))).code).toBe("FLOW_DRIFT"); // PUBLICAR não basta
    expect(fake.puts).toHaveLength(putsBefore);

    await publisher.publish("u1", "SOBRESCREVER");
    expect(canonicalFlowHash(fake.live.nodes, fake.live.connections)).toBe(build.hash);
    expect(mem.state.previous!.version).toContain("editado no n8n"); // a edição fica guardada para o "voltar"
  });

  it("rollback restaura o mesmo hash da versão anterior, preserva webhookId/credenciais e zera o 'voltar'", async () => {
    const { publisher, fake, mem, build } = setup();
    const originalHash = canonicalFlowHash(fake.live.nodes, fake.live.connections);
    await publisher.publish("u1", "PUBLICAR");
    expect((await publisher.getStatus()).canRollback).toBe(true);

    const result = await publisher.rollback("u1");
    expect(result.rolledBack).toBe(true);
    expect(result.hash).toBe(originalHash);
    expect(canonicalFlowHash(fake.live.nodes, fake.live.connections)).toBe(originalHash);
    expect(fake.live.nodes.find((n) => n.name === "Webhook")!.webhookId).toBe(LIVE_WEBHOOK_ID);
    expect(fake.live.nodes.find((n) => n.name === "Claim")!.credentials?.httpHeaderAuth.id).toBe(CRED.painel);
    expect(fake.live.settings?.errorWorkflow).toBe(ERROS_ID);
    expect(mem.state).toMatchObject({ hash: originalHash, previous: null });

    const status = await publisher.getStatus();
    expect(status.canRollback).toBe(false);
    expect(status.updateAvailable).toBe(build.hash !== originalHash);
    expect((await codeOf(publisher.rollback("u1"))).code).toBe("NO_SNAPSHOT");
  });

  it("verificação divergente → o painel volta sozinho ao fluxo anterior e devolve PUBLISH_VERIFY_FAILED", async () => {
    const { publisher, fake, mem } = setup({
      // n8n "engole" um parâmetro no primeiro PUT (o do publicar); no PUT de restauração grava certo.
      corruptOnPut: (wf, count) => {
        if (count === 1) (wf.nodes.find((n) => n.name === "Claim")!.parameters as Record<string, unknown>).corrompido = true;
      },
    });
    const originalHash = canonicalFlowHash(fake.live.nodes, fake.live.connections);

    const err = await codeOf(publisher.publish("u1", "PUBLICAR"));
    expect(err).toEqual({ code: "PUBLISH_VERIFY_FAILED", details: { restored: true } });
    expect(canonicalFlowHash(fake.live.nodes, fake.live.connections)).toBe(originalHash);
    expect(mem.state.hash).toBeNull(); // nada foi registrado como publicado
    expect(mem.state.previous).toBeNull();
  });

  it("webhookId trocado pelo n8n na gravação também é reprovado na verificação", async () => {
    const { publisher, fake } = setup({
      corruptOnPut: (wf, count) => {
        if (count === 1) wf.nodes.find((n) => n.name === "Webhook")!.webhookId = "outro-id";
      },
    });
    expect((await codeOf(publisher.publish("u1", "PUBLICAR"))).code).toBe("PUBLISH_VERIFY_FAILED");
    expect(fake.live.nodes.find((n) => n.name === "Webhook")!.webhookId).toBe(LIVE_WEBHOOK_ID);
  });

  it("path do Webhook diferente do vivo → WEBHOOK_PATH_CHANGED, sem escrever nada", async () => {
    const { publisher, fake, mem } = setup();
    fake.edit((w) => {
      (w.nodes.find((n) => n.name === "Webhook")!.parameters as { path: string }).path = "innochat/outro/:token";
    });
    const err = await codeOf(publisher.publish("u1", "PUBLICAR"));
    expect(err.code).toBe("WEBHOOK_PATH_CHANGED");
    expect(fake.puts).toHaveLength(0);
    expect(mem.state.previous).toBeNull();
  });

  it("PUT que falha mantém o snapshot anterior e nada é registrado", async () => {
    const { publisher, mem } = setup({ failPutAt: 1 });
    expect((await codeOf(publisher.publish("u1", "PUBLICAR"))).code).toBe("N8N_UNREACHABLE");
    expect(mem.state.hash).toBeNull();
    expect(mem.state.previous).toBeNull();
  });

  it("sem sincronização do n8n (ids ausentes) → N8N_NOT_SYNCED", async () => {
    const semCreds = setup({}, { credentialIds: null });
    expect((await codeOf(semCreds.publisher.publish("u1", "PUBLICAR"))).code).toBe("N8N_NOT_SYNCED");
    expect(semCreds.fake.puts).toHaveLength(0);
    const semBot = setup({}, { botWorkflowId: null });
    expect((await codeOf(semBot.publisher.publish("u1", "PUBLICAR"))).code).toBe("N8N_NOT_SYNCED");
  });
});

describe("status e download", () => {
  it("antes da 1ª publicação: firstPublish, sem drift, atualização disponível", async () => {
    const { publisher, build } = setup();
    const status = await publisher.getStatus();
    expect(status).toMatchObject({ firstPublish: true, drift: false, updateAvailable: true, canRollback: false, n8nReachable: true, buildHash: build.hash, publishedHash: null });
  });

  it("n8n fora do ar → n8nReachable=false com erro legível", async () => {
    const { publisher } = setup({}, { botWorkflowId: null });
    const status = await publisher.getStatus();
    expect(status.n8nReachable).toBe(false);
    expect(status.liveHash).toBeNull();
    expect(status.error).toMatch(/Sincronize/);
  });

  it("token colado à mão num nó do vivo não vai para o snapshot do banco nem para o download (I4)", async () => {
    const fakeToken = ["colado", "a", "mao", "123456"].join("-");
    const { publisher, fake, mem } = setup();
    fake.edit((w) => {
      const claim = w.nodes.find((n) => n.name === "Claim")!;
      (claim.parameters as Record<string, unknown>).headerParameters = { parameters: [{ name: "Authorization", value: `Bearer ${fakeToken}` }] };
    });
    await publisher.publish("u1", "PUBLICAR");
    expect(JSON.stringify(mem.state.previous)).not.toContain(fakeToken);
    expect(JSON.stringify(mem.state.previous)).toContain("[REDACTED]");
    fake.edit((w) => {
      const claim = w.nodes.find((n) => n.name === "Claim")!;
      (claim.parameters as Record<string, unknown>).headerParameters = { parameters: [{ name: "apikey", value: fakeToken }] };
    });
    const { json } = await publisher.downloadLive();
    expect(json).not.toContain(fakeToken);
  });

  it("download do vivo sai sem credenciais nem pinData", async () => {
    const { publisher, fake } = setup();
    fake.edit((w) => {
      (w.nodes[0] as N8nNode & { pinData?: unknown }).pinData = [{ json: { conversa: "oi" } }];
    });
    await publisher.publish("u1", "PUBLICAR");
    const { filename, json } = await publisher.downloadLive();
    expect(filename).toMatch(/^innochat-bot-vivo-[0-9a-f]{8}\.json$/);
    expect(json).not.toContain("credentials");
    expect(json).not.toContain(CRED.painel);
    expect(json).not.toContain("pinData");
    expect(JSON.parse(json).nodes.length).toBeGreaterThan(5);
  });
});

describe("versão do fluxo (publicado como 2.0.0 com o conteúdo novo)", () => {
  /** O que o dono fez em produção: publicou o conteúdo atual ainda rotulado com a versão antiga. */
  async function publishedWithOldLabel() {
    const real = loadBundledBuildFlow();
    const nodes = clone(real.nodes);
    setConfig(nodes, "flowVersion", "2.0.0");
    const oldLabel: BuildFlow = { version: "2.0.0", hash: canonicalFlowHash(nodes, real.connections), nodes, connections: clone(real.connections) };
    const fake = createFakeN8n(makeLive(real));
    const mem = createMemoryStore();
    const context: PublishContext = {
      client: fake.client, botWorkflowId: "wf-bot", errosWorkflowId: ERROS_ID, credentialIds: CRED,
      painelUrl: PAINEL_URL, evolutionUrl: EVOLUTION_URL, n8nApiUrl: N8N_API_URL,
    };
    await createFlowPublisher({ store: mem.store, context, build: oldLabel }).publish("u1", "PUBLICAR");
    const publisher = createFlowPublisher({ store: mem.store, context, build: real });
    return { real, fake, mem, publisher };
  }

  it("a versão do sistema é a mais recente do histórico (n8n/flow-versions.json)", () => {
    expect(loadBundledBuildFlow().version).toBe(FLOW_VERSIONS[0]!.version);
  });

  it("status: sem edição manual, mostra o que mudou e avisa que só o número difere", async () => {
    const { real, publisher } = await publishedWithOldLabel();
    const status = await publisher.getStatus();
    expect(status).toMatchObject({
      buildVersion: real.version,
      publishedVersion: "2.0.0",
      drift: false,
      updateAvailable: true,
      onlyVersionLabelDiffers: true,
    });
    expect(status.changes.map((c) => c.version)).toEqual(["2.1.0"]);
    expect(status.changes[0]!.changes.length).toBeGreaterThan(0);
  });

  it("publicar a versão nova funciona sem confirmação, grava a versão e deixa o status em dia", async () => {
    const { real, publisher, mem } = await publishedWithOldLabel();
    const result = await publisher.publish("u1");
    expect(result).toMatchObject({ version: real.version, hash: real.hash, rolledBack: false });
    expect(mem.state.version).toBe(real.version);
    expect(mem.state.previous?.version).toBe("2.0.0");
    const status = await publisher.getStatus();
    expect(status).toMatchObject({ drift: false, updateAvailable: false, onlyVersionLabelDiffers: false, changes: [] });
  });

  it("editado à mão com a mesma versão continua acusando drift", async () => {
    const { fake, publisher } = await publishedWithOldLabel();
    fake.edit((w) => {
      const claim = w.nodes.find((n) => n.name === "Claim")!;
      (claim.parameters as Record<string, unknown>).editadoNoN8n = true;
    });
    const status = await publisher.getStatus();
    expect(status.drift).toBe(true);
    expect(status.onlyVersionLabelDiffers).toBe(false);
    expect((await codeOf(publisher.publish("u1"))).code).toBe("FLOW_DRIFT");
  });

  it("nunca publicado: sem lista de mudanças", async () => {
    const { publisher } = setup();
    const status = await publisher.getStatus();
    expect(status.changes).toEqual([]);
    expect(status.onlyVersionLabelDiffers).toBe(false);
  });
});
