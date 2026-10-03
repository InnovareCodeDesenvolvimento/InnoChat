import { test, expect } from "@playwright/test";
import { SEED_TENANT_SLUG, STAFF_PASSWORD, loadRunFixtures } from "./fixtures/test-data";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";
import { collectCspViolations } from "./fixtures/csp";
import { prisma } from "./fixtures/db";

/**
 * CSP nova (`next.config.ts`, revisão de segurança 2026-09-28): confirma que as telas de maior
 * risco de quebrar sob CSP real (inline styles, QR em `data:` URL, hidratação de Server
 * Components) não disparam NENHUMA violação no console do navegador — login, agenda, admin e
 * assinatura (QR do Pix). WhatsApp (QR da Evolution, também `data:`) é coberto em
 * `whatsapp.spec.ts`, que usa o mesmo helper `collectCspViolations`.
 *
 * Sessão via `storageState` para as telas que só precisam estar autenticadas (Agenda/Admin/
 * Assinatura) — ver `login_rate_limit_e2e` na memória. O teste "login" abaixo continua logando
 * de verdade: é a própria tela de login sob teste, e `/login` renderiza o form independente de
 * já haver sessão (`src/app/(public)/login/page.tsx` não redireciona), então o `storageState`
 * prévio não interfere. Usa o STAFF (não o OWNER de seed) nesse login real — cada sessão de
 * `storageState` abaixo é independente da sessão criada aqui, e evita somar mais uma tentativa
 * no teto de `dev@innochat.local` (8/15min).
 */
test.use({ storageState: OWNER_STORAGE_STATE });

test.describe("CSP (next.config.ts): nenhuma violação nas telas principais", () => {
  test("login: sem violação de CSP", async ({ page }) => {
    const { staffEmail } = loadRunFixtures();
    const { violations } = collectCspViolations(page);
    await page.goto("/login");
    await page.getByLabel("E-mail").fill(staffEmail);
    await page.getByLabel("Senha").fill(STAFF_PASSWORD);
    await page.getByRole("button", { name: "Entrar", exact: true }).click();
    await page.waitForURL(/\/(studio-demo|admin)/);
    expect(violations).toEqual([]);
  });

  test("Agenda (dia e semana): sem violação de CSP", async ({ page }) => {
    const { violations } = collectCspViolations(page);
    await page.goto(`/${SEED_TENANT_SLUG}/agenda`);
    await page.getByRole("button", { name: "Semana" }).click();
    await page.waitForTimeout(500); // dá tempo de qualquer violação assíncrona (ex.: CSS-in-JS) aparecer
    expect(violations).toEqual([]);
  });

  test("Admin → Configurações (todas as abas): sem violação de CSP", async ({ page }) => {
    const { violations } = collectCspViolations(page);
    for (const aba of ["geral", "whatsapp", "automacao", "pagamentos", "email", "login", "marketing"]) {
      await page.goto(`/admin/configuracoes/${aba}`);
      await page.waitForTimeout(300);
    }
    expect(violations).toEqual([]);
  });

  test("Assinatura com QR do Pix (data: URL): sem violação de CSP", async ({ page }) => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: SEED_TENANT_SLUG } });
    const subscription = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    // Fatura OPEN com Pix já gerado — sem isso a tela não chega a montar o `<img>` do QR (data:
    // URL, o ponto que a CSP nova mais arrisca quebrar: `img-src` precisa listar `data:`).
    const invoice = await prisma.invoice.create({
      data: {
        subscriptionId: subscription.id,
        amountCents: 1000,
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 30 * 86_400_000),
        dueAt: new Date(Date.now() + 5 * 86_400_000),
        status: "OPEN",
        pixCopyPaste: "00020126580014BR.GOV.BCB.PIX0136e2e-test-fake-pix-copia-e-cola-csp-5204000053039865802BR5913InnoChat E2E6008BRASILIA62070503***6304ABCD",
        pixExpiresAt: new Date(Date.now() + 30 * 60_000),
      },
    });
    try {
      const { violations } = collectCspViolations(page);
      await page.goto(`/${SEED_TENANT_SLUG}/assinatura`);
      // Espera o `<img>` do QR (gerado client-side via `qrcode`, `QRCode.toDataURL`) aparecer.
      await expect(page.getByAltText("QR code Pix para pagamento da fatura")).toBeVisible({ timeout: 10_000 });
      const src = await page.getByAltText("QR code Pix para pagamento da fatura").getAttribute("src");
      expect(src).toMatch(/^data:image\//);
      await page.waitForTimeout(500);
      expect(violations).toEqual([]);
    } finally {
      await prisma.invoice.delete({ where: { id: invoice.id } });
    }
  });
});
