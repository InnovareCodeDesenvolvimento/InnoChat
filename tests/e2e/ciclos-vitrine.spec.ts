import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma, hashPassword } from "./fixtures/db";
import { loginAndWaitForPanel } from "./fixtures/auth";
import { E2E_RUN_PREFIX } from "./fixtures/test-data";

/**
 * Vitrine dos 4 ciclos do ponto de vista de quem ainda não paga e de quem já paga (QA da entrega dos 4 ciclos):
 * a landing e o cadastro seguem o que o plano oferece (plano só mensal, plano que perdeu ciclos) e nada rola para o lado
 * em 1440 e 390. O cadastro assume o plano de menor `sortOrder` e a landing mostra os planos ativos: cria-se UM plano
 * ativo com `sortOrder` -9000 que cumpre os dois papéis, apagado no fim. A vitrine da landing tem cache de 60 s no servidor:
 * a espera depois de mudar o plano é por poll (até 75 s), nunca por pausa fixa.
 */
const run = randomUUID().slice(0, 6).toUpperCase();
const RUN_LC = E2E_RUN_PREFIX.toLowerCase().replace(/_/g, "-");
const PLAN_NAME = `QA Ciclos ${run}`;
const PASSWORD = "e2e-vitrine-pass-2026";
const ALL = ["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL"] as const;
const FULL = { priceCents: 5900, quarterlyPriceCents: 16800, semiannualPriceCents: 31860, annualPriceCents: 59000 };

let planId = "";

async function expectNoOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, label).toBeLessThanOrEqual(0);
}

async function visibleCycles(page: Page, scope = page.getByTestId("ciclo-seletor")) {
  const found: string[] = [];
  for (const cycle of ALL) if ((await scope.getByTestId(`ciclo-${cycle}`).count()) > 0) found.push(cycle);
  return found;
}

test.beforeAll(async () => {
  const plan = await prisma.plan.create({ data: { code: `qa-vitrine-${run.toLowerCase()}`, name: PLAN_NAME, ...FULL, maxWhatsappNumbers: 1, maxProfessionals: 2, active: true, sortOrder: -9000 } });
  planId = plan.id;
});

test.afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { slug: { startsWith: `${RUN_LC}-vitrine-` } } });
  await prisma.user.deleteMany({ where: { email: { contains: `${RUN_LC}-vitrine-` } } });
  await prisma.plan.deleteMany({ where: { id: planId } });
});

test.describe.serial("Vitrine e cadastro seguem os ciclos do plano", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.setTimeout(150_000);

  for (const size of [{ w: 1440, h: 900 }, { w: 390, h: 844 }]) {
    test(`plano com os 4 ciclos: a landing mostra tudo e o cadastro não rola para o lado em ${size.w}px`, async ({ page }) => {
      await page.setViewportSize({ width: size.w, height: size.h });
      await page.goto("/");
      const card = page.getByTestId("plano-card").filter({ hasText: PLAN_NAME });
      await expect(card).toBeVisible();
      const selector = page.getByTestId("planos-ciclos");
      await expect(selector).toBeVisible();
      expect(await visibleCycles(page, selector)).toEqual([...ALL]);
      await expect(card.getByTestId("plano-a-partir-de")).toContainText("pagando a cada 12 meses");
      for (const cycle of ALL) {
        await selector.getByTestId(`ciclo-${cycle}`).click();
        await expectNoOverflow(page, `landing ${size.w} ${cycle}`);
      }
      await selector.getByTestId("ciclo-SEMIANNUAL").click();
      await expect(card.getByTestId("plano-periodo")).toContainText(/R\$\s?318,60/);
      await expect(card.getByTestId("plano-preco-mes")).toContainText(/R\$\s?53,10/);

      // O cadastro não pede mais o ciclo: a escolha mora na tela Assinatura.
      await page.goto("/cadastro");
      await expect(page.getByRole("main").getByTestId("signup-cobranca")).toHaveCount(0);
      await expectNoOverflow(page, `cadastro ${size.w}`);
    });
  }

  test("plano só com mensal: a Assinatura não oferece os outros ciclos; a landing também esconde", async ({ page }) => {
    await prisma.plan.update({ where: { id: planId }, data: { quarterlyPriceCents: null, semiannualPriceCents: null, annualPriceCents: null } });

    // Assinatura de quem já está nesse plano.
    const slug = `${RUN_LC}-vitrine-assin`;
    const email = `${RUN_LC}-vitrine-owner@e2e.innochat.local`;
    const tenant = await prisma.tenant.create({ data: { slug, name: `Empresa Vitrine ${run}`, timezone: "America/Sao_Paulo" } });
    await prisma.subscription.create({ data: { tenantId: tenant.id, planId, status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000), billingCycle: "MONTHLY" } });
    const owner = await prisma.user.create({
      data: { email, passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: new Date(), termsAcceptedAt: new Date(), termsVersion: "e2e", onboardingTourCompletedAt: new Date() },
    });
    await prisma.membership.create({ data: { userId: owner.id, tenantId: tenant.id, role: "OWNER" } });
    await loginAndWaitForPanel(page, email, PASSWORD, slug);
    await page.goto(`/${slug}/assinatura`);
    const card = page.getByTestId("assinatura-ciclo");
    await expect(card).toBeVisible();
    expect(await visibleCycles(page, card)).not.toEqual(expect.arrayContaining(["QUARTERLY"]));
    expect(await visibleCycles(page, card)).not.toEqual(expect.arrayContaining(["SEMIANNUAL"]));
    expect(await visibleCycles(page, card)).not.toEqual(expect.arrayContaining(["ANNUAL"]));
    await expect(card.getByText(/trimestral|semestral|anual/i)).toHaveCount(0);

    // Landing: some do cartão tudo o que não é mensal quando o cache de 60 s vence.
    await page.context().clearCookies();
    await expect
      .poll(
        async () => {
          await page.goto("/");
          const text = await page.getByTestId("plano-card").filter({ hasText: PLAN_NAME }).innerText();
          return /pagando a cada/.test(text);
        },
        { timeout: 75_000, intervals: [3_000] },
      )
      .toBe(false);
    const cardText = await page.getByTestId("plano-card").filter({ hasText: PLAN_NAME }).innerText();
    expect(cardText).toMatch(/R\$\s?59,00/);
    expect(cardText).not.toMatch(/trimestral|semestral|anual/i);
  });

  test("plano que perdeu semestral e anual (sem assinantes neles) mostra só mensal e trimestral na landing", async ({ page }) => {
    await prisma.plan.update({ where: { id: planId }, data: { quarterlyPriceCents: 16800 } });
    await expect
      .poll(
        async () => {
          await page.goto("/");
          return (await page.getByTestId("plano-card").filter({ hasText: PLAN_NAME }).innerText()).includes("pagando a cada 3 meses");
        },
        { timeout: 75_000, intervals: [3_000] },
      )
      .toBe(true);
    const text = await page.getByTestId("plano-card").filter({ hasText: PLAN_NAME }).innerText();
    expect(text).not.toMatch(/6 meses|12 meses/);
    expect(await visibleCycles(page, page.getByTestId("planos-ciclos"))).toEqual(["MONTHLY", "QUARTERLY"]);
  });
});
