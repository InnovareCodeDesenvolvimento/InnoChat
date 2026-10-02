import { test, expect, type Page } from "@playwright/test";
import { E2E_RUN_PREFIX } from "./fixtures/test-data";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";
import { prisma, ensureBotPlan } from "./fixtures/db";
import { seedCompanyWithNotices, seedExtraNotices, type SeededCompany } from "./fixtures/billing-register";

/**
 * Admin → Financeiro, Envios de cobrança e Cobrança da empresa (F6). O dono da plataforma precisa responder
 * "para quem foi cada aviso e chegou?": aqui provamos destinatário completo, filtros, prévia da mensagem e a
 * linha do tempo, nos dois tamanhos de tela.
 */
test.use({ storageState: OWNER_STORAGE_STATE });

let company: SeededCompany;
const NAME = `${E2E_RUN_PREFIX} Envios Bela`;

test.beforeAll(async () => {
  const plan = await ensureBotPlan();
  company = await seedCompanyWithNotices({ name: NAME, plan: { id: plan.id, priceCents: 5990 }, phone: "5584999991234" });
  await seedExtraNotices({ tenantId: company.tenantId, subscriptionId: company.subscriptionId, invoiceId: company.invoiceId, ownerEmail: company.ownerEmail }, 14);
});

test.afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { name: { contains: E2E_RUN_PREFIX } } });
  await prisma.user.deleteMany({ where: { email: { startsWith: company?.slug ?? "zz-nenhum" } } });
});

async function openEnvios(page: Page) {
  await page.goto(`/admin/envios?tenantQuery=${encodeURIComponent(NAME)}`);
  await expect(page.getByRole("heading", { name: "Envios de cobrança", level: 1 })).toBeVisible();
}

/** Tabela no desktop, cartões no celular: cada um aparece só num dos dois. */
function visibleList(page: Page) {
  return page.locator('[data-testid="notices-table"]:visible, [data-testid="notices-cards"]:visible').first();
}

test.describe("Envios de cobrança (desktop)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("mostra destinatário completo, canal, número que enviou e totais", async ({ page }) => {
    await openEnvios(page);
    const list = visibleList(page);
    await expect(list.getByText(company.ownerEmail).first()).toBeVisible();
    await expect(list.getByText("+55 84 99999-1234").first()).toBeVisible();
    await expect(list.getByText(/Enviado pelo número/).first()).toBeVisible();
    await expect(list.getByText("Falhou").first()).toBeVisible();
    await expect(list.getByText("Não enviado").first()).toBeVisible();
    await expect(list.getByText("Sem número de WhatsApp da plataforma conectado")).toBeVisible();
    // Registro anterior à F6: só o endereço mascarado, e a tela diz isso.
    await expect(list.getByText("do***@e2e.innochat.local")).toBeVisible();
    await expect(page.getByText("Falharam")).toBeVisible();
    await expect(page.getByRole("button", { name: /Como funciona: Envios de cobrança/ })).toBeVisible();
  });

  test("'Só falhas' deixa apenas o que não saiu", async ({ page }) => {
    await openEnvios(page);
    await page.getByLabel("Só falhas").check();
    await page.getByRole("button", { name: "Filtrar" }).click();
    const list = visibleList(page);
    await expect(list.getByText("Falhou").first()).toBeVisible();
    await expect(list.getByText("Enviado", { exact: true })).toHaveCount(0);
    await expect(list.getByText("Na fila")).toHaveCount(0);
  });

  test("filtro por canal e por etapa", async ({ page }) => {
    await openEnvios(page);
    await page.getByLabel("Canal").selectOption("EMAIL");
    await page.getByLabel("Etapa do aviso").selectOption("DUE_D1");
    await page.getByRole("button", { name: "Filtrar" }).click();
    const list = visibleList(page);
    await expect(list.getByText("Lembrete da véspera")).toHaveCount(1);
    await expect(list.getByText("+55 84 99999-1234")).toHaveCount(0);
  });

  test("filtro sem resultado mostra o estado vazio", async ({ page }) => {
    await page.goto("/admin/envios?tenantQuery=empresa-que-nao-existe-xyz");
    await expect(page.getByText("Nenhum envio com esses filtros")).toBeVisible();
  });

  test("'Ver mensagem' mostra o texto enviado e avisa quando é remontado", async ({ page }) => {
    await openEnvios(page);
    await page.getByLabel("Etapa do aviso").selectOption("DUE_D1");
    await page.getByRole("button", { name: "Filtrar" }).click();
    await visibleList(page).getByRole("button", { name: /Ver mensagem/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "Mensagem enviada" });
    await expect(dialog.getByText("Assunto:")).toBeVisible();
    await expect(dialog.getByText("Sua mensalidade vence amanhã")).toBeVisible();
    await expect(dialog.getByTestId("notice-preview-text")).toContainText("O Pix já está no painel");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // Sem texto guardado: remontado, com aviso de aproximação.
    await page.getByLabel("Etapa do aviso").selectOption("INVOICE_CREATED");
    await page.getByRole("button", { name: "Filtrar" }).click();
    await visibleList(page).getByRole("button", { name: /Ver mensagem/ }).first().click();
    await expect(page.getByRole("dialog", { name: "Mensagem enviada" }).getByText(/remontagem|refeito/i)).toBeVisible();
  });

  test("'Reenviar' só aparece onde faz sentido e pede confirmação", async ({ page }) => {
    await openEnvios(page);
    const list = visibleList(page);
    await expect(list.getByRole("button", { name: /^Reenviar: / }).first()).toBeVisible();
    await page.getByLabel("Situação").selectOption("SENT");
    await page.getByRole("button", { name: "Filtrar" }).click();
    await expect(list.getByRole("button", { name: /^Ver mensagem/ }).first()).toBeVisible();
    await expect(list.getByRole("button", { name: /^Reenviar: / })).toHaveCount(0);

    await page.getByLabel("Situação").selectOption("FAILED");
    await page.getByRole("button", { name: "Filtrar" }).click();
    await list.getByRole("button", { name: /^Reenviar: / }).first().click();
    const dialog = page.getByRole("dialog", { name: "Reenviar este aviso?" });
    await expect(dialog).toContainText("+55 84 99999-1234");
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(dialog).toBeHidden();
  });
});

test.describe("Envios de cobrança (paginação)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("troca de página e de tamanho pela URL, sem perder os filtros", async ({ page }) => {
    await page.goto(`/admin/envios?tenantQuery=${encodeURIComponent(NAME)}&porPagina=10`);
    const nav = page.getByRole("navigation", { name: "Paginação dos envios" });
    await expect(nav.getByRole("status")).toHaveText("Mostrando 1–10 de 20");
    await expect(nav.getByRole("button", { name: "Página 1" })).toHaveAttribute("aria-current", "page");

    await nav.getByRole("button", { name: "Próxima" }).click();
    await expect(page).toHaveURL(/pagina=2/);
    await expect(page).toHaveURL(/tenantQuery=/);
    await expect(page).toHaveURL(/porPagina=10/);
    await expect(nav.getByRole("status")).toHaveText("Mostrando 11–20 de 20");
    await expect(nav.getByRole("button", { name: "Página 2" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("button", { name: "Próxima" })).toBeDisabled();

    await nav.getByRole("button", { name: "Anterior" }).click();
    await expect(nav.getByRole("status")).toHaveText("Mostrando 1–10 de 20");

    await nav.getByLabel("Por página").selectOption("50");
    await expect(page).toHaveURL(/porPagina=50/);
    await expect(page).not.toHaveURL(/pagina=/);
    await expect(nav.getByRole("status")).toHaveText("Mostrando 1–20 de 20");
    await expect(nav.getByRole("button", { name: "Página 2" })).toHaveCount(0);
  });

  test("mudar um filtro volta para a página 1", async ({ page }) => {
    await page.goto(`/admin/envios?tenantQuery=${encodeURIComponent(NAME)}&porPagina=10&pagina=2`);
    const nav = page.getByRole("navigation", { name: "Paginação dos envios" });
    await expect(nav.getByRole("status")).toHaveText("Mostrando 11–20 de 20");
    await page.getByLabel("Canal").selectOption("EMAIL");
    await page.getByRole("button", { name: "Filtrar" }).click();
    await expect(page).not.toHaveURL(/pagina=/);
    await expect(page).toHaveURL(/channel=EMAIL/);
    await expect(nav.getByRole("status")).toContainText("Mostrando 1–10 de");
  });

  test("tamanho fora da lista na URL cai no padrão", async ({ page }) => {
    await page.goto(`/admin/envios?tenantQuery=${encodeURIComponent(NAME)}&porPagina=7&pagina=abc`);
    const nav = page.getByRole("navigation", { name: "Paginação dos envios" });
    await expect(nav.getByLabel("Por página")).toHaveValue("25");
    await expect(nav.getByRole("status")).toHaveText("Mostrando 1–20 de 20");
  });

  test("linha do tempo da empresa também pagina", async ({ page }) => {
    await page.goto(`/admin/empresas/${company.tenantId}?porPagina=10`);
    const nav = page.getByRole("navigation", { name: "Paginação da linha do tempo" });
    await expect(nav.getByRole("status")).toContainText("Mostrando 1–10 de");
    await nav.getByRole("button", { name: "Próxima" }).click();
    await expect(page).toHaveURL(/pagina=2/);
    await expect(nav.getByRole("status")).toContainText("Mostrando 11–");
    await expect(nav.getByRole("button", { name: "Página 2" })).toHaveAttribute("aria-current", "page");
  });
});

test.describe("Envios de cobrança (celular)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("vira cartões, sem rolagem horizontal", async ({ page }) => {
    await page.goto(`/admin/envios?tenantQuery=${encodeURIComponent(NAME)}&porPagina=10`);
    await expect(page.getByRole("heading", { name: "Envios de cobrança", level: 1 })).toBeVisible();
    await expect(page.getByTestId("notices-cards")).toBeVisible();
    await expect(page.getByTestId("notices-table")).toBeHidden();
    await expect(page.getByTestId("notices-cards").getByText(company.ownerEmail).first()).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Paginação dos envios" });
    await expect(nav.getByText("Mostrando")).toBeVisible();
    await expect(nav.getByRole("button", { name: "Próxima" })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Página 1" })).toBeHidden();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("Financeiro", () => {
  test("mostra os cartões, ajuda em cada um e o CSV com período e situação", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/admin/financeiro");
    await expect(page.getByRole("heading", { name: "Financeiro", level: 1 })).toBeVisible();
    for (const label of ["Receita mensal recorrente", "Recebido no mês", "Faturas atrasadas", "Recuperados pelos avisos", "Assinantes", "Próximos vencimentos", "Cancelamentos do mês"]) {
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
    }
    expect(await page.locator("[data-help-key]").count()).toBeGreaterThanOrEqual(9);

    await page.getByLabel("Vencimento de").fill("2026-09-01");
    await page.getByLabel("Vencimento até").fill("2026-09-30");
    await page.getByLabel("Situação das faturas").selectOption("PAID");
    const link = page.getByRole("link", { name: "Baixar faturas (CSV)" });
    await expect(link).toHaveAttribute("href", "/api/admin/finance/invoices.csv?from=2026-09-01&to=2026-09-30&status=PAID");

    const response = await page.request.get("/api/admin/finance/invoices.csv?from=2026-09-01&to=2026-09-30&status=PAID");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/csv");

    await page.getByLabel("Vencimento até").fill("2028-01-01");
    await expect(page.getByText("O período pode ter no máximo 12 meses por arquivo.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Baixar faturas (CSV)" })).toBeDisabled();
  });

  test("no celular não rola para os lados", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/admin/financeiro");
    await expect(page.getByRole("heading", { name: "Financeiro", level: 1 })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe("Cobrança da empresa", () => {
  test("resumo, faturas e linha do tempo com avisos e eventos", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/admin/empresas/${company.tenantId}`);
    await expect(page).toHaveURL(new RegExp(`/admin/empresas/${company.tenantId}`));
    await expect(page.getByRole("heading", { name: NAME, level: 1 })).toBeVisible();
    await expect(page.getByText("Pago desde o início")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Faturas" })).toBeVisible();
    const timeline = page.getByRole("list", { name: "Linha do tempo da cobrança" });
    await expect(timeline.locator('li[data-kind="NOTICE"]').first()).toBeVisible();
    await expect(timeline.locator('li[data-kind="EVENT"]').first()).toBeVisible();
    await expect(page.getByRole("link", { name: "Ver todos os envios" })).toHaveAttribute("href", /\/admin\/envios\?tenantQuery=/);
  });

  test("no celular não rola para os lados", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/admin/empresas/${company.tenantId}`);
    await expect(page.getByRole("heading", { name: NAME, level: 1 })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test("empresa que não existe dá 404", async ({ page }) => {
    const response = await page.goto("/admin/empresas/nao-existe-123");
    void response;
    await expect(page.getByText(/não encontrad|404|could not be found/i).first()).toBeVisible();
  });
});
