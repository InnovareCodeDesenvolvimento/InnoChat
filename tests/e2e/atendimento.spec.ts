import { test, expect, type Page } from "@playwright/test";
import { SEED_TENANT_SLUG, SEED_OWNER_EMAIL, E2E_RUN_PREFIX } from "./fixtures/test-data";
import { OWNER_STORAGE_STATE, STAFF_STORAGE_STATE } from "./fixtures/storage-state";
import { prisma } from "./fixtures/db";
import { startFakeServer } from "./fixtures/fake-http-server";

/**
 * Atendimento humano pelo painel (`/[tenantSlug]/atendimento`) + aviso ao cliente quando a equipe agenda,
 * remarca ou cancela. A Evolution é FAKE (servidor HTTP local, URL em `PlatformSettings.evolutionApiUrl`,
 * mesma técnica de `whatsapp.spec.ts`): o envio percorre o caminho real (Server Action -> serviço -> cliente
 * HTTP da Evolution -> histórico no banco), só o WhatsApp de verdade não existe. Isso NÃO prova entrega no
 * WhatsApp real nem o formato exato da resposta da Evolution de produção.
 *
 * Dados: tudo com `E2E_RUN_PREFIX` e limpo no `afterAll` (contatos -> cascata em mensagens/pedidos/agendamentos).
 */
test.use({ storageState: OWNER_STORAGE_STATE, viewport: { width: 1280, height: 1000 } });
test.setTimeout(120_000);
test.describe.configure({ mode: "serial" });

const suffix = E2E_RUN_PREFIX.replace(/\D/g, "").slice(-8);
const INSTANCE_NAME = `e2e-atend-${suffix}`;
const N = (label: string) => `${E2E_RUN_PREFIX} ${label}`;

let tenantId = "";
let instanceId = "";
let ownerName = "";
let phoneSeq = 0;
const nextPhone = () => `+5511${suffix.slice(-6)}${String(phoneSeq++).padStart(3, "0")}`;

let evolutionMode: "ok" | "fail" = "ok";
let fake: Awaited<ReturnType<typeof startFakeServer>>;
let platformBackup: { evolutionApiUrl: string | null; evolutionApiKey: string | null } | null = null;
let originalNotify = true;

const sent = () => fake.received.filter((r) => r.method === "POST" && r.url.includes("/message/sendText/"));
const sentTo = (phone: string) => sent().filter((r) => (r.body as { number?: string })?.number === phone.replace("+", ""));

async function newContact(label: string, opts: { phone?: string | null } = {}) {
  const phone = opts.phone === undefined ? nextPhone() : opts.phone;
  return prisma.contact.create({
    data: {
      tenantId,
      name: N(label),
      phoneE164: phone,
      // Sem telefone: JID de LID (não é número), então não há para onde enviar.
      waJid: phone ? `${phone.replace("+", "")}@s.whatsapp.net` : `${suffix}${phoneSeq++}@lid`,
    },
  });
}

async function addMessages(contactId: string, rows: { direction: "INBOUND" | "OUTBOUND"; body: string; at: Date }[]) {
  await prisma.chatMessage.createMany({
    data: rows.map((r) => ({ tenantId, contactId, whatsappInstanceId: instanceId, direction: r.direction, body: r.body, createdAt: r.at })),
  });
}

/** Cliente que pediu atendente (pedido aberto + sessão em HUMAN), com uma mensagem do cliente. */
async function newWaiting(label: string, opts: { minutesAgo?: number; offHours?: boolean; phone?: string | null } = {}) {
  const contact = await newContact(label, { phone: opts.phone });
  const requestedAt = new Date(Date.now() - (opts.minutesAgo ?? 3) * 60_000);
  const session = await prisma.chatSession.create({
    data: { whatsappInstanceId: instanceId, contactId: contact.id, state: "HUMAN", humanUntil: new Date(Date.now() + 2 * 3_600_000) },
  });
  await prisma.handoffRequest.create({
    data: { tenantId, whatsappInstanceId: instanceId, contactId: contact.id, chatSessionId: session.id, reason: "CLIENT_REQUEST", offHours: !!opts.offHours, requestedAt },
  });
  await addMessages(contact.id, [{ direction: "INBOUND", body: `Oi, preciso de ajuda (${label})`, at: new Date(requestedAt.getTime() + 1000) }]);
  return contact;
}

const waitingInDb = () => prisma.handoffRequest.count({ where: { tenantId, endedAt: null, answeredAt: null } });
const rowOf = (page: Page, contactId: string) => page.locator(`[data-contact-id="${contactId}"]`);
/** Balão do atendente JÁ enviado (o rótulo da bolha local termina em ", enviando" / ", não enviada"). */
const SENT_BUBBLE = /^Atendente(?!.*(enviando|não enviada))/;
const composer = (page: Page) => page.getByTestId("attendance-composer-input");
const setInstanceStatus = (status: "CONNECTED" | "DISCONNECTED") => prisma.whatsappInstance.update({ where: { id: instanceId }, data: { status } });

async function openConversation(page: Page, contactId: string) {
  await page.goto(`/${SEED_TENANT_SLUG}/atendimento?contato=${contactId}`);
  await expect(page.getByTestId("attendance-conversation")).toBeVisible();
  await expect(composer(page)).toBeVisible();
}

test.beforeAll(async () => {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: SEED_TENANT_SLUG }, select: { id: true, notifyClientOnStaffChanges: true } });
  tenantId = tenant.id;
  originalNotify = tenant.notifyClientOnStaffChanges;
  const owner = await prisma.user.findUniqueOrThrow({ where: { email: SEED_OWNER_EMAIL }, select: { name: true } });
  ownerName = owner.name?.trim() || "Atendente";

  fake = await startFakeServer([
    {
      method: "POST",
      path: /^\/message\/sendText\//,
      handler: () => (evolutionMode === "ok" ? { status: 201, body: { key: { id: `FAKE-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` } } } : { status: 500, body: { error: "boom" } }),
    },
  ]);
  const platform = await prisma.platformSettings.findUniqueOrThrow({ where: { id: 1 }, select: { evolutionApiUrl: true, evolutionApiKey: true } });
  platformBackup = platform;
  await prisma.platformSettings.update({ where: { id: 1 }, data: { evolutionApiUrl: fake.url, evolutionApiKey: "fake-evolution-key-e2e" } });

  const instance = await prisma.whatsappInstance.create({
    data: { tenantId, instanceName: INSTANCE_NAME, label: "E2E atendimento", status: "CONNECTED", webhookToken: `e2e-atend-token-${suffix}`, sandbox: false },
  });
  instanceId = instance.id;
  await prisma.tenant.update({ where: { id: tenantId }, data: { notifyClientOnStaffChanges: true } });
});

test.afterAll(async () => {
  await prisma.handoffRequest.deleteMany({ where: { whatsappInstanceId: instanceId } });
  await prisma.chatSession.deleteMany({ where: { whatsappInstanceId: instanceId } });
  await prisma.appointment.deleteMany({ where: { contact: { name: { contains: E2E_RUN_PREFIX } } } });
  await prisma.contact.deleteMany({ where: { name: { contains: E2E_RUN_PREFIX } } });
  await prisma.whatsappInstance.deleteMany({ where: { id: instanceId } });
  await prisma.tenant.update({ where: { id: tenantId }, data: { notifyClientOnStaffChanges: originalNotify } });
  if (platformBackup) await prisma.platformSettings.update({ where: { id: 1 }, data: platformBackup });
  await prisma.user.update({ where: { email: SEED_OWNER_EMAIL }, data: { onboardingTourCompletedAt: new Date() } });
  await fake.close();
});

test.afterEach(async () => {
  evolutionMode = "ok";
  await setInstanceStatus("CONNECTED");
});

// ---------------------------------------------------------------------------------------------
// Fila e badge
// ---------------------------------------------------------------------------------------------
test.describe("fila", () => {
  test("Aguardando (N) e o badge do menu batem; quem espera há mais tempo fica no topo e em destaque; atualiza sem F5", async ({ page }) => {
    const old = await newWaiting("Fila Antigo", { minutesAgo: 40 });
    const recent = await newWaiting("Fila Recente", { minutesAgo: 5, offHours: true });
    const expected = await waitingInDb();
    expect(expected).toBeLessThanOrEqual(9); // badge mostra "9+" acima disso

    await page.goto(`/${SEED_TENANT_SLUG}/atendimento`);
    await expect(page.getByRole("tab", { name: `Aguardando (${expected})` })).toBeVisible();
    await expect(page.getByTestId("nav-badge-attendance")).toHaveText(String(expected));

    const rows = page.getByTestId("attendance-queue").locator("[data-contact-id]");
    await expect(rowOf(page, old.id)).toBeVisible();
    // Mais antigo primeiro e com destaque; o recente não.
    const ids = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-contact-id")));
    expect(ids.indexOf(old.id)).toBeLessThan(ids.indexOf(recent.id));
    expect(await rowOf(page, old.id).getAttribute("data-highlighted")).toBe("true");
    expect(await rowOf(page, recent.id).getAttribute("data-highlighted")).toBeNull();
    await expect(rowOf(page, recent.id)).toContainText("Fora do horário");
    await expect(rowOf(page, old.id)).toContainText("Oi, preciso de ajuda (Fila Antigo)");

    // Aba vazia mostra o estado vazio, não uma lista quebrada.
    await page.getByRole("tab", { name: "Em atendimento" }).click();
    await expect(rowOf(page, old.id)).toHaveCount(0);

    // Atualiza sozinho (poll de 15 s): pedido novo entra na fila e o contador sobe, sem recarregar.
    await page.getByRole("tab", { name: /^Aguardando/ }).click();
    await page.evaluate(() => ((window as unknown as { __semReload: string }).__semReload = "mesma-pagina"));
    const late = await newWaiting("Fila Ao Vivo", { minutesAgo: 1 });
    await expect(rowOf(page, late.id)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("tab", { name: `Aguardando (${expected + 1})` })).toBeVisible();
    await expect(page.getByTestId("nav-badge-attendance")).toHaveText(String(expected + 1));
    expect(await page.evaluate(() => (window as unknown as { __semReload?: string }).__semReload)).toBe("mesma-pagina");
  });
});

// ---------------------------------------------------------------------------------------------
// Conversa
// ---------------------------------------------------------------------------------------------
test.describe("conversa", () => {
  test("mensagem nova do cliente aparece sozinha quando a pessoa está no fim da conversa", async ({ page }) => {
    const c = await newWaiting("Conversa Ao Vivo");
    await openConversation(page, c.id);
    const log = page.getByRole("log", { name: /Conversa com/ });
    await expect(log).toContainText("Oi, preciso de ajuda (Conversa Ao Vivo)");
    await addMessages(c.id, [{ direction: "INBOUND", body: "mensagem chegando ao vivo", at: new Date() }]);
    await expect(log).toContainText("mensagem chegando ao vivo", { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Nova mensagem" })).toHaveCount(0);
  });

  test("lendo o meio da conversa: não rola sozinho e mostra 'Nova mensagem'; clicar leva ao fim", async ({ page }) => {
    const c = await newWaiting("Conversa Longa");
    const base = Date.now() - 3 * 3_600_000;
    await addMessages(
      c.id,
      Array.from({ length: 70 }, (_, i) => ({ direction: i % 2 ? ("OUTBOUND" as const) : ("INBOUND" as const), body: `histórico ${i + 1} ${"texto ".repeat(4)}`, at: new Date(base + i * 60_000) })),
    );
    await openConversation(page, c.id);
    const log = page.getByRole("log", { name: /Conversa com/ });
    await expect(log).toContainText("histórico 70");
    // Sobe para o começo do que foi carregado.
    await log.evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect.poll(() => log.evaluate((el) => el.scrollTop)).toBeLessThan(50);

    await addMessages(c.id, [{ direction: "INBOUND", body: "nova enquanto eu lia", at: new Date() }]);
    const jump = page.getByRole("button", { name: "Nova mensagem" });
    await expect(jump).toBeVisible({ timeout: 30_000 });
    expect(await log.evaluate((el) => el.scrollTop)).toBeLessThan(80); // não puxou a leitura para baixo

    await jump.click();
    await expect(jump).toBeHidden();
    await expect(log.getByText("nova enquanto eu lia")).toBeInViewport();
  });
});

// ---------------------------------------------------------------------------------------------
// Compositor e envio
// ---------------------------------------------------------------------------------------------
test.describe("compositor", () => {
  test("Enter envia (Shift+Enter quebra linha); bolha otimista 'Enviando…' vira a mensagem do servidor, com o autor; fila e badge atualizam", async ({ page }) => {
    const c = await newWaiting("Envio Feliz");
    const before = await waitingInDb();
    await openConversation(page, c.id);

    // Atrasa a Server Action para ver a bolha otimista e a troca pela mensagem real.
    await page.route("**/atendimento**", async (route) => {
      const req = route.request();
      if (req.method() === "POST" && req.headers()["next-action"]) await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });

    await composer(page).click();
    await page.keyboard.type("primeira linha");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("segunda linha");
    expect(await prisma.chatMessage.count({ where: { contactId: c.id, direction: "OUTBOUND" } })).toBe(0); // Shift+Enter não enviou
    await page.keyboard.press("Enter");

    const log = page.getByRole("log", { name: /Conversa com/ });
    const optimistic = log.getByRole("article", { name: /enviando/ });
    await expect(optimistic).toBeVisible();
    await expect(optimistic).toContainText("Enviando…");
    await expect(composer(page)).toHaveValue(""); // campo limpo na hora

    // Depois da resposta: some a bolha local; fica UMA bolha do atendente, com o nome de quem enviou.
    await expect(log.getByRole("article", { name: /enviando/ })).toHaveCount(0);
    const bubble = log.getByRole("article", { name: new RegExp(`^Atendente`) }).filter({ hasText: "primeira linha" });
    await expect(bubble).toHaveCount(1);
    await expect(bubble).toContainText("segunda linha");
    await expect(bubble).not.toContainText("Não enviada");
    await expect(bubble).toContainText(ownerName);
    await page.unroute("**/atendimento**");

    // Banco e Evolution fake: exatamente o que foi digitado, uma vez só.
    const rows = await prisma.chatMessage.findMany({ where: { contactId: c.id, direction: "OUTBOUND" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("primeira linha\nsegunda linha");
    expect(rows[0].authorUserId).not.toBeNull();
    const calls = sentTo(c.phoneE164!);
    expect(calls).toHaveLength(1);
    expect((calls[0].body as { text: string }).text).toBe("primeira linha\nsegunda linha");

    // Responder tira o cliente de "Aguardando": o contador do menu e da aba caem sem F5.
    await expect(page.getByRole("tab", { name: `Aguardando (${before - 1})` })).toBeVisible();
    if (before - 1 > 0) await expect(page.getByTestId("nav-badge-attendance")).toHaveText(String(before - 1));
    else await expect(page.getByTestId("nav-badge-attendance")).toHaveCount(0);
    await page.getByRole("tab", { name: "Em atendimento" }).click();
    await expect(rowOf(page, c.id)).toBeVisible();
  });

  test("Enter com campo vazio ou só espaços não envia nada", async ({ page }) => {
    const c = await newWaiting("Envio Vazio");
    await openConversation(page, c.id);
    await composer(page).click();
    await page.keyboard.press("Enter");
    await page.keyboard.type("   ");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("attendance-send")).toBeDisabled();
    expect(await prisma.chatMessage.count({ where: { contactId: c.id, direction: "OUTBOUND" } })).toBe(0);
    expect(sentTo(c.phoneE164!)).toHaveLength(0);
  });

  test("contador só aparece a partir de 3.600; acima de 4.000 bloqueia o envio", async ({ page }) => {
    const c = await newWaiting("Envio Limite");
    await openConversation(page, c.id);
    const counter = page.getByLabel(/de 4000 caracteres/);
    await composer(page).fill("a".repeat(3599));
    await expect(counter).toHaveCount(0);
    await composer(page).fill("a".repeat(3600));
    await expect(counter).toContainText("3.600 / 4.000");
    await composer(page).fill("a".repeat(4000));
    await expect(page.getByTestId("attendance-send")).toBeEnabled();
    await composer(page).fill("a".repeat(4001));
    await expect(counter).toContainText("4.001 / 4.000");
    await expect(page.getByTestId("attendance-send")).toBeDisabled();
    await composer(page).press("Enter");
    expect(sentTo(c.phoneE164!)).toHaveLength(0);
  });

  test("a Evolution recusa (500): nada é enviado, o texto volta para o campo e o erro é claro", async ({ page }) => {
    const c = await newWaiting("Envio Recusado");
    await openConversation(page, c.id);
    evolutionMode = "fail";
    await composer(page).fill("mensagem que vai falhar");
    await composer(page).press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "O WhatsApp recusou o envio" })).toBeVisible();
    await expect(composer(page)).toHaveValue("mensagem que vai falhar");
    await expect(page.getByRole("log").getByRole("article", { name: SENT_BUBBLE })).toHaveCount(0);
    expect(await prisma.chatMessage.count({ where: { contactId: c.id, direction: "OUTBOUND" } })).toBe(0);
    // Volta ao normal: reenviar do campo funciona e grava uma só.
    evolutionMode = "ok";
    await composer(page).press("Enter");
    await expect(page.getByRole("log").getByRole("article", { name: SENT_BUBBLE }).filter({ hasText: "mensagem que vai falhar" })).toHaveCount(1);
    expect(await prisma.chatMessage.count({ where: { contactId: c.id, direction: "OUTBOUND", body: "mensagem que vai falhar" } })).toBe(1);
  });

  test("sem WhatsApp conectado: mensagem clara e bolha 'Não enviada' com Tentar de novo e Descartar", async ({ page }) => {
    const c = await newWaiting("Envio Sem Whats");
    await openConversation(page, c.id);
    await setInstanceStatus("DISCONNECTED");

    await composer(page).fill("olá sem conexão");
    await composer(page).press("Enter");
    const alert = page.getByRole("alert").filter({ hasText: "WhatsApp da empresa está desconectado" });
    await expect(alert).toBeVisible();
    const failed = page.getByRole("log").getByRole("article", { name: /não enviada/ });
    await expect(failed).toContainText("Não enviada");
    await expect(failed.getByRole("button", { name: "Tentar de novo" })).toBeVisible();
    await expect(failed.getByRole("button", { name: "Descartar" })).toBeVisible();
    expect(await prisma.chatMessage.count({ where: { contactId: c.id, direction: "OUTBOUND" } })).toBe(0);

    // Tentar de novo ainda desconectado: continua falhando, sem duplicar bolha.
    await failed.getByRole("button", { name: "Tentar de novo" }).click();
    await expect(page.getByRole("log").getByRole("article", { name: /não enviada/ })).toHaveCount(1);

    // Reconecta e tenta de novo: envia UMA vez e a bolha de erro some.
    await setInstanceStatus("CONNECTED");
    await failed.getByRole("button", { name: "Tentar de novo" }).click();
    await expect(page.getByRole("log").getByRole("article", { name: /não enviada/ })).toHaveCount(0);
    await expect(page.getByRole("log").getByRole("article", { name: SENT_BUBBLE }).filter({ hasText: "olá sem conexão" })).toHaveCount(1);
    expect(await prisma.chatMessage.count({ where: { contactId: c.id, direction: "OUTBOUND", body: "olá sem conexão" } })).toBe(1);
    expect(sentTo(c.phoneE164!)).toHaveLength(1);

    // Descartar remove a bolha e não envia nada.
    await setInstanceStatus("DISCONNECTED");
    await composer(page).fill("vou descartar");
    await composer(page).press("Enter");
    const failed2 = page.getByRole("log").getByRole("article", { name: /não enviada/ });
    await expect(failed2).toBeVisible();
    await failed2.getByRole("button", { name: "Descartar" }).click();
    await expect(page.getByRole("log").getByText("vou descartar")).toHaveCount(0);
    expect(await prisma.chatMessage.count({ where: { contactId: c.id, body: "vou descartar" } })).toBe(0);
  });

  test("cliente sem telefone: avisa e devolve o texto ao campo, sem bolha", async ({ page }) => {
    const c = await newWaiting("Envio Sem Fone", { phone: null });
    await openConversation(page, c.id);
    await composer(page).fill("oi sem telefone");
    await composer(page).press("Enter");
    await expect(page.getByRole("alert").filter({ hasText: "não tem telefone cadastrado" })).toBeVisible();
    await expect(page.getByRole("log").getByRole("article", { name: SENT_BUBBLE })).toHaveCount(0);
    await expect(composer(page)).toBeDisabled(); // bloqueado com a razão visível
  });
});

// ---------------------------------------------------------------------------------------------
// Encerrar
// ---------------------------------------------------------------------------------------------
test.describe("encerrar", () => {
  test("diálogo, toast, cliente avisado (HANDOFF_CLOSED) e a fila atualiza; cancelar o diálogo não muda nada", async ({ page }) => {
    const c = await newWaiting("Encerrar Feliz");
    const before = await waitingInDb();
    await openConversation(page, c.id);

    await page.getByRole("button", { name: "Encerrar e devolver ao bot" }).click();
    const dialog = page.getByRole("dialog", { name: "Encerrar e devolver ao bot" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Cancelar" }).click();
    await expect(dialog).toBeHidden();
    expect((await prisma.handoffRequest.findFirstOrThrow({ where: { contactId: c.id } })).endedAt).toBeNull();

    await page.getByRole("button", { name: "Encerrar e devolver ao bot" }).click();
    await dialog.getByRole("button", { name: "Encerrar e devolver" }).click();
    await expect(page.getByText("Atendimento encerrado", { exact: true })).toBeVisible();
    await expect(page.getByText("O bot voltou a responder e o cliente foi avisado.", { exact: true })).toBeVisible();

    const handoff = await prisma.handoffRequest.findFirstOrThrow({ where: { contactId: c.id } });
    expect(handoff.endedAt).not.toBeNull();
    expect(sentTo(c.phoneE164!)).toHaveLength(1); // o aviso HANDOFF_CLOSED
    const contact = await prisma.contact.findUniqueOrThrow({ where: { id: c.id } });
    expect(contact.botPausedUntil).toBeNull();
    const session = await prisma.chatSession.findFirstOrThrow({ where: { contactId: c.id } });
    expect(session.humanUntil).toBeNull();

    await expect(page.getByRole("tab", { name: `Aguardando (${before - 1})` })).toBeVisible();
    await page.getByRole("tab", { name: /^Encerrados/ }).click();
    await expect(rowOf(page, c.id)).toBeVisible();
  });

  test("sem WhatsApp conectado o atendimento encerra igual, e o toast não diz que o cliente foi avisado", async ({ page }) => {
    const c = await newWaiting("Encerrar Sem Whats");
    await openConversation(page, c.id);
    await setInstanceStatus("DISCONNECTED");
    await page.getByRole("button", { name: "Encerrar e devolver ao bot" }).click();
    await page.getByRole("dialog", { name: "Encerrar e devolver ao bot" }).getByRole("button", { name: "Encerrar e devolver" }).click();
    await expect(page.getByText("O bot voltou a responder este cliente.", { exact: true })).toBeVisible();
    await expect(page.getByText("O bot voltou a responder e o cliente foi avisado.", { exact: true })).toHaveCount(0);
    expect((await prisma.handoffRequest.findFirstOrThrow({ where: { contactId: c.id } })).endedAt).not.toBeNull();
    expect(sentTo(c.phoneE164!)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Sino
// ---------------------------------------------------------------------------------------------
test.describe("sino", () => {
  test("'Cliente pediu atendente' abre /atendimento?contato=<id> com a conversa daquele cliente", async ({ page }) => {
    const c = await newWaiting("Sino Abre");
    await page.goto(`/${SEED_TENANT_SLUG}/inicio`);
    await page.getByRole("button", { name: /^Notificações/ }).click();
    const panel = page.getByRole("dialog", { name: "Notificações" });
    const item = panel.getByRole("link").filter({ hasText: N("Sino Abre") });
    await expect(item).toHaveAttribute("href", `/${SEED_TENANT_SLUG}/atendimento?contato=${c.id}`);
    await item.click();
    await expect(page).toHaveURL(new RegExp(`/${SEED_TENANT_SLUG}/atendimento\\?contato=${c.id}$`));
    await expect(page.getByRole("heading", { name: N("Sino Abre") })).toBeVisible();
    await expect(page.getByRole("log", { name: /Conversa com/ })).toContainText("Oi, preciso de ajuda (Sino Abre)");
  });
});

// ---------------------------------------------------------------------------------------------
// Aviso ao cliente na Agenda
// ---------------------------------------------------------------------------------------------
function futureTuesday(minDaysAhead = 3): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + minDaysAhead);
  while (d.getDay() !== 2) d.setDate(d.getDate() + 1);
  return d;
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

async function gotoAgendaDay(page: Page, day: Date) {
  await page.goto(`/${SEED_TENANT_SLUG}/agenda`);
  await page.getByRole("button", { name: "Hoje" }).click();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((day.getTime() - today.getTime()) / 86_400_000);
  for (let i = 0; i < diff; i++) await page.getByRole("button", { name: "Próximo período" }).click();
}

async function apptFor(contactId: string, day: Date, hour: number) {
  const service = await prisma.service.findFirstOrThrow({ where: { tenantId, name: "Corte feminino" } });
  const ana = await prisma.professional.findFirstOrThrow({ where: { tenantId, name: "Ana" } });
  const startsAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0);
  const endsAt = new Date(startsAt.getTime() + service.durationMin * 60_000);
  return prisma.appointment.create({
    data: { tenantId, contactId, serviceId: service.id, professionalId: ana.id, startsAt, endsAt, blockEndsAt: endsAt, source: "PANEL" },
  });
}

async function cancelViaDialog(page: Page, name: string) {
  await page.getByRole("button").filter({ hasText: name }).click();
  await page.getByRole("button", { name: "Cancelar agendamento" }).click();
  await page.getByRole("button", { name: "Confirmar cancelamento" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
}

test.describe("aviso ao cliente (agenda)", () => {
  const day = futureTuesday();

  test("criar pelo painel: 'Cliente avisado no WhatsApp' e a Evolution recebe o texto STAFF_BOOKED", async ({ page }) => {
    const phone = nextPhone();
    const name = N("Aviso Criar");
    await gotoAgendaDay(page, day);
    await page.getByRole("button", { name: /Novo agendamento com Ana às 09:30/ }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Nome do cliente").fill(name);
    await dialog.getByLabel("Telefone (opcional)").fill(phone);
    await page.getByRole("button", { name: "Agendar", exact: true }).click();
    await expect(page.getByText("Cliente avisado no WhatsApp", { exact: true })).toBeVisible();
    const calls = sentTo(phone);
    expect(calls).toHaveLength(1);
    expect((calls[0].body as { text: string }).text).toMatch(/agendado pela equipe.*Corte feminino.*Ana.*09:30/s);
    expect((calls[0].body as { text: string }).text).not.toMatch(/\{[a-z_]+\}/); // nenhuma variável sem preencher
  });

  test("remarcar pelo diálogo avisa; remarcar para o MESMO horário não diz 'Cliente avisado' nem envia nada", async ({ page }) => {
    const c = await newContact("Aviso Remarcar");
    const appt = await apptFor(c.id, day, 11);
    await gotoAgendaDay(page, day);
    const open = async () => {
      await page.getByRole("button").filter({ hasText: c.name! }).click();
      await page.getByRole("button", { name: "Remarcar", exact: true }).click();
    };

    // Mesmo horário: nada mudou.
    await open();
    await page.getByLabel("Novo horário").fill(`${iso(day)}T11:00`);
    await page.getByRole("button", { name: "Confirmar remarcação" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(page.getByText("Cliente avisado no WhatsApp", { exact: true })).toHaveCount(0);
    expect(sentTo(c.phoneE164!)).toHaveLength(0);

    // Horário novo: avisa.
    await open();
    await page.getByLabel("Novo horário").fill(`${iso(day)}T15:00`);
    await page.getByRole("button", { name: "Confirmar remarcação" }).click();
    await expect(page.getByText("Cliente avisado no WhatsApp", { exact: true })).toBeVisible();
    expect(sentTo(c.phoneE164!)).toHaveLength(1);
    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.startsAt.getHours()).toBe(15);
  });

  test("cancelar pelo diálogo avisa", async ({ page }) => {
    const c = await newContact("Aviso Cancelar");
    await apptFor(c.id, day, 12);
    await gotoAgendaDay(page, day);
    await cancelViaDialog(page, c.name!);
    await expect(page.getByText("Cliente avisado no WhatsApp", { exact: true })).toBeVisible();
    expect(sentTo(c.phoneE164!)).toHaveLength(1);
  });

  test("remarcar arrastando avisa", async ({ page }) => {
    const c = await newContact("Aviso Arraste");
    const dragDay = futureTuesday(11); // dia livre: mesma combinação 10:00 -> 11:30 já provada em drag-reschedule.spec.ts
    const appt = await apptFor(c.id, dragDay, 10);
    await gotoAgendaDay(page, dragDay);
    const card = page.getByRole("button").filter({ hasText: c.name! });
    const target = page.getByRole("button", { name: /Novo agendamento com Ana às 11:30/ });
    await expect(card).toBeVisible();
    await expect(target).toBeAttached();
    await page.waitForTimeout(500); // a grade termina de hidratar antes de medir
    await target.scrollIntoViewIfNeeded();
    const from = await card.boundingBox();
    const to = await target.boundingBox();
    if (!from || !to) throw new Error("sem bounding box");
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2 + 12, { steps: 5 });
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect(page.getByText("Cliente avisado no WhatsApp", { exact: true })).toBeVisible();
    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.startsAt.getTime()).not.toBe(appt.startsAt.getTime());
    expect(sentTo(c.phoneE164!)).toHaveLength(1);
  });

  test("agendar para o cliente da fila (Atendimento) avisa e não pede nome/telefone de novo", async ({ page }) => {
    const c = await newWaiting("Aviso Da Fila");
    await openConversation(page, c.id);
    await page.getByRole("button", { name: "Agendar para este cliente" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(c.name!)).toBeVisible();
    await expect(dialog.getByLabel("Nome do cliente")).toHaveCount(0);
    await dialog.getByLabel("Data").fill(iso(futureTuesday(10)));
    const firstSlot = dialog.locator("button[aria-pressed]").first();
    await expect(firstSlot).toBeVisible();
    await firstSlot.click();
    await page.getByRole("button", { name: "Agendar", exact: true }).click();
    await expect(page.getByText("Cliente avisado no WhatsApp", { exact: true })).toBeVisible();
    expect(sentTo(c.phoneE164!)).toHaveLength(1);
    expect(await prisma.appointment.count({ where: { contactId: c.id } })).toBe(1);
  });

  test("WhatsApp desconectado: toast 'Cliente sem WhatsApp conectado' e o cancelamento vale mesmo assim", async ({ page }) => {
    const c = await newContact("Aviso Sem Whats");
    const appt = await apptFor(c.id, day, 12);
    await setInstanceStatus("DISCONNECTED");
    await gotoAgendaDay(page, day);
    await cancelViaDialog(page, c.name!);
    await expect(page.getByText("Cliente sem WhatsApp conectado", { exact: true })).toBeVisible();
    await expect(page.getByText("Cliente avisado no WhatsApp", { exact: true })).toHaveCount(0);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).status).toBe("CANCELED");
  });

  test("cliente sem telefone: toast 'Cliente sem telefone cadastrado'", async ({ page }) => {
    const c = await newContact("Aviso Sem Fone", { phone: null });
    await apptFor(c.id, day, 12);
    await gotoAgendaDay(page, day);
    await cancelViaDialog(page, c.name!);
    await expect(page.getByText("Cliente sem telefone cadastrado", { exact: true })).toBeVisible();
    await expect(page.getByText("Cliente avisado no WhatsApp", { exact: true })).toHaveCount(0);
  });

  test("a Evolution falha: toast de erro 'Não foi possível avisar o cliente' e o cancelamento vale", async ({ page }) => {
    const c = await newContact("Aviso Falha");
    const appt = await apptFor(c.id, day, 12);
    evolutionMode = "fail";
    await gotoAgendaDay(page, day);
    await cancelViaDialog(page, c.name!);
    await expect(page.getByText("Não foi possível avisar o cliente", { exact: true })).toBeVisible();
    await expect(page.getByText("Cliente avisado no WhatsApp", { exact: true })).toHaveCount(0);
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).status).toBe("CANCELED");
  });

  test("switch desligado: toast 'Aviso ao cliente desligado' e nada é enviado", async ({ page }) => {
    const c = await newContact("Aviso Desligado");
    await apptFor(c.id, day, 12);
    await prisma.tenant.update({ where: { id: tenantId }, data: { notifyClientOnStaffChanges: false } });
    try {
      await gotoAgendaDay(page, day);
      await cancelViaDialog(page, c.name!);
      await expect(page.getByText("Aviso ao cliente desligado", { exact: true })).toBeVisible();
      await expect(page.getByText("Cliente avisado no WhatsApp", { exact: true })).toHaveCount(0);
      expect(sentTo(c.phoneE164!)).toHaveLength(0);
    } finally {
      await prisma.tenant.update({ where: { id: tenantId }, data: { notifyClientOnStaffChanges: true } });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Switch em Configurações
// ---------------------------------------------------------------------------------------------
test.describe("switch 'Avisar o cliente' em Configurações", () => {
  test("OWNER liga/desliga e persiste depois de recarregar", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/configuracoes`);
    const card = page.getByTestId("atendimento-card");
    const sw = card.getByRole("switch", { name: /Avisar o cliente no WhatsApp/ });
    await expect(sw).toBeChecked();
    await sw.click();
    await card.getByRole("button", { name: /Salvar/ }).click();
    await expect(page.getByText("Regras do atendimento salvas.", { exact: true })).toBeVisible();
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).notifyClientOnStaffChanges).toBe(false);
    await page.reload();
    await expect(page.getByTestId("atendimento-card").getByRole("switch", { name: /Avisar o cliente no WhatsApp/ })).not.toBeChecked();
    // Volta ao estado original.
    await page.getByTestId("atendimento-card").getByRole("switch", { name: /Avisar o cliente no WhatsApp/ }).click();
    await page.getByTestId("atendimento-card").getByRole("button", { name: /Salvar/ }).click();
    await expect(page.getByText("Regras do atendimento salvas.", { exact: true }).first()).toBeVisible();
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).notifyClientOnStaffChanges).toBe(true);
  });
});

test.describe("switch para STAFF", () => {
  test.use({ storageState: STAFF_STORAGE_STATE });
  test("STAFF vê o switch desabilitado, sem botão Salvar", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/configuracoes`);
    const card = page.getByTestId("atendimento-card");
    await expect(card.getByRole("switch", { name: /Avisar o cliente no WhatsApp/ })).toBeDisabled();
    await expect(card.getByRole("button", { name: /Salvar/ })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Tour
// ---------------------------------------------------------------------------------------------
test.describe("tour", () => {
  test("tem 16 passos no desktop e o passo 'Atendimento' aponta para o item do menu", async ({ page }) => {
    await prisma.user.update({ where: { email: SEED_OWNER_EMAIL }, data: { onboardingTourCompletedAt: null } });
    try {
      await page.goto(`/${SEED_TENANT_SLUG}/inicio`);
      const overlay = page.locator("[data-tour-overlay]");
      await expect(overlay).toBeVisible({ timeout: 10_000 });
      const balloon = page.locator("[data-tour-balloon]");
      await expect(balloon).toContainText(/^1 de 16(?!\d)/);
      let sawAtendimento = false;
      for (let i = 1; i <= 16; i++) {
        await expect(balloon).toContainText(new RegExp(`^${i} de 16(?!\\d)`));
        if (await balloon.getByText("Atendimento", { exact: true }).count()) {
          sawAtendimento = true;
          await expect(page.locator('[data-tour="nav-atendimento"]')).toBeVisible();
        }
        const next = balloon.locator("[data-tour-primary]");
        if (i < 16) await next.click();
      }
      expect(sawAtendimento).toBe(true);
      await balloon.locator("[data-tour-primary]").click(); // "Concluir"
      await expect(overlay).toBeHidden();
    } finally {
      await prisma.user.update({ where: { email: SEED_OWNER_EMAIL }, data: { onboardingTourCompletedAt: new Date() } });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Mobile 390
// ---------------------------------------------------------------------------------------------
test.describe("mobile 390", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("fila em tela cheia; abrir mostra a conversa com Voltar; sem rolagem horizontal", async ({ page }) => {
    const c = await newWaiting("Mobile Fila");
    await page.goto(`/${SEED_TENANT_SLUG}/atendimento`);
    await expect(rowOf(page, c.id)).toBeVisible();
    await expect(page.getByTestId("attendance-no-selection")).toBeHidden();
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(await noOverflow()).toBe(true);

    await rowOf(page, c.id).click();
    await expect(page.getByTestId("attendance-conversation")).toBeVisible();
    await expect(page.getByRole("button", { name: "Voltar para a fila" })).toBeVisible();
    await expect(page.getByTestId("attendance-queue")).toBeHidden();
    await expect(composer(page)).toBeVisible();
    expect(await noOverflow()).toBe(true);
    // O compositor cabe na tela (não some abaixo da dobra).
    const box = await composer(page).boundingBox();
    expect(box && box.y + box.height <= 844).toBe(true);

    await page.getByRole("button", { name: "Voltar para a fila" }).click();
    await expect(page.getByTestId("attendance-queue")).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/${SEED_TENANT_SLUG}/atendimento$`));
  });
});

