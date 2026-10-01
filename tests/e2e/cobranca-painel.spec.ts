import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { loginAndWaitForPanel } from "./fixtures/auth";
import { prisma, hashPassword, ensureBotPlan } from "./fixtures/db";
import { E2E_RUN_PREFIX } from "./fixtures/test-data";

/**
 * F3 da régua de cobrança, painel da empresa (docs/regua-de-cobranca.md §2.2 coluna B e §3.3):
 * banner com contador por estado, botão "Pagar com Pix" levando ao cartão do Pix, cartão
 * "renovada", pedido do WhatsApp de cobrança (só OWNER, dispensável), histórico de pagamentos e
 * Contato de cobrança (STAFF só vê).
 *
 * Empresa própria, isolada. Os estados do banner são montados mexendo em `Subscription`/`Invoice`
 * pelo Prisma e recarregando a página: o que se testa é o que o painel desenha a partir do banco.
 * Com `E2E_SHOTS_DIR` definido, também grava os prints (JPG) de cada estado.
 */

const LC = E2E_RUN_PREFIX.toLowerCase();
const SLUG = `${LC}-cobranca`;
const OWNER_EMAIL = `${LC}-owner-cobranca@e2e.innochat.local`;
const STAFF_EMAIL = `${LC}-staff-cobranca@e2e.innochat.local`;
const PASSWORD = "e2e-cobranca-pass-2026";
const DAY = 86_400_000;
const HOUR = 3_600_000;

let tenantId: string;
let subscriptionId: string;
let page: Page;

async function shot(name: string, viewportWidth: number) {
  const dir = process.env.E2E_SHOTS_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}-${viewportWidth}.jpg`), type: "jpeg", quality: 72 });
}

/** Recria a assinatura e as faturas do cenário. */
async function setScenario(args: {
  status: "TRIALING" | "ACTIVE" | "PAST_DUE" | "SUSPENDED";
  periodEndOffsetMs: number;
  trial?: boolean;
  openInvoice?: boolean;
  paidAgoMs?: number;
}) {
  const end = new Date(Date.now() + args.periodEndOffsetMs);
  await prisma.invoice.deleteMany({ where: { subscriptionId } });
  await prisma.subscription.update({
    where: { id: subscriptionId },
    data: {
      status: args.status,
      currentPeriodEnd: end,
      trialEndsAt: args.trial ? end : null,
      firstPaidAt: args.trial ? null : new Date(Date.now() - 40 * DAY),
      cancelAtPeriodEnd: false,
    },
  });
  if (args.paidAgoMs !== undefined) {
    const paidAt = new Date(Date.now() - args.paidAgoMs);
    await prisma.invoice.create({
      data: {
        subscriptionId,
        amountCents: 9900,
        periodStart: new Date(paidAt.getTime() - 30 * DAY),
        periodEnd: paidAt,
        dueAt: paidAt,
        status: "PAID",
        paidAt,
      },
    });
  }
  if (args.openInvoice) {
    await prisma.invoice.create({
      data: {
        subscriptionId,
        amountCents: 9900,
        periodStart: new Date(end.getTime() - 30 * DAY),
        periodEnd: end,
        dueAt: end,
        status: "OPEN",
        pixCopyPaste: "00020126580014br.gov.bcb.pix0136e2e-cobranca-0000-0000-000000005204000053039865802BR5909InnoChat6008SaoPaulo62070503***6304ABCD",
        pixExpiresAt: new Date(Date.now() + 2 * DAY),
      },
    });
  }
}

/** Quanto a página passa da largura da janela, e quem passa (para a mensagem do teste apontar o culpado). */
async function horizontalOverflow(): Promise<{ overflow: number; offenders: string[] }> {
  return page.evaluate(() => {
    const width = window.innerWidth;
    const offenders = Array.from(document.body.querySelectorAll("*"))
      .filter((el) => el.getBoundingClientRect().right > width + 1 && getComputedStyle(el).position !== "fixed")
      .slice(0, 5)
      .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`);
    return { overflow: document.documentElement.scrollWidth - width, offenders };
  });
}

async function open(pathname: string) {
  await page.goto(`/${SLUG}${pathname}`);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test.describe("Painel da empresa: avisos de cobrança", () => {
  test.beforeAll(async ({ browser }) => {
    const plan = await ensureBotPlan();
    const tenant = await prisma.tenant.create({ data: { slug: SLUG, name: "Studio Cobrança (E2E)", timezone: "America/Sao_Paulo" } });
    tenantId = tenant.id;
    const subscription = await prisma.subscription.create({
      data: { tenantId, planId: plan.id, status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 20 * DAY) },
    });
    subscriptionId = subscription.id;
    const passwordHash = await hashPassword(PASSWORD);
    const base = { passwordHash, emailVerifiedAt: new Date(), termsAcceptedAt: new Date(), termsVersion: "e2e", onboardingTourCompletedAt: new Date() };
    const owner = await prisma.user.create({ data: { email: OWNER_EMAIL, ...base } });
    const staff = await prisma.user.create({ data: { email: STAFF_EMAIL, ...base } });
    await prisma.membership.create({ data: { userId: owner.id, tenantId, role: "OWNER" } });
    await prisma.membership.create({ data: { userId: staff.id, tenantId, role: "STAFF" } });

    page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await loginAndWaitForPanel(page, OWNER_EMAIL, PASSWORD, SLUG);
  });

  test.afterAll(async () => {
    await page.context().close();
    await prisma.tenant.deleteMany({ where: { slug: SLUG } });
    await prisma.user.deleteMany({ where: { email: { in: [OWNER_EMAIL, STAFF_EMAIL] } } });
  });

  test("teste: contador e 'Assinar com Pix' levam ao cartão do Pix", async () => {
    await setScenario({ status: "TRIALING", periodEndOffsetMs: 30 * HOUR, trial: true, openInvoice: true });
    await open("/inicio");
    const banner = page.getByTestId("billing-banner-trial");
    await expect(banner).toContainText(/Seu teste termina em 1 dia e (5|6)h/);
    await shot("banner-teste", 1440);

    await banner.getByRole("link", { name: "Assinar com Pix" }).click();
    await expect(page).toHaveURL(/\/assinatura\?pagar=pix/);
    const pix = page.locator("#pix");
    await expect(pix).toBeVisible();
    await expect(pix).toBeFocused();
    await expect(pix.getByText("Fatura em aberto")).toBeVisible();
  });

  test("fatura aberta a 2 dias: banner amarelo com valor, contador e data", async () => {
    await setScenario({ status: "ACTIVE", periodEndOffsetMs: 2 * DAY + 4 * HOUR, openInvoice: true });
    await open("/inicio");
    const banner = page.getByTestId("billing-banner-invoice");
    await expect(banner).toContainText(/Sua fatura de R\$\s?99,00 vence em (\d+ dias?( e \d+h)?|\d+h)/);
    await expect(banner.getByRole("link", { name: "Pagar com Pix" })).toBeVisible();
    await expect(banner.getByRole("button", { name: /Como funciona: Aviso de cobrança no topo/ })).toBeVisible();
    await shot("banner-fatura", 1440);
  });

  test("fatura ainda longe do vencimento: sem banner", async () => {
    await setScenario({ status: "ACTIVE", periodEndOffsetMs: 12 * DAY, openInvoice: true });
    await open("/inicio");
    await expect(page.getByTestId("billing-banner-invoice")).toHaveCount(0);
  });

  test("carência: banner vermelho com 'o bot para de responder em'", async () => {
    await setScenario({ status: "PAST_DUE", periodEndOffsetMs: -36 * HOUR, openInvoice: true });
    await open("/inicio");
    const banner = page.getByTestId("billing-banner-grace");
    await expect(banner).toContainText(/Fatura vencida\. O bot para de responder em/);
    await expect(banner.getByRole("link", { name: "Pagar com Pix" })).toBeVisible();
    await shot("banner-carencia", 1440);
  });

  test("suspensa: aviso com prazo de encerramento e 'Pagar e reativar'", async () => {
    await setScenario({ status: "SUSPENDED", periodEndOffsetMs: -10 * DAY, openInvoice: true });
    await open("/inicio");
    const banner = page.getByTestId("billing-banner-suspended");
    await expect(banner).toContainText("Assinatura suspensa");
    await expect(banner).toContainText(/A conta é encerrada em \d+ dias/);
    await expect(banner.getByRole("link", { name: "Pagar e reativar" })).toBeVisible();
    await shot("banner-suspensa", 1440);
  });

  test("renovada: cartão por 7 dias, dispensável, e aviso no topo da tela Assinatura", async () => {
    await setScenario({ status: "ACTIVE", periodEndOffsetMs: 25 * DAY, paidAgoMs: DAY });
    await open("/inicio");
    const banner = page.getByTestId("billing-banner-renewed");
    await expect(banner).toContainText(/Assinatura renovada até \d{2}\/\d{2}/);
    await shot("banner-renovada", 1440);

    await open("/assinatura");
    await expect(page.getByTestId("assinatura-renovada")).toContainText("Assinatura renovada até");

    await banner.getByRole("button", { name: "Dispensar este aviso" }).click();
    await expect(page.getByTestId("billing-banner-renewed")).toHaveCount(0);
    await open("/inicio");
    await expect(page.getByTestId("billing-banner-renewed")).toHaveCount(0);
  });

  test("pago há mais de 7 dias: sem cartão de renovada", async () => {
    await setScenario({ status: "ACTIVE", periodEndOffsetMs: 25 * DAY, paidAgoMs: 8 * DAY });
    await open("/inicio");
    await expect(page.getByTestId("billing-banner-renewed")).toHaveCount(0);
  });

  test("pedido do WhatsApp: aparece para o dono sem número, valida, dispensa por sessão", async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { billingWhatsappE164: null, billingWhatsappOptOutAt: null } });
    await setScenario({ status: "ACTIVE", periodEndOffsetMs: 20 * DAY });
    await open("/inicio");
    const prompt = page.getByTestId("billing-phone-prompt");
    await expect(prompt.getByText("Qual WhatsApp recebe os avisos de cobrança?")).toBeVisible();
    await expect(prompt.getByRole("button", { name: /Como funciona: WhatsApp dos avisos de cobrança/ })).toBeVisible();
    await shot("pedido-whatsapp", 1440);

    await prompt.getByLabel("Qual WhatsApp recebe os avisos de cobrança?").fill("123");
    await prompt.getByRole("button", { name: "Salvar WhatsApp" }).click();
    await expect(prompt.getByRole("alert")).toContainText("Digite o WhatsApp com DDD");

    await prompt.getByRole("button", { name: "Dispensar o pedido de WhatsApp" }).click();
    await expect(page.getByTestId("billing-phone-prompt")).toHaveCount(0);
    await open("/agenda");
    await expect(page.getByTestId("billing-phone-prompt")).toHaveCount(0);
  });

  test("pedido do WhatsApp: some quando a empresa já tem número ou desligou os avisos", async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { billingWhatsappE164: "5584999990000" } });
    await page.evaluate(() => window.sessionStorage.clear());
    await open("/inicio");
    await expect(page.getByTestId("billing-phone-prompt")).toHaveCount(0);

    await prisma.tenant.update({ where: { id: tenantId }, data: { billingWhatsappE164: null, billingWhatsappOptOutAt: new Date() } });
    await open("/inicio");
    await expect(page.getByTestId("billing-phone-prompt")).toHaveCount(0);
  });

  test("pedido do WhatsApp: não aparece em cima de aviso vermelho", async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { billingWhatsappE164: null, billingWhatsappOptOutAt: null } });
    await setScenario({ status: "PAST_DUE", periodEndOffsetMs: -36 * HOUR, openInvoice: true });
    await page.evaluate(() => window.sessionStorage.clear());
    await open("/inicio");
    await expect(page.getByTestId("billing-banner-grace")).toBeVisible();
    await expect(page.getByTestId("billing-phone-prompt")).toHaveCount(0);
  });

  test("tela Assinatura: histórico e Contato de cobrança (dono edita campos, chave ligada por padrão)", async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { billingEmail: null, billingWhatsappE164: "5584999990000", billingWhatsappOptOutAt: null } });
    await setScenario({ status: "ACTIVE", periodEndOffsetMs: 2 * DAY, openInvoice: true, paidAgoMs: 28 * DAY });
    await open("/assinatura");

    const history = page.getByTestId("payment-history-card");
    await expect(history.getByText("Paga em")).toBeVisible();
    await expect(history.getByText("Em aberto")).toBeVisible();

    const card = page.getByTestId("billing-contact-card");
    await expect(card.getByLabel("E-mail do financeiro (opcional)")).toBeVisible();
    await expect(card.getByLabel("WhatsApp de cobrança")).toHaveValue("+55 (84) 99999-0000");
    const toggle = card.getByRole("switch", { name: "Receber cobrança pelo WhatsApp" });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(card.getByRole("button", { name: "Salvar contato" })).toBeDisabled();

    await card.getByLabel("E-mail do financeiro (opcional)").fill("sem-arroba");
    await card.getByRole("button", { name: "Salvar contato" }).click();
    await expect(card.getByRole("alert")).toContainText("e-mail parece incompleto");

    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(card.getByText("Desligado.")).toBeVisible();
    await page.waitForTimeout(400); // deixa a animação da chave terminar antes do print
    await shot("tela-assinatura", 1440);
  });

  test("pedido do WhatsApp: salvar grava o número e o pedido some", async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { billingWhatsappE164: null, billingWhatsappOptOutAt: null } });
    await setScenario({ status: "ACTIVE", periodEndOffsetMs: 20 * DAY });
    await page.evaluate(() => window.sessionStorage.clear());
    await open("/inicio");
    const prompt = page.getByTestId("billing-phone-prompt");
    await prompt.getByLabel("Qual WhatsApp recebe os avisos de cobrança?").fill("(84) 99999-0000");
    await prompt.getByRole("button", { name: "Salvar WhatsApp" }).click();
    await expect(page.getByTestId("billing-phone-prompt")).toHaveCount(0);
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { billingWhatsappE164: true, billingWhatsappOptOutAt: true } });
    expect(tenant.billingWhatsappE164).toBe("5584999990000");
    expect(tenant.billingWhatsappOptOutAt).toBeNull();
  });

  test("Contato de cobrança: salvar e-mail do financeiro e desligar o WhatsApp (opt-out) grava e persiste", async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { billingEmail: null, billingWhatsappE164: "5584999990000", billingWhatsappOptOutAt: null } });
    await open("/assinatura");
    const card = page.getByTestId("billing-contact-card");
    await card.getByLabel("E-mail do financeiro (opcional)").fill("Financeiro@Studio.com.br");
    await card.getByRole("switch", { name: "Receber cobrança pelo WhatsApp" }).click();
    await card.getByRole("button", { name: "Salvar contato" }).click();
    await expect(page.getByText("Contato de cobrança salvo.")).toBeVisible();
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { billingEmail: true, billingWhatsappOptOutAt: true } });
    expect(tenant.billingEmail).toBe("financeiro@studio.com.br");
    expect(tenant.billingWhatsappOptOutAt).not.toBeNull();

    await open("/assinatura");
    await expect(page.getByTestId("billing-contact-card").getByRole("switch", { name: "Receber cobrança pelo WhatsApp" })).toHaveAttribute("aria-checked", "false");
    await expect(page.getByTestId("billing-contact-card").getByLabel("E-mail do financeiro (opcional)")).toHaveValue("financeiro@studio.com.br");
  });

  test("tela Assinatura: STAFF só vê o contato, sem campos", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const staffPage = await context.newPage();
    await loginAndWaitForPanel(staffPage, STAFF_EMAIL, PASSWORD, SLUG);
    await staffPage.goto(`/${SLUG}/assinatura`);
    const card = staffPage.getByTestId("billing-contact-card");
    await expect(card.getByText("Só o dono da empresa pode alterar o contato de cobrança.")).toBeVisible();
    await expect(card.getByRole("textbox")).toHaveCount(0);
    await expect(card.getByRole("switch")).toHaveCount(0);
    // E o pedido do número é só do dono.
    await expect(staffPage.getByTestId("billing-phone-prompt")).toHaveCount(0);
    await context.close();
  });

  test("celular 390px: banners e pedido não estouram a largura e o botão tem 44px", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    const cases: Array<[string, Parameters<typeof setScenario>[0], string]> = [
      ["billing-banner-trial", { status: "TRIALING", periodEndOffsetMs: 30 * HOUR, trial: true, openInvoice: true }, "banner-teste"],
      ["billing-banner-invoice", { status: "ACTIVE", periodEndOffsetMs: 2 * DAY, openInvoice: true }, "banner-fatura"],
      ["billing-banner-grace", { status: "PAST_DUE", periodEndOffsetMs: -36 * HOUR, openInvoice: true }, "banner-carencia"],
      ["billing-banner-suspended", { status: "SUSPENDED", periodEndOffsetMs: -10 * DAY, openInvoice: true }, "banner-suspensa"],
    ];
    for (const [testId, scenario, shotName] of cases) {
      await setScenario(scenario);
      await open("/inicio");
      const banner = page.getByTestId(testId);
      await expect(banner).toBeVisible();
      const { overflow, offenders } = await horizontalOverflow();
      expect(overflow, `${testId} estourou a largura: ${offenders.join(" | ")}`).toBeLessThanOrEqual(0);
      const box = await banner.getByRole("link").first().boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
      await shot(shotName, 390);
    }

    await prisma.tenant.update({ where: { id: tenantId }, data: { billingWhatsappE164: null, billingWhatsappOptOutAt: null } });
    await setScenario({ status: "ACTIVE", periodEndOffsetMs: 20 * DAY });
    await page.evaluate(() => window.sessionStorage.clear());
    await open("/inicio");
    const prompt = page.getByTestId("billing-phone-prompt");
    await expect(prompt).toBeVisible();
    const promptOverflow = await horizontalOverflow();
    expect(promptOverflow.overflow, `pedido estourou: ${promptOverflow.offenders.join(" | ")}`).toBeLessThanOrEqual(0);
    await shot("pedido-whatsapp", 390);

    await setScenario({ status: "ACTIVE", periodEndOffsetMs: 2 * DAY, openInvoice: true, paidAgoMs: 28 * DAY });
    await prisma.tenant.update({ where: { id: tenantId }, data: { billingWhatsappE164: "5584999990000" } });
    await open("/assinatura");
    const pageOverflow = await horizontalOverflow();
    expect(pageOverflow.overflow, `Assinatura estourou: ${pageOverflow.offenders.join(" | ")}`).toBeLessThanOrEqual(0);
    await shot("tela-assinatura", 390);
  });
});
