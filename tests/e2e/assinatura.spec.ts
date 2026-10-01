import { test, expect } from "@playwright/test";
import { loginAndWaitForPanel } from "./fixtures/auth";
import { prisma } from "./fixtures/db";
import type { SubscriptionStatus } from "@/core/billing/types";
import { SEED_TENANT_SLUG, STAFF_PASSWORD, E2E_RUN_PREFIX, loadRunFixtures } from "./fixtures/test-data";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";

/**
 * Assinatura → trocar plano (docs/contratos.md §7.2): upgrade imediato, downgrade bloqueado
 * mostrando o que remover, downgrade agendado ("próximo ciclo"), e STAFF não troca.
 *
 * Achado ao montar este teste: os 3 planos do seed nascem `active: false` (preço ainda não
 * definido pelo dono, decisão registrada em docs/contratos.md) — `listActivePlansAction` só
 * devolve planos `active: true`, então a tela "Planos disponíveis" fica VAZIA com os dados de
 * seed puros. Sem isso, nenhum destes 4 cenários é alcançável pela UI. Ativa temporariamente
 * Essencial e Profissional (preço continua R$0, só o flag `active`) e restaura tudo no
 * `afterAll` — mesmo padrão de "override temporário" já usado para `maxProfessionalsOverride`
 * (ver [[seed_tenant_plan_limit_e2e]] na memória).
 *
 * Também usa (e devolve) o override de profissionais que o `global-setup.ts` já sobe para 10
 * durante toda a suíte — o cenário de "downgrade bloqueado" precisa dele voltando a `null`
 * momentaneamente para o limite do PLANO (3, Essencial) valer de verdade.
 */
test.describe.configure({ mode: "serial" });

test.describe("Assinatura: trocar plano", () => {
  let essencialId: string;
  let profissionalId: string;
  let originalSubscription: { planId: string; status: SubscriptionStatus; pendingPlanId: string | null; currentPeriodEnd: Date };
  let extraProfessionalIds: string[] = [];

  test.beforeAll(async () => {
    const [essencial, profissional] = await Promise.all([
      prisma.plan.findUniqueOrThrow({ where: { code: "essencial" } }),
      prisma.plan.findUniqueOrThrow({ where: { code: "profissional" } }),
    ]);
    essencialId = essencial.id;
    profissionalId = profissional.id;
    await prisma.plan.updateMany({ where: { id: { in: [essencialId, profissionalId] } }, data: { active: true } });

    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: SEED_TENANT_SLUG } });
    const subscription = await prisma.subscription.findUniqueOrThrow({ where: { tenantId: tenant.id } });
    originalSubscription = {
      planId: subscription.planId,
      status: subscription.status,
      pendingPlanId: subscription.pendingPlanId,
      currentPeriodEnd: subscription.currentPeriodEnd,
    };
  });

  test.afterAll(async () => {
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: SEED_TENANT_SLUG } });
    await prisma.subscription.update({ where: { tenantId: tenant.id }, data: originalSubscription });
    await prisma.plan.updateMany({ where: { id: { in: [essencialId, profissionalId] } }, data: { active: false } });
    await prisma.tenant.update({ where: { id: tenant.id }, data: { maxProfessionalsOverride: 10 } });
    if (extraProfessionalIds.length) {
      await prisma.professional.deleteMany({ where: { id: { in: extraProfessionalIds } } });
    }
  });

  test("STAFF não vê o botão de troca de plano habilitado", async ({ page }) => {
    // STAFF não tem `storageState` pré-gerado (aparece uma única vez nesta suíte) — login real
    // aqui não pesa no orçamento do rate limit.
    const fixtures = loadRunFixtures();
    await loginAndWaitForPanel(page, fixtures.staffEmail, STAFF_PASSWORD, SEED_TENANT_SLUG);
    await page.goto(`/${SEED_TENANT_SLUG}/assinatura`);

    await expect(page.getByText("Só o dono da empresa pode trocar de plano.").first()).toBeVisible();
    const upgradeButton = page.getByRole("button", { name: /Fazer upgrade|Fazer downgrade/ }).first();
    await expect(upgradeButton).toBeDisabled();
  });

  // Demais cenários logam como OWNER — via `storageState` (gerado uma vez em `global-setup.ts`),
  // em vez de logar de novo pela UI em cada teste (ver `login_rate_limit_e2e` na memória).
  test.describe(() => {
    test.use({ storageState: OWNER_STORAGE_STATE });

    test("Upgrade (Essencial → Profissional) aplica imediatamente", async ({ page }) => {
      await page.goto(`/${SEED_TENANT_SLUG}/assinatura`);

      // Mesma renderização dupla (tabela desktop + cartões mobile) do visual premium — ver o
      // achado equivalente em `catalog-and-agenda.spec.ts`.
      await page.getByRole("button", { name: "Fazer upgrade" }).first().click();
      const dialog = page.getByRole("dialog").filter({ hasText: "Trocar de plano" });
      await expect(dialog).toContainText(/já está em vigor|próxima fatura/);
      await dialog.getByRole("button", { name: "Confirmar" }).click();

      await expect(page.getByText("Plano trocado.").first()).toBeVisible();
      await expect(page.getByText("O novo plano já está em vigor.").first()).toBeVisible();
      await page.waitForFunction(
        () => document.body.textContent?.includes("Plano atual") && document.body.textContent?.includes("Profissional"),
      );
    });

    test("Downgrade (Profissional → Essencial) é bloqueado quando o uso atual não cabe, e mostra o que remover", async ({ page }) => {
      const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: SEED_TENANT_SLUG } });

      // Conta o que JÁ existe (nunca assume um número fixo tipo "Ana + Bruna + mais um" — achado
      // ao rodar esta suíte cheia: um fixture de outra sessão que não fazia parte do seed
      // ["Profissional QA"] existia e sumiu depois de uma limpeza de dado órfão, e o "4" fixo
      // neste teste quebrou em silêncio, sem avisar que a premissa tinha mudado) e cria só os
      // profissionais que faltam para passar do limite do Essencial (3), e remove o override
      // temporariamente — sem isso, `changePlan` usa o override (10) em vez do limite do plano.
      const currentCount = await prisma.professional.count({ where: { tenantId: tenant.id, active: true } });
      const essencialLimit = 3;
      const toCreate = Math.max(essencialLimit + 1 - currentCount, 1);
      const extras = await prisma.professional.createManyAndReturn({
        data: Array.from({ length: toCreate }, (_, i) => ({
          tenantId: tenant.id,
          name: `${E2E_RUN_PREFIX} profissional extra ${i}`,
          sortOrder: 99 + i,
        })),
      });
      extraProfessionalIds = extras.map((p) => p.id);
      const finalCount = currentCount + toCreate;
      await prisma.tenant.update({ where: { id: tenant.id }, data: { maxProfessionalsOverride: null } });

      await page.goto(`/${SEED_TENANT_SLUG}/assinatura`);

      await page.getByRole("button", { name: "Fazer downgrade" }).click();
      await page.getByRole("dialog").filter({ hasText: "Trocar de plano" }).getByRole("button", { name: "Confirmar" }).click();

      const blockedDialog = page.getByRole("dialog").filter({ hasText: "Não é possível fazer esse downgrade ainda" });
      await expect(blockedDialog).toBeVisible();
      await expect(blockedDialog).toContainText("até 3 profissionais cadastrados");
      await expect(blockedDialog).toContainText(`empresa tem ${finalCount} hoje`);
      await expect(blockedDialog).toContainText(`Remova ${finalCount - essencialLimit}`);
      await blockedDialog.getByRole("button", { name: "Entendi" }).click();

      // Devolve o cenário para o próximo teste (downgrade que CABE): remove os extras e o
      // override volta a 10 (default da suíte).
      await prisma.professional.deleteMany({ where: { id: { in: extraProfessionalIds } } });
      extraProfessionalIds = [];
      await prisma.tenant.update({ where: { id: tenant.id }, data: { maxProfessionalsOverride: 10 } });
    });

    test("Downgrade (Profissional → Essencial) que cabe fica agendado para o próximo ciclo", async ({ page }) => {
      await page.goto(`/${SEED_TENANT_SLUG}/assinatura`);

      await page.getByRole("button", { name: "Fazer downgrade" }).click();
      const dialog = page.getByRole("dialog").filter({ hasText: "Trocar de plano" });
      await expect(dialog).toContainText("vale a partir do próximo ciclo");
      await dialog.getByRole("button", { name: "Confirmar" }).click();

      await expect(page.getByText("Troca agendada.").first()).toBeVisible();
      await expect(page.getByText("A mudança entra em vigor no próximo ciclo de cobrança.").first()).toBeVisible();
      await expect(page.getByText("Mudança para o plano").first()).toBeVisible();
      await expect(page.getByText("Agendado", { exact: true }).first()).toBeVisible();
    });
  });
});
