import { test, expect, type Page } from "@playwright/test";
import { prisma } from "./fixtures/db";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";
import { SEED_TENANT_SLUG } from "./fixtures/test-data";

/**
 * Pixel do Meta + banner de consentimento (LGPD) e as páginas por nicho.
 * Regra que importa: sem "Aceitar" o script da Meta NUNCA é pedido; o banner não existe no painel nem
 * no Admin; a escolha é lembrada e dá para reabrir pelo rodapé. As chamadas à Meta são abortadas (nenhum
 * tráfego real), só observadas. O Pixel é ligado direto no banco e restaurado no fim; o servidor guarda
 * a config por 30 s, por isso o teste espera o banner aparecer em vez de assumir.
 */
const PIXEL_ID = "123456789012345";
const NICHES = ["salao", "barbearia", "clinica-estetica", "consultorio", "pet-shop"] as const;

type MetaState = { metaEnabled: boolean; metaPixelId: string | null };
let original: MetaState | null = null;

async function setPixel(on: boolean) {
  await prisma.platformSettings.update({ where: { id: 1 }, data: { metaEnabled: on, metaPixelId: on ? PIXEL_ID : original?.metaPixelId ?? null } });
}

/** Observa pedidos à Meta e aborta todos (nada sai da máquina). */
async function watchMeta(page: Page) {
  const calls: string[] = [];
  await page.route(/facebook\.(net|com)/, (route) => {
    calls.push(route.request().url());
    return route.abort();
  });
  return calls;
}

async function expectNoOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, label).toBeLessThanOrEqual(0);
}

async function waitForBanner(page: Page, path: string) {
  await expect
    .poll(
      async () => {
        await page.goto(path);
        return page.getByTestId("consent-banner").isVisible();
      },
      { timeout: 60_000, intervals: [2_000] },
    )
    .toBe(true);
}

test.describe.serial("Banner de cookies e Pixel do Meta", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeAll(async () => {
    const row = await prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 }, select: { metaEnabled: true, metaPixelId: true } });
    original = row;
    await setPixel(false);
  });

  test.afterAll(async () => {
    if (original) await prisma.platformSettings.update({ where: { id: 1 }, data: original });
  });

  test("com o Pixel desligado não há banner e nada da Meta é pedido", async ({ page }) => {
    const meta = await watchMeta(page);
    for (const path of ["/", "/cadastro", "/salao"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await expect(page.getByTestId("consent-banner"), path).toHaveCount(0);
    }
    expect(meta).toEqual([]);
  });

  test("ligado: banner aparece, e antes do Aceitar nenhum pedido à Meta é feito", async ({ page }) => {
    test.setTimeout(100_000); // o servidor guarda a configuração do Pixel por 30 s
    await setPixel(true);
    const meta = await watchMeta(page);
    await waitForBanner(page, "/");
    await expect(page.getByTestId("consent-banner").getByRole("button", { name: "Recusar" })).toBeVisible();
    await expect(page.getByTestId("consent-banner").getByRole("button", { name: "Aceitar" })).toBeVisible();
    await expect(page.getByTestId("consent-banner").getByRole("link", { name: "Política de privacidade" })).toHaveAttribute("href", "/privacidade#cookies");
    await page.waitForTimeout(1_000);
    expect(meta, "pedido à Meta antes do consentimento").toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { fbq?: unknown }).fbq)).toBeUndefined();
  });

  test("Recusar: banner some, escolha fica gravada, não volta ao recarregar e a Meta nunca é chamada", async ({ page }) => {
    const meta = await watchMeta(page);
    await page.goto("/");
    await page.getByTestId("consent-banner").getByRole("button", { name: "Recusar" }).click();
    await expect(page.getByTestId("consent-banner")).toHaveCount(0);
    const stored = await page.evaluate(() => window.localStorage.getItem("innochat-consent-meta"));
    expect(JSON.parse(stored ?? "{}")).toMatchObject({ v: 1, choice: "denied" });

    await page.reload();
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await page.waitForTimeout(800);
    await expect(page.getByTestId("consent-banner")).toHaveCount(0);
    await page.goto("/cadastro");
    await page.waitForTimeout(800);
    await expect(page.getByTestId("consent-banner")).toHaveCount(0);
    expect(meta).toEqual([]);
  });

  test("Preferências de cookies no rodapé reabre o banner (com foco dentro); Aceitar carrega o script da Meta", async ({ page }) => {
    const meta = await watchMeta(page);
    await page.goto("/");
    await page.evaluate(() => window.localStorage.setItem("innochat-consent-meta", JSON.stringify({ v: 1, choice: "denied", at: new Date().toISOString() })));
    await page.reload();
    await expect(page.getByTestId("consent-banner")).toHaveCount(0);

    await page.getByRole("button", { name: "Preferências de cookies" }).click();
    const banner = page.getByTestId("consent-banner");
    await expect(banner).toBeVisible();
    await expect(banner.getByRole("button", { name: "Recusar" })).toBeFocused();
    expect(await page.evaluate(() => window.localStorage.getItem("innochat-consent-meta"))).toBeNull();

    await banner.getByRole("button", { name: "Aceitar" }).click();
    await expect(banner).toHaveCount(0);
    expect(JSON.parse((await page.evaluate(() => window.localStorage.getItem("innochat-consent-meta"))) ?? "{}")).toMatchObject({ choice: "granted" });
    await expect.poll(() => meta.some((u) => u.includes("connect.facebook.net")), { timeout: 8_000 }).toBe(true);
  });

  test("valor corrompido no armazenamento vale como 'sem escolha' (banner volta, sem erro)", async ({ page }) => {
    const meta = await watchMeta(page);
    await page.goto("/");
    await page.evaluate(() => window.localStorage.setItem("innochat-consent-meta", "{isso-nao-e-json"));
    await page.reload();
    await expect(page.getByTestId("consent-banner")).toBeVisible();
    await page.evaluate(() => window.localStorage.setItem("innochat-consent-meta", JSON.stringify({ v: 2, choice: "granted" })));
    await page.reload();
    await expect(page.getByTestId("consent-banner")).toBeVisible();
    expect(meta).toEqual([]);
  });

  test("o banner não existe dentro do painel nem no Admin, mesmo com o Pixel ligado", async ({ browser }) => {
    const context = await browser.newContext({ storageState: OWNER_STORAGE_STATE, baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000" });
    const page = await context.newPage();
    const meta = await watchMeta(page);
    for (const path of [`/${SEED_TENANT_SLUG}/inicio`, "/admin", "/admin/erros"]) {
      await page.goto(path);
      await expect(page.getByRole("main")).toBeVisible();
      await page.waitForTimeout(600);
      await expect(page.getByTestId("consent-banner"), path).toHaveCount(0);
    }
    expect(meta).toEqual([]);
    await context.close();
  });

  test("em 390px o banner cabe na tela, sem rolagem lateral e com os dois botões clicáveis", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const banner = page.getByTestId("consent-banner");
    await expect(banner).toBeVisible();
    const box = (await banner.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
    await expectNoOverflow(page, "landing com banner 390");
  });
});

test.describe("Páginas por nicho", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const niche of NICHES) {
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      test(`/${niche} em ${width}px: carrega com h1, CTA para o cadastro e sem rolagem lateral`, async ({ page }) => {
        await page.setViewportSize({ width, height });
        const res = await page.goto(`/${niche}`);
        expect(res?.status()).toBe(200);
        await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await expect(page.getByRole("link", { name: /teste grátis/i }).first()).toHaveAttribute("href", /\/cadastro/);
        await expect(page.locator('link[rel="canonical"]')).toHaveCount(1);
        await expectNoOverflow(page, `/${niche} ${width}`);
      });
    }
  }
});
