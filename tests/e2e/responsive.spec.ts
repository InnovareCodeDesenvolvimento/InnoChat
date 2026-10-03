import { test, expect, type Page } from "@playwright/test";
import { SEED_TENANT_SLUG } from "./fixtures/test-data";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";
import { prisma } from "./fixtures/db";

/**
 * Responsivo em TODAS as rotas, nas 4 larguras pedidas (360/768/1024/1440) — sem rolagem
 * horizontal da página (`scrollWidth <= clientWidth` no `<html>`). `themes.spec.ts` já cobre a
 * Agenda em 1440/390 com os 3 temas (screenshots de evidência); este spec generaliza o MESMO
 * critério (sem overflow) para o resto do produto, nas larguras exatas do pedido.
 */
test.use({ storageState: OWNER_STORAGE_STATE });

const WIDTHS = [360, 768, 1024, 1440];
const HEIGHT = 900;

async function noHorizontalOverflow(page: Page): Promise<{ ok: boolean; scrollWidth: number; clientWidth: number }> {
  return page.evaluate(() => ({
    ok: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

test.describe("Responsivo (360/768/1024/1440) — sem rolagem horizontal", () => {
  let professionalId: string;

  test.beforeAll(async () => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: SEED_TENANT_SLUG } });
    const ana = await prisma.professional.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Ana" } });
    professionalId = ana.id;
  });

  const tenantRoutes = [
    "/inicio",
    "/agenda",
    "/agendamentos",
    "/clientes",
    "/servicos",
    "/profissionais",
    "/whatsapp",
    "/mensagens-bot",
    "/configuracoes",
    "/configuracoes/aparencia",
    "/configuracoes/bloqueios",
    "/configuracoes/equipe",
    "/assinatura",
  ];
  const adminRoutes = ["/admin", "/admin/empresas", "/admin/planos", "/admin/configuracoes/geral", "/admin/configuracoes/whatsapp", "/admin/configuracoes/automacao", "/admin/configuracoes/pagamentos", "/admin/configuracoes/email", "/admin/configuracoes/login", "/admin/configuracoes/marketing", "/admin/cobranca", "/admin/saude"];
  const publicRoutes = ["/", "/login", "/cadastro", "/recuperar-senha", "/termos", "/privacidade"];

  for (const width of WIDTHS) {
    test(`rotas do painel em ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: HEIGHT });
      for (const route of [...tenantRoutes, `/profissionais/${professionalId}`]) {
        const path = `/${SEED_TENANT_SLUG}${route}`;
        await page.goto(path, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(150);
        const result = await noHorizontalOverflow(page);
        expect(result.ok, `${path} @ ${width}px: scrollWidth=${result.scrollWidth} > clientWidth=${result.clientWidth}`).toBe(true);
      }
    });

    test(`rotas do admin em ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: HEIGHT });
      for (const path of adminRoutes) {
        await page.goto(path, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(150);
        const result = await noHorizontalOverflow(page);
        expect(result.ok, `${path} @ ${width}px: scrollWidth=${result.scrollWidth} > clientWidth=${result.clientWidth}`).toBe(true);
      }
    });

    test(`rotas públicas em ${width}px`, async ({ page, context }) => {
      await context.clearCookies();
      await page.setViewportSize({ width, height: HEIGHT });
      for (const path of publicRoutes) {
        await page.goto(path, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(150);
        const result = await noHorizontalOverflow(page);
        expect(result.ok, `${path} @ ${width}px: scrollWidth=${result.scrollWidth} > clientWidth=${result.clientWidth}`).toBe(true);
      }
    });
  }
});
