import { test, expect } from "@playwright/test";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";
import { startFakeServer, type FakeRoute } from "./fixtures/fake-http-server";
import { prisma } from "./fixtures/db";

/**
 * Admin → Configurações: checklist de integrações, "Testar conexão" com credenciais erradas
 * (sem vazar segredo), "Sincronizar n8n" contra um fake local, e ativar/desativar o bot com
 * confirmação. Complementa `admin-secrets.spec.ts` (que já cobre "segredo nunca volta em texto
 * puro") — aqui o foco é integração com serviços externos.
 *
 * Sessão via `storageState` (ver `admin-secrets.spec.ts` / `login_rate_limit_e2e` na memória).
 */
test.use({ storageState: OWNER_STORAGE_STATE });

test.describe("Admin da plataforma: configurações e integrações", () => {
  test("checklist do topo reflete o que já está salvo (Evolution/n8n/SMTP/Mercado Pago)", async ({ page }) => {
    await page.goto("/admin/configuracoes/geral");
    // A tela carrega o estado ATUAL do banco — só afirmamos a forma (badges presentes), sem
    // assumir um estado prévio específico (outros specs/sessões podem ter salvo credenciais).
    // `.first()`: "n8n" e "Mercado Pago" também aparecem como título de outros cartões da tela
    // (Card "n8n", Card "Mercado Pago") — o badge do checklist é o PRIMEIRO no DOM (fica no topo
    // da página, antes dos cartões de cada integração).
    await expect(page.getByText("Evolution", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("n8n", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("SMTP", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Mercado Pago", { exact: true }).first()).toBeVisible();
  });

  test("Testar conexão da Evolution com credenciais erradas: erro legível, sem vazar a chave no DOM", async ({ page }) => {
    await page.goto("/admin/configuracoes/whatsapp");
    const wrongKey = "chave-errada-e2e-nao-deve-aparecer-em-lugar-nenhum";
    const routes: FakeRoute[] = [
      {
        method: "GET",
        path: "/instance/fetchInstances",
        handler: ({ headers }) => {
          const key = headers["apikey"];
          if (key !== "chave-correta-fake") return { status: 401, body: { message: "Unauthorized" } };
          return { status: 200, body: [] };
        },
      },
    ];
    const fake = await startFakeServer(routes);
    try {
      await page.getByLabel("URL da Evolution").fill(fake.url);
      await page.getByLabel("Chave da Evolution").fill(wrongKey);
      await page.getByRole("button", { name: "Testar conexão" }).first().click();

      const status = page.getByRole("status").first();
      await expect(status).toContainText(/rejeitada|401/i);

      // O RESULTADO do teste (o "detalhe" que a Server Action devolve, docs/contratos.md —
      // "nunca o segredo de volta, nem no detalhe, nem em log") nunca ecoa a chave digitada —
      // isso é diferente de "o campo de senha ainda mostra o que a pessoa está digitando", que é
      // esperado (o campo não foi salvo, só testado; `admin-secrets.spec.ts` já cobre que o
      // valor SALVO nunca reaparece depois de recarregar a tela).
      const statusText = (await status.textContent()) ?? "";
      expect(statusText).not.toContain(wrongKey);
    } finally {
      await fake.close();
    }
  });

  test("Testar conexão da Evolution com credenciais certas: sucesso, e o resultado do teste não ecoa a chave", async ({ page }) => {
    await page.goto("/admin/configuracoes/whatsapp");
    const correctKey = "chave-correta-fake-e2e";
    const routes: FakeRoute[] = [
      {
        method: "GET",
        path: "/instance/fetchInstances",
        handler: ({ headers }) => (headers["apikey"] === correctKey ? { status: 200, body: [] } : { status: 401 }),
      },
    ];
    const fake = await startFakeServer(routes);
    try {
      await page.getByLabel("URL da Evolution").fill(fake.url);
      await page.getByLabel("Chave da Evolution").fill(correctKey);
      await page.getByRole("button", { name: "Testar conexão" }).first().click();

      const status = page.getByRole("status").first();
      await expect(status).toContainText(/Conectado/i);
      const statusText = (await status.textContent()) ?? "";
      expect(statusText).not.toContain(correctKey);
    } finally {
      await fake.close();
    }
  });

  test("Sincronizar n8n contra um fake local: credenciais criadas, workflows atualizados, nunca ativa nada", async ({ page }) => {
    await page.goto("/admin/configuracoes/whatsapp");
    const evolutionKey = "evolution-key-sync-e2e";
    const n8nKey = "n8n-key-sync-e2e";

    const evolutionFake = await startFakeServer([
      { method: "GET", path: "/instance/fetchInstances", handler: () => ({ status: 200, body: [] }) },
    ]);

    const botWorkflow = {
      id: "bot-e2e-1",
      name: "innochat-bot",
      active: false,
      nodes: [
        // Desde 61f3139 o sync deriva a URL de webhook do nó Webhook do bot (path com `:token` exige
        // `webhookId`) — sem ele, `N8N_WEBHOOK_NODE_NOT_FOUND`.
        {
          name: "Webhook",
          type: "n8n-nodes-base.webhook",
          webhookId: "wh-e2e-1",
          parameters: { path: "innochat/evolution/:token" },
        },
        {
          name: "Config",
          type: "n8n-nodes-base.set",
          parameters: { assignments: { assignments: [{ name: "painelUrl", value: "" }, { name: "evolutionUrl", value: "" }] } },
        },
      ],
      connections: {},
      settings: {},
    };
    const errosWorkflow = {
      id: "erros-e2e-1",
      name: "innochat-erros",
      active: false,
      nodes: [
        {
          name: "Config erros",
          type: "n8n-nodes-base.set",
          parameters: { assignments: { assignments: [{ name: "n8nApiUrl", value: "" }] } },
        },
      ],
      connections: {},
      settings: {},
    };

    let credCounter = 0;
    const n8nFake = await startFakeServer([
      {
        method: "GET",
        path: "/api/v1/workflows?limit=1",
        handler: () => ({ status: 200, body: { data: [], nextCursor: null } }),
      },
      // ids de fábrica não existem nesta instância fake -> força o fallback por nome.
      { method: "GET", path: /^\/api\/v1\/workflows\/levHnMSXf1dOR3gS$/, handler: () => ({ status: 404 }) },
      { method: "GET", path: /^\/api\/v1\/workflows\/GZSwTNgvVt4LYnwW$/, handler: () => ({ status: 404 }) },
      {
        method: "GET",
        path: /^\/api\/v1\/workflows\?limit=100$/,
        handler: () => ({ status: 200, body: { data: [botWorkflow, errosWorkflow], nextCursor: null } }),
      },
      {
        method: "POST",
        path: "/api/v1/credentials",
        handler: () => {
          credCounter += 1;
          return { status: 200, body: { id: `cred-e2e-${credCounter}`, name: "fake" } };
        },
      },
      { method: "PUT", path: /^\/api\/v1\/workflows\/bot-e2e-1$/, handler: () => ({ status: 200, body: botWorkflow }) },
      { method: "PUT", path: /^\/api\/v1\/workflows\/erros-e2e-1$/, handler: () => ({ status: 200, body: errosWorkflow }) },
    ]);

    try {
      // Salva Evolution e n8n apontando para os fakes (pré-requisito de `syncN8nAction`).
      await page.getByLabel("URL da Evolution").fill(evolutionFake.url);
      await page.getByLabel("Chave da Evolution").fill(evolutionKey);
      await page.getByRole("button", { name: "Salvar" }).first().click();
      await expect(page.getByText("Evolution API salva.").first()).toBeVisible();

      await page.goto("/admin/configuracoes/automacao");
      await page.getByLabel("URL do n8n").fill(n8nFake.url);
      await page.getByLabel("Chave da API do n8n").fill(n8nKey);
      await page.getByLabel("URL base de webhook do n8n", { exact: true }).fill(`${n8nFake.url}/webhook`);
      await page.getByRole("button", { name: "Salvar" }).first().click();
      await expect(page.getByText("n8n salvo.").first()).toBeVisible();

      await page.getByRole("button", { name: "Sincronizar n8n" }).click();
      await expect(page.getByText(/Sincronizado:/).first()).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText(/3 credencial\(is\) rotacionada\(s\)/).first()).toBeVisible();
      await expect(page.getByText(/bot-e2e-1/).first()).toBeVisible();
      // URL de webhook derivada do nó Webhook (prefixo webhookId), gravada pela sync.
      const settings = await prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 }, select: { n8nWebhookBaseUrl: true } });
      expect(settings.n8nWebhookBaseUrl).toBe(`${n8nFake.url}/webhook/wh-e2e-1/innochat/evolution`);

      // A sync NUNCA chama publish/activate — nenhuma dessas rotas foi cadastrada no fake, então
      // se o cliente tivesse chamado, teria recebido 404 do fallback do `startFakeServer` e a
      // tela mostraria erro em vez de "Sincronizado". Reforça isso checando o log de requisições.
      const activateCalls = n8nFake.received.filter((r) => /publish|activate/.test(r.url));
      expect(activateCalls).toHaveLength(0);
    } finally {
      await evolutionFake.close();
      await n8nFake.close();
      // Limpa o que a sincronização gravou em PlatformSettings (ids de credencial/workflow do
      // fake não fazem sentido fora deste teste) e restaura Evolution/n8n para "não configurado".
      await prisma.platformSettings.update({
        where: { id: 1 },
        data: {
          evolutionApiUrl: null,
          evolutionApiKey: null,
          n8nBaseUrl: null,
          n8nApiKey: null,
          n8nWebhookBaseUrl: null,
          n8nCredPainelId: null,
          n8nCredEvolutionId: null,
          n8nCredApiId: null,
          n8nWorkflowBotId: null,
          n8nWorkflowErrosId: null,
          n8nWorkflowCronId: null,
        },
      });
    }
  });

  test("Ativar/Desativar o bot exige confirmação, e sem sincronizar antes dá erro legível", async ({ page }) => {
    await page.goto("/admin/configuracoes/automacao");
    // Garante estado "não sincronizado" para este teste especificamente (idempotente mesmo se
    // outro teste desta sessão deixou ids de um fake anterior).
    await prisma.platformSettings.update({
      where: { id: 1 },
      data: { n8nWorkflowBotId: null, n8nBaseUrl: null, n8nApiKey: null },
    });
    await page.reload();

    await page.getByRole("button", { name: "Ativar bot", exact: true }).click();
    await expect(page.getByRole("dialog").filter({ hasText: "Ativar o bot" })).toBeVisible();
    await page.getByRole("button", { name: "Confirmar" }).click();

    // Sem n8n configurado/sincronizado, a action devolve erro (N8N_NOT_CONFIGURED ou
    // N8N_NOT_SYNCED) — a tela deve mostrar isso, nunca travar silenciosamente.
    await expect(page.getByText(/Não foi possível ativar o bot/).first()).toBeVisible();
  });

  test("Cancelar no diálogo de confirmação não chama a action", async ({ page }) => {
    await page.goto("/admin/configuracoes/automacao");
    await page.getByRole("button", { name: "Desativar bot", exact: true }).click();
    const dialog = page.getByRole("dialog").filter({ hasText: "Desativar o bot" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(dialog).toBeHidden();
    // Nenhum toast de sucesso/erro apareceu — a ação nunca foi disparada.
    await expect(page.getByText(/desativado\.|Não foi possível desativar/)).toHaveCount(0);
  });
});
