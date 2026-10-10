import { test, expect } from "@playwright/test";
import { SEED_TENANT_SLUG } from "./fixtures/test-data";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";
import { prisma } from "./fixtures/db";

/**
 * Assinatura → "Gerar Pix agora" (`regenerateMyInvoicePixAction`, `src/modules/billing/actions.ts`).
 *
 * IMPORTANTE (gap de arquitetura, registrado no handoff): diferente de Evolution/n8n, o Mercado
 * Pago NÃO tem uma URL base configurável em `PlatformSettings` — `API_BASE` em
 * `src/modules/billing/mercadopago.ts` é uma constante fixa
 * (`https://api.mercadopago.com`). Não é possível apontar o gateway para um servidor HTTP fake
 * local sem alterar código de produto. Por isso:
 * - `RATE_LIMITED` é testado aqui, de ponta a ponta pelo navegador — o teto (`checkRateLimit`) é
 *   checado ANTES de qualquer chamada ao Mercado Pago, então independe de o MP estar configurado.
 * - `MERCADOPAGO_MISSING_DOCUMENT` é testado no nível de integração
 *   (`tests/integration/billing-admin.integration.test.ts`, via `createMockMercadoPagoGateway`),
 *   o único ponto de injeção que o produto expõe hoje para esse cenário.
 */
test.use({ storageState: OWNER_STORAGE_STATE });

test.describe("Assinatura: Gerar Pix agora", () => {
  let invoiceId: string;
  let originalDocument: string | null = null;

  test.beforeAll(async () => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: SEED_TENANT_SLUG } });
    // Sem CPF/CNPJ a tela mostra o campo do documento no lugar do botão (cadastro sem fricção): este teste é do botão,
    // então a empresa de seed ganha um CPF válido durante o teste e volta ao que era no fim.
    originalDocument = tenant.document;
    await prisma.tenant.update({ where: { id: tenant.id }, data: { document: "52998224725" } });
    const subscription = await prisma.subscription.findFirstOrThrow({ where: { tenantId: tenant.id } });
    const invoice = await prisma.invoice.create({
      data: {
        subscriptionId: subscription.id,
        amountCents: 5990,
        periodStart: new Date(),
        periodEnd: new Date(Date.now() + 30 * 86_400_000),
        dueAt: new Date(Date.now() + 3 * 86_400_000),
        status: "OPEN",
      },
    });
    invoiceId = invoice.id;
  });

  test.afterAll(async () => {
    await prisma.invoice.deleteMany({ where: { id: invoiceId } });
    await prisma.tenant.update({ where: { slug: SEED_TENANT_SLUG }, data: { document: originalDocument } });
  });

  test("6ª tentativa em menos de 10min devolve RATE_LIMITED (independe do Mercado Pago estar configurado)", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/assinatura`);
    const button = page.getByRole("button", { name: /Gerar Pix agora|Tentar de novo/ });
    await expect(button).toBeVisible();
    // O botão vem do servidor antes de hidratar: um clique nesse intervalo se perde. O React marca o nó com `__reactProps$` ao hidratar.
    await button.evaluate(
      (el) => new Promise<void>((resolve) => {
        const ready = () => Object.keys(el).some((k) => k.startsWith("__reactProps$"));
        if (ready()) return resolve();
        const timer = setInterval(() => { if (ready()) { clearInterval(timer); resolve(); } }, 50);
      }),
    );

    // 5 primeiras tentativas: dentro do teto, mas ainda assim falham (MP não configurado neste
    // ambiente) — o que importa aqui é que NENHUMA delas mostra a mensagem de rate limit.
    for (let i = 0; i < 5; i++) {
      await button.click();
      await expect(page.getByText("Não foi possível gerar o Pix").first()).toBeVisible();
      await expect(page.getByText("Muitas tentativas em pouco tempo.")).toHaveCount(0);
    }

    // 6ª: estoura o teto (5 tentativas/10min por empresa) — mensagem específica.
    await button.click();
    await expect(page.getByText("Muitas tentativas em pouco tempo. Aguarde alguns minutos antes de tentar de novo.").first()).toBeVisible();
  });
});
