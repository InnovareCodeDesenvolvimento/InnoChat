import fs from "node:fs";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { loginAndWaitForPanel } from "./fixtures/auth";
import { prisma, hashPassword, ensureBotPlan } from "./fixtures/db";
import { E2E_RUN_PREFIX } from "./fixtures/test-data";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";

/**
 * Contato de cobrança em empresa EM TESTE GRÁTIS (caso real: dono cadastrou o WhatsApp errado, o aviso falhou e ele não
 * achou onde trocar). Prova: o cartão é editável em TRIALING, também se chega por Configurações, o aviso de falha
 * aparece no painel do dono com botão que leva ao cartão e some ao trocar o número (sem reenviar o que falhou), e o
 * Admin corrige o contato com auditoria mascarada. Com `E2E_SHOTS_DIR`, grava prints nos dois tamanhos.
 */

const LC = E2E_RUN_PREFIX.toLowerCase();
const SLUG = `${LC}-contato`;
const OWNER_EMAIL = `${LC}-owner-contato@e2e.innochat.local`;
const PASSWORD = "e2e-contato-pass-2026";
const WRONG = "5584999993082";
const DAY = 86_400_000;

let tenantId: string;
let noticeId: string;
let page: Page;

async function shot(name: string, width: number) {
  const dir = process.env.E2E_SHOTS_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}-${width}.jpg`), type: "jpeg", quality: 72 });
}

async function settle(p: Page) {
  await p.waitForFunction(() => !document.querySelector('div[hidden][id^="S:"]'), undefined, { timeout: 10_000 });
}

async function open(pathname: string) {
  await page.goto(`/${SLUG}${pathname}`);
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
  await settle(page);
}

async function horizontalOverflow(): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
}

test.describe.configure({ mode: "serial" });

test.describe("Contato de cobrança: teste grátis, aviso de falha e correção", () => {
  test.beforeAll(async ({ browser }) => {
    const plan = await ensureBotPlan();
    const tenant = await prisma.tenant.create({
      data: { slug: SLUG, name: "Innovare Contato (E2E)", timezone: "America/Sao_Paulo", billingWhatsappE164: WRONG, billingWhatsappConfirmedAt: new Date() },
    });
    tenantId = tenant.id;
    const end = new Date(Date.now() + 1 * DAY);
    const subscription = await prisma.subscription.create({
      data: { tenantId, planId: plan.id, status: "TRIALING", trialEndsAt: end, currentPeriodEnd: end },
    });
    const now = new Date();
    const notice = await prisma.billingNotice.create({
      data: {
        tenantId,
        subscriptionId: subscription.id,
        step: "TRIAL_ENDING",
        channel: "WHATSAPP",
        cycleKey: `${subscription.id}:e2e-contato`,
        status: "FAILED",
        attempts: 1,
        notBefore: now,
        expiresAt: new Date(now.getTime() + DAY),
        nextAttemptAt: new Date(now.getTime() + 30 * 60_000),
        lastErrorCode: "WHATSAPP_INVALID_NUMBER",
        recipient: WRONG,
        recipientKind: "BILLING_WHATSAPP",
        recipientMasked: "+55 84 9****-3082",
      },
    });
    noticeId = notice.id;
    const passwordHash = await hashPassword(PASSWORD);
    const owner = await prisma.user.create({
      data: { email: OWNER_EMAIL, passwordHash, emailVerifiedAt: new Date(), termsAcceptedAt: new Date(), termsVersion: "e2e", onboardingTourCompletedAt: new Date() },
    });
    await prisma.membership.create({ data: { userId: owner.id, tenantId, role: "OWNER" } });

    page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
    await loginAndWaitForPanel(page, OWNER_EMAIL, PASSWORD, SLUG);
  });

  test.afterAll(async () => {
    await page.context().close();
    await prisma.tenant.deleteMany({ where: { slug: SLUG } });
    await prisma.user.deleteMany({ where: { email: OWNER_EMAIL } });
  });

  test("em teste grátis o cartão aparece e é editável (o salvar funciona)", async () => {
    await open("/assinatura");
    await expect(page.getByText(/^Teste termina em/)).toBeVisible();
    const card = page.getByTestId("billing-contact-card");
    await expect(card).toBeVisible();
    await expect(card.getByLabel("WhatsApp de cobrança")).toBeEditable();
    await expect(card.getByLabel("WhatsApp de cobrança")).toHaveValue("+55 (84) 99999-3082");
  });

  test("aviso de falha no painel, com o número, e o botão leva ao cartão", async () => {
    await open("/inicio");
    const banner = page.getByTestId("billing-whatsapp-problem");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Não conseguimos te mandar mensagem no WhatsApp (84) 99999-3082. Confira o número.");
    await shot("aviso-whatsapp", 1440);
    await banner.getByRole("link", { name: "Corrigir número" }).click();
    await expect(page).toHaveURL(/\/assinatura#contato-de-cobranca/);
    const card = page.getByTestId("billing-contact-card");
    await expect(card).toBeInViewport();
    await expect(card.getByLabel("WhatsApp de cobrança")).toBeFocused();
    await shot("cartao-contato", 1440);
  });

  test("Configurações tem o cartão 'Contato de cobrança' que leva ao mesmo lugar", async () => {
    await open("/configuracoes");
    const tile = page.locator("p", { hasText: "Contato de cobrança" }).first();
    await expect(tile).toBeVisible();
    await shot("configuracoes", 1440);
    await page.getByRole("main").locator('a[href$="/assinatura#contato-de-cobranca"]').click();
    await expect(page).toHaveURL(/\/assinatura#contato-de-cobranca/);
    await expect(page.getByTestId("billing-contact-card")).toBeVisible();
  });

  test("a ajuda do cartão explica que avisos antigos não reenviam", async () => {
    await open("/assinatura");
    await page.getByTestId("billing-contact-card").getByRole("button", { name: /Como funciona/ }).click();
    await expect(page.getByText(/não são reenviados/).first()).toBeVisible();
    await expect(page.getByText(/Digitou \(84\) 99999-3082/).first()).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("390px: aviso, Assinatura e Configurações sem rolagem horizontal", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const p of ["/inicio", "/assinatura", "/configuracoes"]) {
      await open(p);
      expect(await horizontalOverflow(), `rolagem horizontal em ${p}`).toBeLessThanOrEqual(1);
      if (p === "/inicio") {
        await expect(page.getByTestId("billing-whatsapp-problem")).toBeVisible();
        await shot("aviso-whatsapp", 390);
      }
      if (p === "/configuracoes") await shot("configuracoes", 390);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test("trocar o número: salva, o aviso some e o aviso que falhou NÃO é reenviado", async () => {
    await open("/assinatura");
    const card = page.getByTestId("billing-contact-card");
    await card.getByLabel("WhatsApp de cobrança").fill("(84) 98888-1234");
    await card.getByRole("button", { name: "Salvar contato" }).click();
    await expect(page.getByText("Contato de cobrança salvo.").first()).toBeVisible();
    await expect(page.getByTestId("billing-whatsapp-problem")).toHaveCount(0);
    await open("/inicio");
    await expect(page.getByTestId("billing-whatsapp-problem")).toHaveCount(0);

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    expect(tenant.billingWhatsappE164).toBe("5584988881234");
    expect(tenant.billingWhatsappConfirmedAt).toBeNull(); // número novo: posse a confirmar de novo
    const notice = await prisma.billingNotice.findUniqueOrThrow({ where: { id: noticeId } });
    expect(notice.status).toBe("FAILED"); // ninguém reenviou
    expect(notice.attempts).toBe(1);
  });

  test("card editável no detalhe da empresa; salva e grava auditoria com número mascarado", async ({ browser }) => {
    const adminPage = await (await browser.newContext({ storageState: OWNER_STORAGE_STATE, viewport: { width: 1440, height: 900 } })).newPage();
    await adminPage.goto(`/admin/empresas/${tenantId}`);
    const card = adminPage.getByTestId("billing-contact-card");
    await expect(card).toBeVisible();
    await expect(card.getByLabel("WhatsApp de cobrança")).toHaveValue("+55 (84) 98888-1234");
    await card.getByLabel("WhatsApp de cobrança").fill("(84) 97777-5555");
    await card.getByRole("button", { name: "Salvar contato" }).click();
    await expect(adminPage.getByText("Contato de cobrança salvo.").first()).toBeVisible();

    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).billingWhatsappE164).toBe("5584977775555");
    const log = await prisma.auditLog.findFirstOrThrow({ where: { tenantId, action: "company.billing_contact_changed" }, orderBy: { createdAt: "desc" } });
    expect(log.actorRole).toBe("PLATFORM_ADMIN");
    const raw = JSON.stringify({ summary: log.summary, changes: log.changes });
    expect(raw).not.toContain("977775555");
    expect(raw).not.toContain("5584977775555");
    expect(raw).toContain("5555");
  });

  test("390px: card do Admin sem rolagem horizontal", async ({ browser }) => {
    const adminPage = await (await browser.newContext({ storageState: OWNER_STORAGE_STATE, viewport: { width: 1440, height: 900 } })).newPage();
    await adminPage.setViewportSize({ width: 390, height: 844 });
    await adminPage.goto(`/admin/empresas/${tenantId}`);
    await expect(adminPage.getByTestId("billing-contact-card")).toBeVisible();
    const overflow = await adminPage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});
