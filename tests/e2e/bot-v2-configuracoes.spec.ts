import { test, expect } from "@playwright/test";
import { SEED_TENANT_SLUG } from "./fixtures/test-data";
import { OWNER_STORAGE_STATE, STAFF_STORAGE_STATE } from "./fixtures/storage-state";
import { prisma } from "./fixtures/db";

/**
 * Configurações → "Atendimento pelo WhatsApp" (bot v2, docs/bot-v2-plano.md §3.5 / L-1):
 * limite de agendamentos futuros por cliente, grade de horários (15/30) e tempo até o bot voltar
 * a responder depois do atendente. Só o OWNER edita; o STAFF só vê.
 *
 * Os valores originais da empresa de seed são restaurados no `afterAll` (a spec grava de verdade).
 */
const RULES_SELECT = {
  maxFutureAppointmentsPerContact: true,
  slotGranularityMin: true,
  handoffResumeMinutes: true,
} as const;

let original: { maxFutureAppointmentsPerContact: number; slotGranularityMin: number; handoffResumeMinutes: number };

async function resetRules() {
  await prisma.tenant.update({ where: { slug: SEED_TENANT_SLUG }, data: { maxFutureAppointmentsPerContact: 3, slotGranularityMin: 30, handoffResumeMinutes: 120 } });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  original = await prisma.tenant.findUniqueOrThrow({ where: { slug: SEED_TENANT_SLUG }, select: RULES_SELECT });
  await resetRules();
});

test.afterAll(async () => {
  await prisma.tenant.update({ where: { slug: SEED_TENANT_SLUG }, data: original });
});

test.describe("dono da empresa", () => {
  test.use({ storageState: OWNER_STORAGE_STATE });

  test.beforeEach(async () => {
    await resetRules();
  });

  test("mostra os valores atuais, salva e mantém depois de recarregar (e no banco)", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/configuracoes`);
    const card = page.getByTestId("atendimento-card");
    await expect(card).toBeVisible();

    const max = card.getByLabel(/Agendamentos futuros por cliente/);
    const resume = card.getByLabel(/Bot volta a responder depois de/);
    await expect(max).toHaveValue("3");
    await expect(card.getByRole("radio", { name: /A cada 30 minutos/ })).toBeChecked();
    await expect(resume).toHaveValue("120");
    // Nada mudou: "Salvar" começa desabilitado.
    await expect(card.getByRole("button", { name: "Salvar" })).toBeDisabled();

    await max.fill("5");
    await card.getByText("A cada 15 minutos").click();
    await resume.selectOption("240");
    await card.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Regras do atendimento salvas.").first()).toBeVisible();

    const saved = await prisma.tenant.findUniqueOrThrow({ where: { slug: SEED_TENANT_SLUG }, select: RULES_SELECT });
    expect(saved).toEqual({ maxFutureAppointmentsPerContact: 5, slotGranularityMin: 15, handoffResumeMinutes: 240 });

    await page.reload();
    const again = page.getByTestId("atendimento-card");
    await expect(again.getByLabel(/Agendamentos futuros por cliente/)).toHaveValue("5");
    await expect(again.getByRole("radio", { name: /A cada 15 minutos/ })).toBeChecked();
    await expect(again.getByLabel(/Bot volta a responder depois de/)).toHaveValue("240");
  });

  test("0 significa sem limite e é aceito", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/configuracoes`);
    const card = page.getByTestId("atendimento-card");
    await card.getByLabel(/Agendamentos futuros por cliente/).fill("0");
    await card.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Regras do atendimento salvas.").first()).toBeVisible();
    const saved = await prisma.tenant.findUniqueOrThrow({ where: { slug: SEED_TENANT_SLUG }, select: RULES_SELECT });
    expect(saved.maxFutureAppointmentsPerContact).toBe(0);
  });

  for (const invalid of ["21", "-1", "1.5", ""]) {
    test(`recusa limite inválido (${JSON.stringify(invalid)}) em linha, sem gravar nada`, async ({ page }) => {
      await page.goto(`/${SEED_TENANT_SLUG}/configuracoes`);
      const card = page.getByTestId("atendimento-card");
      const max = card.getByLabel(/Agendamentos futuros por cliente/);
      await max.fill(invalid);
      // Muda também a grade para o botão "Salvar" habilitar mesmo se o campo for lido como "sem mudança".
      await card.getByText("A cada 15 minutos").click();
      await card.getByRole("button", { name: "Salvar" }).click();
      await expect(card.getByText("Informe um número inteiro de 0 a 20.")).toBeVisible();
      await expect(page.getByText("Regras do atendimento salvas.")).toHaveCount(0);
      const saved = await prisma.tenant.findUniqueOrThrow({ where: { slug: SEED_TENANT_SLUG }, select: RULES_SELECT });
      expect(saved).toEqual({ maxFutureAppointmentsPerContact: 3, slotGranularityMin: 30, handoffResumeMinutes: 120 });
    });
  }

  test("o erro em linha some quando o valor volta a ser válido", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/configuracoes`);
    const card = page.getByTestId("atendimento-card");
    const max = card.getByLabel(/Agendamentos futuros por cliente/);
    await max.fill("99");
    await max.blur();
    await expect(card.getByText("Informe um número inteiro de 0 a 20.")).toBeVisible();
    await max.fill("4");
    await expect(card.getByText("Informe um número inteiro de 0 a 20.")).toBeHidden();
  });
});

test.describe("equipe (STAFF)", () => {
  test.use({ storageState: STAFF_STORAGE_STATE });

  test("só vê: controles desabilitados, sem botão Salvar, com a explicação", async ({ page }) => {
    await page.goto(`/${SEED_TENANT_SLUG}/configuracoes`);
    const card = page.getByTestId("atendimento-card");
    await expect(card).toBeVisible();
    await expect(card.getByLabel(/Agendamentos futuros por cliente/)).toBeDisabled();
    await expect(card.getByLabel(/Bot volta a responder depois de/)).toBeDisabled();
    await expect(card.getByRole("radio", { name: /A cada 15 minutos/ })).toBeDisabled();
    await expect(card.getByRole("button", { name: "Salvar" })).toHaveCount(0);
    await expect(card.getByText("Só o dono da empresa pode alterar estas regras.")).toBeVisible();
  });
});
