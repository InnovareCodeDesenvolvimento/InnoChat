import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma, hashPassword } from "./fixtures/db";
import { login } from "./fixtures/auth";
import { loadRunFixtures } from "./fixtures/test-data";
import { submitTwoFactorCode } from "./fixtures/two-factor";
import { totpCode } from "../../src/modules/two-factor/totp";

/**
 * Verificação em 2 etapas (item 3 das melhorias): ativar pela tela Minha conta, login em 2 passos
 * (código do app e código de recuperação de uso único) e a obrigatoriedade do admin da plataforma.
 * Usa usuários próprios (nunca o dono de seed) e mede o layout em 1440 e 390 de largura.
 */
const run = randomUUID().slice(0, 8);
const PASSWORD = "e2e-2fa-pass-2026";
const ownerEmail = `e2e-2fa-owner-${run}@e2e.innochat.local`;
const adminEmail = `e2e-2fa-admin-${run}@e2e.innochat.local`;

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe.serial("Verificação em 2 etapas", () => {
  // Estes testes começam SEM sessão: nada de storageState do dono de seed.
  test.use({ storageState: { cookies: [], origins: [] } });

  let slug = "";
  let secret = "";
  let recoveryCodes: string[] = [];

  test.beforeAll(async () => {
    const fixtures = loadRunFixtures();
    slug = fixtures.tenantBSlug;
    const owner = await prisma.user.create({
      data: {
        email: ownerEmail,
        passwordHash: await hashPassword(PASSWORD),
        emailVerifiedAt: new Date(),
        termsAcceptedAt: new Date(),
        termsVersion: "e2e",
        onboardingTourCompletedAt: new Date(),
      },
    });
    await prisma.membership.create({ data: { userId: owner.id, tenantId: fixtures.tenantBId, role: "OWNER" } });
    await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: await hashPassword(PASSWORD),
        emailVerifiedAt: new Date(),
        termsAcceptedAt: new Date(),
        termsVersion: "e2e",
        isPlatformAdmin: true,
      },
    });
  });

  test.afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: [ownerEmail, adminEmail] } } });
  });

  test("dono ativa pela tela Minha conta e recebe os 10 códigos de recuperação", async ({ page, browser }) => {
    await login(page, ownerEmail, PASSWORD);
    await expect(page).toHaveURL(new RegExp(`/${slug}/inicio`));
    // Cópia da sessão em outro aparelho (uma sessão esquecida ou roubada): ativar a 2FA derruba essa cópia.
    // Clona o cookie em vez de logar de novo: um login a mais gastaria o teto de logins por IP da suíte.
    const otherDevice = await browser.newContext({ storageState: await page.context().storageState() });
    const otherPage = await otherDevice.newPage();
    await otherPage.goto(`/${slug}/inicio`);
    await expect(otherPage).toHaveURL(new RegExp(`/${slug}/inicio`));
    // Convite discreto para o dono sem 2FA.
    await expect(page.getByTestId("two-factor-nudge")).toBeVisible();

    await page.goto(`/${slug}/minha-conta`);
    await page.getByRole("button", { name: "Ativar verificação em 2 etapas" }).click();
    await expect(page.getByAltText("QR code para o app de verificação")).toBeVisible();
    secret = ((await page.getByTestId("two-factor-secret").textContent()) ?? "").replace(/\s/g, "");
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);

    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await expectNoHorizontalOverflow(page);
    }

    await page.getByLabel("Código do app").fill("000000");
    await page.getByRole("button", { name: "Confirmar e ativar" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Código errado" })).toBeVisible();

    await page.getByLabel("Código do app").fill(totpCode(secret));
    await page.getByRole("button", { name: "Confirmar e ativar" }).click();
    const codesBox = page.getByTestId("recovery-codes");
    await expect(codesBox).toBeVisible();
    recoveryCodes = (await codesBox.locator("li").allTextContents()).map((t) => t.trim());
    expect(recoveryCodes).toHaveLength(10);
    await expectNoHorizontalOverflow(page);
    // Quem ativou continua logado (o cookie dele foi renovado); o outro aparelho caiu.
    expect(page.url()).toContain("/minha-conta");
    // A revogação vale em até 5 s (cache do `sessionVersion`, src/modules/auth/session-version.ts): repete até cair.
    await expect(async () => {
      await otherPage.goto(`/${slug}/inicio`);
      await expect(otherPage).toHaveURL(/\/login/, { timeout: 1_000 });
    }).toPass({ timeout: 20_000 });
    await otherDevice.close();

    await page.getByRole("button", { name: "Já guardei, concluir" }).click();
    await expect(page.getByTestId("two-factor-card").getByText("Ativada", { exact: true })).toBeVisible();
    await expect(page.getByText("Você tem 10 códigos de recuperação sem uso.")).toBeVisible();
  });

  test("login pede o código; código errado não entra; o certo entra", async ({ page }) => {
    await login(page, ownerEmail, PASSWORD);
    // Sem sessão ainda: a tela do código aparece e /inicio continua fechado.
    await expect(page.getByLabel("Código de verificação")).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await expectNoHorizontalOverflow(page);
    }
    await page.goto(`/${slug}/inicio`);
    await expect(page).toHaveURL(/\/login/);

    await login(page, ownerEmail, PASSWORD);
    await submitTwoFactorCode(page, "000000", true);
    await expect(page.getByRole("alert").filter({ hasText: "Código errado" })).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);

    // Passo seguinte (+30 s): o da ativação já foi consumido (anti-replay) e a janela aceita 1 à frente.
    await page.getByLabel("Código de verificação").fill(totpCode(secret, Date.now() + 30_000));
    await page.getByRole("button", { name: "Verificar e entrar" }).click();
    await expect(page).toHaveURL(new RegExp(`/${slug}/inicio`));
  });

  test("código de recuperação entra uma vez e não serve de novo", async ({ page }) => {
    const code = recoveryCodes[0]!;
    await login(page, ownerEmail, PASSWORD);
    await submitTwoFactorCode(page, code, true);
    await expect(page).toHaveURL(new RegExp(`/${slug}/inicio`));

    await page.context().clearCookies();
    await login(page, ownerEmail, PASSWORD);
    await submitTwoFactorCode(page, code, true);
    await expect(page.getByRole("alert").filter({ hasText: "Código errado" })).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });

  test("admin da plataforma sem 2FA só vê a tela de ativação no /admin", async ({ page }) => {
    await login(page, adminEmail, PASSWORD);
    await page.waitForURL(/\/admin/);
    await expect(page.getByRole("alert").filter({ hasText: "Ative a verificação em 2 etapas para continuar" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Ativar verificação em 2 etapas" })).toBeVisible();
    // Admin não pode desativar depois de ativar: o botão não existe nem na tela forçada.
    await page.goto("/admin/saude");
    await expect(page.getByRole("alert").filter({ hasText: "Ative a verificação em 2 etapas para continuar" })).toBeVisible();
    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      await page.setViewportSize({ width, height });
      await expectNoHorizontalOverflow(page);
    }
  });
});
