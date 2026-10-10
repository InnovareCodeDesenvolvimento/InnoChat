import { test, expect } from "@playwright/test";
import { loginAndWaitForPanel } from "./fixtures/auth";
import { prisma, hashPassword, ensureBotPlan } from "./fixtures/db";
import { E2E_RUN_PREFIX } from "./fixtures/test-data";

/**
 * Cancelamento pelo painel (Termos §9): o dono abre o diálogo em Assinatura, vê a data em que o
 * acesso termina, confirma e vê "Cancelamento agendado para DD/MM"; desfaz e o aviso some. A equipe
 * (STAFF) só vê a explicação, sem o botão. Com a assinatura já cancelada, o painel mostra só a tela
 * de Assinatura. Empresa e usuários isolados, criados/limpos só por este arquivo.
 */

const RUN_PREFIX_LC = E2E_RUN_PREFIX.toLowerCase();
const SLUG = `${RUN_PREFIX_LC}-cancelamento`;
const OWNER_EMAIL = `${RUN_PREFIX_LC}-owner-cancelamento@e2e.innochat.local`;
const STAFF_EMAIL = `${RUN_PREFIX_LC}-staff-cancelamento@e2e.innochat.local`;
const PASSWORD = "e2e-cancelamento-pass-2026";

let tenantId: string;

test.describe("Cancelar assinatura pelo painel", () => {
  test.beforeAll(async () => {
    const plan = await ensureBotPlan();
    const tenant = await prisma.tenant.create({ data: { slug: SLUG, name: "Empresa Cancelamento (E2E)", timezone: "America/Sao_Paulo" } });
    tenantId = tenant.id;
    await prisma.subscription.create({
      data: { tenantId, planId: plan.id, status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000), firstPaidAt: new Date() },
    });
    for (const [email, role] of [
      [OWNER_EMAIL, "OWNER"],
      [STAFF_EMAIL, "STAFF"],
    ] as const) {
      const user = await prisma.user.create({
        data: { email, passwordHash: await hashPassword(PASSWORD), emailVerifiedAt: new Date(), termsAcceptedAt: new Date(), termsVersion: "e2e", onboardingTourCompletedAt: new Date() },
      });
      await prisma.membership.create({ data: { userId: user.id, tenantId, role } });
    }
  });

  test.afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { slug: SLUG } });
    await prisma.user.deleteMany({ where: { email: { in: [OWNER_EMAIL, STAFF_EMAIL] } } });
  });

  test("dono: abre o diálogo, mantém, cancela, vê o aviso de agendamento e desfaz", async ({ page }) => {
    await loginAndWaitForPanel(page, OWNER_EMAIL, PASSWORD, SLUG);
    await page.goto(`/${SLUG}/assinatura`);

    // O card tem o ícone de ajuda (regra do dono) e o botão discreto.
    await expect(page.getByRole("button", { name: /Como funciona: Cancelar assinatura/ })).toBeVisible();
    await page.getByTestId("assinatura-cancelar-abrir").click();

    const dialog = page.getByRole("dialog", { name: "Cancelar a assinatura?" });
    await expect(dialog.getByText(/o cancelamento vale no fim do período que você já pagou/i)).toBeVisible();
    await expect(dialog.getByText(/guardados por 90 dias/)).toBeVisible();
    await expect(dialog.getByRole("link", { name: /Exportar meus clientes/ })).toBeVisible();

    // "Manter minha assinatura" fecha sem cancelar.
    await page.getByTestId("assinatura-cancelar-manter").click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId("assinatura-cancelamento-agendado")).toHaveCount(0);

    // Cancela de verdade, com motivo.
    await page.getByTestId("assinatura-cancelar-abrir").click();
    await page.getByLabel(/Por que você está cancelando/).fill("Estou fechando o salão (E2E)");
    await page.getByTestId("assinatura-cancelar-confirmar").click();

    const aviso = page.getByTestId("assinatura-cancelamento-agendado");
    await expect(aviso).toBeVisible();
    await expect(aviso).toContainText(/Cancelamento agendado para \d{2}\/\d{2}\/\d{4}/);
    await expect(page.getByTestId("assinatura-cancelar-abrir")).toHaveCount(0);

    const sub = await prisma.subscription.findUniqueOrThrow({ where: { tenantId } });
    expect(sub.cancelAtPeriodEnd).toBe(true);
    expect(sub.cancelReason).toBe("Estou fechando o salão (E2E)");
    expect(sub.status).toBe("ACTIVE");

    // Até a data o painel inteiro continua funcionando.
    await page.goto(`/${SLUG}/servicos`);
    await expect(page.getByTestId("painel-cancelado")).toHaveCount(0);

    // Desfaz.
    await page.goto(`/${SLUG}/assinatura`);
    await page.getByRole("button", { name: "Desfazer cancelamento" }).click();
    await expect(page.getByTestId("assinatura-cancelamento-agendado")).toHaveCount(0);
    await expect(page.getByTestId("assinatura-cancelar-abrir")).toBeVisible();
    expect((await prisma.subscription.findUniqueOrThrow({ where: { tenantId } })).cancelAtPeriodEnd).toBe(false);
  });

  test("equipe (STAFF): vê a explicação, sem botão de cancelar", async ({ page }) => {
    await loginAndWaitForPanel(page, STAFF_EMAIL, PASSWORD, SLUG);
    await page.goto(`/${SLUG}/assinatura`);
    await expect(page.getByRole("main").getByText(/Só o dono da empresa pode cancelar a assinatura\. Se for o caso/)).toBeVisible();
    await expect(page.getByTestId("assinatura-cancelar-abrir")).toHaveCount(0);
  });

  test("assinatura cancelada: o painel mostra só a tela de Assinatura, com o botão de reativar", async ({ page }) => {
    await prisma.subscription.update({
      where: { tenantId },
      data: { status: "CANCELED", canceledAt: new Date(), currentPeriodEnd: new Date(Date.now() - 86_400_000) },
    });
    await loginAndWaitForPanel(page, OWNER_EMAIL, PASSWORD, SLUG);

    await page.goto(`/${SLUG}/servicos`);
    await expect(page.getByTestId("painel-cancelado")).toBeVisible();

    await page.goto(`/${SLUG}/assinatura`);
    await expect(page.getByTestId("painel-cancelado")).toHaveCount(0);
    await expect(page.getByText("Assinatura cancelada").first()).toBeVisible();
    await expect(page.getByRole("main").getByTestId("assinatura-reativar")).toBeVisible();
    // Sidebar enxuta: só a Assinatura.
    await expect(page.getByRole("link", { name: "Serviços" })).toHaveCount(0);
  });
});
