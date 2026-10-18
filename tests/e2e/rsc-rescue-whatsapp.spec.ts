import { test, expect } from "@playwright/test";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";

test.use({ storageState: OWNER_STORAGE_STATE });

test.describe.serial("Validação RSC do card WhatsApp de resgate (v1.13.7)", () => {
  test("Página /admin/configuracoes/whatsapp renderiza sem erro RSC e com ambos os cards e ícones", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });
    page.on("pageerror", (err) => {
      consoleErrors.push(err.message);
    });

    await page.goto("/admin/configuracoes/whatsapp");

    // 1. Verifica que não houve erro de serialização RSC no console do cliente
    const rscErrors = consoleErrors.filter(
      (msg) =>
        msg.includes("Functions cannot be passed directly to Client Components") ||
        msg.includes("798180923")
    );
    expect(rscErrors).toEqual([]);

    // 2. Card WhatsApp de cobrança visível
    const cobrancaCard = page.locator("#whatsapp-cobranca");
    await expect(cobrancaCard).toBeVisible();
    await expect(cobrancaCard.getByRole("heading", { name: "WhatsApp de cobrança" })).toBeVisible();

    // Ícone MessageCircle no card de cobrança (lucide-message-circle)
    const cobrancaIcon = cobrancaCard.locator("svg.lucide-message-circle");
    await expect(cobrancaIcon).toBeVisible();

    // Badge de status no card de cobrança
    await expect(
      cobrancaCard.getByText("Ligado", { exact: true }).or(cobrancaCard.getByText("Desligado", { exact: true }))
    ).toBeVisible();

    // 3. Card WhatsApp de resgate visível logo abaixo
    const resgateCard = page.locator("#whatsapp-resgate");
    await expect(resgateCard).toBeVisible();
    await expect(resgateCard.getByRole("heading", { name: "WhatsApp de resgate" })).toBeVisible();

    // Ícone UserCheck no card de resgate (lucide-user-check)
    const resgateIcon = resgateCard.locator("svg.lucide-user-check");
    await expect(resgateIcon).toBeVisible();

    // Badge de status no card de resgate
    await expect(
      resgateCard.getByText("Ligado", { exact: true }).or(resgateCard.getByText("Desligado", { exact: true }))
    ).toBeVisible();
  });

  test("Interações no card de resgate: toggle de ligar/desligar e modal de conexão", async ({ page }) => {
    await page.goto("/admin/configuracoes/whatsapp");
    const resgateCard = page.locator("#whatsapp-resgate");
    await expect(resgateCard).toBeVisible();

    // Toggle do switch no card de resgate
    const resgateSwitch = resgateCard.getByRole("switch", { name: "Mandar mensagens de resgate pelo WhatsApp" });
    await expect(resgateSwitch).toBeVisible();

    const initialChecked = await resgateSwitch.isChecked();

    // Clica para alternar
    await resgateSwitch.click();

    // Deve disparar toast de sucesso de alteração
    const expectedToast = initialChecked
      ? /Mensagens de resgate desligadas/
      : /Mensagens de resgate ligadas/;
    await expect(page.getByText(expectedToast).first()).toBeVisible({ timeout: 10_000 });

    // Alterna de volta para o estado original
    await resgateSwitch.click();
    const revertToast = initialChecked
      ? /Mensagens de resgate ligadas/
      : /Mensagens de resgate desligadas/;
    await expect(page.getByText(revertToast).first()).toBeVisible({ timeout: 10_000 });

    // Se houver botão de conectar (quando não há número ativo ou em andamento)
    const connectBtn = resgateCard.getByRole("button", { name: "Conectar WhatsApp de resgate" });
    if (await connectBtn.isVisible()) {
      await connectBtn.click();
      // Modal de nome do número / gerar QR abre sem erro
      await expect(page.getByRole("heading", { name: /Conectar WhatsApp de resgate|Conectar/ })).toBeVisible();
      await page.keyboard.press("Escape");
    }
  });

  test("Card de cobrança permanece funcional (não quebrou o lado BILLING)", async ({ page }) => {
    await page.goto("/admin/configuracoes/whatsapp");
    const cobrancaCard = page.locator("#whatsapp-cobranca");
    await expect(cobrancaCard).toBeVisible();

    // Toggle do switch no card de cobrança
    const cobrancaSwitch = cobrancaCard.getByRole("switch", {
      name: "Mandar avisos de cobrança pelo WhatsApp",
    });
    await expect(cobrancaSwitch).toBeVisible();

    const initialChecked = await cobrancaSwitch.isChecked();
    await cobrancaSwitch.click();

    const expectedToast = initialChecked
      ? /Avisos por WhatsApp desligados/
      : /Avisos por WhatsApp ligados/;
    await expect(page.getByText(expectedToast).first()).toBeVisible({ timeout: 10_000 });

    // Reverte
    await cobrancaSwitch.click();
    const revertToast = initialChecked
      ? /Avisos por WhatsApp ligados/
      : /Avisos por WhatsApp desligados/;
    await expect(page.getByText(revertToast).first()).toBeVisible({ timeout: 10_000 });
  });

  test("Aba Marketing (/admin/configuracoes/marketing) tem link para o card de resgate e kill switch funcional", async ({ page }) => {
    await page.goto("/admin/configuracoes/marketing");

    // Card da régua de resgate visível
    await expect(page.getByText("Régua de resgate de leads via WhatsApp")).toBeVisible();

    // Link para o card de WhatsApp de resgate presente e correto
    const whatsappLink = page.getByRole("link", {
      name: /Admin → Configurações → WhatsApp → WhatsApp de resgate → Conectar/,
    });
    await expect(whatsappLink).toBeVisible();
    await expect(whatsappLink).toHaveAttribute(
      "href",
      "/admin/configuracoes/whatsapp#whatsapp-resgate"
    );

    // Teste de abertura do modal do Kill Switch
    const actionButton = page.getByRole("button", { name: /Pausar régua \(Kill switch\)|Ativar régua de resgate/ });
    await expect(actionButton).toBeVisible();
    await actionButton.click();

    // Modal deve abrir com campo de motivo
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel(/Motivo da alteração/)).toBeVisible();
    // Fecha o modal pelo botão Cancelar
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(dialog).not.toBeVisible();
  });

  test("Monitor de erros (/admin/erros) não tem registros de erro RSC", async ({ page }) => {
    await page.goto("/admin/erros");
    await expect(page.getByRole("heading", { name: "Erros", exact: true })).toBeVisible();

    // Verifica se não há grupo com texto do erro RSC
    const bodyText = await page.locator("main").innerText();
    expect(bodyText).not.toContain("Functions cannot be passed directly");
    expect(bodyText).not.toContain("798180923");
  });
});
