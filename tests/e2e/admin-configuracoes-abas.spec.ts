import { test, expect, type Page } from "@playwright/test";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";
import { prisma } from "./fixtures/db";

/**
 * Admin → Configurações em abas: cada assunto tem a sua rota (`/admin/configuracoes/<aba>`), a barra
 * de abas é uma lista de links (`aria-current="page"`), o título muda ("Configurações · WhatsApp"),
 * o teclado anda entre as abas, o aviso de alterações não salvas protege o que foi digitado, e nada
 * estoura a largura da página em 1440 e 390 px.
 */
test.use({ storageState: OWNER_STORAGE_STATE });

const ABAS = [
  { id: "geral", label: "Geral", heading: "Dados da empresa (Termos e Privacidade)" },
  { id: "whatsapp", label: "WhatsApp", heading: "Evolution API" },
  { id: "automacao", label: "Automação (n8n)", heading: "Bot no n8n" },
  { id: "pagamentos", label: "Pagamentos", heading: "Mercado Pago" },
  { id: "email", label: "E-mail", heading: "E-mail transacional (SMTP)" },
  { id: "login", label: "Login", heading: "Login com Google" },
  { id: "marketing", label: "Marketing", heading: "Pixel do Meta" },
] as const;

const BASE = "/admin/configuracoes";

function nav(page: Page) {
  return page.getByRole("navigation", { name: "Assuntos das configurações" });
}

function h1(page: Page) {
  return page.getByRole("main").getByRole("heading", { level: 1 });
}

async function overflowPx(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

test.describe("Configurações da plataforma em abas", () => {
  test("/admin/configuracoes puro leva para Geral; aba desconhecida dá 404", async ({ page }) => {
    await page.goto(BASE);
    await expect(page).toHaveURL(/\/admin\/configuracoes\/geral$/);
    await expect(h1(page)).toHaveText("Configurações · Geral");
    await expect(nav(page).getByRole("link", { name: "Geral" })).toHaveAttribute("aria-current", "page");

    await page.goto(`${BASE}/nao-existe`);
    await expect(page.getByText("This page could not be found.")).toBeVisible();
  });

  test("cada aba abre pela barra: URL, título, aria-current e o card certo, e sobrevive ao recarregar", async ({ page }) => {
    await page.goto(`${BASE}/geral`);
    for (const aba of ABAS) {
      await nav(page).getByRole("link", { name: aba.label }).click();
      await expect(page).toHaveURL(new RegExp(`/admin/configuracoes/${aba.id}$`));
      await expect(h1(page)).toHaveText(`Configurações · ${aba.label}`);
      await expect(nav(page).getByRole("link", { name: aba.label })).toHaveAttribute("aria-current", "page");
      await expect(nav(page).locator('[aria-current="page"]')).toHaveCount(1);
      await expect(page.getByRole("heading", { name: aba.heading }).first()).toBeVisible();
    }

    await page.goto(`${BASE}/email`);
    await page.reload();
    await expect(h1(page)).toHaveText("Configurações · E-mail");
    await expect(page.getByRole("heading", { name: "E-mail transacional (SMTP)" })).toBeVisible();
  });

  test("tudo continua no lugar: nenhum card some ao dividir em abas", async ({ page }) => {
    const esperados: Record<string, string[]> = {
      geral: ["URLs detectadas", "Dados da empresa (Termos e Privacidade)"],
      whatsapp: ["Evolution API", "WhatsApp de cobrança"],
      automacao: ["n8n", "Bot no n8n", "Segredo da API interna (n8n → painel)"],
      pagamentos: ["Mercado Pago"],
      email: ["E-mail transacional (SMTP)"],
      login: ["Login com Google"],
      marketing: ["Pixel do Meta"],
    };
    for (const [aba, titulos] of Object.entries(esperados)) {
      await page.goto(`${BASE}/${aba}`);
      // Vários títulos carregam o botão de ajuda ⓘ dentro do heading: o nome acessível não é exato.
      for (const titulo of titulos) {
        await expect(page.getByRole("heading", { name: titulo, exact: titulo === "n8n" }).first(), `${aba}: ${titulo}`).toBeVisible();
      }
    }
    await page.goto(`${BASE}/automacao`);
    await expect(page.getByTestId("bot-flow-card")).toBeVisible();
    await page.goto(`${BASE}/geral`);
    await expect(page.getByRole("textbox", { name: /WhatsApp de atendimento comercial/ })).toBeVisible();
  });

  test("âncora do sino abre a aba certa com o card de cobrança à vista", async ({ page }) => {
    await page.goto(`${BASE}/whatsapp#whatsapp-cobranca`);
    await expect(h1(page)).toHaveText("Configurações · WhatsApp");
    await expect(page.locator("#whatsapp-cobranca")).toBeVisible();
  });

  test("teclado: setas, Home e End movem o foco entre as abas, Enter abre, foco visível", async ({ page }) => {
    await page.goto(`${BASE}/geral`);
    const links = nav(page).getByRole("link");
    await links.first().focus();
    await expect(links.first()).toBeFocused();

    await page.keyboard.press("ArrowRight");
    await expect(nav(page).getByRole("link", { name: "WhatsApp" })).toBeFocused();
    await page.keyboard.press("End");
    await expect(nav(page).getByRole("link", { name: "Marketing" })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(nav(page).getByRole("link", { name: "Geral" })).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(nav(page).getByRole("link", { name: "Marketing" })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(nav(page).getByRole("link", { name: "Geral" })).toBeFocused();

    // Foco visível: o contorno do foco por teclado existe (outline-style diferente de none).
    const outline = await nav(page).getByRole("link", { name: "Geral" }).evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).not.toBe("none");

    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/admin\/configuracoes\/whatsapp$/);
    await expect(h1(page)).toHaveText("Configurações · WhatsApp");
  });

  test("alterações não salvas: avisa ao trocar de aba; continuar editando mantém o texto; sair descarta", async ({ page }) => {
    await page.goto(`${BASE}/whatsapp`);
    const url = page.getByLabel("URL da Evolution");

    // Sem alteração, troca direto, sem aviso.
    await nav(page).getByRole("link", { name: "Geral" }).click();
    await expect(page).toHaveURL(/\/geral$/);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await nav(page).getByRole("link", { name: "WhatsApp" }).click();
    await expect(page).toHaveURL(/\/whatsapp$/);
    const original = await url.inputValue();
    await url.fill("https://evolution-nao-salva.exemplo.com");

    await nav(page).getByRole("link", { name: "E-mail" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Você tem alterações não salvas")).toBeVisible();
    await expect(page).toHaveURL(/\/whatsapp$/);

    await dialog.getByRole("button", { name: "Continuar editando" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(url).toHaveValue("https://evolution-nao-salva.exemplo.com");

    await nav(page).getByRole("link", { name: "E-mail" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Sair sem salvar" }).click();
    await expect(page).toHaveURL(/\/email$/);

    // Voltando, o valor salvo (não o digitado) está lá.
    await nav(page).getByRole("link", { name: "WhatsApp" }).click();
    await expect(page.getByLabel("URL da Evolution")).toHaveValue(original);
  });

  test("ponto de atenção da aba E-mail acompanha o SMTP salvo (sem servidor = ponto; com servidor = sem ponto)", async ({ page }) => {
    const row = await prisma.platformSettings.findUnique({ where: { id: 1 }, select: { smtpHost: true } });
    await page.goto(`${BASE}/geral`);
    const emailTab = nav(page).getByRole("link", { name: /^E-mail/ });
    if (row?.smtpHost) {
      await expect(emailTab.getByTestId("tab-attention-email")).toHaveCount(0);
      await expect(emailTab).toHaveAccessibleName("E-mail");
    } else {
      await expect(emailTab.getByTestId("tab-attention-email")).toBeVisible();
      await expect(emailTab).toHaveAccessibleName(/precisa de atenção/);
    }
  });

  for (const width of [1440, 390]) {
    test(`sem rolagem lateral da página em ${width}px, em todas as abas`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      for (const aba of ABAS) {
        await page.goto(`${BASE}/${aba.id}`);
        await expect(h1(page)).toHaveText(`Configurações · ${aba.label}`);
        expect(await overflowPx(page), `${aba.id} a ${width}px`).toBeLessThanOrEqual(0);
      }
    });
  }

  test("celular 390px: a barra rola sozinha e a aba ativa fica à vista (última aba, carga direta)", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/marketing`);
    const scroller = page.getByTestId("tab-nav");
    await expect(h1(page)).toHaveText("Configurações · Marketing");

    const dims = await scroller.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
    expect(dims.scrollWidth, "a barra é mais larga que a tela, então rola por dentro").toBeGreaterThan(dims.clientWidth);
    expect(await overflowPx(page)).toBeLessThanOrEqual(0);

    const active = nav(page).getByRole("link", { name: "Marketing" });
    await expect.poll(async () => {
      const box = await active.boundingBox();
      return box ? box.x >= 0 && box.x + box.width <= 390 : false;
    }).toBe(true);

    // Alvo de toque confortável.
    const box = await active.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});
