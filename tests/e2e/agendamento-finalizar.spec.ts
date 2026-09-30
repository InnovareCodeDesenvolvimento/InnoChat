import { test, expect, type Page } from "@playwright/test";
import { SEED_TENANT_SLUG, E2E_RUN_PREFIX } from "./fixtures/test-data";
import { OWNER_STORAGE_STATE } from "./fixtures/storage-state";
import { prisma } from "./fixtures/db";

/**
 * Detalhe do agendamento: concluir atendimento, registrar falta e reabrir (docs/contratos.md, "finalizar
 * agendamento"). Só depois do horário de início; reabrir devolve para "Agendado". Os agendamentos são
 * criados direto no banco, em terça-feira (expediente normal de Ana no seed), num dia PASSADO (o que já
 * começou) e num FUTURO (que ainda não pode ser concluído).
 *
 * Mesma convenção de `drag-reschedule.spec.ts`: o host roda no fuso do tenant de seed.
 */
test.use({ storageState: OWNER_STORAGE_STATE, viewport: { width: 1280, height: 1000 } });
test.describe.configure({ mode: "serial" });

const CLIENT = `${E2E_RUN_PREFIX} Cliente Finalizar`;

function tuesday(direction: 1 | -1): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  do d.setDate(d.getDate() + direction);
  while (d.getDay() !== 2);
  return d;
}

async function setAgendaDate(page: Page, target: Date) {
  await page.getByRole("button", { name: "Hoje" }).click();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  const button = page.getByRole("button", { name: diffDays > 0 ? "Próximo período" : "Período anterior" });
  for (let i = 0; i < Math.abs(diffDays); i++) await button.click();
}

async function createAppointment(name: string, day: Date, hour: number, minute = 0) {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { slug: SEED_TENANT_SLUG }, select: { id: true } });
  const service = await prisma.service.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Corte feminino" } });
  const ana = await prisma.professional.findFirstOrThrow({ where: { tenantId: tenant.id, name: "Ana" } });
  const suffix = E2E_RUN_PREFIX.replace(/\D/g, "").slice(-8);
  const contact = await prisma.contact.create({
    data: { tenantId: tenant.id, name, waJid: `55118${suffix}${hour}@s.whatsapp.net`, phoneE164: `+55118${suffix}${hour}` },
  });
  const startsAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
  const endsAt = new Date(startsAt.getTime() + service.durationMin * 60_000);
  return prisma.appointment.create({
    data: {
      tenantId: tenant.id,
      contactId: contact.id,
      serviceId: service.id,
      professionalId: ana.id,
      startsAt,
      endsAt,
      blockEndsAt: endsAt,
      source: "PANEL",
    },
  });
}

async function openAppointment(page: Page, day: Date, name: string) {
  await page.goto(`/${SEED_TENANT_SLUG}/agenda`);
  await setAgendaDate(page, day);
  await page.getByRole("button").filter({ hasText: name }).click();
  const dialog = page.getByRole("dialog").filter({ hasText: "Agendamento" });
  await expect(dialog).toBeVisible();
  return dialog;
}

const statusOf = async (id: string) => (await prisma.appointment.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

test.afterEach(async () => {
  await prisma.appointment.deleteMany({ where: { contact: { name: { contains: CLIENT } } } });
  await prisma.contact.deleteMany({ where: { name: { contains: CLIENT } } });
});

test.describe("Detalhe do agendamento: concluir, faltou, reabrir", () => {
  test("concluir atendimento de um horário que já passou, e reabrir volta para Agendado", async ({ page }) => {
    const day = tuesday(-1);
    const name = `${CLIENT} Concluir`;
    const appt = await createAppointment(name, day, 10);
    const dialog = await openAppointment(page, day, name);

    await expect(dialog.getByText("Agendado")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Reabrir agendamento" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Concluir atendimento" }).click();

    await expect(page.getByText("Atendimento concluído.").first()).toBeVisible();
    await expect(dialog.getByText("Concluído", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Concluir atendimento" })).toHaveCount(0);
    expect(await statusOf(appt.id)).toBe("COMPLETED");
    // A linha do tempo registra a mudança.
    expect(await prisma.appointmentEvent.count({ where: { appointmentId: appt.id, action: "COMPLETED" } })).toBe(1);

    await dialog.getByRole("button", { name: "Reabrir agendamento" }).click();
    await expect(page.getByText("Agendamento reaberto.").first()).toBeVisible();
    await expect(dialog.getByText("Agendado")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Concluir atendimento" })).toBeEnabled();
    expect(await statusOf(appt.id)).toBe("SCHEDULED");
    expect(await prisma.appointmentEvent.count({ where: { appointmentId: appt.id, action: "REOPENED" } })).toBe(1);
  });

  test("registrar falta (Cliente faltou) e reabrir", async ({ page }) => {
    const day = tuesday(-1);
    const name = `${CLIENT} Faltou`;
    const appt = await createAppointment(name, day, 11, 30);
    const dialog = await openAppointment(page, day, name);

    await dialog.getByRole("button", { name: "Cliente faltou" }).click();
    await expect(page.getByText("Falta registrada.").first()).toBeVisible();
    await expect(dialog.getByText("Faltou", { exact: true })).toBeVisible();
    expect(await statusOf(appt.id)).toBe("NO_SHOW");
    // Faltou não oferece "Concluir"; só reabrir.
    await expect(dialog.getByRole("button", { name: "Concluir atendimento" })).toHaveCount(0);

    await dialog.getByRole("button", { name: "Reabrir agendamento" }).click();
    await expect(page.getByText("Agendamento reaberto.").first()).toBeVisible();
    expect(await statusOf(appt.id)).toBe("SCHEDULED");
  });

  test("horário que ainda não começou: concluir e faltou ficam bloqueados, com a explicação, e nada muda", async ({ page }) => {
    const day = tuesday(1);
    const name = `${CLIENT} Futuro`;
    const appt = await createAppointment(name, day, 10);
    const dialog = await openAppointment(page, day, name);

    await expect(dialog.getByRole("button", { name: "Concluir atendimento" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Cliente faltou" })).toBeDisabled();
    await expect(dialog.getByText(/ficam disponíveis a partir das 10:00/)).toBeVisible();
    // Remarcar e cancelar continuam disponíveis para o futuro.
    await expect(dialog.getByRole("button", { name: "Remarcar" })).toBeEnabled();
    expect(await statusOf(appt.id)).toBe("SCHEDULED");
  });
});
