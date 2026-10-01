import { test, expect } from "@playwright/test";
import { loginAndWaitForPanel } from "./fixtures/auth";
import { prisma, hashPassword, ensureBotPlan } from "./fixtures/db";
import { E2E_RUN_PREFIX } from "./fixtures/test-data";

/**
 * Suspensão (docs/arquitetura.md §7.4): empresa com assinatura `SUSPENDED` fica com o painel
 * "somente leitura" — Serviços, Profissionais e Agenda mostram os botões de escrita desabilitados
 * com um aviso, e o SERVIDOR (não só a tela) recusa a ação com `TENANT_SUSPENDED`
 * (`assertTenantCanWrite`, chamado em toda Server Action de mutação de catalog/appointment).
 *
 * Empresa e usuário isolados, criados/limpos só por este arquivo (não usa a Empresa B do
 * `global-setup.ts`, que fica `ACTIVE` de propósito para outros specs).
 */

// E-mail é normalizado para minúsculas no servidor antes de qualquer lookup (`verifyCredentials`,
// `src/modules/auth/service.ts:37`) — `E2E_RUN_PREFIX` tem o marcador em MAIÚSCULAS
// (`E2E_TEST_DATA_...`), então construir o e-mail sem `.toLowerCase()` aqui gravaria um valor que
// o login nunca encontra (achado ao rodar este teste: "user_not_found" mesmo com o usuário
// existindo no banco, só que com capitalização diferente).
const RUN_PREFIX_LC = E2E_RUN_PREFIX.toLowerCase();
const SLUG = `${RUN_PREFIX_LC}-suspensa`;
const OWNER_EMAIL = `${RUN_PREFIX_LC}-owner-suspensa@e2e.innochat.local`;
const OWNER_PASSWORD = "e2e-suspensa-pass-2026";

let tenantId: string;

/**
 * Força efetivamente SUSPENDED: `effectiveStatus` (src/core/billing/status.ts) olha `status` E
 * `currentPeriodEnd` juntos — só marcar `status: "SUSPENDED"` não basta se `currentPeriodEnd`
 * ainda está no futuro (o cálculo devolveria "ACTIVE"). Empurra o vencimento 5 dias para o
 * passado (depois da carência de 3 dias de quem paga, dentro dos 60 dias antes de virar CANCELED) — mesmo
 * truque documentado em `admin-service.ts#suspendCompanyManually`.
 */
async function suspendNow() {
  await prisma.subscription.update({
    where: { tenantId },
    data: { status: "SUSPENDED", currentPeriodEnd: new Date(Date.now() - 5 * 86_400_000) },
  });
}

test.describe("Empresa suspensa: painel somente leitura", () => {
  test.beforeAll(async () => {
    const plan = await ensureBotPlan();
    const tenant = await prisma.tenant.create({
      data: { slug: SLUG, name: "Empresa Suspensa (E2E)", timezone: "America/Sao_Paulo" },
    });
    tenantId = tenant.id;

    // Nasce ACTIVE — cada teste decide quando suspender (o teste de Serviços precisa do botão
    // "Novo serviço" DESTRAVADO para abrir o diálogo antes de suspender no meio do caminho).
    await prisma.subscription.create({
      data: { tenantId: tenant.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) },
    });

    const owner = await prisma.user.create({
      data: {
        email: OWNER_EMAIL,
        passwordHash: await hashPassword(OWNER_PASSWORD),
        emailVerifiedAt: new Date(),
        termsAcceptedAt: new Date(),
        termsVersion: "e2e",
      },
    });
    await prisma.membership.create({ data: { userId: owner.id, tenantId: tenant.id, role: "OWNER" } });

    // Um serviço e um profissional para a tela não cair no estado vazio (queremos ver os botões
    // de ação desabilitados EM LINHAS existentes, não só no cabeçalho).
    await prisma.service.create({
      data: { tenantId: tenant.id, name: "Corte (E2E suspensa)", durationMin: 30, sortOrder: 0 },
    });
    await prisma.professional.create({ data: { tenantId: tenant.id, name: "Prof. (E2E suspensa)", sortOrder: 0 } });
  });

  test.afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { slug: SLUG } });
    await prisma.user.deleteMany({ where: { email: OWNER_EMAIL } });
  });

  test("servidor recusa a Server Action com TENANT_SUSPENDED mesmo se a UI ainda não sabia (janela de corrida)", async ({ page }) => {
    // Abre o diálogo de "Novo serviço" ENQUANTO a empresa ainda está ACTIVE (botão habilitado,
    // clique real) — simula a janela entre "a tela carregou" e "a assinatura foi suspensa no
    // meio da sessão" (ex.: `billing/tick` suspendendo por falta de pagamento). O objetivo é
    // provar que quem garante a regra é o `assertTenantCanWrite` NO SERVIDOR, e não só o
    // `disabled` do botão — clicar num botão HTML de verdade desabilitado não dispara o
    // `onClick` do React de propósito nenhum (testado: nem removendo o atributo via DOM e
    // clicando de verdade depois, então essa é a forma realista de exercitar o caminho).
    await loginAndWaitForPanel(page, OWNER_EMAIL, OWNER_PASSWORD, SLUG);
    await page.goto(`/${SLUG}/servicos`);
    await expect(page.getByText(/Assinatura suspensa/)).toHaveCount(0);

    await page.getByRole("button", { name: "Novo serviço" }).first().click();
    await page.getByLabel("Nome").fill(`${E2E_RUN_PREFIX} servico forcado`);
    await page.getByLabel("Duração (min)").fill("30");

    await suspendNow();

    await page.getByRole("button", { name: "Criar" }).click();

    // A Server Action recusa com TENANT_SUSPENDED — a tela mostra a mensagem no formulário (não
    // trava, não devolve 500) e o serviço forçado NUNCA é criado.
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 8_000 });
    const created = await prisma.service.findFirst({ where: { name: { contains: "servico forcado" } } });
    expect(created).toBeNull();
  });

  test("Serviços: botões de escrita desabilitados com aviso quando a tela já carrega suspensa", async ({ page }) => {
    await suspendNow();
    await loginAndWaitForPanel(page, OWNER_EMAIL, OWNER_PASSWORD, SLUG);
    await page.goto(`/${SLUG}/servicos`);

    await expect(page.getByText(/Assinatura suspensa/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Novo serviço" }).first()).toBeDisabled();
  });

  test("Profissionais: botão de novo profissional desabilitado com o mesmo aviso", async ({ page }) => {
    await suspendNow();
    await loginAndWaitForPanel(page, OWNER_EMAIL, OWNER_PASSWORD, SLUG);
    await page.goto(`/${SLUG}/profissionais`);

    await expect(page.getByText(/Assinatura suspensa/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Novo profissional" }).first()).toBeDisabled();
  });

  test("Agenda: 'Novo agendamento' desabilitado com o mesmo aviso", async ({ page }) => {
    await suspendNow();
    await loginAndWaitForPanel(page, OWNER_EMAIL, OWNER_PASSWORD, SLUG);
    await page.goto(`/${SLUG}/agenda`);

    await expect(page.getByRole("button", { name: "Novo agendamento" })).toBeDisabled();
  });
});
