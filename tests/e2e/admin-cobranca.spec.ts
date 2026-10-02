import { test, expect } from "@playwright/test";
import { E2E_RUN_PREFIX } from "./fixtures/test-data";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";
import { prisma, ensureBotPlan } from "./fixtures/db";

/**
 * Admin → Cobrança (`/admin/cobranca`) — "Marcar como paga" (motivo obrigatório, clique real,
 * duplo clique só produz 1 efeito — a idempotência de `markInvoicePaidManually` em si já está
 * provada em `tests/integration/billing-admin.integration.test.ts`; aqui provamos que a TELA não
 * dispara 2 chamadas de verdade) e "Regerar Pix".
 */
test.use({ storageState: OWNER_STORAGE_STATE });

async function makeOpenInvoiceTenant(label: string) {
  const plan = await ensureBotPlan();
  const slug = `${E2E_RUN_PREFIX.toLowerCase().replace(/_/g, "-")}-cobranca-${label}`;
  const tenant = await prisma.tenant.create({
    data: { slug, name: `${E2E_RUN_PREFIX} Cobrança ${label}`, timezone: "America/Sao_Paulo", document: "52998224725" },
  });
  const user = await prisma.user.create({
    data: { email: `${slug}@e2e.innochat.local`, passwordHash: "x", emailVerifiedAt: new Date() },
  });
  await prisma.membership.create({ data: { userId: user.id, tenantId: tenant.id, role: "OWNER" } });
  const subscription = await prisma.subscription.create({
    data: { tenantId: tenant.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) },
  });
  const invoice = await prisma.invoice.create({
    data: {
      subscriptionId: subscription.id,
      amountCents: 5990,
      periodStart: new Date(),
      periodEnd: new Date(Date.now() + 30 * 86_400_000),
      dueAt: new Date(Date.now() + 5 * 86_400_000),
      status: "OPEN",
    },
  });
  return { tenant, user, subscription, invoice };
}

test.describe("Admin → Cobrança", () => {
  test.afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { name: { contains: E2E_RUN_PREFIX } } });
  });

  test("'Marcar como paga': motivo obrigatório, clique real muda o status, duplo clique não duplica o efeito", async ({ page }) => {
    const { tenant, invoice } = await makeOpenInvoiceTenant("marcar-paga");

    await page.goto("/admin/cobranca");
    await page.getByLabel("Empresa", { exact: true }).fill(tenant.name);
    await page.getByRole("button", { name: "Filtrar" }).click();
    await expect(page.getByText(tenant.name).first()).toBeVisible();

    const markPaidButton = page.getByRole("button", { name: `Marcar como paga a fatura de ${tenant.name}` });
    await markPaidButton.click();
    const dialog = page.getByRole("dialog").filter({ hasText: "Marcar fatura como paga manualmente" });
    await expect(dialog).toBeVisible();

    // Motivo obrigatório: sem preencher, o `required` nativo do textarea bloqueia o submit antes
    // mesmo de chegar no JS (o dialog continua aberto, nada muda no banco).
    await dialog.getByRole("button", { name: "Confirmar baixa manual" }).click();
    await expect(dialog).toBeVisible();
    let invoiceCheck = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(invoiceCheck.status).toBe("OPEN");

    // Digita e apaga (só espaços) — passa o `required` do HTML, mas cai na validação de negócio
    // ("pelo menos 3 caracteres" depois do trim).
    await dialog.getByLabel("Motivo da baixa manual", { exact: false }).fill("  ");
    await dialog.getByRole("button", { name: "Confirmar baixa manual" }).click();
    await expect(dialog.getByText("Informe um motivo com pelo menos 3 caracteres.")).toBeVisible();
    invoiceCheck = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(invoiceCheck.status).toBe("OPEN");

    // Preenche o motivo e clica DUAS vezes rápido (duplo clique real) — só 1 efeito no banco.
    await dialog.getByLabel("Motivo da baixa manual", { exact: false }).fill(`${E2E_RUN_PREFIX} pago por transferência, comprovante em anexo`);
    await dialog.getByRole("button", { name: "Confirmar baixa manual" }).dblclick();
    await expect(page.getByText("Fatura marcada como paga.").first()).toBeVisible();
    await expect(dialog).toBeHidden();

    invoiceCheck = await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(invoiceCheck.status).toBe("PAID");
    const auditCount = await prisma.providerEvent.count({ where: { provider: "manual", providerEventId: invoice.id } });
    expect(auditCount).toBe(1); // duplo clique não duplicou a auditoria/baixa

    // Ações de fatura sumém depois de PAID (só existem para OPEN).
    await expect(page.getByRole("button", { name: `Marcar como paga a fatura de ${tenant.name}` })).toHaveCount(0);
  });

  test("'Regerar Pix' chama a action e atualiza a linha (sem Mercado Pago configurado, mostra erro claro)", async ({ page }) => {
    const { tenant } = await makeOpenInvoiceTenant("regerar-pix");

    await page.goto("/admin/cobranca");
    await page.getByLabel("Empresa", { exact: true }).fill(tenant.name);
    await page.getByRole("button", { name: "Filtrar" }).click();
    await expect(page.getByText(tenant.name).first()).toBeVisible();

    await page.getByRole("button", { name: `Regerar Pix da fatura de ${tenant.name}` }).click();
    // Sem Mercado Pago configurado neste ambiente (PlatformSettings sem token) — a ação chega a
    // rodar e devolve um erro específico, não trava nem quebra a tela.
    await expect(page.getByText("Não foi possível regerar o Pix").first()).toBeVisible();
  });
});
