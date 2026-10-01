import { test, expect } from "@playwright/test";
import { prisma } from "./fixtures/db";

/**
 * Landing pública (`/`): carrega, CTAs, planos vindos do banco, FAQ por teclado e sem overflow em
 * 390px. Sem sessão (contexto limpo).
 */
test.describe("Landing pública", () => {
  test.beforeEach(async ({ context }) => {
    await context.clearCookies();
  });

  test("carrega com h1, microcopy do teste e celular da demo", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toContainText("agenda sozinho");
    await expect(page.getByText("sem cartão de crédito").first()).toBeVisible();
    await expect(page.getByTestId("phone-demo")).toBeAttached();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", "https://innochat.innovarecode.com.br");
    const ld = await page.locator('script[type="application/ld+json"]').textContent();
    expect(ld).toContain("SoftwareApplication");
  });

  test("CTAs levam a /cadastro e /login", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Começar teste grátis" }).first().click();
    await expect(page).toHaveURL(/\/cadastro$/);

    await page.goto("/");
    await page.getByRole("link", { name: "Já tenho conta" }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("planos renderizam a partir do banco", async ({ page }) => {
    const active = await prisma.plan.findMany({ where: { active: true }, orderBy: { sortOrder: "asc" } });
    await page.goto("/");
    const section = page.locator("#planos");
    await expect(section).toBeVisible();
    if (active.length === 0) {
      await expect(page.getByTestId("planos-sem-preco")).toBeVisible();
      return;
    }
    // O cache da vitrine é de 60 s: aceita que o banco tenha mudado há pouco, mas exige pelo menos
    // um plano ativo atual renderizado com o preço certo.
    const cards = page.getByTestId("plano-card");
    await expect(cards.first()).toBeVisible();
    const first = active.find((p) => p.priceCents > 0) ?? active[0];
    const price = (first.priceCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }).replace(/ /g, " ");
    const text = (await section.innerText()).replace(/ /g, " ");
    expect(text).toContain(first.name);
    expect(text).toContain(price);
  });

  test("FAQ abre e fecha pelo teclado", async ({ page }) => {
    await page.goto("/");
    const summary = page.locator("#faq summary").first();
    await summary.scrollIntoViewIfNeeded();
    await summary.focus();
    const details = page.locator("#faq details").first();
    await expect(details).not.toHaveAttribute("open", "");
    await page.keyboard.press("Enter");
    await expect(details).toHaveAttribute("open", "");
    await page.keyboard.press("Space");
    await expect(details).not.toHaveAttribute("open", "");
  });

  test("390px: sem rolagem horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const r = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth,
      cw: document.documentElement.clientWidth,
    }));
    expect(r.sw).toBeLessThanOrEqual(r.cw);
  });

  test("com movimento reduzido a conversa aparece completa, com o prazo padrão de 2 horas", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    const demo = page.getByTestId("phone-demo");
    await expect(demo.getByText("Agendamento confirmado!")).toBeVisible();
    await expect(demo.getByText(/até 2 horas antes/)).toBeVisible();
    await expect(demo.getByText("Studio Bella").first()).toBeVisible();
  });

  test("a demo anima: 'digitando...' no cabeçalho e o chat rola até o fim", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await page.evaluate(() => document.querySelector('[data-testid="phone-demo"]')?.scrollIntoView({ block: "center" }));
    await expect(page.getByTestId("phone-demo-status")).toHaveText("digitando...", { timeout: 8_000 });
    await expect(page.getByTestId("phone-demo-status")).toHaveText("online", { timeout: 8_000 });
    await expect
      .poll(() => page.getByTestId("phone-demo").getByRole("region").evaluate((el) => el.scrollTop), { timeout: 15_000 })
      .toBeGreaterThan(0);
  });

  test("cabeçalho usa o logo oficial (balão ⓘ) e a página não estoura em 1440, 1024, 768 e 390", async ({ page }) => {
    for (const width of [1440, 1024, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/");
      const r = await page.evaluate(() => ({
        sw: document.documentElement.scrollWidth,
        cw: document.documentElement.clientWidth,
      }));
      expect(r.sw, `overflow em ${width}px`).toBeLessThanOrEqual(r.cw);
    }
    await expect(page.locator('header img[src*="innochat-balao"]').first()).toBeAttached();
    await expect(page.getByRole("link", { name: "InnoChat, início" }).first()).toBeVisible();
  });
});
