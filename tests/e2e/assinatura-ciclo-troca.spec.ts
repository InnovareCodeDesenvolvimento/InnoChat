import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma, hashPassword } from "./fixtures/db";
import { loginAndWaitForPanel } from "./fixtures/auth";
import { E2E_RUN_PREFIX } from "./fixtures/test-data";

/**
 * Revisão do Órion aos 4 ciclos (I-2): na tela de Assinatura, trocar para um plano que não tem o ciclo que a empresa paga
 * hoje não é aceito em silêncio (o diálogo explica e o botão fica desligado), e quem já caiu no mensal por outro caminho
 * (plano que perdeu o ciclo) vê o aviso de que a próxima fatura sai mensal.
 */
const run = randomUUID().slice(0, 6).toUpperCase();
const RUN_LC = E2E_RUN_PREFIX.toLowerCase().replace(/_/g, "-");
const PASSWORD = "e2e-troca-ciclo-pass-2026";
const SLUG = `${RUN_LC}-trocaciclo-${run.toLowerCase()}`;
const EMAIL = `${RUN_LC}-trocaciclo-owner-${run.toLowerCase()}@e2e.innochat.local`;
const NAME_A = `Troca Ciclo A ${run}`;
const NAME_B = `Troca Ciclo B ${run}`;
const FULL = { priceCents: 5900, quarterlyPriceCents: 16800, semiannualPriceCents: 31860, annualPriceCents: 59000 };

let planAId = "";
let planBId = "";

test.use({ storageState: { cookies: [], origins: [] } });

test.beforeAll(async () => {
  const a = await prisma.plan.create({ data: { code: `e2e-troca-a-${run.toLowerCase()}`, name: NAME_A, ...FULL, maxWhatsappNumbers: 5, maxProfessionals: 10, active: true, sortOrder: -8000 } });
  const b = await prisma.plan.create({ data: { code: `e2e-troca-b-${run.toLowerCase()}`, name: NAME_B, ...FULL, semiannualPriceCents: null, maxWhatsappNumbers: 5, maxProfessionals: 10, active: true, sortOrder: -7999 } });
  planAId = a.id;
  planBId = b.id;
  const tenant = await prisma.tenant.create({ data: { slug: SLUG, name: `Empresa Troca Ciclo ${run}`, timezone: "America/Sao_Paulo" } });
  await prisma.subscription.create({ data: { tenantId: tenant.id, planId: a.id, status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000), billingCycle: "SEMIANNUAL" } });
  const owner = await prisma.user.create({
    data: { email: EMAIL, passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: new Date(), termsAcceptedAt: new Date(), termsVersion: "e2e", onboardingTourCompletedAt: new Date() },
  });
  await prisma.membership.create({ data: { userId: owner.id, tenantId: tenant.id, role: "OWNER" } });
});

test.afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { slug: SLUG } });
  await prisma.user.deleteMany({ where: { email: EMAIL } });
  await prisma.plan.deleteMany({ where: { id: { in: [planAId, planBId] } } });
});

test.describe.serial("Assinatura: ciclo e troca de plano", () => {
  test("plano sem o ciclo atual: o diálogo explica e não deixa confirmar; a assinatura não muda", async ({ page }) => {
    await loginAndWaitForPanel(page, EMAIL, PASSWORD, SLUG);
    await page.goto(`/${SLUG}/assinatura`);
    const cardB = page.getByRole("main").locator("div.group").filter({ hasText: NAME_B });
    await cardB.getByRole("button", { name: /Fazer upgrade|Fazer downgrade/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("troca-sem-ciclo")).toContainText(`O plano ${NAME_B} não tem pagamento a cada 6 meses. Escolha outro ciclo antes de trocar de plano`);
    await expect(dialog.getByRole("button", { name: "Confirmar" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    const sub = await prisma.subscription.findFirstOrThrow({ where: { tenant: { slug: SLUG } } });
    expect(sub).toMatchObject({ planId: planAId, billingCycle: "SEMIANNUAL", pendingPlanId: null });
  });

  test("com outro ciclo que os dois planos têm, a troca passa", async ({ page }) => {
    await loginAndWaitForPanel(page, EMAIL, PASSWORD, SLUG);
    await page.goto(`/${SLUG}/assinatura`);
    await page.getByRole("main").getByTestId("assinatura-ciclo").getByTestId("ciclo-QUARTERLY").click();
    await page.getByRole("button", { name: "Salvar cobrança" }).click();
    await expect.poll(async () => (await prisma.subscription.findFirstOrThrow({ where: { tenant: { slug: SLUG } } })).billingCycle).toBe("QUARTERLY");
    await page.reload();
    const cardB = page.getByRole("main").locator("div.group").filter({ hasText: NAME_B });
    await cardB.getByRole("button", { name: /Fazer upgrade|Fazer downgrade/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("troca-sem-ciclo")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Confirmar" }).click();
    await expect.poll(async () => (await prisma.subscription.findFirstOrThrow({ where: { tenant: { slug: SLUG } } })).planId).toBe(planBId);
  });

  test("plano que perdeu o ciclo guardado: aviso de que a próxima fatura sai mensal", async ({ page }) => {
    await prisma.plan.update({ where: { id: planBId }, data: { quarterlyPriceCents: null } });
    await loginAndWaitForPanel(page, EMAIL, PASSWORD, SLUG);
    await page.goto(`/${SLUG}/assinatura`);
    await expect(page.getByRole("main").getByTestId("ciclo-caiu-no-mensal")).toContainText("Seu plano não tem mais pagamento a cada 3 meses; a próxima fatura sai mensal.");
    await expect(page.getByRole("main").getByTestId("proxima-fatura")).toContainText(/R\$\s?59,00/);
  });
});
