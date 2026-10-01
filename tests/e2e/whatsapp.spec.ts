import { test, expect } from "@playwright/test";
import { loginAndWaitForPanel } from "./fixtures/auth";
import { prisma, hashPassword } from "./fixtures/db";
import { E2E_RUN_PREFIX } from "./fixtures/test-data";
import { startFakeEvolutionServer } from "./fixtures/fake-evolution-server";
import { collectCspViolations } from "./fixtures/csp";

/**
 * WhatsApp (`/[tenantSlug]/whatsapp`, `src/components/whatsapp/*`) contra uma Evolution FAKE
 * (mesma técnica do `admin-configuracoes.spec.ts` para o n8n — servidor HTTP local, a URL vai em
 * `PlatformSettings.evolutionApiUrl`). Empresa e usuários isolados, criados/limpos só por este
 * arquivo. `test.describe.serial`: os cenários dependem uns dos outros de propósito (limite de
 * plano só é interessante DEPOIS de já existir 1 número; o ponto vermelho da nav só depois de
 * desconectar).
 */

const RUN_PREFIX_LC = E2E_RUN_PREFIX.toLowerCase();
const SLUG = `${RUN_PREFIX_LC}-whatsapp`;
const OWNER_EMAIL = `${RUN_PREFIX_LC}-owner-whatsapp@e2e.innochat.local`;
const STAFF_EMAIL = `${RUN_PREFIX_LC}-staff-whatsapp@e2e.innochat.local`;
const OWNER_PASSWORD = "e2e-whatsapp-owner-2026";
const STAFF_PASSWORD = "e2e-whatsapp-staff-2026";
// Fora do Brasil, sem 9º dígito a corrigir — mais simples para os asserts de formatação.
const PHONE_JID_OK = "5511988887777@s.whatsapp.net";
const PHONE_JID_TRIAL_TAKEN = "5511977776666@s.whatsapp.net";
const PHONE_E164_OK_DISPLAY = "+55 (11) 98888-7777";

type PlatformSnapshot = {
  evolutionApiUrl: string | null;
  evolutionApiKey: string | null;
  n8nWebhookBaseUrl: string | null;
};

test.describe.serial("WhatsApp: conexão por QR com Evolution fake", () => {
  let tenantId: string;
  let originalPlatform: PlatformSnapshot;
  let fakeEvolution: Awaited<ReturnType<typeof startFakeEvolutionServer>>;
  let foreignTenantIdForTrialClaim: string;
  let ownerCookies: Awaited<ReturnType<import("@playwright/test").BrowserContext["cookies"]>> | null = null;

  /**
   * Login novo (`signIn`) tem rate limit de 8/15min POR E-MAIL (`src/modules/auth/service.ts`,
   * segurança 2026-09-28) — este arquivo loga como o mesmo OWNER em quase todo teste e estourava
   * o limite no meio da suíte (achado ao rodar). Loga de verdade só UMA vez e reaproveita o
   * cookie de sessão nos demais testes (guards releem tudo do banco a cada chamada, então mudar
   * `emailVerifiedAt`/status da assinatura entre testes continua valendo mesmo com o cookie
   * "velho" — sessão não carrega esses campos).
   */
  async function loginOwner(page: import("@playwright/test").Page, context: import("@playwright/test").BrowserContext) {
    if (ownerCookies) {
      await context.addCookies(ownerCookies);
      await page.goto(`/${SLUG}/whatsapp`);
      return;
    }
    await loginAndWaitForPanel(page, OWNER_EMAIL, OWNER_PASSWORD, SLUG);
    ownerCookies = await context.cookies();
    await page.goto(`/${SLUG}/whatsapp`);
  }

  test.beforeAll(async () => {
    fakeEvolution = await startFakeEvolutionServer();

    originalPlatform = await prisma.platformSettings.findUniqueOrThrow({
      where: { id: 1 },
      select: { evolutionApiUrl: true, evolutionApiKey: true, n8nWebhookBaseUrl: true },
    });
    await prisma.platformSettings.update({
      where: { id: 1 },
      data: {
        evolutionApiUrl: fakeEvolution.url,
        evolutionApiKey: "fake-evolution-key-e2e",
        n8nWebhookBaseUrl: "http://fake-n8n-webhook.e2e.local/webhook",
      },
    });

    const essencial = await prisma.plan.findUniqueOrThrow({ where: { code: "essencial" } }); // maxWhatsappNumbers: 1
    const tenant = await prisma.tenant.create({
      data: { slug: SLUG, name: "Empresa WhatsApp (E2E)", timezone: "America/Sao_Paulo" },
    });
    tenantId = tenant.id;
    await prisma.subscription.create({
      data: {
        tenantId: tenant.id,
        planId: essencial.id,
        status: "TRIALING",
        trialEndsAt: new Date(Date.now() + 86_400_000),
        currentPeriodEnd: new Date(Date.now() + 86_400_000),
      },
    });

    const owner = await prisma.user.create({
      data: {
        email: OWNER_EMAIL,
        passwordHash: await hashPassword(OWNER_PASSWORD),
        emailVerifiedAt: new Date(),
        termsAcceptedAt: new Date(),
        termsVersion: "e2e",
        // Sem isto o tour do Inno abre sozinho 700ms depois da página e o overlay intercepta cliques.
        onboardingTourCompletedAt: new Date(),
      },
    });
    await prisma.membership.create({ data: { userId: owner.id, tenantId: tenant.id, role: "OWNER" } });

    const staff = await prisma.user.create({
      data: {
        email: STAFF_EMAIL,
        passwordHash: await hashPassword(STAFF_PASSWORD),
        emailVerifiedAt: new Date(),
        termsAcceptedAt: new Date(),
        termsVersion: "e2e",
        // Sem isto o tour do Inno abre sozinho 700ms depois da página e o overlay intercepta cliques.
        onboardingTourCompletedAt: new Date(),
      },
    });
    await prisma.membership.create({ data: { userId: staff.id, tenantId: tenant.id, role: "STAFF" } });

    // Empresa DIFERENTE que já "gastou" o trial deste número — usada no cenário
    // TRIAL_PHONE_ALREADY_USED. Precisa só existir, nunca é acessada pela UI.
    const foreignTenant = await prisma.tenant.create({
      data: { slug: `${SLUG}-outra-empresa`, name: "Outra empresa (E2E)", timezone: "America/Sao_Paulo" },
    });
    foreignTenantIdForTrialClaim = foreignTenant.id;
    const phoneAlreadyClaimed = "+5511977776666";
    await prisma.trialClaim.create({ data: { phoneE164: phoneAlreadyClaimed, tenantId: foreignTenant.id } });
  });

  test.afterAll(async () => {
    await prisma.tenant.deleteMany({ where: { slug: { in: [SLUG, `${SLUG}-outra-empresa`] } } });
    await prisma.user.deleteMany({ where: { email: { in: [OWNER_EMAIL, STAFF_EMAIL] } } });
    await prisma.platformSettings.update({ where: { id: 1 }, data: originalPlatform });
    await fakeEvolution.close();
    void foreignTenantIdForTrialClaim;
  });

  test("fluxo feliz: QR → 'open' → cartão Conectado com telefone formatado, sem violar CSP", async ({ page, context }) => {
    const { violations } = collectCspViolations(page);
    await loginOwner(page, context);

    await page.getByRole("button", { name: "Conectar número" }).click();
    await page.getByLabel("Rótulo *", { exact: true }).fill("Recepção");
    await page.getByRole("button", { name: "Gerar QR code" }).click();

    await expect(page.getByAltText(/QR code para conectar o WhatsApp/)).toBeVisible({ timeout: 10_000 });
    const src = await page.getByAltText(/QR code para conectar o WhatsApp/).getAttribute("src");
    expect(src).toMatch(/^data:image\/png;base64,/);

    const instanceName = fakeEvolution.lastCreatedInstanceName();
    expect(instanceName).toBeTruthy();
    fakeEvolution.setState(instanceName!, "open");
    fakeEvolution.setOwnerJid(instanceName!, PHONE_JID_OK);

    // Corrigido pela Lyra: o `ConnectWhatsappDialog` agora fica SEMPRE montado em
    // `whatsapp-client.tsx` (estado `open` no componente pai), então o passo de sucesso aparece
    // mesmo ao conectar o PRIMEIRO número — antes ele desmontava junto com o `EmptyState` no
    // instante em que a lista deixava de estar vazia.
    await expect(page.getByRole("dialog").getByText("Número conectado", { exact: true })).toBeVisible({
      timeout: 8_000,
    });
    await page.getByRole("button", { name: "Concluir" }).click();

    await expect(page.getByText("Conectado", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(PHONE_E164_OK_DISPLAY).first()).toBeVisible();

    expect(violations).toEqual([]);
  });

  test("'Gerar novo QR' depois de 2 minutos sem leitura (clock virtual, sem esperar de verdade)", async ({ page, context }) => {
    await context.clock.install();
    await loginOwner(page, context);

    // Sobe o limite do plano ANTES (Essencial só permite 1 número, e o teste anterior já usou o
    // único slot) — este cenário testa a expiração do QR, não o limite; o próximo teste é quem
    // testa `PLAN_LIMIT_REACHED` de propósito, então essa ordem importa.
    await prisma.tenant.update({ where: { id: tenantId }, data: { maxWhatsappNumbersOverride: 10 } });

    await page.goto(`/${SLUG}/whatsapp`);
    await page.getByRole("button", { name: "Conectar número" }).click();
    await page.getByLabel("Rótulo *", { exact: true }).fill("Segunda linha");
    await page.getByRole("button", { name: "Gerar QR code" }).click();
    await expect(page.getByAltText(/QR code para conectar o WhatsApp/)).toBeVisible({ timeout: 10_000 });

    // Avança o relógio VIRTUAL 2min01s — o `setTimeout(POLL_TIMEOUT_MS)` do diálogo dispara sem
    // esperar isso de verdade (`connect-whatsapp-dialog.tsx`, `POLL_TIMEOUT_MS = 2*60*1000`).
    await context.clock.fastForward("02:01");
    await expect(page.getByText("O QR code expirou.", { exact: true }).first()).toBeVisible();
    const expiredButton = page.getByRole("button", { name: "Gerar novo QR" });
    await expect(expiredButton).toBeVisible();

    await context.clock.resume(); // volta ao tempo real antes de continuar (evita travar o próximo poll)
    await expiredButton.click();
    await expect(page.getByAltText(/QR code para conectar o WhatsApp/)).toBeVisible({ timeout: 10_000 });

    await prisma.tenant.update({ where: { id: tenantId }, data: { maxWhatsappNumbersOverride: null } });
  });

  test("limite do plano (Essencial: 1 número): a tela troca 'Adicionar número' pelo card de upgrade", async ({ page, context }) => {
    // Volta ao limite apertado — a instância do teste 1 (conectada) já ocupa a única vaga; a
    // "Segunda linha" do teste anterior ainda existe (override tinha subido para 10), então
    // remove ela antes para o cenário ficar limpo (exatamente 1 número, no limite).
    await prisma.whatsappInstance.updateMany({
      where: { tenantId, label: "Segunda linha" },
      data: { deletedAt: new Date() },
    });

    await loginOwner(page, context);
    // Fase 2: a UI não oferece mais o caminho que o servidor recusaria (a recusa em si,
    // PLAN_LIMIT_REACHED, segue coberta em tests/integration/whatsapp.integration.test.ts).
    const limitCard = page.getByTestId("plan-limit-card");
    await expect(limitCard).toBeVisible();
    await expect(limitCard.getByText("Limite do plano atingido (1 de 1)")).toBeVisible();
    await expect(limitCard.getByRole("link", { name: "Fazer upgrade" })).toHaveAttribute("href", /\/assinatura$/);
    await expect(page.getByRole("button", { name: "Conectar número" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Adicionar número" })).toHaveCount(0);
  });

  test("TRIAL_PHONE_ALREADY_USED: número já usado em outro teste grátis mostra mensagem específica", async ({ page, context }) => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { maxWhatsappNumbersOverride: 10 } });

    await loginOwner(page, context);
    await page.getByRole("button", { name: "Conectar número" }).click();
    await page.getByLabel("Rótulo *", { exact: true }).fill("Linha trial já usada");
    await page.getByRole("button", { name: "Gerar QR code" }).click();
    await expect(page.getByAltText(/QR code para conectar o WhatsApp/)).toBeVisible({ timeout: 10_000 });

    const instanceName = fakeEvolution.lastCreatedInstanceName();
    fakeEvolution.setState(instanceName!, "open");
    fakeEvolution.setOwnerJid(instanceName!, PHONE_JID_TRIAL_TAKEN);

    await expect(page.getByText("Este número já usou o teste grátis").first()).toBeVisible({ timeout: 8_000 });
    await expect(
      page.getByText("Esse número de WhatsApp já foi conectado em outro teste grátis do InnoChat."),
    ).toBeVisible();

    const instance = await prisma.whatsappInstance.findFirstOrThrow({ where: { tenantId, label: "Linha trial já usada" } });
    expect(instance.status).toBe("DISCONNECTED");
    expect(instance.phoneE164).toBeNull();
  });

  test("EMAIL_NOT_VERIFIED: sem e-mail confirmado, não conecta", async ({ page, context }) => {
    await prisma.user.update({ where: { email: OWNER_EMAIL }, data: { emailVerifiedAt: null } });
    try {
      await loginOwner(page, context);
      await page.getByRole("button", { name: "Conectar número" }).click();
      await page.getByLabel("Rótulo *", { exact: true }).fill("Linha sem verificar email");
      await page.getByRole("button", { name: "Gerar QR code" }).click();

      await expect(page.getByText("Confirme seu e-mail antes de conectar").first()).toBeVisible();
      const created = await prisma.whatsappInstance.findFirst({ where: { tenantId, label: "Linha sem verificar email" } });
      expect(created).toBeNull();
    } finally {
      await prisma.user.update({ where: { email: OWNER_EMAIL }, data: { emailVerifiedAt: new Date() } });
    }
  });

  test("N8N_NOT_CONFIGURED e EVOLUTION_NOT_CONFIGURED: mesma mensagem genérica, nada é criado", async ({ page, context }) => {
    await loginOwner(page, context);

    // --- sem n8nWebhookBaseUrl ---
    await prisma.platformSettings.update({ where: { id: 1 }, data: { n8nWebhookBaseUrl: null } });
    await page.goto(`/${SLUG}/whatsapp`);
    await page.getByRole("button", { name: "Conectar número" }).click();
    await page.getByLabel("Rótulo *", { exact: true }).fill("Linha sem n8n");
    await page.getByRole("button", { name: "Gerar QR code" }).click();
    await expect(page.getByText("Ainda não é possível conectar").first()).toBeVisible();
    await prisma.platformSettings.update({ where: { id: 1 }, data: { n8nWebhookBaseUrl: "http://fake-n8n-webhook.e2e.local/webhook" } });

    // --- sem Evolution configurada ---
    await page.getByRole("button", { name: "Cancelar" }).click();
    await prisma.platformSettings.update({ where: { id: 1 }, data: { evolutionApiUrl: null, evolutionApiKey: null } });
    await page.getByRole("button", { name: "Conectar número" }).click();
    await page.getByLabel("Rótulo *", { exact: true }).fill("Linha sem evolution");
    await page.getByRole("button", { name: "Gerar QR code" }).click();
    await expect(page.getByText("Ainda não é possível conectar").first()).toBeVisible();
    await prisma.platformSettings.update({
      where: { id: 1 },
      data: { evolutionApiUrl: fakeEvolution.url, evolutionApiKey: "fake-evolution-key-e2e" },
    });

    const created = await prisma.whatsappInstance.findMany({
      where: { tenantId, label: { in: ["Linha sem n8n", "Linha sem evolution"] } },
    });
    expect(created).toHaveLength(0);
  });

  test("TENANT_SUSPENDED: mensagem de assinatura suspensa, e reativa em seguida", async ({ page, context }) => {
    await prisma.subscription.update({
      where: { tenantId },
      data: { status: "SUSPENDED", currentPeriodEnd: new Date(Date.now() - 5 * 86_400_000) },
    });
    try {
      await loginOwner(page, context);
      // O botão já nasce desabilitado (`writeBlocked`) — o teste de enforcement no servidor para
      // suspensão já está coberto em `suspensao.spec.ts`; aqui o foco é a MENSAGEM específica do
      // WhatsApp (link "Ver assinatura", texto do aviso no topo da tela).
      await expect(page.getByText(/Assinatura suspensa/).first()).toBeVisible();
      await expect(page.getByRole("link", { name: "Ver assinatura" })).toBeVisible();
    } finally {
      await prisma.subscription.update({
        where: { tenantId },
        data: { status: "TRIALING", currentPeriodEnd: new Date(Date.now() + 86_400_000) },
      });
    }
  });

  test("STAFF não vê nenhuma ação de escrita (conectar/atualizar/desconectar/remover)", async ({ page }) => {
    await loginAndWaitForPanel(page, STAFF_EMAIL, STAFF_PASSWORD, SLUG);
    await page.goto(`/${SLUG}/whatsapp`);

    await expect(page.getByRole("button", { name: "Conectar número" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Atualizar status" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Desconectar" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Remover" })).toHaveCount(0);
    // Mas continua vendo a informação (o card do número conectado no teste 1).
    await expect(page.getByText("Recepção").first()).toBeVisible();
  });

  test("remover só funciona digitando o rótulo exato", async ({ page, context }) => {
    await loginOwner(page, context);

    const card = page.getByText("Linha trial já usada", { exact: true }).locator("xpath=ancestor::div[contains(@class,'rounded-card')][1]");
    await card.getByRole("button", { name: "Remover" }).click();

    const dialog = page.getByRole("dialog").filter({ hasText: "Remover número" });
    const confirmButton = dialog.getByRole("button", { name: "Remover para sempre" });
    await expect(confirmButton).toBeDisabled();

    await dialog.getByLabel("Rótulo do número").fill("texto errado");
    await expect(confirmButton).toBeDisabled();

    await dialog.getByLabel("Rótulo do número").fill("Linha trial já usada");
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();

    await expect(page.getByText("Número removido.").first()).toBeVisible();
    const removed = await prisma.whatsappInstance.findFirstOrThrow({ where: { tenantId, label: "Linha trial já usada" } });
    expect(removed.deletedAt).not.toBeNull();
    const deleteCalls = fakeEvolution.received.filter((r) => r.method === "DELETE" && r.url.startsWith("/instance/delete/"));
    expect(deleteCalls.length).toBeGreaterThan(0);
  });

  test("ponto vermelho na nav: nunca para QRCODE, só depois de DISCONNECTED", async ({ page, context }) => {
    await loginOwner(page, context);
    const navDot = page.getByRole("link", { name: /WhatsApp/ }).locator('[title="Precisa de atenção"]');

    // Ainda só a instância CONECTADA do teste 1 — sem ponto.
    await page.goto(`/${SLUG}/agenda`);
    await expect(navDot).toHaveCount(0);

    // Cria uma nova (nasce QRCODE) — continua SEM ponto (QRCODE nunca acende o alerta).
    await page.goto(`/${SLUG}/whatsapp`);
    await page.getByRole("button", { name: "Conectar número" }).click();
    await page.getByLabel("Rótulo *", { exact: true }).fill("Linha para desconectar");
    await page.getByRole("button", { name: "Gerar QR code" }).click();
    await expect(page.getByAltText(/QR code para conectar o WhatsApp/)).toBeVisible({ timeout: 10_000 });
    await page.getByRole("dialog").getByRole("button", { name: "Fechar", exact: true }).last().click();
    await page.goto(`/${SLUG}/agenda`);
    await expect(navDot).toHaveCount(0);

    // Desconecta essa instância — AGORA acende (DISCONNECTED de verdade, não "nunca conectou").
    await page.goto(`/${SLUG}/whatsapp`);
    const card = page.getByText("Linha para desconectar", { exact: true }).locator("xpath=ancestor::div[contains(@class,'rounded-card')][1]");
    await card.getByRole("button", { name: "Desconectar" }).click();
    await page.getByRole("dialog").filter({ hasText: "Desconectar número" }).getByRole("button", { name: "Desconectar" }).click();
    await expect(page.getByText("Número desconectado.").first()).toBeVisible();

    await page.goto(`/${SLUG}/agenda`);
    await expect(navDot).toHaveCount(1);
  });
});
