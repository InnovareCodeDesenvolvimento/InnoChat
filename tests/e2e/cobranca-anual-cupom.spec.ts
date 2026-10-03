import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma, hashPassword } from "./fixtures/db";
import { loginAndWaitForPanel } from "./fixtures/auth";
import { E2E_RUN_PREFIX } from "./fixtures/test-data";

/**
 * Plano anual e cupons, do ponto de vista de quem paga: cadastro (escolha mensal/anual, validação
 * ao vivo do cupom, resumo da 1ª fatura) e tela Assinatura (trocar ciclo, aplicar cupom). Os cupons
 * ruins (vencido, de outro plano, esgotado, desativado) são montados no banco; a tela é que prova
 * que a pessoa vê uma recusa clara e que nada é gravado.
 *
 * O cadastro usa o plano padrão (menor `sortOrder`): ganha preço anual temporário, restaurado no fim.
 * Limites em memória do servidor: prévia 20/10 min por IP e 10/10 min por empresa; este arquivo fica
 * abaixo disso, mas rodar duas vezes seguidas contra o mesmo servidor exige reiniciá-lo.
 */
const run = randomUUID().slice(0, 6).toUpperCase();
const RUN_LC = E2E_RUN_PREFIX.toLowerCase();
const PASSWORD = "e2e-ciclo-pass-2026";

const C = {
  anualOnly: `E2EANU${run}`,
  any20: `E2EANY${run}`,
  expired: `E2EEXP${run}`,
  otherPlan: `E2EPLN${run}`,
  exhausted: `E2EESG${run}`,
  inactive: `E2EOFF${run}`,
  futureStart: `E2EFUT${run}`,
};
const allCodes = Object.values(C);

async function expectNoOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, label).toBeLessThanOrEqual(0);
}

let defaultPlanId = "";
let defaultPlanOriginalAnnual: number | null = null;
let otherPlanId = "";

test.beforeAll(async () => {
  const plan = await prisma.plan.findFirstOrThrow({ orderBy: { sortOrder: "asc" } });
  defaultPlanId = plan.id;
  defaultPlanOriginalAnnual = plan.annualPriceCents;
  // 10 mensalidades no ano = "2 meses grátis".
  await prisma.plan.update({ where: { id: plan.id }, data: { annualPriceCents: plan.priceCents * 10 } });
  const other = await prisma.plan.create({ data: { code: `e2e-outro-${run.toLowerCase()}`, name: `Outro ${run}`, priceCents: 7000, maxWhatsappNumbers: 1, maxProfessionals: 1, active: false, sortOrder: 997 } });
  otherPlanId = other.id;

  const base = { kind: "PERCENT", value: 20, duration: "ONCE", active: true } as const;
  await prisma.coupon.create({ data: { ...base, code: C.anualOnly, appliesToCycle: "ANNUAL" } });
  await prisma.coupon.create({ data: { ...base, code: C.any20, appliesToCycle: "ANY" } });
  await prisma.coupon.create({ data: { ...base, code: C.expired, appliesToCycle: "ANY", validUntil: new Date(Date.now() - 86_400_000) } });
  await prisma.coupon.create({ data: { ...base, code: C.exhausted, appliesToCycle: "ANY", maxRedemptions: 1, redemptionsCount: 1 } });
  await prisma.coupon.create({ data: { ...base, code: C.inactive, appliesToCycle: "ANY", active: false } });
  await prisma.coupon.create({ data: { ...base, code: C.futureStart, appliesToCycle: "ANY", validFrom: new Date(Date.now() + 5 * 86_400_000) } });
  const onlyOther = await prisma.coupon.create({ data: { ...base, code: C.otherPlan, appliesToCycle: "ANY" } });
  await prisma.couponPlan.create({ data: { couponId: onlyOther.id, planId: otherPlanId } });
});

test.afterAll(async () => {
  await prisma.subscription.updateMany({ where: { couponId: { not: null }, coupon: { code: { in: allCodes } } }, data: { couponId: null, couponCyclesRemaining: null } });
  await prisma.couponRedemption.deleteMany({ where: { coupon: { code: { in: allCodes } } } });
  await prisma.tenant.deleteMany({ where: { slug: { startsWith: `${RUN_LC.replace(/_/g, "-")}-anual-` } } });
  await prisma.coupon.deleteMany({ where: { code: { in: allCodes } } });
  await prisma.plan.deleteMany({ where: { id: otherPlanId } });
  await prisma.plan.update({ where: { id: defaultPlanId }, data: { annualPriceCents: defaultPlanOriginalAnnual } });
  await prisma.user.deleteMany({ where: { email: { contains: `${RUN_LC}-anual-` } } });
});

test.describe.serial("Cadastro com plano anual e cupom", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("mostra mensal/anual com a economia e o resumo da 1ª fatura acompanha a escolha", async ({ page }) => {
    await page.goto("/cadastro");
    const section = page.getByTestId("signup-cobranca");
    await expect(section.getByText("Como você prefere pagar depois do teste")).toBeVisible();
    await expect(section.getByText("2 meses grátis")).toBeVisible();
    const summary = page.getByTestId("signup-resumo-cobranca");
    await expect(summary).toContainText("primeira fatura");
    await expect(summary).not.toContainText("cobre 12 meses");

    await section.getByText("Anual", { exact: true }).click();
    await expect(summary).toContainText("(cobre 12 meses)");
    await expect(summary).toContainText(/R\$\s?599,00/);
    await section.getByText("Mensal", { exact: true }).click();
    await expect(summary).toContainText(/R\$\s?59,90/);
    await expectNoOverflow(page, "cadastro 1280");
  });

  test("cupom: validação ao vivo, desconto no resumo, e a recusa certa para cada cupom ruim", async ({ page }) => {
    await page.goto("/cadastro");
    const section = page.getByTestId("signup-cobranca");
    const summary = page.getByTestId("signup-resumo-cobranca");
    await section.getByText("Anual", { exact: true }).click();
    await section.getByRole("button", { name: "Tenho um cupom" }).click();
    const input = section.getByLabel("Cupom de desconto");

    // Cupom do anual, escolha anual: vale, e o resumo mostra o preço com desconto (599,00 -> 479,20).
    await input.fill(C.anualOnly.toLowerCase());
    await expect(input).toHaveValue(C.anualOnly);
    await expect(section.getByText(/Cupom válido: /)).toBeVisible();
    await expect(summary).toContainText(/R\$\s?479,20/);
    await expect(summary).toContainText(/em vez de R\$\s?599,00/);

    // Troca para mensal: o MESMO cupom deixa de valer (a validação refaz sozinha) e o resumo volta ao cheio.
    await section.getByText("Mensal", { exact: true }).click();
    await expect(section.getByRole("alert")).toBeVisible();
    await expect(summary).toContainText(/R\$\s?59,90/);
    await expect(summary).not.toContainText("em vez de");

    // Volta ao anual e testa cada cupom ruim: sempre uma recusa visível e o preço cheio.
    await section.getByText("Anual", { exact: true }).click();
    for (const bad of [C.expired, C.otherPlan, C.exhausted, C.inactive, C.futureStart, `NAOEXISTE${run}`]) {
      await input.fill(bad);
      await expect(section.getByRole("alert"), bad).toBeVisible();
      await expect(section.getByText(/Cupom válido: /), bad).toHaveCount(0);
      await expect(summary, bad).toContainText(/R\$\s?599,00/);
      await expect(summary, bad).not.toContainText("em vez de");
    }

    // Um cupom bom depois dos ruins limpa o erro.
    await input.fill(C.any20);
    await expect(section.getByText(/Cupom válido: /)).toBeVisible();
    await expect(section.getByRole("alert")).toHaveCount(0);
  });

  test("criar a conta anual com cupom grava ciclo, cupom e resgate; a 1ª fatura (fim do teste) já sai anual com desconto", async ({ page }) => {
    const slug = `${RUN_LC.replace(/_/g, "-")}-anual-ok`;
    const email = `${RUN_LC}-anual-ok@e2e.innochat.local`;
    await page.goto("/cadastro");
    await page.getByLabel("Nome da empresa").fill(`${E2E_RUN_PREFIX} Empresa Anual`);
    await page.getByLabel("Endereço da empresa").fill(slug);
    await page.getByLabel("Seu nome").fill("Dona Anual E2E");
    await page.getByLabel("CPF ou CNPJ *", { exact: true }).fill("52998224725");
    await page.getByLabel("E-mail *", { exact: true }).fill(email);
    await page.getByLabel("Senha *", { exact: true }).fill(PASSWORD);
    await page.getByLabel("Confirmar senha").fill(PASSWORD);
    const section = page.getByTestId("signup-cobranca");
    await section.getByText("Anual", { exact: true }).click();
    await section.getByRole("button", { name: "Tenho um cupom" }).click();
    await section.getByLabel("Cupom de desconto").fill(C.any20);
    await expect(section.getByText(/Cupom válido: /)).toBeVisible();
    await page.locator('input[type="checkbox"]').check();
    await page.getByRole("button", { name: "Criar conta" }).click();
    await expect(page.getByText("Confirme seu e-mail").first()).toBeVisible();

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug }, include: { subscription: true } });
    expect(tenant.subscription?.billingCycle).toBe("ANNUAL");
    // Cupom "só na 1ª cobrança" já é gasto pela fatura do fim do teste: a assinatura não guarda mais o cupom,
    // quem carrega a prova é a fatura (valor líquido, código e desconto) e o resgate.
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { subscriptionId: tenant.subscription!.id } });
    expect(invoice).toMatchObject({ cycle: "ANNUAL", couponCode: C.any20, amountCents: 47920, discountCents: 11980 });
    const redemption = await prisma.couponRedemption.findFirst({ where: { tenantId: tenant.id, coupon: { code: C.any20 } } });
    expect(redemption).not.toBeNull();
    expect((await prisma.coupon.findUniqueOrThrow({ where: { code: C.any20 } })).redemptionsCount).toBe(1);
  });

  test("cupom inválido no envio (esgotou entre a conferência e o clique) derruba o cadastro inteiro sem criar nada", async ({ page }) => {
    const slug = `${RUN_LC.replace(/_/g, "-")}-anual-bad`;
    const email = `${RUN_LC}-anual-bad@e2e.innochat.local`;
    await page.goto("/cadastro");
    await page.getByLabel("Nome da empresa").fill(`${E2E_RUN_PREFIX} Empresa Anual Ruim`);
    await page.getByLabel("Endereço da empresa").fill(slug);
    await page.getByLabel("Seu nome").fill("Dona Anual E2E");
    await page.getByLabel("CPF ou CNPJ *", { exact: true }).fill("52998224725");
    await page.getByLabel("E-mail *", { exact: true }).fill(email);
    await page.getByLabel("Senha *", { exact: true }).fill(PASSWORD);
    await page.getByLabel("Confirmar senha").fill(PASSWORD);
    const section = page.getByTestId("signup-cobranca");
    await section.getByRole("button", { name: "Tenho um cupom" }).click();
    await section.getByLabel("Cupom de desconto").fill(C.futureStart);
    await page.locator('input[type="checkbox"]').check();
    await page.getByRole("button", { name: "Criar conta" }).click();
    await expect(section.getByRole("alert")).toBeVisible();
    await expect(page.getByText("Confirme seu e-mail")).toHaveCount(0);
    expect(await prisma.tenant.count({ where: { slug } })).toBe(0);
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  test("cadastro em 390px: escolha de ciclo e cupom sem rolagem horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/cadastro");
    const section = page.getByTestId("signup-cobranca");
    await section.getByRole("button", { name: "Tenho um cupom" }).click();
    await expect(section.getByLabel("Cupom de desconto")).toBeVisible();
    await expectNoOverflow(page, "cadastro 390");
  });
});

test.describe.serial("Assinatura: trocar o ciclo e aplicar cupom", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  const slug = `${RUN_LC.replace(/_/g, "-")}-anual-assin`;
  const ownerEmail = `${RUN_LC}-anual-assin-owner@e2e.innochat.local`;
  const staffEmail = `${RUN_LC}-anual-assin-staff@e2e.innochat.local`;
  let tenantId = "";

  test.beforeAll(async () => {
    const plan = await prisma.plan.create({ data: { code: `e2e-ciclo-${run.toLowerCase()}`, name: `Ciclo ${run}`, priceCents: 10000, annualPriceCents: 100000, maxWhatsappNumbers: 1, maxProfessionals: 3, active: false, sortOrder: 996 } });
    const tenant = await prisma.tenant.create({ data: { slug, name: `Empresa Assinatura ${run}`, timezone: "America/Sao_Paulo" } });
    tenantId = tenant.id;
    await prisma.subscription.create({ data: { tenantId, planId: plan.id, status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 20 * 86_400_000), billingCycle: "MONTHLY" } });
    const hash = await hashPassword(PASSWORD);
    const common = { passwordHash: hash, emailVerifiedAt: new Date(), termsAcceptedAt: new Date(), termsVersion: "e2e", onboardingTourCompletedAt: new Date() };
    const owner = await prisma.user.create({ data: { email: ownerEmail, ...common } });
    const staff = await prisma.user.create({ data: { email: staffEmail, ...common } });
    await prisma.membership.create({ data: { userId: owner.id, tenantId, role: "OWNER" } });
    await prisma.membership.create({ data: { userId: staff.id, tenantId, role: "STAFF" } });
  });

  test.afterAll(async () => {
    await prisma.couponRedemption.deleteMany({ where: { tenantId } });
    await prisma.tenant.deleteMany({ where: { slug } });
    await prisma.plan.deleteMany({ where: { code: `e2e-ciclo-${run.toLowerCase()}` } });
  });

  test("dono troca para anual e vê a próxima fatura de 12 meses; volta para mensal", async ({ page }) => {
    await loginAndWaitForPanel(page, ownerEmail, PASSWORD, slug);
    await page.goto(`/${slug}/assinatura`);
    const card = page.getByTestId("assinatura-ciclo");
    await expect(card.getByText("Hoje a cobrança é mensal.").first()).toBeVisible();
    await expect(card.getByTestId("proxima-fatura")).toContainText(/R\$\s?100,00/);
    await expect(card.getByRole("button", { name: "Salvar cobrança" })).toBeDisabled();

    await card.getByText("Anual", { exact: true }).click();
    await card.getByRole("button", { name: "Salvar cobrança" }).click();
    await expect(page.getByText("Cobrança anual escolhida.").first()).toBeVisible();
    await expect(card.getByText("Hoje a cobrança é anual.")).toBeVisible();
    await expect(card.getByTestId("proxima-fatura")).toContainText(/R\$\s?1\.000,00/);
    await expect(card.getByTestId("proxima-fatura")).toContainText("cobre 12 meses");
    expect((await prisma.subscription.findUniqueOrThrow({ where: { tenantId } })).billingCycle).toBe("ANNUAL");
    await expectNoOverflow(page, "assinatura 1280");
  });

  test("cupom ruim é recusado com mensagem e nada é gravado; cupom bom é aplicado e entra na próxima fatura", async ({ page }) => {
    await loginAndWaitForPanel(page, ownerEmail, PASSWORD, slug);
    await page.goto(`/${slug}/assinatura`);
    const card = page.getByTestId("assinatura-cupom");
    const field = card.getByLabel("Código do cupom");

    for (const bad of [C.expired, C.otherPlan, C.exhausted, C.inactive, `NAOEXISTE${run}`]) {
      await field.fill(bad);
      await card.getByRole("button", { name: "Conferir valor" }).click();
      await expect(card.getByRole("alert"), bad).toBeVisible();
      await expect(card.getByText("Cupom válido"), bad).toHaveCount(0);
    }
    expect((await prisma.subscription.findUniqueOrThrow({ where: { tenantId } })).couponId).toBeNull();

    // Aplicar direto um cupom ruim também é recusado (não depende de ter conferido antes).
    await field.fill(C.exhausted);
    await card.getByRole("button", { name: "Aplicar cupom" }).click();
    await expect(card.getByRole("alert")).toBeVisible();
    expect((await prisma.subscription.findUniqueOrThrow({ where: { tenantId } })).couponId).toBeNull();

    await field.fill(C.anualOnly);
    await card.getByRole("button", { name: "Conferir valor" }).click();
    await expect(card.getByText("Cupom válido")).toBeVisible();
    await expect(card).toContainText(/R\$\s?800,00/);
    await card.getByRole("button", { name: "Aplicar cupom" }).click();
    await expect(page.getByText("Cupom aplicado.", { exact: true }).first()).toBeVisible();
    await expect(card.getByText(C.anualOnly)).toBeVisible();
    await expect(page.getByTestId("proxima-fatura")).toContainText(/R\$\s?800,00/);
    const sub = await prisma.subscription.findUniqueOrThrow({ where: { tenantId }, include: { coupon: true } });
    expect(sub.coupon?.code).toBe(C.anualOnly);
    expect(await prisma.couponRedemption.count({ where: { tenantId } })).toBe(1);
  });

  test("voltar para mensal avisa que o cupom do anual fica guardado, sem gastar cobranças", async ({ page }) => {
    await loginAndWaitForPanel(page, ownerEmail, PASSWORD, slug);
    await page.goto(`/${slug}/assinatura`);
    const card = page.getByTestId("assinatura-ciclo");
    await card.getByText("Mensal", { exact: true }).click();
    await card.getByRole("button", { name: "Salvar cobrança" }).click();
    await expect(page.getByText("Seu cupom não vale nesse tipo de cobrança. Ele fica guardado.").first()).toBeVisible();
    await expect(page.getByTestId("assinatura-cupom").getByText(/fica guardado, sem gastar cobranças/)).toBeVisible();
    await expect(page.getByTestId("proxima-fatura")).toContainText(/R\$\s?100,00/);
    await expect(page.getByTestId("proxima-fatura")).not.toContainText("com o desconto do cupom");
    // Segundo cupom enquanto já há um guardado: não aparece o campo de novo cupom.
    await expect(page.getByTestId("assinatura-cupom").getByLabel("Código do cupom")).toHaveCount(0);
  });

  test("membro da equipe vê mas não troca o ciclo nem aplica cupom", async ({ page }) => {
    await loginAndWaitForPanel(page, staffEmail, PASSWORD, slug);
    await page.goto(`/${slug}/assinatura`);
    await expect(page.getByText("Só o dono da empresa pode trocar a cobrança.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Salvar cobrança" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Aplicar cupom" })).toHaveCount(0);
  });

  test("assinatura em 390px sem rolagem horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAndWaitForPanel(page, ownerEmail, PASSWORD, slug);
    await page.goto(`/${slug}/assinatura`);
    await expect(page.getByTestId("assinatura-ciclo")).toBeVisible();
    await expectNoOverflow(page, "assinatura 390");
  });
});
