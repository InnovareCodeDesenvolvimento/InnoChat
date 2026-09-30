import { test, expect } from "@playwright/test";
import { SEED_TENANT_SLUG, E2E_RUN_PREFIX } from "./fixtures/test-data";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";
import { prisma } from "./fixtures/db";

/**
 * Sino: notificação "Cliente pediu atendente" (bot v2, L-2). É DERIVADA de `HandoffRequest`
 * (não há tabela de notificação): o pedido é criado direto no banco — o mesmo efeito de o cliente
 * digitar "atendente" no WhatsApp — e a spec confere ícone/texto/selo "Fora do horário" no sino,
 * o aviso ao vivo (toast, sem recarregar) e o clique que abre a ficha do cliente.
 */
test.use({ storageState: OWNER_STORAGE_STATE });
test.setTimeout(90_000);
test.describe.configure({ mode: "serial" });

const suffix = E2E_RUN_PREFIX.replace(/\D/g, "").slice(-9);
const INSTANCE_NAME = `e2e-handoff-${suffix}`;
const IN_HOURS_NAME = `${E2E_RUN_PREFIX} Pediu Atendente`;
const OFF_HOURS_NAME = `${E2E_RUN_PREFIX} Pediu Fora Horario`;
const LIVE_NAME = `${E2E_RUN_PREFIX} Pediu Ao Vivo`;

let tenantId = "";
let instanceId = "";

async function createHandoff(name: string, opts: { offHours: boolean; digit: string }) {
  const contact = await prisma.contact.create({
    data: { tenantId, name, waJid: `55119${suffix}${opts.digit}@s.whatsapp.net`, phoneE164: `+55119${suffix}${opts.digit}` },
  });
  const session = await prisma.chatSession.create({
    data: { whatsappInstanceId: instanceId, contactId: contact.id, state: "HUMAN", humanUntil: new Date(Date.now() + 2 * 3_600_000) },
  });
  await prisma.handoffRequest.create({
    data: {
      tenantId,
      whatsappInstanceId: instanceId,
      contactId: contact.id,
      chatSessionId: session.id,
      reason: "CLIENT_REQUEST",
      offHours: opts.offHours,
    },
  });
  return contact;
}

test.beforeAll(async () => {
  tenantId = (await prisma.tenant.findUniqueOrThrow({ where: { slug: SEED_TENANT_SLUG }, select: { id: true } })).id;
  const instance = await prisma.whatsappInstance.create({
    data: { tenantId, instanceName: INSTANCE_NAME, label: "E2E atendente", status: "CONNECTED", webhookToken: `e2e-token-${suffix}`, sandbox: true },
  });
  instanceId = instance.id;
});

test.afterAll(async () => {
  await prisma.handoffRequest.deleteMany({ where: { whatsappInstanceId: instanceId } });
  await prisma.chatSession.deleteMany({ where: { whatsappInstanceId: instanceId } });
  await prisma.contact.deleteMany({ where: { name: { contains: E2E_RUN_PREFIX } } });
  await prisma.whatsappInstance.deleteMany({ where: { id: instanceId } });
});

test.describe("sino: Cliente pediu atendente", () => {
  test("aparece no sino com o nome do cliente; fora do horário ganha o selo, dentro do horário não", async ({ page }) => {
    await createHandoff(IN_HOURS_NAME, { offHours: false, digit: "1" });
    await createHandoff(OFF_HOURS_NAME, { offHours: true, digit: "2" });

    await page.goto(`/${SEED_TENANT_SLUG}/inicio`);
    await page.getByRole("button", { name: /^Notificações/ }).click();
    const panel = page.getByRole("dialog", { name: "Notificações" });
    await expect(panel).toBeVisible();

    const inHours = panel.getByRole("link").filter({ hasText: IN_HOURS_NAME });
    const offHours = panel.getByRole("link").filter({ hasText: OFF_HOURS_NAME });
    await expect(inHours.getByText("Cliente pediu atendente")).toBeVisible();
    await expect(offHours.getByText("Cliente pediu atendente")).toBeVisible();
    await expect(offHours.getByText("Fora do horário")).toBeVisible();
    await expect(inHours.getByText("Fora do horário")).toHaveCount(0);
    // O sufixo "· fora do horário" do corpo não se repete ao lado do selo.
    await expect(offHours).not.toContainText("· fora do horário");
    // Nunca expõe o telefone, só o nome (privacidade da central de notificações).
    await expect(panel).not.toContainText(`+55119${suffix}`);
  });

  test("clicar abre a ficha do cliente (onde fica o Retomar bot) e limpa a URL", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/inicio`);
    await page.getByRole("button", { name: /^Notificações/ }).click();
    const panel = page.getByRole("dialog", { name: "Notificações" });
    await panel.getByRole("link").filter({ hasText: IN_HOURS_NAME }).click();

    await expect(page).toHaveURL(new RegExp(`/${SEED_TENANT_SLUG}/clientes$`));
    const detail = page.getByRole("dialog").filter({ hasText: IN_HOURS_NAME });
    await expect(detail).toBeVisible();
    await expect(detail.getByText("Bot do WhatsApp")).toBeVisible();
  });

  test("pedido novo com o painel aberto aparece sem recarregar (toast e sino)", async ({ page }) => {
    // A lista inicial do sino define o "desde quando" do polling: o pedido só vira toast se nascer DEPOIS
    // dela (um pedido criado antes de a lista voltar entra na lista, sem toast — comportamento correto).
    const firstListLoaded = page.waitForResponse(async (r) => r.request().method() === "POST" && (await r.text().catch(() => "")).includes("\"nextCursor\""));
    await page.goto(`/${SEED_TENANT_SLUG}/agenda`);
    await expect(page.getByRole("button", { name: /^Notificações/ })).toBeVisible();
    await firstListLoaded;
    await page.waitForTimeout(500); // o cliente processa a resposta (define o "desde quando")
    await page.evaluate(() => {
      (window as unknown as { __semReload: string }).__semReload = "mesma-pagina";
    });

    await createHandoff(LIVE_NAME, { offHours: false, digit: "3" });

    // O polling das notificações roda a cada ~30 s.
    const toast = page.locator(".notif-toast").filter({ hasText: LIVE_NAME });
    await expect(toast).toBeVisible({ timeout: 50_000 });
    await expect(toast).toContainText("Cliente pediu atendente");
    expect(await page.evaluate(() => (window as unknown as { __semReload?: string }).__semReload)).toBe("mesma-pagina");
  });

  test("a notificação não vaza para outra empresa", async ({ page }) => {
    // Empresa B (fixture do global-setup): o pedido feito na empresa de seed não pode aparecer lá.
    const fixtures = JSON.parse((await import("node:fs")).readFileSync("./tests/e2e/.e2e-fixture-ids.json", "utf-8")) as { tenantBSlug: string };
    const { TENANT_B_OWNER_STORAGE_STATE } = await import("./fixtures/storage-state");
    const context = await page.context().browser()!.newContext({ storageState: TENANT_B_OWNER_STORAGE_STATE, baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000" });
    const pageB = await context.newPage();
    try {
      await pageB.goto(`/${fixtures.tenantBSlug}/inicio`);
      await pageB.getByRole("button", { name: /^Notificações/ }).click();
      const panel = pageB.getByRole("dialog", { name: "Notificações" });
      await expect(panel).toBeVisible();
      await expect(panel).not.toContainText(IN_HOURS_NAME);
      await expect(panel).not.toContainText("Cliente pediu atendente");
    } finally {
      await context.close();
    }
  });
});
