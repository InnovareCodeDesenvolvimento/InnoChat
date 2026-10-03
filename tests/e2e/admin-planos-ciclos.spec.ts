import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma } from "./fixtures/db";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";

/**
 * Admin → Planos: os 4 preços (mensal obrigatório, os outros opcionais), economia ao vivo em % e R$, botão
 * "Sugerir preços" com a conta à vista, validação contra mensal x meses e a trava de apagar o preço de um ciclo
 * que tem assinatura ativa. Tudo pela tela; o banco só confirma.
 */
test.use({ storageState: OWNER_STORAGE_STATE });

const run = randomUUID().slice(0, 6);
const PLAN_CODE = `e2e-ciclos-${run}`;
const PLAN_NAME = `Plano Ciclos ${run.toUpperCase()}`;
const SLUG = `e2e-ciclos-plan-${run}`;

function main(page: Page) {
  return page.getByRole("main");
}

test.describe.serial("Admin → Planos: preços por ciclo", () => {
  test.afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { slug: SLUG } });
    await prisma.plan.deleteMany({ where: { code: PLAN_CODE } });
  });

  test("sugerir preenche os 3 períodos com a conta, a economia aparece ao vivo e os valores salvam", async ({ page }) => {
    await prisma.plan.create({ data: { code: PLAN_CODE, name: PLAN_NAME, priceCents: 5900, maxWhatsappNumbers: 1, maxProfessionals: 2, active: false, sortOrder: 998 } });
    await page.goto("/admin/planos");
    const card = main(page).locator("div.group").filter({ hasText: PLAN_NAME });
    await expect(card.getByText("Só cobrança mensal")).toBeVisible();
    await card.getByRole("button", { name: "Editar plano" }).click();
    const dialog = page.getByRole("dialog");
    const q = dialog.getByLabel(/^Trimestral/);
    const s = dialog.getByLabel(/^Semestral/);
    const a = dialog.getByLabel(/^Anual/);

    await expect(dialog.getByText("Em branco: o plano não oferece este período.").first()).toBeVisible();
    await dialog.getByTestId("sugerir-precos").click();
    await expect(q).toHaveValue("168.00");
    await expect(s).toHaveValue("319.00");
    await expect(a).toHaveValue("590.00");
    const calc = dialog.getByTestId("sugestao-calculo");
    await expect(calc).toContainText(/R\$\s?59,00 x 3 = R\$\s?177,00/);
    await expect(calc).toContainText(/R\$\s?168,15, arredondado para R\$\s?168,00/);
    await expect(calc).toContainText("2 meses grátis");
    // Economia ao vivo, em reais e em %.
    await expect(dialog.getByText(/Economia de R\$\s?9,00 \(5%\)/)).toBeVisible();
    await expect(dialog.getByText(/Economia de R\$\s?118,00 \(17%, 2 meses grátis\)/)).toBeVisible();

    // Editável: muda o trimestral e a dica acompanha; acima de 3 mensalidades avisa.
    await q.fill("160");
    await expect(dialog.getByText(/Economia de R\$\s?17,00 \(10%\)/)).toBeVisible();
    await q.fill("200");
    await expect(dialog.getByText(/Maior que 3 mensalidades/)).toBeVisible();
    await dialog.getByRole("button", { name: "Salvar" }).click();
    await expect(dialog.getByText(/não pode ser maior que 3 mensalidades/)).toBeVisible();
    expect((await prisma.plan.findUnique({ where: { code: PLAN_CODE } }))?.quarterlyPriceCents).toBe(null);

    await q.fill("160");
    await dialog.getByRole("button", { name: "Salvar" }).click();
    await expect(dialog).toBeHidden();
    await expect(card.getByTestId("plano-ciclo-QUARTERLY")).toContainText("a cada 3 meses");
    await expect(card.getByTestId("plano-ciclo-ANNUAL")).toContainText("2 meses grátis");
    expect(await prisma.plan.findUnique({ where: { code: PLAN_CODE } })).toMatchObject({ quarterlyPriceCents: 16000, semiannualPriceCents: 31900, annualPriceCents: 59000 });
  });

  test("não deixa apagar o preço de um ciclo com assinatura ativa, e diz quantas; apaga o que ninguém usa", async ({ page }) => {
    const plan = await prisma.plan.findUniqueOrThrow({ where: { code: PLAN_CODE } });
    const tenant = await prisma.tenant.create({ data: { slug: SLUG, name: `Empresa ${SLUG}`, timezone: "America/Sao_Paulo" } });
    await prisma.subscription.create({ data: { tenantId: tenant.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000), billingCycle: "QUARTERLY" } });

    await page.goto("/admin/planos");
    const card = main(page).locator("div.group").filter({ hasText: PLAN_NAME });
    await card.getByRole("button", { name: "Editar plano" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/^Trimestral/).fill("");
    await expect(dialog.getByText(/1 assinatura ativa usa este período: o preço não pode ficar em branco/)).toBeVisible();
    await dialog.getByRole("button", { name: "Salvar" }).click();
    await expect(dialog.getByText(/Não dá para tirar o preço trimestral: 1 assinatura ativa usa/)).toBeVisible();
    expect((await prisma.plan.findUnique({ where: { code: PLAN_CODE } }))?.quarterlyPriceCents).toBe(16000);

    // O semestral ninguém usa: pode sair.
    await dialog.getByLabel(/^Trimestral/).fill("160");
    await dialog.getByLabel(/^Semestral/).fill("");
    await dialog.getByRole("button", { name: "Salvar" }).click();
    await expect(dialog).toBeHidden();
    await expect(card.getByTestId("plano-ciclo-SEMIANNUAL")).toHaveCount(0);
    expect((await prisma.plan.findUnique({ where: { code: PLAN_CODE } }))?.semiannualPriceCents).toBe(null);
  });

  test("layout do diálogo sem rolagem horizontal em 1440 e 390", async ({ page }) => {
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await page.goto("/admin/planos");
      const card = main(page).locator("div.group").filter({ hasText: PLAN_NAME });
      await card.getByRole("button", { name: "Editar plano" }).click();
      await expect(page.getByTestId("plano-precos-periodo")).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `overflow a ${width}px`).toBeLessThanOrEqual(0);
      await page.keyboard.press("Escape");
    }
  });
});
