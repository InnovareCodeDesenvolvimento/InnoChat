import { test, expect, type Browser, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { prisma, hashPassword } from "./fixtures/db";
import { loginAndWaitForPanel } from "./fixtures/auth";
import { cleanupSignup, expectLeftCadastro, fillCadastro, tenantOfEmail, CADASTRO_PASSWORD } from "./fixtures/cadastro";
import { E2E_RUN_PREFIX } from "./fixtures/test-data";

/**
 * QA do "cadastro sem fricção" depois do cadastro: o que acontece na tela Assinatura de quem entrou sem CPF/CNPJ
 * (campo do documento dentro do cartão do Pix), a faixa "informe o CPF" nas últimas 24 h do teste (só o dono),
 * a fatura do teste refeita ao trocar ciclo/cupom e o evento CompleteRegistration do Pixel (só com consentimento).
 * Uma conta criada pelo formulário de verdade serve a vários testes (serial); o Mercado Pago não tem servidor fake
 * (ver memória mercadopago_no_fake_server), então "gerar o Pix" termina em aviso, mas o documento fica salvo.
 */
const run = randomUUID().slice(0, 6).toLowerCase();
const RUN_LC = E2E_RUN_PREFIX.toLowerCase().replace(/_/g, "-");
const OWNER_EMAIL = `${RUN_LC}-sf-dono-${run}@e2e.innochat.local`;
const STAFF_EMAIL = `${RUN_LC}-sf-equipe-${run}@e2e.innochat.local`;
const PIXEL_EMAIL = `${RUN_LC}-sf-pixel-${run}@e2e.innochat.local`;
const DENY_EMAIL = `${RUN_LC}-sf-recusa-${run}@e2e.innochat.local`;
const STAFF_PASSWORD = "e2e-staff-sem-friccao-2026";
const PLAN_CODE = `qa-sf-${run}`;
const COUPON = `QASF${run.toUpperCase()}`;
const VALID_CPF = "52998224725";
const PIXEL_ID = "123456789012345";
const FULL = { priceCents: 5900, quarterlyPriceCents: 16800, semiannualPriceCents: 31860, annualPriceCents: 59000 };

let planId = "";
let ownerState: Awaited<ReturnType<BrowserContext["storageState"]>> | null = null;
let slug = "";
let pixelOriginal: { metaEnabled: boolean; metaPixelId: string | null } | null = null;

async function ownerContext(browser: Browser) {
  return browser.newContext({ storageState: ownerState! });
}

async function trialInvoices() {
  return prisma.invoice.findMany({ where: { subscription: { tenant: { slug } } }, orderBy: { createdAt: "asc" } });
}

test.use({ storageState: { cookies: [], origins: [] } });

test.beforeAll(async () => {
  const plan = await prisma.plan.create({ data: { code: PLAN_CODE, name: `QA Sem Friccao ${run}`, ...FULL, maxWhatsappNumbers: 1, maxProfessionals: 2, active: true, sortOrder: -9100 } });
  planId = plan.id;
  await prisma.coupon.create({ data: { code: COUPON, kind: "PERCENT", value: 10, duration: "ONCE", active: true } });
  pixelOriginal = await prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 }, select: { metaEnabled: true, metaPixelId: true } });
});

test.afterAll(async () => {
  if (pixelOriginal) await prisma.platformSettings.update({ where: { id: 1 }, data: pixelOriginal });
  await prisma.subscription.updateMany({ where: { coupon: { code: COUPON } }, data: { couponId: null, couponCyclesRemaining: null } });
  await prisma.couponRedemption.deleteMany({ where: { coupon: { code: COUPON } } });
  const memberships = await prisma.membership.findMany({ where: { user: { email: { in: [OWNER_EMAIL, STAFF_EMAIL, PIXEL_EMAIL, DENY_EMAIL] } } }, select: { tenantId: true } });
  await prisma.tenant.deleteMany({ where: { id: { in: memberships.map((m) => m.tenantId) } } });
  await cleanupSignup([OWNER_EMAIL, PIXEL_EMAIL, DENY_EMAIL]);
  await prisma.user.deleteMany({ where: { email: STAFF_EMAIL } });
  await prisma.coupon.deleteMany({ where: { code: COUPON } });
  await prisma.plan.deleteMany({ where: { id: planId } });
});

test.describe.serial("Cadastro sem fricção: depois do cadastro", () => {
  test.setTimeout(90_000);

  test("cadastro cria o teste sem CPF, com a fatura do teste mensal aberta e sem Pix", async ({ page }) => {
    await fillCadastro(page, { email: OWNER_EMAIL, companyName: `${E2E_RUN_PREFIX} Sem Friccao ${run}` });
    await page.getByRole("main").getByRole("button", { name: "Criar conta grátis" }).click();
    await expectLeftCadastro(page);
    ownerState = await page.context().storageState();
    const tenant = await tenantOfEmail(OWNER_EMAIL);
    slug = tenant.slug;
    expect(tenant.document).toBeNull();
    const sub = await prisma.subscription.findFirstOrThrow({ where: { tenantId: tenant.id } });
    expect(sub.status).toBe("TRIALING");
    expect(sub.planId, "o cadastro pegou o plano criado pelo teste").toBe(planId);
    const invoices = await trialInvoices();
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ status: "OPEN", isTrialConversion: true, amountCents: 5900, pixCopyPaste: null });

    // Membro da equipe (STAFF) para provar que a faixa e o campo do documento tratam o dono e a equipe de forma diferente.
    const staff = await prisma.user.create({
      data: { email: STAFF_EMAIL, passwordHash: await hashPassword(STAFF_PASSWORD), emailVerifiedAt: new Date(), termsAcceptedAt: new Date(), termsVersion: "e2e", onboardingTourCompletedAt: new Date() },
    });
    await prisma.membership.create({ data: { userId: staff.id, tenantId: tenant.id, role: "STAFF" } });
  });

  test("Assinatura sem CPF: o cartão do Pix pede o documento ali mesmo; CPF inválido dá erro e não grava nada", async ({ browser }) => {
    const context = await ownerContext(browser);
    const page = await context.newPage();
    await page.goto(`/${slug}/assinatura`);
    const form = page.getByRole("main").getByTestId("pix-document-form");
    await expect(form).toBeVisible();
    await form.getByLabel("CPF ou CNPJ da empresa", { exact: false }).fill("111.111.111-11");
    await form.getByRole("button", { name: "Salvar e gerar Pix" }).click();
    await expect(form).toContainText("Confira o CPF ou CNPJ");
    await form.getByLabel("CPF ou CNPJ da empresa", { exact: false }).fill("123");
    await form.getByRole("button", { name: "Salvar e gerar Pix" }).click();
    await expect(form).toContainText("Confira o CPF ou CNPJ");
    expect((await tenantOfEmail(OWNER_EMAIL)).document).toBeNull();
    await context.close();
  });

  test("Assinatura sem CPF: a equipe (STAFF) vê o aviso para chamar o dono, sem campo", async ({ page }) => {
    await loginAndWaitForPanel(page, STAFF_EMAIL, STAFF_PASSWORD, slug);
    await page.goto(`/${slug}/assinatura`);
    await expect(page.getByRole("main").getByText("Falta o CPF ou CNPJ da empresa")).toBeVisible();
    await expect(page.getByTestId("pix-document-form")).toHaveCount(0);
  });

  test("faixa 'informe o CPF': só nas últimas 24 h, só para o dono e some quando o documento é válido", async ({ browser, page }) => {
    const tenant = await tenantOfEmail(OWNER_EMAIL);
    const setTrialEnd = (ms: number) =>
      prisma.subscription.updateMany({ where: { tenantId: tenant.id }, data: { trialEndsAt: new Date(Date.now() + ms), currentPeriodEnd: new Date(Date.now() + ms) } });
    const banner = (p: typeof page) => p.getByTestId("billing-banner-needs-document");

    const owner = await ownerContext(browser);
    const op = await owner.newPage();

    await setTrialEnd(48 * 3_600_000);
    await op.goto(`/${slug}/inicio`);
    await expect(op.getByRole("main")).toBeVisible();
    await expect(banner(op)).toHaveCount(0);

    await setTrialEnd(12 * 3_600_000);
    await op.reload();
    await expect(banner(op)).toBeVisible();
    await expect(banner(op).getByRole("link", { name: "Informar CPF ou CNPJ" })).toHaveAttribute("href", new RegExp(`/${slug}/assinatura`));

    // A equipe não vê a faixa, mesmo dentro das 24 h.
    await loginAndWaitForPanel(page, STAFF_EMAIL, STAFF_PASSWORD, slug);
    await page.goto(`/${slug}/inicio`);
    await expect(page.getByRole("main")).toBeVisible();
    await expect(banner(page)).toHaveCount(0);

    // Documento válido salvo: a faixa some.
    await prisma.tenant.update({ where: { id: tenant.id }, data: { document: VALID_CPF } });
    await op.reload();
    await expect(banner(op)).toHaveCount(0);
    await prisma.tenant.update({ where: { id: tenant.id }, data: { document: null } });

    // Quem já pagou alguma vez não vê a faixa.
    await prisma.subscription.updateMany({ where: { tenantId: tenant.id }, data: { firstPaidAt: new Date() } });
    await op.reload();
    await expect(banner(op)).toHaveCount(0);
    await prisma.subscription.updateMany({ where: { tenantId: tenant.id }, data: { firstPaidAt: null } });
    await owner.close();
  });

  test("CPF válido: o documento fica salvo e a tela deixa de pedir o campo (Pix depende do Mercado Pago)", async ({ browser }) => {
    const context = await ownerContext(browser);
    const page = await context.newPage();
    await page.goto(`/${slug}/assinatura`);
    const form = page.getByRole("main").getByTestId("pix-document-form");
    await form.getByLabel("CPF ou CNPJ da empresa", { exact: false }).fill("529.982.247-25");
    await form.getByRole("button", { name: "Salvar e gerar Pix" }).click();
    await expect.poll(async () => (await tenantOfEmail(OWNER_EMAIL)).document, { timeout: 20_000 }).toBe(VALID_CPF);
    await page.reload();
    await expect(page.getByTestId("pix-document-form")).toHaveCount(0);
    await prisma.tenant.update({ where: { slug }, data: { document: null } });
    await context.close();
  });

  test("trocar para anual no teste refaz a fatura do teste (anula a mensal, cria a anual) e a tela não diz que a aberta fica como estava", async ({ browser }) => {
    const context = await ownerContext(browser);
    const page = await context.newPage();
    await page.goto(`/${slug}/assinatura`);
    await page.getByRole("main").getByTestId("assinatura-ciclo").getByTestId("ciclo-ANNUAL").click();
    await page.getByRole("button", { name: "Salvar cobrança" }).click();
    await expect
      .poll(async () => (await trialInvoices()).filter((i) => i.status === "OPEN").map((i) => i.amountCents), { timeout: 20_000 })
      .toEqual([59000]);
    const all = await trialInvoices();
    expect(all.filter((i) => i.status === "VOID")).toHaveLength(1);
    expect(all.find((i) => i.status === "OPEN")).toMatchObject({ isTrialConversion: true, cycle: "ANNUAL" });

    await page.reload();
    await expect(page.getByRole("main")).toContainText(/R\$\s?590,00/);
    await context.close();
  });

  test("aplicar cupom no teste refaz a fatura com o desconto e o aviso não promete só 'a partir da próxima fatura'", async ({ browser }) => {
    const context = await ownerContext(browser);
    const page = await context.newPage();
    await page.goto(`/${slug}/assinatura`);
    const card = page.getByRole("main").getByTestId("assinatura-cupom");
    await card.getByRole("textbox").fill(COUPON);
    await card.getByRole("button", { name: /Verificar|Conferir|Aplicar/ }).first().click();
    const apply = card.getByRole("button", { name: /^Aplicar/ });
    if (await apply.isVisible().catch(() => false)) await apply.click();
    await expect
      .poll(async () => (await trialInvoices()).filter((i) => i.status === "OPEN").map((i) => i.amountCents), { timeout: 20_000 })
      .toEqual([53100]);
    const open = (await trialInvoices()).find((i) => i.status === "OPEN")!;
    expect(open.couponCode).toBe(COUPON);
    expect(open.discountCents).toBe(5900);
    await expect(page.getByText("O desconto entra a partir da próxima fatura.")).toHaveCount(0);
    await context.close();
  });

  test("a tela Assinatura de quem nunca pagou não diz que a fatura aberta fica como estava (ela foi refeita)", async ({ browser }) => {
    const context = await ownerContext(browser);
    const page = await context.newPage();
    await page.goto(`/${slug}/assinatura`);
    await expect(page.getByRole("main").getByTestId("assinatura-ciclo")).toBeVisible();
    await expect(page.getByRole("main").getByTestId("assinatura-ciclo")).not.toContainText("continuam como estão");
    await context.close();
  });
});

test.describe.serial("CompleteRegistration do Pixel", () => {
  test.setTimeout(150_000);

  async function watchPixel(page: import("@playwright/test").Page, consent: "granted" | "denied") {
    const events: string[] = [];
    await page.addInitScript(
      ([key, choice]) => window.localStorage.setItem(key!, JSON.stringify({ v: 1, choice, at: new Date().toISOString() })),
      ["innochat-consent-meta", consent],
    );
    // O fbevents.js vira um stub que manda cada chamada por sendBeacon (sobrevive à navegação para /pos-login).
    await page.route(/connect\.facebook\.net/, (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: `(function(){var f=window.fbq;function s(a){navigator.sendBeacon('https://www.facebook.com/tr/e2e?d='+encodeURIComponent(JSON.stringify(a)))}f.callMethod=function(){s([].slice.call(arguments))};(f.queue||[]).forEach(s);f.queue=[];})();`,
      }),
    );
    await page.route(/www\.facebook\.com\/tr/, (route) => {
      events.push(decodeURIComponent(route.request().url()));
      return route.fulfill({ status: 204 });
    });
    return events;
  }

  test("com consentimento, o cadastro com sessão aberta dispara CompleteRegistration (com o id do par da CAPI)", async ({ page }) => {
    await prisma.platformSettings.update({ where: { id: 1 }, data: { metaEnabled: true, metaPixelId: PIXEL_ID } });
    const events = await watchPixel(page, "granted");
    // O servidor guarda a configuração por 30 s: espera o Pixel nascer na página.
    await expect
      .poll(
        async () => {
          await page.goto("/cadastro");
          await page.waitForTimeout(800);
          return page.evaluate(() => typeof window.fbq === "function");
        },
        { timeout: 60_000, intervals: [2_000] },
      )
      .toBe(true);
    await fillCadastro(page, { email: PIXEL_EMAIL, companyName: `${E2E_RUN_PREFIX} Pixel ${run}`, path: "/cadastro" });
    await page.getByRole("main").getByRole("button", { name: "Criar conta grátis" }).click();
    await expectLeftCadastro(page);
    await expect.poll(() => events.some((e) => e.includes("CompleteRegistration")), { timeout: 10_000 }).toBe(true);
    const evt = events.find((e) => e.includes("CompleteRegistration"))!;
    expect(evt, "eventID presente para casar com a CAPI").toMatch(/eventID/);
  });

  test("sem consentimento (Recusar), nenhum evento da Meta sai no cadastro", async ({ page }) => {
    const events = await watchPixel(page, "denied");
    await page.goto("/cadastro");
    await fillCadastro(page, { email: DENY_EMAIL, companyName: `${E2E_RUN_PREFIX} Pixel Recusa ${run}`, path: "/cadastro" });
    await page.getByRole("main").getByRole("button", { name: "Criar conta grátis" }).click();
    await expectLeftCadastro(page);
    await page.waitForTimeout(1_500);
    expect(events).toEqual([]);
    expect(await prisma.user.count({ where: { email: DENY_EMAIL } })).toBe(1);
    expect(CADASTRO_PASSWORD.length).toBeGreaterThan(8);
  });
});
