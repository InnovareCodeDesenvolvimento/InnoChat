import { test, expect } from "@playwright/test";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";
import { prisma } from "./fixtures/db";
import { startFakeEvolutionServer } from "./fixtures/fake-evolution-server";

/**
 * Admin > Configurações > card "WhatsApp de cobrança" (F4 da régua) contra uma Evolution FAKE: conectar
 * por QR, trocar de número sem perder o canal, enviar teste, cancelar a troca e desconectar. A tabela
 * `platform_whatsapp_connections` é global (no máximo 1 ativa): o spec zera as linhas antes e depois, e
 * restaura as credenciais da Evolution em `PlatformSettings`.
 */
test.use({ storageState: OWNER_STORAGE_STATE });

const PHONE_A_JID = "5584991110101@s.whatsapp.net";
const PHONE_B_JID = "5584991110202@s.whatsapp.net";

test.describe.serial("Admin: WhatsApp de cobrança", () => {
  let fake: Awaited<ReturnType<typeof startFakeEvolutionServer>>;
  let saved: { evolutionApiUrl: string | null; evolutionApiKey: string | null; platformWhatsappEnabled: boolean } | null = null;

  test.beforeAll(async () => {
    fake = await startFakeEvolutionServer();
    const row = await prisma.platformSettings.findUnique({ where: { id: 1 }, select: { evolutionApiUrl: true, evolutionApiKey: true, platformWhatsappEnabled: true } });
    saved = row ?? { evolutionApiUrl: null, evolutionApiKey: null, platformWhatsappEnabled: false };
    await prisma.platformWhatsappConnection.deleteMany({});
    await prisma.platformSettings.upsert({
      where: { id: 1 },
      create: { id: 1, evolutionApiUrl: fake.url, evolutionApiKey: "e2e-fake-key", platformWhatsappEnabled: true },
      update: { evolutionApiUrl: fake.url, evolutionApiKey: "e2e-fake-key", platformWhatsappEnabled: true },
    });
  });

  test.afterAll(async () => {
    await prisma.platformWhatsappConnection.deleteMany({});
    await prisma.providerEvent.deleteMany({ where: { provider: { startsWith: "platform-whatsapp" } } });
    if (saved) {
      await prisma.platformSettings.update({
        where: { id: 1 },
        data: { evolutionApiUrl: saved.evolutionApiUrl, evolutionApiKey: saved.evolutionApiKey, platformWhatsappEnabled: saved.platformWhatsappEnabled },
      });
    }
    await fake.close();
  });

  test("conecta o primeiro número lendo o QR, mostra o número e envia o teste", async ({ page }) => {
    await page.goto("/admin/configuracoes/whatsapp");
    const card = page.locator("#whatsapp-cobranca");
    await expect(card.getByRole("heading", { name: "WhatsApp de cobrança" })).toBeVisible();
    await expect(card.getByText("Nenhum número conectado")).toBeVisible();

    // ajuda ⓘ com exemplos
    await card.getByRole("button", { name: /Como funciona: WhatsApp de cobrança/ }).click();
    await expect(page.getByText("Você comprou um chip só para cobrança", { exact: false })).toBeVisible();
    await page.keyboard.press("Escape");

    await card.getByRole("button", { name: "Conectar número" }).click();
    await page.getByRole("button", { name: "Gerar QR" }).click();
    await expect(page.getByAltText("QR code para conectar o WhatsApp de cobrança")).toBeVisible();

    const instance = fake.lastCreatedInstanceName()!;
    expect(instance).toMatch(/^innochat-plataforma-/);
    fake.setOwnerJid(instance, PHONE_A_JID);
    fake.setState(instance, "open");

    await expect(card.getByText("+55 84 99111-0101")).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText("Conectado", { exact: true })).toBeVisible();

    await card.getByRole("button", { name: "Enviar teste" }).click();
    await page.getByLabel("Seu celular com DDD").fill("(84) 99109-9099");
    await page.getByRole("button", { name: "Enviar teste" }).last().click();
    await expect(page.getByText("Mensagem enviada. Confira o seu celular.")).toBeVisible();
    expect(fake.received.some((r) => r.method === "POST" && r.url.startsWith("/message/sendText/"))).toBe(true);
    await page.keyboard.press("Escape");
  });

  test("troca de número: o atual segue ativo durante o QR; ao conectar, vira histórico", async ({ page }) => {
    await page.goto("/admin/configuracoes/whatsapp");
    const card = page.locator("#whatsapp-cobranca");
    await card.getByRole("button", { name: "Trocar de número" }).click();
    await page.getByLabel("Nome do número").fill("Cobrança (chip novo)");
    await page.getByRole("button", { name: "Gerar QR" }).click();
    await expect(page.getByAltText("QR code para conectar o WhatsApp de cobrança")).toBeVisible();
    await page.getByRole("dialog").locator("button", { hasText: "Fechar" }).click();

    // Durante a troca: antigo ativo e item "Troca em andamento".
    await expect(card.getByText("+55 84 99111-0101")).toBeVisible();
    await expect(card.getByText(/Troca em andamento/)).toBeVisible();
    expect(await prisma.platformWhatsappConnection.count({ where: { role: "ACTIVE" } })).toBe(1);

    const instance = fake.lastCreatedInstanceName()!;
    fake.setOwnerJid(instance, PHONE_B_JID);
    fake.setState(instance, "open");
    await card.getByRole("button", { name: "Mostrar QR" }).click();

    await expect(card.getByText("+55 84 99111-0202")).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText("Números anteriores")).toBeVisible();
    await expect(card.getByText(/Trocado por outro número/)).toBeVisible();
    expect(await prisma.platformWhatsappConnection.count({ where: { role: "ACTIVE" } })).toBe(1);
  });

  test("cancelar a troca mantém o número atual", async ({ page }) => {
    await page.goto("/admin/configuracoes/whatsapp");
    const card = page.locator("#whatsapp-cobranca");
    await card.getByRole("button", { name: "Trocar de número" }).click();
    await page.getByRole("button", { name: "Gerar QR" }).click();
    await expect(page.getByAltText("QR code para conectar o WhatsApp de cobrança")).toBeVisible();
    await page.getByRole("button", { name: "Cancelar a troca" }).click();
    await expect(card.getByText(/Troca em andamento/)).toHaveCount(0);
    await expect(card.getByText("+55 84 99111-0202")).toBeVisible();
  });

  test("desconectar exige digitar DESCONECTAR", async ({ page }) => {
    await page.goto("/admin/configuracoes/whatsapp");
    const card = page.locator("#whatsapp-cobranca");
    await card.getByRole("button", { name: "Desconectar" }).click();
    const confirm = page.getByRole("button", { name: "Desconectar" }).last();
    await expect(confirm).toBeDisabled();
    await page.getByLabel("Para confirmar, digite DESCONECTAR").fill("DESCONECTAR");
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await expect(card.getByText("Nenhum número conectado")).toBeVisible();
    await expect(card.getByText("Números anteriores")).toBeVisible();
  });

  test("a Saúde mostra a linha do WhatsApp de cobrança", async ({ page }) => {
    await page.goto("/admin/saude");
    await expect(page.getByText("WhatsApp de cobrança", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("Desligado.", { exact: false }).or(page.getByText("sem número", { exact: false })).first()).toBeVisible();
  });
});
