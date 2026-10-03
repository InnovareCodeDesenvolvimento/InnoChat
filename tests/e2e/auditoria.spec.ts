import { test, expect, type Page } from "@playwright/test";
import { SEED_TENANT_SLUG, E2E_RUN_PREFIX, loadRunFixtures } from "./fixtures/test-data";
import { OWNER_STORAGE_STATE, STAFF_STORAGE_STATE } from "./fixtures/storage-state";
import { prisma } from "./fixtures/db";

/**
 * Auditoria: as ações feitas aqui pela interface (preço de serviço pelo painel; chave da Evolution pelo Admin)
 * aparecem em Admin → Auditoria com o antes/depois, o dono da empresa as vê em Configurações → Histórico (só as da
 * PRÓPRIA empresa), a equipe (STAFF) recebe aviso, e nenhum segredo aparece em lugar nenhum (nem tela, nem banco).
 */
test.use({ storageState: OWNER_STORAGE_STATE, viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: "serial" });

const SERVICE = `${E2E_RUN_PREFIX} Servico Auditoria`;
const SECRET = `chave-secreta-auditoria-${E2E_RUN_PREFIX.replace(/\D/g, "").slice(-9)}-zz`;
const OTHER_TENANT_MARK = `${E2E_RUN_PREFIX} sentinela outra empresa`;
const startedAt = new Date();

const ctx = { tenantId: "", serviceId: "", tenantBId: "" };

function main(page: Page) {
  return page.getByRole("main");
}

async function overflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

test.beforeAll(async () => {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: SEED_TENANT_SLUG }, select: { id: true } });
  ctx.tenantId = tenant.id;
  ctx.tenantBId = loadRunFixtures().tenantBId;
  const service = await prisma.service.create({ data: { tenantId: tenant.id, name: SERVICE, durationMin: 30, priceCents: 5000 } });
  ctx.serviceId = service.id;
  // Sentinela: um registro de OUTRA empresa que o histórico da empresa de seed jamais pode mostrar.
  await prisma.auditLog.create({
    data: { tenantId: ctx.tenantBId, actorRole: "OWNER", action: "service.updated", summary: OTHER_TENANT_MARK, changes: { name: { from: "a", to: "b" } } },
  });
});

test.afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { OR: [{ summary: { contains: E2E_RUN_PREFIX } }, { action: "platform.settings_changed", createdAt: { gte: startedAt } }] } });
  await prisma.service.deleteMany({ where: { id: ctx.serviceId } });
  // Devolve a configuração da plataforma: o segredo de teste não pode ficar gravado.
  await prisma.platformSettings.updateMany({ data: { evolutionApiKey: null } }).catch(() => undefined);
});

test.describe("Auditoria", () => {
  test("preço alterado no painel e chave salva no Admin geram registros; o Admin lista com antes/depois", async ({ page }) => {
    // 1) Preço pelo painel (Serviços), como o dono faria.
    await page.goto(`/${SEED_TENANT_SLUG}/servicos`);
    await page.getByRole("button", { name: `Editar ${SERVICE}` }).click();
    const dlg = page.getByRole("dialog").filter({ hasText: "Editar serviço" });
    await dlg.getByLabel("Preço (R$)").fill("75");
    await dlg.getByRole("button", { name: "Salvar" }).click();
    await expect(dlg).toBeHidden();

    // 2) Credencial pelo Admin da plataforma.
    await page.goto("/admin/configuracoes/whatsapp");
    await main(page).getByLabel("Chave da Evolution").fill(SECRET);
    await page.getByRole("button", { name: "Salvar" }).first().click();
    await expect(page.getByText(/Chave atual: ••••/).first()).toBeVisible();

    // 3) Admin → Auditoria.
    await page.goto("/admin/auditoria");
    await expect(main(page).getByRole("heading", { name: "Auditoria", level: 1 })).toBeVisible();
    const priceRow = page.getByTestId("audit-table").getByRole("row").filter({ hasText: SERVICE });
    await expect(priceRow.first()).toContainText("Preço de serviço alterado");
    await expect(priceRow.first()).toContainText("Studio Demo");
    await priceRow.first().getByRole("button", { name: /Ver detalhes/ }).click();
    const detail = page.getByTestId("audit-detail");
    await expect(detail).toBeVisible();
    const changes = page.getByTestId("audit-changes");
    await expect(changes).toContainText("Preço");
    await expect(changes).toContainText(/R\$\s*50,00/);
    await expect(changes).toContainText(/R\$\s*75,00/);
    await expect(detail).toContainText(`/${SEED_TENANT_SLUG}`);
    await page.getByRole("dialog").getByRole("button", { name: "Fechar" }).first().click();

    // Registro da credencial: diz QUAL campo mudou, nunca o valor.
    const cfgRow = page.getByTestId("audit-table").getByRole("row").filter({ hasText: "Configurações da plataforma alteradas" });
    await expect(cfgRow.first()).toBeVisible();
    await cfgRow.first().getByRole("button", { name: /Ver detalhes/ }).click();
    await expect(page.getByTestId("audit-detail")).toBeVisible();
    await expect(page.getByTestId("audit-detail")).toContainText(/Evolution/i);
    await expect(page.locator("body")).not.toContainText(SECRET);
    expect(await page.content()).not.toContain(SECRET);
    await page.getByRole("dialog").getByRole("button", { name: "Fechar" }).first().click();

    // No banco também: nada do segredo em resumo ou antes/depois.
    const rows = await prisma.auditLog.findMany({ where: { createdAt: { gte: startedAt } } });
    expect(JSON.stringify(rows)).not.toContain(SECRET);
  });

  test("filtros do Admin: por empresa e por área; limpar volta tudo", async ({ page }) => {
    await page.goto("/admin/auditoria");
    await page.getByLabel("Empresa", { exact: true }).fill("Studio Demo");
    await page.getByRole("button", { name: "Filtrar" }).click();
    await expect(page).toHaveURL(/empresa=Studio/);
    await expect(page.getByTestId("audit-table").getByRole("row").filter({ hasText: SERVICE }).first()).toBeVisible();
    await expect(page.getByTestId("audit-table")).not.toContainText(OTHER_TENANT_MARK);

    await page.getByLabel("Empresa", { exact: true }).fill("empresa-que-nao-existe-xyz");
    await page.getByRole("button", { name: "Filtrar" }).click();
    await expect(page.getByText("Nenhuma alteração com esses filtros")).toBeVisible();

    await page.getByRole("button", { name: "Limpar" }).click();
    await expect(page.getByTestId("audit-table").getByRole("row").filter({ hasText: SERVICE }).first()).toBeVisible();

    // Área "Serviços e preços" não traz a configuração da plataforma.
    await page.goto("/admin/auditoria?area=catalogo");
    await expect(page.getByTestId("audit-table").getByRole("row").filter({ hasText: SERVICE }).first()).toBeVisible();
    await expect(page.getByTestId("audit-table")).not.toContainText("Configurações da plataforma alteradas");
  });

  test("Configurações → Histórico: o dono vê só as alterações da PRÓPRIA empresa", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/configuracoes/historico`);
    await expect(main(page).getByRole("heading", { name: "Histórico de alterações", level: 1 })).toBeVisible();
    const row = page.getByTestId("audit-table").getByRole("row").filter({ hasText: SERVICE });
    await expect(row.first()).toContainText("Preço de serviço alterado");
    await expect(page.locator("body")).not.toContainText(OTHER_TENANT_MARK);
    // Ações de plataforma não vazam para o histórico da empresa.
    await expect(page.locator("body")).not.toContainText("Configurações da plataforma alteradas");
    await expect(page.locator("body")).not.toContainText(SECRET);

    // A área restrita à plataforma é ignorada no filtro da empresa.
    await page.goto(`/${SEED_TENANT_SLUG}/configuracoes/historico?area=plataforma`);
    await expect(page.locator("body")).not.toContainText("Configurações da plataforma alteradas");
  });

  test("a empresa B não enxerga a empresa de seed no histórico, e o sentinela dela só aparece para ela", async ({ browser }) => {
    const { TENANT_B_OWNER_STORAGE_STATE } = await import("./fixtures/storage-state");
    const tenantB = await prisma.tenant.findUniqueOrThrow({ where: { id: ctx.tenantBId }, select: { slug: true } });
    const context = await browser.newContext({ storageState: TENANT_B_OWNER_STORAGE_STATE, viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(`/${tenantB.slug}/configuracoes/historico`);
    await expect(page.getByRole("heading", { name: "Histórico de alterações", level: 1 })).toBeVisible();
    await expect(page.locator("body")).toContainText(OTHER_TENANT_MARK);
    await expect(page.locator("body")).not.toContainText(SERVICE);
    // Tentar abrir o histórico da empresa de seed é 404 (não é membro).
    const res = await page.goto(`/${SEED_TENANT_SLUG}/configuracoes/historico`);
    expect(res?.status()).toBe(404);
    await context.close();
  });

  test("telas de auditoria cabem em 1440 e 390, com o diálogo de detalhes aberto", async ({ page }) => {
    for (const [w, h] of [[1440, 900], [390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h });
      for (const url of ["/admin/auditoria", `/${SEED_TENANT_SLUG}/configuracoes/historico`]) {
        await page.goto(url);
        await expect(main(page).getByRole("heading", { level: 1 })).toBeVisible();
        expect(await overflow(page), `overflow ${url} a ${w}px`).toBeLessThanOrEqual(0);
        await page.getByRole("button", { name: /Ver detalhes/ }).locator("visible=true").first().click();
        await expect(page.getByRole("dialog")).toBeVisible();
        expect(await overflow(page), `overflow do diálogo ${url} a ${w}px`).toBeLessThanOrEqual(0);
        await page.getByRole("dialog").getByRole("button", { name: "Fechar" }).first().click();
      }
    }
  });
});

test.describe("Auditoria para a equipe (STAFF)", () => {
  test.use({ storageState: STAFF_STORAGE_STATE });

  test("o histórico mostra aviso, sem nenhuma linha, e o Admin responde 404", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/configuracoes/historico`);
    await expect(page.getByText("Só o dono vê o histórico")).toBeVisible();
    await expect(page.getByTestId("audit-table")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(SERVICE);
    const res = await page.goto("/admin/auditoria");
    expect(res?.status()).toBe(404);
  });
});
