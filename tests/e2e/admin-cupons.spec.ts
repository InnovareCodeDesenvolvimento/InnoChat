import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "./fixtures/db";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";
import { SEED_TENANT_SLUG } from "./fixtures/test-data";

/**
 * Admin → Cupons: criar, validar no formulário, editar, travar o que já foi usado, desativar e reativar,
 * ver resgates. E Admin → Planos: preço anual com a dica de economia. Tudo pela tela; o banco só confirma.
 */
test.use({ storageState: OWNER_STORAGE_STATE });

const run = randomUUID().slice(0, 6).toUpperCase();
const CODE = `E2EC${run}`;
const USED_CODE = `E2EU${run}`;

function main(page: Page) {
  return page.getByRole("main");
}
function rowOf(page: Page, code: string) {
  return page.getByTestId("cupons-tabela").getByRole("row").filter({ hasText: code });
}

test.describe.serial("Admin → Cupons", () => {
  test.afterAll(async () => {
    await prisma.couponRedemption.deleteMany({ where: { coupon: { code: { in: [CODE, USED_CODE] } } } });
    await prisma.coupon.deleteMany({ where: { code: { in: [CODE, USED_CODE] } } });
  });

  test("criar: erro de formulário claro, depois cria e a linha aparece com desconto e validade", async ({ page }) => {
    await page.goto("/admin/cupons?busca=" + CODE);
    await main(page).getByRole("button", { name: "Novo cupom" }).click();
    const dialog = page.getByRole("dialog");

    // Porcentagem fora da faixa e código curto são barrados antes de ir ao servidor.
    await dialog.getByLabel(/^Código/).fill("ab");
    await dialog.getByRole("button", { name: "Salvar" }).click();
    await expect(dialog.getByText(/de 3 a 32 caracteres/)).toBeVisible();
    await dialog.getByLabel(/^Código/).fill(CODE.toLowerCase());
    await expect(dialog.getByLabel(/^Código/)).toHaveValue(CODE); // sempre em maiúsculas
    await dialog.getByLabel(/^Desconto \(%\)/).fill("150");
    await dialog.getByRole("button", { name: "Salvar" }).click();
    await expect(dialog.getByText("A porcentagem vai de 1 a 100.")).toBeVisible();

    await dialog.getByLabel(/^Desconto \(%\)/).fill("15");
    await dialog.getByLabel("Descrição (só você vê)").fill("Campanha E2E");
    await dialog.getByLabel(/^Em qual cobrança vale/).selectOption("ANNUAL");
    await dialog.getByLabel("Limite de empresas").fill("5");
    await dialog.getByRole("button", { name: "Salvar" }).click();
    await expect(dialog).toBeHidden();

    const row = rowOf(page, CODE);
    await expect(row).toBeVisible();
    await expect(row.getByText("15% de desconto").or(row.getByText(/15\s?%/)).first()).toBeVisible();
    await expect(row.getByText("Ativo", { exact: true })).toBeVisible();
    await expect(row.getByText("0 de 5")).toBeVisible();
    const saved = await prisma.coupon.findUnique({ where: { code: CODE } });
    expect(saved).toMatchObject({ kind: "PERCENT", value: 15, appliesToCycle: "ANNUAL", maxRedemptions: 5, duration: "ONCE", active: true });
  });

  test("código repetido é recusado pelo servidor com mensagem, sem criar outro", async ({ page }) => {
    await page.goto("/admin/cupons?busca=" + CODE);
    await main(page).getByRole("button", { name: "Novo cupom" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/^Código/).fill(CODE);
    await dialog.getByRole("button", { name: "Salvar" }).click();
    await expect(dialog.getByRole("alert").or(dialog.locator("[role=alert], .bg-danger-bg")).first()).toBeVisible();
    await expect(dialog).toBeVisible();
    expect(await prisma.coupon.count({ where: { code: CODE } })).toBe(1);
    await dialog.getByRole("button", { name: "Cancelar" }).click();
  });

  test("editar: muda descrição, validade e limite; o código fica travado", async ({ page }) => {
    await page.goto("/admin/cupons?busca=" + CODE);
    await rowOf(page, CODE).getByRole("button", { name: `Editar o cupom ${CODE}` }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel(/^Código/)).toBeDisabled();
    await dialog.getByLabel("Descrição (só você vê)").fill("Campanha E2E editada");
    await dialog.getByLabel("Vale até").fill("2099-12-31");
    await dialog.getByLabel("Limite de empresas").fill("8");
    await dialog.getByRole("button", { name: "Salvar" }).click();
    await expect(dialog).toBeHidden();
    const row = rowOf(page, CODE);
    await expect(row.getByText("Campanha E2E editada")).toBeVisible();
    await expect(row.getByText("0 de 8")).toBeVisible();
    await expect(row.getByText("31/12/2099")).toBeVisible();
    const saved = await prisma.coupon.findUnique({ where: { code: CODE } });
    expect(saved?.maxRedemptions).toBe(8);
    // Fim do dia em Brasília: 23:59:59.999-03:00 = 02:59:59.999Z do dia seguinte.
    expect(saved?.validUntil?.toISOString()).toBe("2100-01-01T02:59:59.999Z");
  });

  test("desativar e reativar pela linha; o filtro Desativados acha o cupom", async ({ page }) => {
    await page.goto("/admin/cupons?busca=" + CODE);
    await rowOf(page, CODE).getByRole("button", { name: `Desativar o cupom ${CODE}` }).click();
    await expect(rowOf(page, CODE).getByText("Desativado", { exact: true })).toBeVisible();
    expect((await prisma.coupon.findUnique({ where: { code: CODE } }))?.active).toBe(false);

    await page.goto(`/admin/cupons?busca=${CODE}&situacao=desativados`);
    await expect(rowOf(page, CODE)).toBeVisible();
    await page.goto(`/admin/cupons?busca=${CODE}&situacao=ativos`);
    await expect(rowOf(page, CODE)).toHaveCount(0);

    await page.goto("/admin/cupons?busca=" + CODE);
    await rowOf(page, CODE).getByRole("button", { name: `Ativar o cupom ${CODE}` }).click();
    await expect(rowOf(page, CODE).getByText("Ativo", { exact: true })).toBeVisible();
    expect((await prisma.coupon.findUnique({ where: { code: CODE } }))?.active).toBe(true);
  });

  test("cupom já usado trava desconto/duração/ciclo e mostra quem usou", async ({ page }) => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: SEED_TENANT_SLUG } });
    const coupon = await prisma.coupon.create({ data: { code: USED_CODE, kind: "PERCENT", value: 10, duration: "ONCE", appliesToCycle: "ANY", active: true, redemptionsCount: 1, maxRedemptions: 3 } });
    await prisma.couponRedemption.create({ data: { couponId: coupon.id, tenantId: tenant.id } });

    await page.goto("/admin/cupons?busca=" + USED_CODE);
    await rowOf(page, USED_CODE).getByRole("button", { name: `Editar o cupom ${USED_CODE}` }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/já foi usado 1 vez/)).toBeVisible();
    await expect(dialog.getByLabel(/^Desconto \(%\)/)).toBeDisabled();
    await expect(dialog.getByLabel(/^Por quanto tempo vale/)).toBeDisabled();
    await expect(dialog.getByLabel("Limite de empresas")).toBeEnabled();
    // O limite não pode cair abaixo do que já foi usado (1).
    await dialog.getByLabel("Limite de empresas").fill("0");
    await dialog.getByRole("button", { name: "Salvar" }).click();
    await expect(dialog.getByText(/pelo menos 1|menos que|já foi usado|limite/i).first()).toBeVisible();
    expect((await prisma.coupon.findUnique({ where: { code: USED_CODE } }))?.maxRedemptions).toBe(3);
    await dialog.getByRole("button", { name: "Cancelar" }).click();

    await rowOf(page, USED_CODE).getByRole("button", { name: `Ver resgates do cupom ${USED_CODE}` }).click();
    const redemptions = page.getByRole("dialog");
    await expect(redemptions.getByTestId("resgates-lista").getByText(`/${SEED_TENANT_SLUG}`)).toBeVisible();
  });

  test("layout da lista sem rolagem horizontal em 1440 e 390", async ({ page }) => {
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await page.goto("/admin/cupons");
      await expect(main(page).getByRole("heading", { name: "Cupons", level: 1 })).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `overflow a ${width}px`).toBeLessThanOrEqual(0);
    }
  });
});

test.describe("Admin → Planos: preço anual", () => {
  const PLAN_CODE = `e2e-anual-${run.toLowerCase()}`;
  test.afterAll(async () => {
    await prisma.plan.deleteMany({ where: { code: PLAN_CODE } });
  });

  test("define o preço anual com dica de economia, recusa valor acima de 12 mensalidades e limpa para voltar a só mensal", async ({ page }) => {
    await prisma.plan.create({ data: { code: PLAN_CODE, name: `Plano Anual ${run}`, priceCents: 10000, maxWhatsappNumbers: 1, maxProfessionals: 2, active: false, sortOrder: 998 } });
    await page.goto("/admin/planos");
    const card = main(page).locator("div.group").filter({ hasText: `Plano Anual ${run}` });
    await expect(card.getByText("Sem opção anual")).toBeVisible();
    await card.getByRole("button", { name: "Editar plano" }).click();
    const dialog = page.getByRole("dialog");

    await dialog.getByLabel(/^Preço anual/).fill("1000");
    await expect(dialog.getByText(/economiza R\$\s?200,00.*2 meses grátis/)).toBeVisible();
    await dialog.getByLabel(/^Preço anual/).fill("1300");
    await expect(dialog.getByText(/Maior que 12 mensalidades/)).toBeVisible();
    await dialog.getByRole("button", { name: "Salvar" }).click();
    // O servidor também recusa (a dica é só aviso): nada de preço anual acima de 12 mensalidades.
    await expect.poll(async () => (await prisma.plan.findUnique({ where: { code: PLAN_CODE } }))?.annualPriceCents).toBe(null);
    await expect(dialog).toBeVisible();

    await dialog.getByLabel(/^Preço anual/).fill("1000");
    await dialog.getByRole("button", { name: "Salvar" }).click();
    await expect(dialog).toBeHidden();
    await expect(card.getByTestId("plano-anual")).toContainText("por ano");
    expect((await prisma.plan.findUnique({ where: { code: PLAN_CODE } }))?.annualPriceCents).toBe(100000);

    await card.getByRole("button", { name: "Editar plano" }).click();
    await page.getByRole("dialog").getByLabel(/^Preço anual/).fill("");
    await page.getByRole("dialog").getByRole("button", { name: "Salvar" }).click();
    await expect(card.getByText("Sem opção anual")).toBeVisible();
    expect((await prisma.plan.findUnique({ where: { code: PLAN_CODE } }))?.annualPriceCents).toBe(null);
  });
});
