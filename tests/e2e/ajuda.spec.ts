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
