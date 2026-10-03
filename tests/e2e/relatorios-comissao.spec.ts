import { test, expect, type Page } from "@playwright/test";
import { SEED_TENANT_SLUG, E2E_RUN_PREFIX } from "./fixtures/test-data";
import { OWNER_STORAGE_STATE, STAFF_STORAGE_STATE } from "./fixtures/storage-state";
import { prisma } from "./fixtures/db";

/**
 * Relatórios (só o dono) + comissão na ficha do profissional. O que se prova:
 *  - o dono vê totais, "Por profissional" e "Por serviço", e o CSV baixa com BOM;
 *  - mudar o preço do serviço DEPOIS de concluir não altera o que já foi concluído (foto do preço);
 *  - a comissão é cadastrada na ficha (padrão + por serviço) e entra no relatório;
 *  - STAFF não vê o item no menu, a página mostra o aviso e o CSV responde 403;
 *  - a tela cabe em 1440 e 390 sem rolagem lateral.
 * Tudo roda com um serviço próprio (marcador E2E) atendido pela Ana do seed; a comissão dela volta ao que era.
 */
const SERVICE = `${E2E_RUN_PREFIX} Servico Relatorio`;
const CLIENT = `${E2E_RUN_PREFIX} Cliente Relatorio`;

function tuesday(direction: 1 | -1): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  do d.setDate(d.getDate() + direction);
  while (d.getDay() !== 2);
  return d;
}

const ctx = { tenantId: "", anaId: "", serviceId: "", anaOriginalPct: null as string | null };

async function setAgendaDate(page: Page, target: Date) {
  await page.getByRole("button", { name: "Hoje" }).click();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  const button = page.getByRole("button", { name: diffDays > 0 ? "Próximo período" : "Período anterior" });
  for (let i = 0; i < Math.abs(diffDays); i++) await button.click();
}

async function createAppointment(label: string, day: Date, hour: number) {
  const suffix = E2E_RUN_PREFIX.replace(/\D/g, "").slice(-8);
  const contact = await prisma.contact.create({
    data: { tenantId: ctx.tenantId, name: `${CLIENT} ${label}`, waJid: `55119${suffix}${hour}@s.whatsapp.net`, phoneE164: `+55119${suffix}${hour}` },
  });
  const startsAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, 0);
  const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
  return prisma.appointment.create({
    data: { tenantId: ctx.tenantId, contactId: contact.id, serviceId: ctx.serviceId, professionalId: ctx.anaId, startsAt, endsAt, blockEndsAt: endsAt, source: "PANEL" },
  });
}

async function finish(page: Page, day: Date, label: string, action: "Concluir atendimento" | "Cliente faltou") {
  await page.goto(`/${SEED_TENANT_SLUG}/agenda`);
  await setAgendaDate(page, day);
  await page.getByRole("button").filter({ hasText: `${CLIENT} ${label}` }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Agendamento" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: action }).click();
  await expect(page.getByText(action === "Concluir atendimento" ? "Atendimento concluído." : "Falta registrada.").first()).toBeVisible();
}

function card(page: Page, title: string) {
  return page.getByRole("heading", { name: title }).locator("xpath=ancestor::*[contains(@class,'rounded-hero')][1]");
}

test.beforeAll(async () => {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: SEED_TENANT_SLUG }, select: { id: true } });
  ctx.tenantId = tenant.id;
  const ana = await prisma.professional.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Ana" }, select: { id: true, commissionPct: true } });
  ctx.anaId = ana.id;
  ctx.anaOriginalPct = ana.commissionPct === null ? null : String(ana.commissionPct);
  const service = await prisma.service.create({ data: { tenantId: tenant.id, name: SERVICE, durationMin: 30, priceCents: 10_000 } });
  ctx.serviceId = service.id;
  await prisma.professionalService.create({ data: { professionalId: ana.id, serviceId: service.id } });
});

test.afterAll(async () => {
  await prisma.appointment.deleteMany({ where: { contact: { name: { contains: CLIENT } } } });
  await prisma.contact.deleteMany({ where: { name: { contains: CLIENT } } });
  await prisma.professionalService.deleteMany({ where: { serviceId: ctx.serviceId } });
  await prisma.service.deleteMany({ where: { id: ctx.serviceId } });
  await prisma.professional.updateMany({ where: { id: ctx.anaId }, data: { commissionPct: ctx.anaOriginalPct } });
});

const brl = (v: string) => new RegExp(v.replace("$", "\\$").replace(/ /g, "\\s"));

test.describe("Relatórios e comissão (dono)", () => {
  test.use({ storageState: OWNER_STORAGE_STATE, viewport: { width: 1440, height: 900 } });
  test.describe.configure({ mode: "serial" });

  test("comissão na ficha: padrão da profissional e percentual próprio do serviço são salvos e voltam ao reabrir", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/profissionais/${ctx.anaId}`);
    await expect(page.getByRole("heading", { name: "Comissão" })).toBeVisible();
    await page.getByLabel("Comissão padrão (%)").fill("10");
    await page.getByLabel(`Comissão em ${SERVICE}, em porcentagem`).fill("50");
    await page.getByRole("button", { name: "Salvar comissão" }).click();
    await expect(page.getByText("Comissão atualizada.").first()).toBeVisible();

    const ana = await prisma.professional.findUniqueOrThrow({ where: { id: ctx.anaId }, select: { commissionPct: true } });
    expect(Number(ana.commissionPct)).toBe(10);
    const link = await prisma.professionalService.findFirstOrThrow({ where: { professionalId: ctx.anaId, serviceId: ctx.serviceId }, select: { commissionPct: true } });
    expect(Number(link.commissionPct)).toBe(50);

    await page.reload();
    await expect(page.getByLabel("Comissão padrão (%)")).toHaveValue(/^10(\.0+)?$/);
    await expect(page.getByLabel(`Comissão em ${SERVICE}, em porcentagem`)).toHaveValue(/^50(\.0+)?$/);

    // Valor fora de 0 a 100 é barrado com mensagem e nada muda.
    await page.getByLabel("Comissão padrão (%)").fill("101");
    await page.getByRole("button", { name: "Salvar comissão" }).click();
    await expect(page.getByRole("alert").filter({ hasText: /Comissão padrão inválida/ })).toBeVisible();
    expect(Number((await prisma.professional.findUniqueOrThrow({ where: { id: ctx.anaId }, select: { commissionPct: true } })).commissionPct)).toBe(10);
  });

  test("conclui dois atendimentos, registra uma falta e o relatório mostra totais, por profissional e por serviço", async ({ page }) => {
    const day = tuesday(-1);
    await createAppointment("A", day, 9);
    await createAppointment("B", day, 10);
    await createAppointment("F", day, 11);
    await finish(page, day, "A", "Concluir atendimento");
    await finish(page, day, "B", "Concluir atendimento");
    await finish(page, day, "F", "Cliente faltou");

    await page.goto(`/${SEED_TENANT_SLUG}/relatorios`);
    await page.getByRole("button", { name: "Últimos 30 dias" }).click();
    await expect(page).toHaveURL(/periodo=last_30_days/);
    const resumo = page.getByTestId("relatorios-resumo");
    await expect(resumo).toBeVisible();
    for (const label of ["Faturamento", "Atendimentos concluídos", "Ticket médio", "Comissão a pagar", "Taxa de faltas"]) {
      await expect(resumo.getByText(label, { exact: true })).toBeVisible();
    }
    const serviceRow = card(page, "Por serviço").getByRole("row").filter({ hasText: SERVICE });
    await expect(serviceRow).toContainText("2");
    await expect(serviceRow).toContainText(brl("R$ 200,00"));
    await expect(serviceRow).toContainText(brl("R$ 100,00"));

    await expect(card(page, "Por profissional").getByRole("row").filter({ hasText: "Ana" }).first()).toBeVisible();
    // 50% do serviço sobre R$ 200,00 = R$ 100,00 de comissão guardados na foto de cada atendimento.
    const sum = await prisma.appointment.aggregate({
      where: { tenantId: ctx.tenantId, serviceId: ctx.serviceId, status: "COMPLETED" },
      _sum: { priceCentsSnapshot: true, commissionCentsSnapshot: true },
    });
    expect(sum._sum.priceCentsSnapshot).toBe(20_000);
    expect(sum._sum.commissionCentsSnapshot).toBe(10_000);
  });

  test("mudar o preço do serviço depois de concluir não altera o que já foi concluído; o novo atendimento usa o preço novo", async ({ page }) => {
    // Edita o preço pela tela Serviços, como o dono faria.
    await page.goto(`/${SEED_TENANT_SLUG}/servicos`);
    await page.getByRole("button", { name: `Editar ${SERVICE}` }).click();
    const dlg = page.getByRole("dialog").filter({ hasText: "Editar serviço" });
    await dlg.getByLabel("Preço (R$)").fill("150");
    await dlg.getByRole("button", { name: "Salvar" }).click();
    await expect(dlg).toBeHidden();
    expect((await prisma.service.findUniqueOrThrow({ where: { id: ctx.serviceId } })).priceCents).toBe(15_000);

    // Os dois já concluídos continuam valendo R$ 100,00 cada.
    await page.goto(`/${SEED_TENANT_SLUG}/relatorios?periodo=last_30_days`);
    await expect(card(page, "Por serviço").getByRole("row").filter({ hasText: SERVICE })).toContainText(brl("R$ 200,00"));
    const snaps = await prisma.appointment.findMany({ where: { serviceId: ctx.serviceId, status: "COMPLETED" }, select: { priceCentsSnapshot: true } });
    expect(snaps.map((s) => s.priceCentsSnapshot)).toEqual([10_000, 10_000]);

    // Um terceiro concluído agora entra pelo preço novo: 100 + 100 + 150.
    const day = tuesday(-1);
    await createAppointment("C", day, 12);
    await finish(page, day, "C", "Concluir atendimento");
    await page.goto(`/${SEED_TENANT_SLUG}/relatorios?periodo=last_30_days`);
    await expect(card(page, "Por serviço").getByRole("row").filter({ hasText: SERVICE })).toContainText(brl("R$ 350,00"));
  });

  test("CSV baixa com BOM, nome de arquivo e as linhas do período; e a tela cabe em 1440 e 390", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/relatorios?periodo=last_30_days`);
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Baixar CSV" }).click()]);
    expect(download.suggestedFilename()).toMatch(/\.csv$/);
    const raw = await (await import("node:fs/promises")).readFile((await download.path())!);
    expect([raw[0], raw[1], raw[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect(raw.toString("utf8")).toContain(SERVICE);

    const res = await page.request.get(`/api/reports/csv?tenant=${SEED_TENANT_SLUG}&periodo=last_30_days`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/csv");
    expect(res.headers()["content-disposition"]).toContain("attachment");
    // Entrada ruim é recusada em JSON estruturado, nunca 500.
    const bad = await page.request.get(`/api/reports/csv?tenant=${SEED_TENANT_SLUG}&periodo=custom&de=2026-13-45&ate=abc`);
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error.code).toBe("INVALID_PAYLOAD");

    for (const [w, h] of [[1440, 900], [390, 844]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.goto(`/${SEED_TENANT_SLUG}/relatorios?periodo=last_30_days`);
      await expect(page.getByTestId("relatorios-resumo")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), `overflow a ${w}px`).toBeLessThanOrEqual(0);
    }
    // Celular: a lista em cartões mostra o serviço do teste.
    await expect(page.getByRole("listitem").filter({ hasText: SERVICE }).first()).toBeVisible();
  });

  test("período personalizado com data final antes da inicial não quebra a tela", async ({ page }) => {
    const res = await page.goto(`/${SEED_TENANT_SLUG}/relatorios?periodo=custom&de=2026-10-02&ate=2026-09-01`);
    expect(res?.status()).toBeLessThan(500);
    await expect(page.getByRole("main")).toBeVisible();
  });
});

test.describe("Relatórios para a equipe (STAFF)", () => {
  test.use({ storageState: STAFF_STORAGE_STATE, viewport: { width: 1440, height: 900 } });

  test("não aparece no menu, a página mostra o aviso e o CSV responde 403", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/agenda`);
    await expect(page.getByRole("navigation").getByRole("link", { name: "Agenda" }).first()).toBeVisible();
    await expect(page.getByRole("navigation").getByRole("link", { name: "Relatórios" })).toHaveCount(0);

    await page.goto(`/${SEED_TENANT_SLUG}/relatorios`);
    await expect(page.getByText("Esta tela é só para o dono")).toBeVisible();
    await expect(page.getByTestId("relatorios-resumo")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(SERVICE);

    const res = await page.request.get(`/api/reports/csv?tenant=${SEED_TENANT_SLUG}&periodo=last_30_days`);
    expect(res.status()).toBe(403);
    expect(await res.text()).not.toContain(SERVICE);

    // E a ficha do profissional não mostra o cartão de comissão para quem não é dono.
    await page.goto(`/${SEED_TENANT_SLUG}/profissionais/${ctx.anaId}`);
    await expect(page.getByRole("heading", { name: "Comissão" })).toHaveCount(0);
  });
});
