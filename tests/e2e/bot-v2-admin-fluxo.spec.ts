import fs from "node:fs";
import { test, expect, type Page } from "@playwright/test";
import { Prisma } from "@prisma/client";
import { OWNER_STORAGE_STATE, TENANT_B_OWNER_STORAGE_STATE } from "./fixtures/storage-state";
import { startFakeServer, type FakeRoute } from "./fixtures/fake-http-server";
import { prisma } from "./fixtures/db";
import { canonicalFlowHash } from "../../src/modules/platform/n8n-flow-hash";

/**
 * Admin → Configurações → "Fluxo do bot" (bot v2, D-1/L-4): publicar o `innochat-bot.json` que vem
 * no build para o n8n sem perder o que é da instalação (webhookId, credenciais, errorWorkflow),
 * confirmações digitadas (PUBLICAR / SOBRESCREVER / VOLTAR), edição manual no n8n (drift),
 * rollback de 1 versão e falhas do n8n.
 *
 * O n8n é FALSO e com estado (`fake-http-server`): guarda o workflow que recebe no PUT, então o que
 * a spec afirma é o que ficou "gravado no n8n" de verdade, não só o que a tela diz. Nada disto toca
 * um n8n real. As configurações de n8n do `PlatformSettings` são restauradas no `afterAll`.
 *
 * O n8n vivo começa como o fluxo v1 (`n8n/legacy/innochat-bot.v1.json`) com um `webhookId` próprio
 * da "instalação" — o publish do v2 precisa manter esse id, não trocar pelo do JSON do build.
 */
test.use({ storageState: OWNER_STORAGE_STATE });
test.describe.configure({ mode: "serial" });
test.setTimeout(60_000);

const LIVE_WEBHOOK_ID = "wh-e2e-live-installation-id";
const LIVE_WAIT_ID = "wait-e2e-live-installation-id";
const WORKFLOW_ID = "bot-e2e-1";
const ERROS_ID = "erros-e2e-1";
const N8N_KEY = "n8n-key-fluxo-e2e";

type Node = { name: string; type: string; parameters?: Record<string, unknown>; webhookId?: string; credentials?: unknown };
type Workflow = { id: string; name: string; active: boolean; nodes: Node[]; connections: Record<string, unknown>; settings: Record<string, unknown> };

const buildFile = JSON.parse(fs.readFileSync("./n8n/innochat-bot.json", "utf-8")) as { nodes: Node[]; connections: Record<string, unknown> };
const legacyFile = JSON.parse(fs.readFileSync("./n8n/legacy/innochat-bot.v1.json", "utf-8")) as { nodes: Node[]; connections: Record<string, unknown> };
const BUILD_HASH = canonicalFlowHash(buildFile.nodes as never, buildFile.connections);
const LEGACY_HASH = canonicalFlowHash(legacyFile.nodes as never, legacyFile.connections);

const live: Workflow = { id: WORKFLOW_ID, name: "innochat-bot", active: false, nodes: [], connections: {}, settings: {} };
const faults = { getStatus: 0, corruptNextPut: false };
let puts = 0;

function resetLive() {
  live.nodes = structuredClone(legacyFile.nodes);
  live.connections = structuredClone(legacyFile.connections);
  live.settings = {};
  for (const node of live.nodes) {
    if (node.type === "n8n-nodes-base.webhook") node.webhookId = LIVE_WEBHOOK_ID;
    if (node.name === "Esperar") node.webhookId = LIVE_WAIT_ID;
  }
  faults.getStatus = 0;
  faults.corruptNextPut = false;
  puts = 0;
}
const liveHash = () => canonicalFlowHash(live.nodes as never, live.connections);
const liveWebhook = () => live.nodes.find((n) => n.type === "n8n-nodes-base.webhook")!;

const routes: FakeRoute[] = [
  {
    method: "GET",
    path: `/api/v1/workflows/${WORKFLOW_ID}`,
    handler: () => (faults.getStatus ? { status: faults.getStatus, body: { message: "falha injetada" } } : { status: 200, body: live }),
  },
  {
    method: "PUT",
    path: `/api/v1/workflows/${WORKFLOW_ID}`,
    handler: ({ body }) => {
      puts += 1;
      const sent = body as { name: string; nodes: Node[]; connections: Record<string, unknown>; settings: Record<string, unknown> };
      live.name = sent.name;
      live.nodes = structuredClone(sent.nodes);
      live.connections = structuredClone(sent.connections);
      live.settings = structuredClone(sent.settings);
      if (faults.corruptNextPut) {
        // Simula um n8n que grava algo diferente do que recebeu (o publisher precisa perceber e desfazer).
        faults.corruptNextPut = false;
        const code = live.nodes.find((n) => n.type === "n8n-nodes-base.code");
        if (code) code.parameters = { ...(code.parameters ?? {}), jsCode: "// corrompido pelo n8n falso" };
      }
      return { status: 200, body: live };
    },
  },
];

type SettingsSnapshot = Awaited<ReturnType<typeof readSettings>>;
async function readSettings() {
  return prisma.platformSettings.findUnique({
    where: { id: 1 },
    select: {
      n8nBaseUrl: true,
      n8nApiKey: true,
      n8nWorkflowBotId: true,
      n8nWorkflowErrosId: true,
      n8nCredPainelId: true,
      n8nCredEvolutionId: true,
      n8nCredApiId: true,
      n8nBotFlowVersion: true,
      n8nBotFlowHash: true,
      n8nBotFlowPublishedAt: true,
      n8nBotFlowPublishedByUserId: true,
    },
  });
}

async function resetPublishState() {
  await prisma.platformSettings.update({
    where: { id: 1 },
    data: {
      n8nBotFlowVersion: null,
      n8nBotFlowHash: null,
      n8nBotFlowPublishedAt: null,
      n8nBotFlowPublishedByUserId: null,
      n8nBotFlowPrevious: Prisma.DbNull,
    },
  });
}

let fake: Awaited<ReturnType<typeof startFakeServer>>;
let original: SettingsSnapshot;
let originalPrevious: Prisma.JsonValue | null = null;

test.beforeAll(async ({ browser }) => {
  fake = await startFakeServer(routes);
  await prisma.platformSettings.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
  original = await readSettings();
  originalPrevious = (await prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 }, select: { n8nBotFlowPrevious: true } })).n8nBotFlowPrevious;

  // A chave do n8n é cifrada no banco: salva pela própria tela (o mesmo caminho do admin de verdade).
  const context = await browser.newContext({ storageState: OWNER_STORAGE_STATE, baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000" });
  const page = await context.newPage();
  try {
    await page.goto("/admin/configuracoes");
    await page.getByLabel("URL do n8n").fill(fake.url);
    await page.getByLabel("Chave da API do n8n").fill(N8N_KEY);
    await page.getByLabel("URL base de webhook do n8n", { exact: true }).fill(`${fake.url}/webhook`);
    await page.getByRole("button", { name: "Salvar" }).nth(1).click();
    await expect(page.getByText("n8n salvo.").first()).toBeVisible();
  } finally {
    await context.close();
  }
  // Ids que a "Sincronizar n8n" gravaria (a sincronização em si já tem spec própria).
  await prisma.platformSettings.update({
    where: { id: 1 },
    data: { n8nWorkflowBotId: WORKFLOW_ID, n8nWorkflowErrosId: ERROS_ID, n8nCredPainelId: "cred-p", n8nCredEvolutionId: "cred-e", n8nCredApiId: "cred-n" },
  });
});

test.afterAll(async () => {
  await fake?.close();
  await prisma.platformSettings.update({
    where: { id: 1 },
    data: {
      ...original,
      n8nBotFlowPrevious: originalPrevious === null ? Prisma.DbNull : (originalPrevious as Prisma.InputJsonValue),
    },
  });
});

test.beforeEach(async () => {
  resetLive();
  await resetPublishState();
});

async function openCard(page: Page) {
  await page.goto("/admin/configuracoes");
  const card = page.getByTestId("bot-flow-card");
  await expect(card.getByText("Versão do sistema")).toBeVisible();
  return card;
}

async function typeConfirm(page: Page, word: string, buttonName: string) {
  const dialog = page.getByRole("dialog");
  const confirm = dialog.getByRole("button", { name: buttonName, exact: true });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(`Digite ${word} para confirmar`).fill(word);
  await expect(confirm).toBeEnabled();
  return { dialog, confirm };
}

async function firstPublish(page: Page) {
  const card = await openCard(page);
  await card.getByRole("button", { name: "Publicar fluxo" }).click();
  const { confirm } = await typeConfirm(page, "PUBLICAR", "Publicar fluxo");
  await confirm.click();
  await expect(card.getByText("Fluxo publicado: versão 2.0.0 no ar no n8n.")).toBeVisible();
  return card;
}

test.describe("Fluxo do bot (admin da plataforma)", () => {
  test("nunca publicado: mostra a versão do sistema, o aviso e pede confirmação", async ({ page }) => {
    const card = await openCard(page);
    await expect(card.getByText("Nunca publicado").first()).toBeVisible();
    await expect(card.getByText("Ainda não foi publicado por aqui")).toBeVisible();
    await expect(card.getByText("2.0.0", { exact: true })).toBeVisible(); // versão do sistema = Config.flowVersion do build
    await expect(card.getByRole("button", { name: "Voltar à versão anterior" })).toHaveCount(0);
    expect(puts).toBe(0);
  });

  test("1ª publicação: exige digitar PUBLICAR (minúsculas não valem) e grava o v2 mantendo o que é da instalação", async ({ page }) => {
    const card = await openCard(page);
    await card.getByRole("button", { name: "Publicar fluxo" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Publicar o fluxo pela primeira vez")).toBeVisible();
    const confirm = dialog.getByRole("button", { name: "Publicar fluxo", exact: true });
    await dialog.getByLabel("Digite PUBLICAR para confirmar").fill("publicar");
    await expect(confirm).toBeDisabled();
    expect(puts).toBe(0);
    await dialog.getByLabel("Digite PUBLICAR para confirmar").fill("PUBLICAR");
    await confirm.click();

    await expect(card.getByText("Fluxo publicado: versão 2.0.0 no ar no n8n.")).toBeVisible();
    await expect(card.getByText("Já está atualizado").first()).toBeVisible();

    // O que ficou GRAVADO no n8n falso:
    expect(puts).toBe(1);
    expect(liveHash()).toBe(BUILD_HASH);
    expect(live.nodes).toHaveLength(buildFile.nodes.length);
    expect(liveWebhook().webhookId).toBe(LIVE_WEBHOOK_ID); // NÃO troca pelo id do JSON do build
    expect(live.nodes.find((n) => n.name === "Esperar")?.webhookId).toBe(LIVE_WAIT_ID);
    expect(live.settings.errorWorkflow).toBe(ERROS_ID);
    const credentialed = live.nodes.filter((n) => n.credentials);
    expect(credentialed.length).toBeGreaterThan(0);
    expect(JSON.stringify(credentialed)).toContain("cred-"); // religadas às credenciais da instalação
    const config = live.nodes.find((n) => n.name === "Config")!;
    const painelUrl = (config.parameters as { assignments: { assignments: { name: string; value: string }[] } }).assignments.assignments.find((a) => a.name === "painelUrl")!.value;
    expect(painelUrl).toMatch(/\/api\/internal\/v1$/);

    const row = await prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 }, select: { n8nBotFlowVersion: true, n8nBotFlowHash: true } });
    expect(row).toEqual({ n8nBotFlowVersion: "2.0.0", n8nBotFlowHash: BUILD_HASH });
    // A cópia do v1 fica guardada para o "voltar".
    await expect(card.getByText(/Versão anterior guardada/)).toBeVisible();
  });

  test("já atualizado: 'Publicar fluxo' fica desabilitado e nada é regravado", async ({ page }) => {
    const card = await firstPublish(page);
    await expect(card.getByRole("button", { name: "Publicar fluxo" })).toBeDisabled();
    await card.getByRole("button", { name: "Consultar de novo" }).click();
    await expect(card.getByText("Já está atualizado").first()).toBeVisible();
    expect(puts).toBe(1);
  });

  test("voltar à versão anterior: exige VOLTAR, restaura o v1 no n8n (mesmo hash) e só volta 1 versão", async ({ page }) => {
    const card = await firstPublish(page);
    expect(liveHash()).toBe(BUILD_HASH);

    await card.getByRole("button", { name: "Voltar à versão anterior" }).click();
    const { confirm } = await typeConfirm(page, "VOLTAR", "Voltar versão");
    await confirm.click();

    await expect(card.getByText(/^Voltou para a versão/)).toBeVisible();
    expect(liveHash()).toBe(LEGACY_HASH); // o MESMO fluxo de antes, não "parecido"
    expect(live.nodes).toHaveLength(legacyFile.nodes.length);
    expect(liveWebhook().webhookId).toBe(LIVE_WEBHOOK_ID);
    // Depois de voltar, não há outra versão guardada e o sistema volta a oferecer a nova.
    await expect(card.getByRole("button", { name: "Voltar à versão anterior" })).toHaveCount(0);
    await expect(card.getByText("Nova versão disponível").first()).toBeVisible();
    const row = await prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 }, select: { n8nBotFlowHash: true } });
    expect(row.n8nBotFlowHash).toBe(LEGACY_HASH);
  });

  test("edição manual no n8n (drift): avisa, some o Publicar, baixa o fluxo vivo sem credenciais e só sobrescreve digitando SOBRESCREVER", async ({ page }) => {
    const card = await firstPublish(page);
    const before = puts;

    // Alguém edita à mão no n8n: muda um nó e liga uma credencial "literal" no vivo.
    const code = live.nodes.find((n) => n.type === "n8n-nodes-base.code")!;
    code.parameters = { ...(code.parameters ?? {}), jsCode: "// EDITADO A MAO NO N8N" };
    const edited = liveHash();
    expect(edited).not.toBe(BUILD_HASH);

    await card.getByRole("button", { name: "Consultar de novo" }).click();
    await expect(card.getByText("Editado no n8n").first()).toBeVisible();
    await expect(card.getByText("Alguém editou o fluxo direto no n8n")).toBeVisible();
    await expect(card.getByRole("button", { name: "Publicar fluxo" })).toHaveCount(0); // sem atalho para sobrescrever sem querer

    // Baixar o vivo: arquivo com a edição, sem credenciais nem pinData.
    const downloadPromise = page.waitForEvent("download");
    await card.getByRole("button", { name: "Baixar o fluxo atual" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^innochat-bot-vivo-[0-9a-f]{8}\.json$/);
    const downloaded = fs.readFileSync((await download.path())!, "utf-8");
    expect(downloaded).toContain("EDITADO A MAO NO N8N");
    expect(downloaded).not.toMatch(/"credentials"|"pinData"/);

    // Sobrescrever: confirmação digitada; a edição é descartada.
    await card.getByRole("button", { name: "Sobrescrever", exact: true }).click();
    const { confirm } = await typeConfirm(page, "SOBRESCREVER", "Sobrescrever");
    expect(puts).toBe(before); // nada foi gravado antes de confirmar
    await confirm.click();
    await expect(card.getByText("Fluxo publicado: versão 2.0.0 no ar no n8n.")).toBeVisible();
    expect(liveHash()).toBe(BUILD_HASH);
    expect(JSON.stringify(live.nodes)).not.toContain("EDITADO A MAO NO N8N");
    expect(liveWebhook().webhookId).toBe(LIVE_WEBHOOK_ID);
  });

  test("webhook com path diferente no n8n: recusa antes de escrever (nada é gravado)", async ({ page }) => {
    liveWebhook().parameters = { ...(liveWebhook().parameters ?? {}), path: "outro/caminho/:token" };
    const card = await openCard(page);
    await card.getByRole("button", { name: "Publicar fluxo" }).click();
    const { confirm } = await typeConfirm(page, "PUBLICAR", "Publicar fluxo");
    await confirm.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/O path do Webhook mudou/)).toBeVisible();
    expect(puts).toBe(0);
    const row = await prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 }, select: { n8nBotFlowHash: true } });
    expect(row.n8nBotFlowHash).toBeNull();
  });

  test("n8n grava algo diferente do enviado: a publicação é desfeita e o fluxo anterior volta", async ({ page }) => {
    faults.corruptNextPut = true;
    const before = liveHash();
    const card = await openCard(page);
    await card.getByRole("button", { name: "Publicar fluxo" }).click();
    const { confirm } = await typeConfirm(page, "PUBLICAR", "Publicar fluxo");
    await confirm.click();

    await expect(page.getByRole("dialog").getByText(/A publicação foi desfeita/)).toBeVisible();
    expect(puts).toBe(2); // o PUT do v2 + o PUT que restaura
    expect(liveHash()).toBe(before); // voltou ao fluxo de antes
    expect(liveWebhook().webhookId).toBe(LIVE_WEBHOOK_ID);
    // Nada ficou registrado como publicado.
    const row = await prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 }, select: { n8nBotFlowHash: true, n8nBotFlowVersion: true } });
    expect(row).toEqual({ n8nBotFlowHash: null, n8nBotFlowVersion: null });
  });

  test("n8n fora do ar: mostra o erro, aponta a configuração e não deixa publicar", async ({ page }) => {
    faults.getStatus = 500;
    const card = await openCard(page);
    await expect(card.getByText("n8n sem resposta")).toBeVisible();
    await expect(card.getByText("Não deu para falar com o n8n")).toBeVisible();
    await expect(card.getByRole("link", { name: /Conferir a configuração do n8n/ })).toBeVisible();
    await expect(card.getByRole("button", { name: "Publicar fluxo" })).toBeDisabled();
    expect(puts).toBe(0);

    // Voltou: "Consultar de novo" recupera sem recarregar a página.
    faults.getStatus = 0;
    await card.getByRole("button", { name: "Consultar de novo" }).click();
    await expect(card.getByText("Nunca publicado").first()).toBeVisible();
    await expect(card.getByRole("button", { name: "Publicar fluxo" })).toBeEnabled();
  });

  test("n8n sem chave configurada: o status explica o que falta", async ({ page }) => {
    const saved = await prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 }, select: { n8nApiKey: true } });
    await prisma.platformSettings.update({ where: { id: 1 }, data: { n8nApiKey: null } });
    try {
      const card = await openCard(page);
      await expect(card.getByText("n8n sem resposta")).toBeVisible();
      await expect(card.getByText(/Configure a URL e a API key do n8n/)).toBeVisible();
    } finally {
      await prisma.platformSettings.update({ where: { id: 1 }, data: { n8nApiKey: saved.n8nApiKey } });
    }
  });

  test("dono de empresa que não é admin da plataforma não vê o card", async ({ browser }) => {
    const context = await browser.newContext({ storageState: TENANT_B_OWNER_STORAGE_STATE, baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000" });
    const page = await context.newPage();
    try {
      await page.goto("/admin/configuracoes");
      await expect(page.getByTestId("bot-flow-card")).toHaveCount(0);
      // A área do admin responde 404 (não revela que existe): sem o card e sem o formulário do n8n.
      await expect(page.getByText("This page could not be found.")).toBeVisible();
      await expect(page.getByLabel("URL do n8n")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
