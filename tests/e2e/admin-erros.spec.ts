import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "./fixtures/db";
import { OWNER_STORAGE_STATE, STAFF_STORAGE_STATE, TENANT_B_OWNER_STORAGE_STATE } from "./fixtures/storage-state";

/**
 * Admin → Erros (monitor de erros próprio). Os grupos são montados direto no banco com um marcador
 * único na mensagem (o banco de dev pode ter erros reais de outras execuções, então toda asserção
 * olha só o que é nosso) e `lastSeenAt` no futuro para ficarem no topo da lista ordenada por
 * "última vez". Também prova o caminho real do navegador: `POST /api/client-errors` vira um grupo.
 */
const run = randomUUID().slice(0, 8);
const MARK = `E2E_ERR_${run}`;
const FUTURE = new Date(Date.now() + 6 * 3_600_000);

function main(page: Page) {
  return page.getByRole("main");
}

test.describe.serial("Admin → Erros", () => {
  test.use({ storageState: OWNER_STORAGE_STATE });

  test.beforeAll(async () => {
    const at = (min: number) => new Date(FUTURE.getTime() - min * 60_000);
    // 12 abertos do servidor (para paginar com 10 por página) + 1 do navegador + 1 resolvido + 1 ignorado.
    for (let i = 0; i < 12; i++) {
      await prisma.errorGroup.create({
        data: { fingerprint: `fp-${run}-open-${i}`, message: `${MARK} aberto ${String(i).padStart(2, "0")}`, type: "TypeError", source: "SERVER", route: "/api/teste", lastSeenAt: at(i), count: i + 1, status: "OPEN" },
      });
    }
    const withEvents = await prisma.errorGroup.create({
      data: { fingerprint: `fp-${run}-client`, message: `${MARK} navegador com detalhe`, type: "ReferenceError", source: "CLIENT", route: "/clientes", lastSeenAt: at(30), count: 2, status: "OPEN", lastVersion: "9.9.9" },
    });
    await prisma.errorEvent.create({ data: { groupId: withEvents.id, occurredAt: at(30), version: "9.9.9", route: "/clientes", stack: `ReferenceError: x is not defined\n    at ${MARK}-pilha (app.js:1:1)` } });
    await prisma.errorGroup.create({
      data: { fingerprint: `fp-${run}-resolved`, message: `${MARK} resolvido`, type: "Error", source: "SERVER", lastSeenAt: at(40), status: "RESOLVED", resolvedAt: new Date() },
    });
    await prisma.errorGroup.create({
      data: { fingerprint: `fp-${run}-ignored`, message: `${MARK} ignorado`, type: "Error", source: "SERVER", lastSeenAt: at(50), status: "IGNORED" },
    });
  });

  test.afterAll(async () => {
    await prisma.errorGroup.deleteMany({ where: { fingerprint: { startsWith: `fp-${run}-` } } });
    await prisma.errorGroup.deleteMany({ where: { message: { contains: `${MARK}-browser` } } });
  });

  test("lista só os que casam com o filtro de Situação e de Origem", async ({ page }) => {
    await page.goto("/admin/erros?porPagina=100");
    await expect(main(page).getByRole("heading", { name: "Erros", level: 1 })).toBeVisible();
    const list = page.getByTestId("errors-list");
    await expect(list.getByText(`${MARK} aberto 00`)).toBeVisible();
    await expect(list.getByText(`${MARK} resolvido`)).toBeVisible();

    await page.getByLabel("Situação").selectOption("RESOLVED");
    await expect(page).toHaveURL(/status=RESOLVED/);
    await expect(list.getByText(`${MARK} resolvido`)).toBeVisible();
    await expect(list.getByText(`${MARK} aberto 00`)).toHaveCount(0);
    await expect(list.getByText(`${MARK} ignorado`)).toHaveCount(0);

    await page.getByLabel("Situação").selectOption("OPEN");
    await page.getByLabel("Origem").selectOption("CLIENT");
    await expect(page).toHaveURL(/origem=CLIENT/);
    await expect(list.getByText(`${MARK} navegador com detalhe`)).toBeVisible();
    await expect(list.getByText(`${MARK} aberto 00`)).toHaveCount(0);
    await expect(list.getByText(`${MARK} resolvido`)).toHaveCount(0);
  });

  test("filtro sem resultado mostra o estado vazio e não quebra", async ({ page }) => {
    await page.goto("/admin/erros?status=IGNORED&origem=CLIENT&porPagina=100");
    await expect(main(page).getByRole("heading", { name: "Erros", level: 1 })).toBeVisible();
    // Pode haver erro real ignorado do navegador no banco de dev; o que não pode é aparecer item nosso.
    await expect(page.getByText(`${MARK} ignorado`)).toHaveCount(0);
    await expect(page.getByText(`${MARK} aberto 00`)).toHaveCount(0);
  });

  test("paginação: 10 por página, a página 2 traz o resto e o parâmetro porPagina é respeitado", async ({ page }) => {
    await page.goto("/admin/erros?status=OPEN&origem=SERVER&porPagina=10");
    const nav = page.getByRole("navigation", { name: "Paginação dos erros" });
    await expect(nav).toBeVisible();
    const items = page.getByTestId("errors-list").getByRole("listitem");
    await expect(items).toHaveCount(10);
    await expect(page.getByText(`${MARK} aberto 00`)).toBeVisible();
    await expect(page.getByText(`${MARK} aberto 11`)).toHaveCount(0);

    await nav.getByRole("button", { name: "Próxima" }).first().click();
    await expect(page).toHaveURL(/pagina=2/);
    await expect(page.getByText(`${MARK} aberto 11`)).toBeVisible();
    await expect(page.getByText(`${MARK} aberto 00`)).toHaveCount(0);

    // Página além do fim não derruba a tela.
    const res = await page.goto("/admin/erros?status=OPEN&pagina=9999&porPagina=10");
    expect(res?.status()).toBeLessThan(500);
    await expect(main(page).getByRole("heading", { name: "Erros", level: 1 })).toBeVisible();
  });

  test("detalhe mostra a pilha e as ocorrências; Resolver, Reabrir e Ignorar mudam a situação no banco", async ({ page }) => {
    await page.goto("/admin/erros?origem=CLIENT&status=OPEN&porPagina=100");
    await page.getByRole("button", { name: `Ver detalhes: ${MARK} navegador com detalhe` }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(`${MARK}-pilha`)).toBeVisible();
    await expect(dialog.getByText("Versão 9.9.9.")).toBeVisible();

    await dialog.getByRole("button", { name: /^Resolver/ }).click();
    await expect(dialog.getByText("Resolvido", { exact: true })).toBeVisible();
    const fp = `fp-${run}-client`;
    await expect.poll(async () => (await prisma.errorGroup.findUnique({ where: { fingerprint: fp } }))?.status).toBe("RESOLVED");

    await dialog.getByRole("button", { name: /^Reabrir/ }).click();
    await expect.poll(async () => (await prisma.errorGroup.findUnique({ where: { fingerprint: fp } }))?.status).toBe("OPEN");

    await dialog.getByRole("button", { name: /^Ignorar/ }).click();
    await expect.poll(async () => (await prisma.errorGroup.findUnique({ where: { fingerprint: fp } }))?.status).toBe("IGNORED");
    await expect(dialog.getByText(/Erro ignorado: novas ocorrências só somam no contador/)).toBeVisible();
    // O aviso (toast) fica por cima do diálogo e come o 1º Escape (camadas do Radix): fecha pelo botão.
    await dialog.getByRole("button", { name: /Fechar/i }).click();
    await expect(dialog).toBeHidden();
  });

  test("Resolver e Reabrir direto na lista atualizam os totais e a linha", async ({ page }) => {
    await page.goto("/admin/erros?porPagina=100");
    const row = page.getByTestId("errors-list").getByRole("listitem").filter({ hasText: `${MARK} aberto 05` });
    await expect(row.getByText("Aberto", { exact: true })).toBeVisible();
    await row.getByRole("button", { name: /^Resolver/ }).click();
    await expect(row.getByText("Resolvido", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: /^Reabrir/ })).toBeVisible();
    await row.getByRole("button", { name: /^Reabrir/ }).click();
    await expect(row.getByText("Aberto", { exact: true })).toBeVisible();
    await expect.poll(async () => (await prisma.errorGroup.findUnique({ where: { fingerprint: `fp-${run}-open-5` } }))?.status).toBe("OPEN");
  });

  test("um relato real do navegador (POST /api/client-errors) vira um grupo visível; lixo é recusado", async ({ page, request }) => {
    const message = `${MARK}-browser falha de render`;
    const ok = await request.post("/api/client-errors", { data: { message, type: "TypeError", route: "/e2e", version: "1.0.0", kind: "window-error" } });
    expect(ok.status()).toBe(202);
    // Corpo sem mensagem e origem de outro site: recusados, nada gravado.
    const bad = await request.post("/api/client-errors", { data: { type: "x" } });
    expect(bad.status()).toBe(400);
    const foreign = await request.post("/api/client-errors", { data: { message: `${MARK}-browser forjado` }, headers: { origin: "https://evil.example" } });
    expect(foreign.status()).toBe(403);
    expect(await prisma.errorGroup.count({ where: { message: { contains: `${MARK}-browser forjado` } } })).toBe(0);

    await page.goto("/admin/erros?origem=CLIENT&porPagina=100");
    await expect(page.getByTestId("errors-list").getByText(message)).toBeVisible();
  });

  test("layout sem rolagem horizontal em 1440 e 390", async ({ page }) => {
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await page.goto("/admin/erros?porPagina=25");
      await expect(main(page).getByRole("heading", { name: "Erros", level: 1 })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `overflow a ${width}px`).toBeLessThanOrEqual(0);
    }
  });
});

test.describe("Admin → Erros: quem não é admin não vê", () => {
  for (const [label, state] of [
    ["membro da equipe (STAFF)", STAFF_STORAGE_STATE],
    ["dono de outra empresa", TENANT_B_OWNER_STORAGE_STATE],
  ] as const) {
    test(`${label} recebe 404 em /admin/erros e /admin/cupons`, async ({ browser }) => {
      const context = await browser.newContext({ storageState: state, baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000" });
      const page = await context.newPage();
      for (const path of ["/admin/erros", "/admin/cupons", "/admin/backup"]) {
        const res = await page.goto(path);
        expect(res?.status(), path).toBe(404);
      }
      await context.close();
    });
  }

  test("sem sessão, /admin/erros manda para o login e nunca mostra a lista", async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] }, baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000" });
    const page = await context.newPage();
    await page.goto("/admin/erros");
    await expect(page).toHaveURL(/\/login/);
    await context.close();
  });
});
