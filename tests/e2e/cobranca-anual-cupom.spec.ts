import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma, hashPassword } from "./fixtures/db";
import { loginAndWaitForPanel } from "./fixtures/auth";
import { E2E_RUN_PREFIX } from "./fixtures/test-data";
import { cleanupSignup, expectLeftCadastro, fillCadastro, tenantOfEmail } from "./fixtures/cadastro";

/**
 * Os 4 ciclos (1, 3, 6 e 12 meses) e cupons, do ponto de vista de quem paga: cadastro (cupom só por link
 * `?cupom=`, sem escolha de ciclo) e tela Assinatura (trocar ciclo, aplicar cupom). Os cupons
 * ruins (vencido, de outro plano, esgotado, desativado) são montados no banco; a tela é que prova
 * que a pessoa vê uma recusa clara e que nada é gravado.
 *
 * O cadastro usa o plano padrão (menor `sortOrder`): ganha preços trimestral, semestral e anual temporários, restaurados no fim.
 * Limites em memória do servidor: prévia 20/10 min por IP e 10/10 min por empresa; este arquivo fica
 * abaixo disso, mas rodar duas vezes seguidas contra o mesmo servidor exige reiniciá-lo.
 */
const run = randomUUID().slice(0, 6).toUpperCase();
const RUN_LC = E2E_RUN_PREFIX.toLowerCase();
const PASSWORD = "e2e-ciclo-pass-2026";

const C = {
  anualOnly: `E2EANU${run}`,
  trimOnly: `E2ETRI${run}`,
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
let defaultPlanOriginal: { quarterlyPriceCents: number | null; semiannualPriceCents: number | null; annualPriceCents: number | null } = { quarterlyPriceCents: null, semiannualPriceCents: null, annualPriceCents: null };
let otherPlanId = "";

test.beforeAll(async () => {
  const plan = await prisma.plan.findFirstOrThrow({ orderBy: { sortOrder: "asc" } });
  defaultPlanId = plan.id;
  defaultPlanOriginal = { quarterlyPriceCents: plan.quarterlyPriceCents, semiannualPriceCents: plan.semiannualPriceCents, annualPriceCents: plan.annualPriceCents };
  // Mensal R$ 59,90: trimestral R$ 170,00 (5%), semestral R$ 320,00 (11%) e 10 mensalidades no ano = "2 meses grátis".
  await prisma.plan.update({ where: { id: plan.id }, data: { quarterlyPriceCents: 17000, semiannualPriceCents: 32000, annualPriceCents: plan.priceCents * 10 } });
  const other = await prisma.plan.create({ data: { code: `e2e-outro-${run.toLowerCase()}`, name: `Outro ${run}`, priceCents: 7000, maxWhatsappNumbers: 1, maxProfessionals: 1, active: false, sortOrder: 997 } });
  otherPlanId = other.id;

  const base = { kind: "PERCENT", value: 20, duration: "ONCE", active: true } as const;
  await prisma.coupon.create({ data: { ...base, code: C.anualOnly, appliesToCycles: ["ANNUAL"] } });
  await prisma.coupon.create({ data: { ...base, code: C.trimOnly, appliesToCycles: ["QUARTERLY"] } });
  await prisma.coupon.create({ data: { ...base, code: C.any20 } });
  await prisma.coupon.create({ data: { ...base, code: C.expired, validUntil: new Date(Date.now() - 86_400_000) } });
  await prisma.coupon.create({ data: { ...base, code: C.exhausted, maxRedemptions: 1, redemptionsCount: 1 } });
  await prisma.coupon.create({ data: { ...base, code: C.inactive, active: false } });
  await prisma.coupon.create({ data: { ...base, code: C.futureStart, validFrom: new Date(Date.now() + 5 * 86_400_000) } });
  const onlyOther = await prisma.coupon.create({ data: { ...base, code: C.otherPlan } });
  await prisma.couponPlan.create({ data: { couponId: onlyOther.id, planId: otherPlanId } });
});

test.afterAll(async () => {
  await prisma.subscription.updateMany({ where: { couponId: { not: null }, coupon: { code: { in: allCodes } } }, data: { couponId: null, couponCyclesRemaining: null } });
  await prisma.couponRedemption.deleteMany({ where: { coupon: { code: { in: allCodes } } } });
  await prisma.tenant.deleteMany({ where: { slug: { startsWith: `${RUN_LC.replace(/_/g, "-")}-anual-` } } });
  await prisma.coupon.deleteMany({ where: { code: { in: allCodes } } });
  await prisma.plan.deleteMany({ where: { id: otherPlanId } });
  await prisma.plan.update({ where: { id: defaultPlanId }, data: defaultPlanOriginal });
  await prisma.user.deleteMany({ where: { email: { contains: `${RUN_LC}-anual-` } } });
});

test.describe.serial("Cadastro com cupom do link (?cupom=)", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  const emails: string[] = [];
  const dropCode = `E2EDRP${run}`;

  test.afterAll(async () => {
    await cleanupSignup(emails);
    await prisma.coupon.deleteMany({ where: { code: dropCode } });
  });

  test("cupom válido no link mostra o selo; cupom ruim ou inexistente não mostra selo nem erro", async ({ page }) => {
    await page.goto(`/cadastro?cupom=${C.any20.toLowerCase()}`);
    const main = page.getByRole("main");
    await expect(main.getByTestId("cadastro-cupom")).toContainText(C.any20);
    await expect(main.getByTestId("cadastro-cupom")).toContainText("Cupom");
    // O formulário não tem campo de cupom: ele só entra por link.
    await expect(main.getByLabel("Cupom de desconto")).toHaveCount(0);
    for (const bad of [C.expired, C.otherPlan, C.exhausted, C.inactive, C.futureStart, `NAOEXISTE${run}`]) {
      await page.goto(`/cadastro?cupom=${bad}`);
      await expect(page.getByRole("main").getByLabel("Nome da empresa"), bad).toBeVisible();
      await expect(page.getByRole("main").getByTestId("cadastro-cupom"), bad).toHaveCount(0);
      await expect(page.getByRole("main").getByRole("alert"), bad).toHaveCount(0);
    }
  });

  test("criar a conta pelo link com cupom grava o resgate e a fatura do teste (mensal) já sai com desconto", async ({ page }) => {
    const email = `${RUN_LC}-anual-ok@e2e.innochat.local`;
    emails.push(email);
    await fillCadastro(page, { email, companyName: `${E2E_RUN_PREFIX} Empresa Cupom`, path: `/cadastro?cupom=${C.any20}` });
    await page.getByRole("main").getByRole("button", { name: "Criar conta grátis" }).click();
    await expectLeftCadastro(page);

    const tenant = await tenantOfEmail(email);
    const subscription = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenant.id }, include: { plan: true } });
    expect(subscription.billingCycle).toBe("MONTHLY"); // o ciclo saiu do cadastro: começa mensal
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { subscriptionId: subscription.id } });
    expect(invoice).toMatchObject({ cycle: "MONTHLY", couponCode: C.any20 });
    expect(invoice.discountCents).toBeGreaterThan(0);
    expect(invoice.amountCents + invoice.discountCents).toBe(subscription.plan.priceCents);
    const redemption = await prisma.couponRedemption.findFirst({ where: { tenantId: tenant.id, coupon: { code: C.any20 } } });
    expect(redemption).not.toBeNull();
  });

  test("cupom que deixa de valer entre abrir a página e enviar não derruba o cadastro: a conta nasce sem cupom", async ({ page }) => {
    const email = `${RUN_LC}-anual-bad@e2e.innochat.local`;
    emails.push(email);
    // Cupom próprio (o trimestral só vale no ciclo trimestral e o cadastro começa mensal).
    await prisma.coupon.create({ data: { kind: "PERCENT", value: 15, duration: "ONCE", active: true, code: dropCode } });
    await fillCadastro(page, { email, companyName: `${E2E_RUN_PREFIX} Empresa Cupom Caiu`, path: `/cadastro?cupom=${dropCode}` });
    await expect(page.getByRole("main").getByTestId("cadastro-cupom")).toBeVisible();
    // Entre o carregamento e o envio o cupom é desativado.
    await prisma.coupon.update({ where: { code: dropCode }, data: { active: false } });
    await page.getByRole("main").getByRole("button", { name: "Criar conta grátis" }).click();
    await expectLeftCadastro(page);

    const tenant = await tenantOfEmail(email);
    const invoice = await prisma.invoice.findFirstOrThrow({ where: { subscription: { tenantId: tenant.id } } });
    expect(invoice.couponCode).toBeNull();
    expect(invoice.discountCents).toBe(0);
    expect(await prisma.couponRedemption.count({ where: { tenantId: tenant.id } })).toBe(0);
  });

  test("cadastro com selo de cupom em 390px: sem rolagem lateral", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/cadastro?cupom=${C.any20}`);
    await expect(page.getByRole("main").getByTestId("cadastro-cupom")).toBeVisible();
    await expectNoOverflow(page, "cadastro 390 com cupom");
  });
});

test.describe.serial("Assinatura: trocar o ciclo e aplicar cupom", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  const slug = `${RUN_LC.replace(/_/g, "-")}-anual-assin`;
  const ownerEmail = `${RUN_LC}-anual-assin-owner@e2e.innochat.local`;
  const staffEmail = `${RUN_LC}-anual-assin-staff@e2e.innochat.local`;
  let tenantId = "";

  test.beforeAll(async () => {
    const plan = await prisma.plan.create({
      data: { code: `e2e-ciclo-${run.toLowerCase()}`, name: `Ciclo ${run}`, priceCents: 10000, quarterlyPriceCents: 28500, semiannualPriceCents: 54000, annualPriceCents: 100000, maxWhatsappNumbers: 1, maxProfessionals: 3, active: false, sortOrder: 996 },
    });
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

  test("dono troca para semestral e depois anual e vê a próxima fatura do período; volta para mensal", async ({ page }) => {
    await loginAndWaitForPanel(page, ownerEmail, PASSWORD, slug);
    await page.goto(`/${slug}/assinatura`);
    const card = page.getByTestId("assinatura-ciclo");
    await expect(card.getByText("Hoje a cobrança é mensal.").first()).toBeVisible();
    await expect(card.getByTestId("proxima-fatura")).toContainText(/R\$\s?100,00/);
    await expect(card.getByRole("button", { name: "Salvar cobrança" })).toBeDisabled();
    for (const cycle of ["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL"]) await expect(card.getByTestId(`ciclo-${cycle}`)).toBeVisible();

    await card.getByTestId("ciclo-SEMIANNUAL").click();
    await expect(card.getByTestId("ciclo-detalhe")).toContainText(/R\$\s?540,00 a cada 6 meses, o que dá R\$\s?90,00 por mês/);
    await expect(card.getByTestId("ciclo-detalhe")).toContainText(/Você economiza R\$\s?60,00 \(10%\)/);
    await card.getByRole("button", { name: "Salvar cobrança" }).click();
    await expect(page.getByText("Cobrança semestral escolhida.").first()).toBeVisible();
    await expect(card.getByText("Hoje a cobrança é semestral.")).toBeVisible();
    await expect(card.getByTestId("proxima-fatura")).toContainText(/R\$\s?540,00/);
    await expect(card.getByTestId("proxima-fatura")).toContainText("do plano semestral (6 meses)");
    expect((await prisma.subscription.findUniqueOrThrow({ where: { tenantId } })).billingCycle).toBe("SEMIANNUAL");

    await card.getByTestId("ciclo-ANNUAL").click();
    await card.getByRole("button", { name: "Salvar cobrança" }).click();
    await expect(page.getByText("Cobrança anual escolhida.").first()).toBeVisible();
    await expect(card.getByText("Hoje a cobrança é anual.")).toBeVisible();
    await expect(card.getByTestId("proxima-fatura")).toContainText(/R\$\s?1\.000,00/);
    await expect(card.getByTestId("proxima-fatura")).toContainText("do plano anual (12 meses)");
    expect((await prisma.subscription.findUniqueOrThrow({ where: { tenantId } })).billingCycle).toBe("ANNUAL");
    await expectNoOverflow(page, "assinatura 1280");
  });

  test("cupom ruim é recusado com mensagem e nada é gravado; cupom bom é aplicado e entra na próxima fatura", async ({ page }) => {
    await loginAndWaitForPanel(page, ownerEmail, PASSWORD, slug);
    await page.goto(`/${slug}/assinatura`);
    const card = page.getByTestId("assinatura-cupom");
    const field = card.getByLabel("Código do cupom");

    // A assinatura está no anual: o cupom só do trimestral também é recusado, dizendo onde vale.
    for (const bad of [C.expired, C.otherPlan, C.exhausted, C.inactive, C.trimOnly, `NAOEXISTE${run}`]) {
      await field.fill(bad);
      await card.getByRole("button", { name: "Conferir valor" }).click();
      await expect(card.getByRole("alert"), bad).toBeVisible();
      await expect(card.getByText("Cupom válido"), bad).toHaveCount(0);
    }
    await field.fill(C.trimOnly);
    await card.getByRole("button", { name: "Conferir valor" }).click();
    await expect(card.getByRole("alert")).toContainText("trimestral");
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

  test("trocar para trimestral avisa que o cupom do anual fica guardado, sem gastar faturas", async ({ page }) => {
    await loginAndWaitForPanel(page, ownerEmail, PASSWORD, slug);
    await page.goto(`/${slug}/assinatura`);
    const card = page.getByTestId("assinatura-ciclo");
    await card.getByTestId("ciclo-QUARTERLY").click();
    await card.getByRole("button", { name: "Salvar cobrança" }).click();
    await expect(page.getByText("Seu cupom não vale nesse tipo de cobrança. Ele fica guardado.").first()).toBeVisible();
    await expect(page.getByTestId("assinatura-cupom").getByText(/fica guardado, sem gastar faturas/)).toBeVisible();
    await expect(page.getByTestId("proxima-fatura")).toContainText(/R\$\s?285,00/);
    await expect(page.getByTestId("proxima-fatura")).toContainText("do plano trimestral (3 meses)");
    await expect(page.getByTestId("proxima-fatura")).not.toContainText("com o desconto do cupom");
    // Segundo cupom enquanto já há um guardado: não aparece o campo de novo cupom.
    await expect(page.getByTestId("assinatura-cupom").getByLabel("Código do cupom")).toHaveCount(0);
  });

  test("membro da equipe vê mas não troca o ciclo nem aplica cupom", async ({ page }) => {
    await loginAndWaitForPanel(page, staffEmail, PASSWORD, slug);
    await page.goto(`/${slug}/assinatura`);
    await expect(page.getByRole("main").getByText("Só o dono da empresa pode trocar a cobrança.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Salvar cobrança" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Aplicar cupom" })).toHaveCount(0);
  });

  test("assinatura em 390px sem rolagem horizontal", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAndWaitForPanel(page, ownerEmail, PASSWORD, slug);
    await page.goto(`/${slug}/assinatura`);
    await expect(page.getByRole("main").getByTestId("assinatura-ciclo")).toBeVisible();
    await expectNoOverflow(page, "assinatura 390");
  });
});
