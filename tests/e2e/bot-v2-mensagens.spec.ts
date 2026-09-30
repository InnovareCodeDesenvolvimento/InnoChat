import { test, expect, type Page } from "@playwright/test";
import { SEED_TENANT_SLUG } from "./fixtures/test-data";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";
import { prisma, setPublishedFlowVersion } from "./fixtures/db";

/**
 * Mensagens do bot (bot v2, L-3): abas por etapa, editor com prévia no formato do WhatsApp
 * (`wa-bubble`, gerada pelo mesmo motor do bot), variáveis por mensagem, "Textos da versão
 * anterior" (só leitura) e o selo da versão do fluxo. O catálogo (v1 ou v2) depende de
 * `PlatformSettings.n8nBotFlowVersion`: a spec fixa a versão e restaura no `afterAll`.
 *
 * O bloqueio de variável fora de contexto acontece nos DOIS lados (a tela avisa antes de enviar; o
 * servidor recusa com `disallowedVariables`); a recusa do servidor é coberta em
 * `tests/integration/bot-texts-v2.integration.test.ts` — pela UI o botão Salvar nem chega a ser
 * habilitado, então aqui se prova a barreira da tela.
 */
test.use({ storageState: OWNER_STORAGE_STATE });
test.describe.configure({ mode: "serial" });

let originalVersion: string | null = null;
let tenantId = "";
let originalRows: { key: string; text: string }[] = [];
const TOUCHED_KEYS = ["GREETING", "MAIN_MENU", "LABEL_MENU_BOOK"] as const;

test.beforeAll(async () => {
  tenantId = (await prisma.tenant.findUniqueOrThrow({ where: { slug: SEED_TENANT_SLUG }, select: { id: true } })).id;
  originalRows = await prisma.botText.findMany({ where: { tenantId, key: { in: [...TOUCHED_KEYS] } }, select: { key: true, text: true } });
  await prisma.botText.deleteMany({ where: { tenantId, key: { in: [...TOUCHED_KEYS] } } });
  originalVersion = await setPublishedFlowVersion("2.0.0");
});

test.afterAll(async () => {
  await prisma.botText.deleteMany({ where: { tenantId, key: { in: [...TOUCHED_KEYS] } } });
  for (const row of originalRows) await prisma.botText.create({ data: { tenantId, key: row.key as (typeof TOUCHED_KEYS)[number], text: row.text } });
  await setPublishedFlowVersion(originalVersion);
});

async function openEditor(page: Page, tab: string, title: string) {
  await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).click();
  await page.getByRole("button", { name: `Editar ${title}`, exact: true }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Prévia" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("fluxo v2", () => {
  test("selo da versão e as 5 abas; setas do teclado trocam de aba", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/mensagens-bot`);
    await expect(page.getByTestId("flow-version")).toContainText("Fluxo publicado: v2");
    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveCount(5);
    for (const name of ["Conversa", "Agendamento", "Meus agendamentos", "Atendente", "Rótulos"]) {
      await expect(page.getByRole("tab", { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    await expect(page.getByRole("tab", { name: /^Conversa/ })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: /^Conversa/ }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: /^Agendamento/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel")).toContainText("Cada etapa até o horário ser reservado.");
    await page.keyboard.press("End");
    await expect(page.getByRole("tab", { name: /^Rótulos/ })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Home");
    await expect(page.getByRole("tab", { name: /^Conversa/ })).toHaveAttribute("aria-selected", "true");
  });

  test("prévia do resumo: com preço mostra a linha Valor; sem preço a linha some", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/mensagens-bot`);
    const dialog = await openEditor(page, "Agendamento", "Resumo para confirmar");
    const bubble = dialog.getByTestId("wa-bubble");
    await expect(bubble).toContainText("Valor:");
    await expect(bubble).toContainText("R$ 80,00");
    // Negrito do WhatsApp vira <span class="font-bold">, não asteriscos soltos.
    await expect(bubble.locator("span.font-bold").first()).toBeVisible();
    await expect(bubble).not.toContainText("*Serviço:*");

    await dialog.getByRole("switch", { name: "Simular serviço sem preço" }).click();
    await expect(bubble).not.toContainText("Valor:");
    await expect(bubble).not.toContainText("R$ 80,00");
    await expect(bubble).toContainText("Serviço:"); // as demais linhas continuam

    await dialog.getByRole("switch", { name: "Simular serviço sem preço" }).click();
    await expect(bubble).toContainText("Valor:");
  });

  test("a prévia acompanha a digitação e usa os dados de exemplo", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/mensagens-bot`);
    const dialog = await openEditor(page, "Conversa", "Saudação");
    const area = dialog.getByLabel("Texto da mensagem");
    await area.fill("Oi, {nome}! Aqui é a *{empresa}*.");
    await expect(dialog.getByTestId("wa-bubble")).toContainText("Oi, Maria! Aqui é a Studio Bela.");
  });

  test("variável fora de contexto ({limite} na saudação): avisa, marca o campo e bloqueia o Salvar", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/mensagens-bot`);
    const dialog = await openEditor(page, "Conversa", "Saudação");
    const area = dialog.getByLabel("Texto da mensagem");
    const save = dialog.getByRole("button", { name: "Salvar" });

    await area.fill("Olá {nome}, você pode ter {limite} horários.");
    await expect(dialog.getByText("Variável que não vale nesta mensagem")).toBeVisible();
    await expect(dialog.getByText(/\{limite\} não pode ser usada aqui/)).toBeVisible();
    await expect(area).toHaveAttribute("aria-invalid", "true");
    await expect(save).toBeDisabled();
    // Os chips só oferecem o que vale nesta mensagem.
    const chips = dialog.getByRole("group", { name: "Variáveis desta mensagem" });
    await expect(chips.getByRole("button", { name: "{nome}" })).toBeVisible();
    await expect(chips.getByRole("button", { name: "{empresa}" })).toBeVisible();
    await expect(chips.getByRole("button", { name: "{limite}" })).toHaveCount(0);

    await area.fill("Olá {nome}, você pode ter horários.");
    await expect(dialog.getByText("Variável que não vale nesta mensagem")).toBeHidden();
    await expect(save).toBeEnabled();
    // Nada foi gravado.
    expect(await prisma.botText.count({ where: { tenantId, key: "GREETING" } })).toBe(0);
  });

  test("{limite} vale na mensagem de limite (chip oferecido)", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/mensagens-bot`);
    const dialog = await openEditor(page, "Agendamento", "Limite de agendamentos");
    await expect(dialog.getByRole("group", { name: "Variáveis desta mensagem" }).getByRole("button", { name: "{limite}" })).toBeVisible();
  });

  test("chip insere a variável onde está o cursor", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/mensagens-bot`);
    const dialog = await openEditor(page, "Conversa", "Saudação");
    const area = dialog.getByLabel("Texto da mensagem");
    await area.fill("Oi !");
    await area.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(3, 3));
    await dialog.getByRole("button", { name: "{nome}" }).click();
    await expect(area).toHaveValue("Oi {nome}!");
  });

  test("salvar personaliza (badge, contador da aba, banco) e restaurar volta ao padrão", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/mensagens-bot`);
    const dialog = await openEditor(page, "Conversa", "Saudação");
    await dialog.getByLabel("Texto da mensagem").fill("Fala, {nome}! Você está na *{empresa}* (teste E2E).");
    await dialog.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Mensagem atualizada.").first()).toBeVisible();
    await expect(dialog).toBeHidden();

    const row = page.getByRole("listitem").filter({ hasText: "Saudação" }).first();
    await expect(row).toContainText("Personalizado");
    await expect(row).toContainText("teste E2E");
    await expect(page.getByRole("tab", { name: /^Conversa/ })).toContainText("1");
    const saved = await prisma.botText.findUniqueOrThrow({ where: { tenantId_key: { tenantId, key: "GREETING" } } });
    expect(saved.text).toBe("Fala, {nome}! Você está na *{empresa}* (teste E2E).");

    // Persiste depois de recarregar.
    await page.reload();
    await expect(page.getByRole("listitem").filter({ hasText: "Saudação" }).first()).toContainText("teste E2E");

    await page.getByRole("button", { name: "Restaurar padrão de Saudação" }).click();
    const confirm = page.getByRole("dialog").filter({ hasText: "O texto personalizado é apagado" });
    await confirm.getByRole("button", { name: "Restaurar", exact: true }).click();
    await expect(page.getByText("Mensagem restaurada ao padrão.").first()).toBeVisible();
    await expect(page.getByRole("listitem").filter({ hasText: "Saudação" }).first()).toContainText("Padrão");
    expect(await prisma.botText.count({ where: { tenantId, key: "GREETING" } })).toBe(0);
  });

  test("rótulos não usam variáveis", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/mensagens-bot`);
    await page.getByRole("tab", { name: /^Rótulos/ }).click();
    await page.getByRole("button", { name: /^Editar / }).first().click();
    const dialog = page.getByRole("dialog").filter({ hasText: "Prévia" });
    await expect(dialog.getByText("Rótulos não usam variáveis")).toBeVisible();
    await expect(dialog.getByRole("group", { name: "Variáveis desta mensagem" })).toHaveCount(0);
  });

  test("Lembretes: link #lembretes abre a aba certa, leva até o item e o editor oferece as variáveis do lembrete", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/mensagens-bot#lembretes`);
    const item = page.locator("#lembretes");
    await expect(item).toBeVisible();
    await expect(page.getByRole("tab", { name: /^Meus agendamentos/ })).toHaveAttribute("aria-selected", "true");
    await expect(item.getByRole("heading", { name: "Lembrete" })).toBeVisible();
    await item.getByRole("button", { name: "Editar Lembrete" }).click();
    const chips = page.getByRole("dialog").getByRole("group", { name: "Variáveis desta mensagem" });
    for (const v of ["{servico}", "{profissional}", "{hora}", "{quando}"]) {
      await expect(chips.getByRole("button", { name: v })).toBeVisible();
    }
    await expect(chips.getByRole("button", { name: "{preco}" })).toHaveCount(0);
  });

  test("Textos da versão anterior: só aparece com texto legado editado, em somente leitura", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/mensagens-bot`);
    await expect(page.getByTestId("legacy-texts")).toHaveCount(0);

    await prisma.botText.create({ data: { tenantId, key: "MAIN_MENU", text: "Menu antigo editado E2E {nome}" } });
    await page.reload();
    const legacy = page.getByTestId("legacy-texts");
    await expect(legacy).toBeVisible();
    await expect(legacy).toContainText("Textos da versão anterior");
    await expect(legacy.locator("summary")).toContainText("1");
    await legacy.locator("summary").click();
    await expect(legacy).toContainText("Só leitura.");
    await expect(legacy).toContainText("Menu antigo editado E2E {nome}");
    await expect(legacy.getByRole("button")).toHaveCount(0); // sem editar/restaurar
    // O texto legado não vira uma linha editável nas abas da v2.
    await expect(page.getByRole("button", { name: "Editar Menu principal" })).toHaveCount(0);
    await prisma.botText.deleteMany({ where: { tenantId, key: "MAIN_MENU" } });
  });
});

test.describe("fluxo v1 (ainda não publicaram o v2)", () => {
  test.beforeAll(async () => {
    await setPublishedFlowVersion(null);
  });
  test.afterAll(async () => {
    await setPublishedFlowVersion("2.0.0"); // volta ao estado do describe anterior; o afterAll geral restaura o original
  });

  test("mostra o selo v1, o aviso e nenhum bloco de textos antigos", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/mensagens-bot`);
    await expect(page.getByTestId("flow-version")).toContainText("Fluxo publicado: v1");
    await expect(page.getByTestId("flow-version")).toContainText("O bot ainda usa o fluxo anterior");
    await expect(page.getByTestId("legacy-texts")).toHaveCount(0);
    // Catálogo da v1: o menu principal é editável (na v2 ele vira "textos antigos").
    await page.getByRole("tab", { name: /^Conversa/ }).click();
    await expect(page.getByRole("button", { name: /^Editar Menu principal/ })).toBeVisible();
  });

  test("na v1 a prévia do editor é a de sempre (sem interruptor de preço)", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/mensagens-bot`);
    await page.getByRole("tab", { name: /^Agendamento/ }).click();
    await page.getByRole("button", { name: /^Editar Resumo/ }).first().click();
    const dialog = page.getByRole("dialog").filter({ hasText: "Prévia" });
    await expect(dialog.getByTestId("wa-bubble")).toBeVisible();
    await expect(dialog.getByRole("switch", { name: "Simular serviço sem preço" })).toHaveCount(0);
  });
});
