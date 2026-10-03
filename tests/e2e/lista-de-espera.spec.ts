import { test, expect, type Page } from "@playwright/test";
import { SEED_TENANT_SLUG, E2E_RUN_PREFIX } from "./fixtures/test-data";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";
import { prisma } from "./fixtures/db";

/**
 * Lista de espera no painel: adicionar (cliente novo e repetido), filtrar por dia/profissional/situação, remover
 * com confirmação e "Oferecer encaixe" — com a Evolution ausente/falsa o servidor pode recusar ou enviar, mas a
 * tela nunca quebra e o estado do banco continua coerente com o aviso mostrado. 1440 e 390 sem rolagem lateral.
 */
test.use({ storageState: OWNER_STORAGE_STATE, viewport: { width: 1440, height: 900 } });
test.describe.configure({ mode: "serial" });

const SERVICE = `${E2E_RUN_PREFIX} Servico Espera`;
const NAME_A = `${E2E_RUN_PREFIX} Espera Alice`;
const NAME_B = `${E2E_RUN_PREFIX} Espera Bruno`;
const SUFFIX = E2E_RUN_PREFIX.replace(/\D/g, "").slice(-6);

const ctx = { tenantId: "", anaId: "", serviceId: "" };

function isoDay(offsetFromTuesday: 0 | 1): string {
  // Próxima terça-feira (expediente da Ana no seed) + deslocamento, no formato do input type=date.
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  do d.setDate(d.getDate() + 1);
  while (d.getDay() !== 2);
  d.setDate(d.getDate() + offsetFromTuesday);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const DAY_A = isoDay(0);
const DAY_B = isoDay(1);

function main(page: Page) {
  return page.getByRole("main");
}

async function addEntry(page: Page, opts: { name: string; phone: string; date: string; professionalId?: string; period?: string }) {
  await page.getByRole("button", { name: "Adicionar à lista" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Adicionar à lista de espera" })).toBeVisible();
  await dialog.getByRole("button", { name: "Novo cliente" }).click();
  await dialog.getByLabel("Nome do cliente").fill(opts.name);
  await dialog.getByLabel("Telefone com DDD").fill(opts.phone);
  await dialog.locator("#wl-servico").selectOption(ctx.serviceId);
  await dialog.locator("#wl-prof").selectOption(opts.professionalId ?? "");
  await dialog.getByLabel("Dia que o cliente quer").fill(opts.date);
  if (opts.period) await dialog.locator("#wl-periodo").selectOption(opts.period);
  await dialog.getByRole("button", { name: "Adicionar à lista", exact: true }).click();
}

test.beforeAll(async () => {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: SEED_TENANT_SLUG }, select: { id: true } });
  ctx.tenantId = tenant.id;
  const ana = await prisma.professional.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Ana" }, select: { id: true } });
  ctx.anaId = ana.id;
  const service = await prisma.service.create({ data: { tenantId: tenant.id, name: SERVICE, durationMin: 30, priceCents: 5000 } });
  ctx.serviceId = service.id;
  await prisma.professionalService.create({ data: { professionalId: ana.id, serviceId: service.id } });
});

test.afterAll(async () => {
  await prisma.waitlistEntry.deleteMany({ where: { serviceId: ctx.serviceId } });
  await prisma.appointment.deleteMany({ where: { serviceId: ctx.serviceId } });
  await prisma.contact.deleteMany({ where: { name: { contains: E2E_RUN_PREFIX } } });
  await prisma.professionalService.deleteMany({ where: { serviceId: ctx.serviceId } });
  await prisma.service.deleteMany({ where: { id: ctx.serviceId } });
});

test.describe("Lista de espera", () => {
  test("adiciona dois clientes novos, repetir o mesmo avisa que já estava, e o contato nasce com o telefone", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/lista-de-espera`);
    await expect(main(page).getByRole("heading", { name: "Lista de espera", level: 1 })).toBeVisible();

    await addEntry(page, { name: NAME_A, phone: `(11) 97${SUFFIX.slice(0, 3)}-${SUFFIX.slice(3)}1`, date: DAY_A, professionalId: ctx.anaId });
    await expect(page.getByText("Pessoa adicionada à lista").first()).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: NAME_A })).toBeVisible();

    await addEntry(page, { name: NAME_B, phone: `(11) 96${SUFFIX.slice(0, 3)}-${SUFFIX.slice(3)}2`, date: DAY_B, period: "MORNING" });
    await expect(page.getByRole("row").filter({ hasText: NAME_B })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: NAME_B })).toContainText("Na fila");
    await expect(page.getByRole("row").filter({ hasText: NAME_B })).toContainText("QualquerManhã");

    const entries = await prisma.waitlistEntry.findMany({ where: { serviceId: ctx.serviceId }, select: { status: true, source: true, period: true, professionalId: true, contact: { select: { name: true, phoneE164: true } } } });
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.status === "WAITING" && e.source === "PANEL")).toBe(true);
    expect(entries.find((e) => e.contact?.name === NAME_B)?.period).toBe("MORNING");
    expect(entries.find((e) => e.contact?.name === NAME_A)?.contact?.phoneE164).toMatch(/^\+55/);

    // Repetir a mesma pessoa no mesmo pedido não duplica.
    const contact = await prisma.contact.findFirstOrThrow({ where: { name: NAME_A } });
    await addEntry(page, { name: NAME_A, phone: contact.phoneE164 ?? "", date: DAY_A, professionalId: ctx.anaId });
    await expect(page.getByText("Essa pessoa já estava nessa lista").first()).toBeVisible();
    expect(await prisma.waitlistEntry.count({ where: { serviceId: ctx.serviceId } })).toBe(2);
  });

  test("formulário recusa nome sem telefone e faixa de horário invertida, sem gravar nada", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/lista-de-espera`);
    await page.getByRole("button", { name: "Adicionar à lista" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Novo cliente" }).click();
    await dialog.getByLabel("Nome do cliente").fill(`${E2E_RUN_PREFIX} Sem Telefone`);
    await dialog.getByRole("button", { name: "Adicionar à lista", exact: true }).click();
    await expect(dialog.getByText(/Informe o nome e o telefone/)).toBeVisible();

    await dialog.getByLabel("Telefone com DDD").fill("(11) 95555-0000");
    await dialog.locator("#wl-periodo").selectOption("RANGE");
    await dialog.getByLabel("A partir de").fill("17:00");
    await dialog.getByLabel("Até", { exact: true }).fill("14:00");
    await dialog.getByRole("button", { name: "Adicionar à lista", exact: true }).click();
    await expect(dialog.getByText(/faixa de horário precisa começar antes de terminar/)).toBeVisible();
    expect(await prisma.contact.count({ where: { name: { contains: "Sem Telefone" } } })).toBe(0);
  });

  test("filtra por dia, por profissional e por situação", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/lista-de-espera`);
    const rowA = page.getByRole("row").filter({ hasText: NAME_A });
    const rowB = page.getByRole("row").filter({ hasText: NAME_B });
    await expect(rowA).toBeVisible();
    await expect(rowB).toBeVisible();

    await page.getByLabel("Dia", { exact: true }).fill(DAY_A);
    await expect(rowA).toBeVisible();
    await expect(rowB).toHaveCount(0);
    await page.getByRole("button", { name: "Todos", exact: true }).click();
    await expect(rowB).toBeVisible();

    // Filtrar por Ana mostra os pedidos dela E os de "qualquer profissional" (ela poderia atender).
    await page.getByLabel("Profissional", { exact: true }).selectOption(ctx.anaId);
    await expect(rowA).toBeVisible();
    await expect(rowB).toBeVisible();
    // Outra profissional: o pedido que nomeia Ana some, o aberto continua.
    const other = await prisma.professional.findFirstOrThrow({ where: { tenantId: ctx.tenantId, active: true, id: { not: ctx.anaId } }, select: { id: true } });
    await page.getByLabel("Profissional", { exact: true }).selectOption(other.id);
    await expect(rowA).toHaveCount(0);
    await expect(rowB).toBeVisible();
    await page.getByLabel("Profissional", { exact: true }).selectOption("");

    await page.getByLabel("Situação").selectOption("OFFERED");
    await expect(rowA).toHaveCount(0);
    await expect(rowB).toHaveCount(0);
    await page.getByLabel("Situação").selectOption("WAITING");
    await expect(rowA).toBeVisible();
  });

  test("remover pede confirmação; manter não muda nada, remover tira da fila e registra a saída", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/lista-de-espera`);
    await page.getByRole("button", { name: `Remover ${NAME_B} da lista` }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Remover da lista de espera?" })).toBeVisible();
    await dialog.getByRole("button", { name: "Manter na lista" }).click();
    await expect(page.getByRole("row").filter({ hasText: NAME_B })).toBeVisible();
    expect(await prisma.waitlistEntry.count({ where: { serviceId: ctx.serviceId, status: "WAITING" } })).toBe(2);

    await page.getByRole("button", { name: `Remover ${NAME_B} da lista` }).click();
    await dialog.getByRole("button", { name: "Remover", exact: true }).click();
    await expect(page.getByText("Pessoa removida da lista").first()).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: NAME_B })).toHaveCount(0);
    const gone = await prisma.waitlistEntry.findFirstOrThrow({ where: { serviceId: ctx.serviceId, contact: { name: NAME_B } } });
    expect(gone.status).toBe("CANCELED");
    expect(await prisma.auditLog.count({ where: { tenantId: ctx.tenantId, action: "waitlist.removed", createdAt: { gt: new Date(Date.now() - 120_000) } } })).toBeGreaterThanOrEqual(1);
  });

  test("Oferecer encaixe sem Evolution configurada responde com aviso claro e deixa o estado coerente", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/lista-de-espera`);
    await page.getByRole("row").filter({ hasText: NAME_A }).getByRole("button", { name: "Oferecer encaixe" }).click();
    // O texto "Oferta enviada" também existe como <option> do filtro (oculta): só conta o aviso visível.
    const ok = page.getByText("Oferta enviada", { exact: true }).locator("visible=true");
    const fail = page.getByText("Não deu para oferecer o encaixe").locator("visible=true");
    await expect(ok.or(fail).first()).toBeVisible({ timeout: 15_000 });
    // A tela continua inteira, sem erro de aplicação.
    await expect(main(page).getByRole("heading", { name: "Lista de espera", level: 1 })).toBeVisible();
    const entry = await prisma.waitlistEntry.findFirstOrThrow({ where: { serviceId: ctx.serviceId, contact: { name: NAME_A } } });
    if ((await fail.count()) > 0) {
      expect(entry.status, "recusou a oferta: o pedido tem de continuar na fila").toBe("WAITING");
      expect(entry.offeredSlotStart).toBeNull();
    } else {
      expect(entry.status).toBe("OFFERED");
      expect(entry.offeredSlotStart).not.toBeNull();
    }
  });

  test("a página cabe em 1440 e 390 sem rolagem lateral", async ({ page }) => {
    for (const [w, h] of [[1440, 900], [390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`/${SEED_TENANT_SLUG}/lista-de-espera`);
      await expect(main(page).getByRole("heading", { name: "Lista de espera", level: 1 })).toBeVisible();
      await expect(page.getByText(NAME_A).locator("visible=true").first()).toBeVisible();
      // (Com nomes longos do marcador E2E a tabela rola dentro do próprio cartão — overflow auto —, por isso só a página inteira é medida.)
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `overflow a ${w}px`).toBeLessThanOrEqual(0);
      await page.getByRole("button", { name: "Adicionar à lista" }).first().click();
      await expect(page.getByRole("dialog")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `overflow do diálogo a ${w}px`).toBeLessThanOrEqual(0);
      await page.keyboard.press("Escape");
    }
  });
});
