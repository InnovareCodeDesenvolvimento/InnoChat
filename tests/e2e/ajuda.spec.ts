import { test, expect } from "@playwright/test";
import { SEED_TENANT_SLUG } from "./fixtures/test-data";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";

/**
 * Ícone "i" de ajuda (src/components/help): abre e fecha num card de Configurações e num
 * cabeçalho de página, só com teclado (Enter abre, Esc fecha e o foco volta ao "i").
 */
test.use({ storageState: OWNER_STORAGE_STATE });

test("Configurações: 'i' do card de lembrete abre e fecha por teclado", async ({ page }) => {
  await page.goto(`/${SEED_TENANT_SLUG}/configuracoes`);
  const card = page.getByTestId("lembrete-card");
  const trigger = card.getByRole("button", { name: "Como funciona: Lembrete automático para clientes" });
  await expect(trigger).toBeVisible();

  await trigger.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Lembrete automático para clientes" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Para que serve" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Como usar" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: /Exemplos?/ })).toBeVisible();
  await expect(dialog).toContainText("Ana");

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("Configurações: 'i' do aviso ao cliente (dentro do card de atendimento) abre e fecha", async ({ page }) => {
  await page.goto(`/${SEED_TENANT_SLUG}/configuracoes`);
  const trigger = page.getByTestId("atendimento-card").getByRole("button", { name: /Como funciona: Avisar o cliente/ });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: /Avisar o cliente/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Entendi" }).click();
  await expect(dialog).toBeHidden();
});

test("Página (Serviços): 'i' do cabeçalho abre com clique e fecha com Esc", async ({ page }) => {
  await page.goto(`/${SEED_TENANT_SLUG}/servicos`);
  const trigger = page.getByRole("button", { name: "Como funciona: Serviços" });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Serviços" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

/**
 * Esmaecimento do "i": visível por HELP_VISIBLE_MS (6 s) após carregar/trocar de página, depois
 * opacity 0 — mas continua no DOM, focável, clicável e reaparece com hover/foco. Relógio falso
 * do Playwright para não esperar 6 s de verdade.
 */
test.describe("'i' de ajuda some depois de 6 s", () => {
  const opacityOf = (locator: import("@playwright/test").Locator) =>
    locator.evaluate((el) => Number(getComputedStyle(el).opacity));

  test("aparece na carga, some após 6 s, volta com hover e foco, e o clique abre", async ({ page }) => {
    await page.clock.install();
    await page.goto(`/${SEED_TENANT_SLUG}/servicos`);
    const trigger = page.getByRole("button", { name: "Como funciona: Serviços" });
    await expect(trigger).toBeVisible();
    expect(await opacityOf(trigger)).toBe(1);

    await page.clock.runFor(5000);
    expect(await opacityOf(trigger)).toBe(1);
    await page.clock.runFor(1500);
    await expect.poll(() => opacityOf(trigger)).toBe(0);
    // continua no layout e acessível
    const box = await trigger.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    await expect(trigger).toHaveAttribute("aria-label", "Como funciona: Serviços");

    // hover no ícone
    await trigger.hover();
    await expect.poll(() => opacityOf(trigger)).toBe(1);
    await page.mouse.move(2, 2);
    await expect.poll(() => opacityOf(trigger)).toBe(0);

    // foco por teclado
    await trigger.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(trigger).toBeFocused();
    await expect.poll(() => opacityOf(trigger)).toBe(1);

    // abre com teclado; fica visível com o diálogo aberto
    await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Serviços" });
    await expect(dialog).toBeVisible();
    // com o diálogo aberto o "i" fica aria-hidden (Radix): localizar por data-help-key, não por role.
    await expect.poll(() => opacityOf(page.locator('[data-help-key="pagina.servicos"]'))).toBe(1);
    await page.keyboard.press("Escape");
  });

  test("invisível ainda abre por clique", async ({ page }) => {
    await page.clock.install();
    await page.goto(`/${SEED_TENANT_SLUG}/servicos`);
    const trigger = page.getByRole("button", { name: "Como funciona: Serviços" });
    await expect(trigger).toBeVisible();
    await page.clock.runFor(6500);
    await expect.poll(() => opacityOf(trigger)).toBe(0);
    await trigger.click();
    await expect(page.getByRole("dialog", { name: "Serviços" })).toBeVisible();
  });

  test("trocar de página reinicia os 6 s", async ({ page }) => {
    await page.clock.install();
    await page.goto(`/${SEED_TENANT_SLUG}/servicos`);
    const first = page.getByRole("button", { name: "Como funciona: Serviços" });
    await expect(first).toBeVisible();
    await page.clock.runFor(6500);
    await expect.poll(() => opacityOf(first)).toBe(0);

    await page.getByRole("navigation").getByRole("link", { name: "Profissionais" }).first().click();
    await expect(page).toHaveURL(/\/profissionais/);
    const second = page.getByRole("button", { name: "Como funciona: Profissionais" });
    await expect(second).toBeVisible();
    await expect.poll(() => opacityOf(second)).toBe(1);
    await page.clock.runFor(6500);
    await expect.poll(() => opacityOf(second)).toBe(0);
  });

  test("reduced-motion: some sem transição", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.clock.install();
    await page.goto(`/${SEED_TENANT_SLUG}/servicos`);
    const trigger = page.getByRole("button", { name: "Como funciona: Serviços" });
    await expect(trigger).toBeVisible();
    expect(await trigger.evaluate((el) => getComputedStyle(el).transitionDuration)).toBe("0s");
    await page.clock.runFor(6500);
    await expect.poll(() => opacityOf(trigger)).toBe(0);
  });
});
