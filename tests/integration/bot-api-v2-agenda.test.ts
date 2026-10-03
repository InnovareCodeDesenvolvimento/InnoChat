/**
 * B-1 do bot v2 (docs/bot-v2-plano.md §3.4, §4 B-1): catálogo filtrado e com rótulos, dias com
 * `nextFrom` correto, horários com período/`near`/`reason`, `availability/next`, agendamentos com
 * `canChange`, `contactName` e o limite de agendamentos futuros (só com `X-InnoChat-Flow: 2`).
 *
 * Mesma convenção dos outros testes de integração: banco `innochat_test` real; a lógica de módulo é
 * chamada direto e as rotas (para o header de versão) com `Request` montado à mão.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import { hashInternalApiSecret } from "@/modules/platform/service";
import type { InternalApiContext } from "@/modules/bot-api/internal-auth";
import {
  createAppointmentBot,
  listAvailabilityDayOptions,
  listAvailabilitySlotOptions,
  listCatalogProfessionalOptions,
  listCatalogServiceOptions,
  listMyAppointmentOptions,
  listNextAvailableSlots,
  rescheduleAppointmentBot,
} from "@/modules/bot-api/booking-bot";
import { flowVersionOf } from "@/modules/bot-api/flow-version";
import { createProfessional, createService, setProfessionalServices, setProfessionalWorkingHours } from "@/modules/agenda/catalog";
import { formatDayLabelFromISO } from "@/core/bot/format";
import { POST as postAppointment } from "@/app/api/internal/v1/appointments/route";

const prisma = getPrisma();
const SECRET = ["test", "internal", "secret", "v2agenda"].join("-");
const createdTenantIds: string[] = [];
let planId: string | null = null;

async function getPlanId() {
  if (!planId) {
    const plan = await prisma.plan.create({
      data: { code: `it-v2ag-${Date.now()}-${randomUUID().slice(0, 6)}`, name: "Plano IT v2 agenda", priceCents: 0, maxWhatsappNumbers: 3, maxProfessionals: null, active: false, sortOrder: 999 },
    });
    planId = plan.id;
  }
  return planId;
}

async function makeTenant(label: string, opts: { timezone?: string; tenant?: Record<string, unknown> } = {}) {
  const tenant = await prisma.tenant.create({
    data: {
      slug: `it-v2ag-${label}-${Date.now()}-${randomUUID().slice(0, 6)}`,
      name: `V2 Agenda ${label}`,
      timezone: opts.timezone ?? "America/Sao_Paulo",
      minLeadTimeMin: 0,
      maxHorizonDays: 30,
      ...(opts.tenant ?? {}),
    },
  });
  createdTenantIds.push(tenant.id);
  await prisma.subscription.create({
    data: { tenantId: tenant.id, planId: await getPlanId(), status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) },
  });
  const instance = await prisma.whatsappInstance.create({
    data: { tenantId: tenant.id, instanceName: `innochat-${label}-${randomUUID().slice(0, 6)}`, label: "Principal", webhookToken: randomUUID(), sandbox: false },
  });
  const ctx: InternalApiContext = {
    tenantId: tenant.id,
    instance: { id: instance.id, tenantId: tenant.id, instanceName: instance.instanceName, sandbox: instance.sandbox, status: instance.status },
  };
  return { tenant, instance, ctx };
}

const ALL_WEEK = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: "08:00", endTime: "18:00" }));

async function makeBookable(tenantId: string, opts: { serviceName?: string; durationMin?: number; priceCents?: number | null; professional?: string } = {}) {
  const service = await createService(tenantId, {
    name: opts.serviceName ?? "Corte",
    durationMin: opts.durationMin ?? 30,
    bufferAfterMin: 0,
    priceCents: opts.priceCents === undefined ? 8000 : opts.priceCents,
    active: true,
    sortOrder: 0,
  });
  const professional = await createProfessional(tenantId, { name: opts.professional ?? "Ana", active: true, sortOrder: 0 });
  await setProfessionalServices(tenantId, professional.id, [service.id]);
  await setProfessionalWorkingHours(tenantId, professional.id, ALL_WEEK);
  return { service, professional };
}

async function makeContact(tenantId: string, suffix: string) {
  return prisma.contact.create({ data: { tenantId, waJid: `55119${Date.now()}${suffix}@s.whatsapp.net` } });
}

async function ensureSecret() {
  await prisma.platformSettings.upsert({
    where: { id: 1 },
    create: { id: 1, internalApiSecretHash: hashInternalApiSecret(SECRET) },
    update: { internalApiSecretHash: hashInternalApiSecret(SECRET) },
  });
}

function todayISO(tz: string, plusDays = 0) {
  const d = new Date(Date.now() + plusDays * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** Um horário livre bem à frente (dia D+n, o n-ésimo da lista de dias) para reservar. */
async function futureSlots(tenantId: string, serviceId: string, professionalId: string, plusDays: number, tz = "America/Sao_Paulo") {
  const r = await listAvailabilitySlotOptions(tenantId, { serviceId, professionalId, date: todayISO(tz, plusDays), offset: 0, limit: 8 });
  return r.options.map((o) => new Date(o.id));
}

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  if (planId) await prisma.plan.delete({ where: { id: planId } });
  await prisma.$disconnect();
});

describe("flowVersionOf", () => {
  it("só o header exato 2 é v2; ausente ou qualquer outro valor é v1", () => {
    expect(flowVersionOf(new Request("http://x", { headers: { "X-InnoChat-Flow": "2" } }))).toBe(2);
    expect(flowVersionOf(new Request("http://x"))).toBe(1);
    expect(flowVersionOf(new Request("http://x", { headers: { "X-InnoChat-Flow": "3" } }))).toBe(1);
  });
});

describe("API-04 catálogo filtrado e com rótulos", () => {
  it("só serviços agendáveis, com name/durationLabel/priceLabel; profissional sem expediente some", async () => {
    const { ctx } = await makeTenant("catalog", { tenant: { askProfessional: true } });
    const { service, professional } = await makeBookable(ctx.tenantId, { serviceName: "Corte feminino", durationMin: 90, priceCents: 8000 });

    // Serviço sem nenhum profissional com expediente (BUG-09).
    const semExpediente = await createService(ctx.tenantId, { name: "Massagem", durationMin: 40, bufferAfterMin: 0, priceCents: null, active: true, sortOrder: 1 });
    const carla = await createProfessional(ctx.tenantId, { name: "Carla", active: true, sortOrder: 5 });
    await setProfessionalServices(ctx.tenantId, carla.id, [semExpediente.id, service.id]);

    const catalog = await listCatalogServiceOptions(ctx.tenantId);
    expect(catalog.options.map((o) => o.id)).toEqual([service.id]);
    expect(catalog.options[0]).toMatchObject({
      label: "Corte feminino — R$ 80,00",
      name: "Corte feminino",
      durationMin: 90,
      durationLabel: "1h30",
      priceLabel: "R$ 80,00",
    });
    expect(catalog.limit).toBeUndefined();

    // Carla está ligada ao serviço mas sem expediente: não aparece; sobrando 1 profissional, pula a escolha.
    const pros = await listCatalogProfessionalOptions(ctx.tenantId, service.id);
    expect(pros).toEqual({ options: [{ id: professional.id, label: "Ana" }], skip: true });
  });

  it("serviço sem preço vem com priceLabel null", async () => {
    const { ctx } = await makeTenant("catalog-noprice");
    await makeBookable(ctx.tenantId, { priceCents: null, durationMin: 40 });
    const { options } = await listCatalogServiceOptions(ctx.tenantId);
    expect(options[0].priceLabel).toBeNull();
    expect(options[0].durationLabel).toBe("40 min");
  });

  it("?contactId devolve o limite; contato de outro tenant é 404", async () => {
    const a = await makeTenant("limit-a", { tenant: { maxFutureAppointmentsPerContact: 1 } });
    const b = await makeTenant("limit-b");
    const { service, professional } = await makeBookable(a.ctx.tenantId);
    const contact = await makeContact(a.ctx.tenantId, "01");
    const foreign = await makeContact(b.ctx.tenantId, "02");

    const before = await listCatalogServiceOptions(a.ctx.tenantId, { contactId: contact.id });
    expect(before.limit).toEqual({ max: 1, count: 0, reached: false });

    const [slot] = await futureSlots(a.ctx.tenantId, service.id, professional.id, 2);
    await createAppointmentBot(a.ctx, { contactId: contact.id, serviceId: service.id, professionalId: professional.id, startsAt: slot, idempotencyKey: "cat-1" });

    const after = await listCatalogServiceOptions(a.ctx.tenantId, { contactId: contact.id });
    expect(after.limit).toEqual({ max: 1, count: 1, reached: true });

    await expect(listCatalogServiceOptions(a.ctx.tenantId, { contactId: foreign.id })).rejects.toMatchObject({ status: 404 });
  });
});

describe("API-01 dias", () => {
  it("nextFrom é o dia SEGUINTE ao último mostrado; a 2ª página não repete dia (BUG-05)", async () => {
    const { ctx } = await makeTenant("days");
    const { service, professional } = await makeBookable(ctx.tenantId);

    const page1 = await listAvailabilityDayOptions(ctx.tenantId, { serviceId: service.id, professionalId: professional.id, from: null, limit: 6 });
    expect(page1.options).toHaveLength(6);
    expect(page1.hasMore).toBe(true);
    const last = page1.options[5].id;
    const dayAfterLast = new Date(`${last}T12:00:00Z`);
    dayAfterLast.setUTCDate(dayAfterLast.getUTCDate() + 1);
    expect(page1.nextFrom).toBe(dayAfterLast.toISOString().slice(0, 10));

    const page2 = await listAvailabilityDayOptions(ctx.tenantId, { serviceId: service.id, professionalId: professional.id, from: page1.nextFrom, limit: 6 });
    const ids1 = new Set(page1.options.map((o) => o.id));
    expect(page2.options.every((o) => !ids1.has(o.id))).toBe(true);
    expect(page2.options[0].id).toBe(page1.nextFrom);
  });

  it("rótulos: relativeLabel de hoje/amanhã e lastBookableDate", async () => {
    const { ctx } = await makeTenant("days-labels");
    const { service, professional } = await makeBookable(ctx.tenantId);
    const r = await listAvailabilityDayOptions(ctx.tenantId, { serviceId: service.id, professionalId: professional.id, from: todayISO("America/Sao_Paulo", 1), limit: 3 });
    expect(r.options[0].relativeLabel).toBe(`Amanhã · ${r.options[0].label}`);
    expect(r.options[1].relativeLabel).toBe(r.options[1].label);
    expect(r.lastBookableDate.id).toBe(todayISO("America/Sao_Paulo", 29));
    expect(r.lastBookableDate.label).toBe(formatDayLabelFromISO(r.lastBookableDate.id, "America/Sao_Paulo"));
  });

  it("BUG-15: em UTC+14 o rótulo tem o MESMO dia do id (sem +1)", async () => {
    const tz = "Pacific/Kiritimati";
    const { ctx } = await makeTenant("days-kiritimati", { timezone: tz });
    const { service, professional } = await makeBookable(ctx.tenantId);
    const r = await listAvailabilityDayOptions(ctx.tenantId, { serviceId: service.id, professionalId: professional.id, from: null, limit: 4 });
    expect(r.options.length).toBeGreaterThan(0);
    for (const o of r.options) {
      const [, mm, dd] = o.id.split("-");
      expect(o.label.endsWith(`${dd}/${mm}`)).toBe(true);
    }
  });
});

describe("API-02 horários", () => {
  it("period filtra por hora local e near ordena por distância com exact", async () => {
    const { ctx } = await makeTenant("slots");
    const { service, professional } = await makeBookable(ctx.tenantId);
    const date = todayISO("America/Sao_Paulo", 3);
    const base = { serviceId: service.id, professionalId: professional.id, date, offset: 0 };

    const morning = await listAvailabilitySlotOptions(ctx.tenantId, { ...base, limit: 8, period: "morning" });
    expect(morning.options.map((o) => o.label)).toEqual(["08:00", "08:30", "09:00", "09:30", "10:00", "10:30", "11:00", "11:30"]);
    const evening = await listAvailabilitySlotOptions(ctx.tenantId, { ...base, limit: 8, period: "evening" });
    expect(evening.options.map((o) => o.label)).toEqual([]);
    expect(evening.reason).toBe("FULL");
    const afternoon = await listAvailabilitySlotOptions(ctx.tenantId, { ...base, limit: 8, period: "afternoon" });
    expect(afternoon.options[0].label).toBe("12:00");
    expect(afternoon.options.at(-1)?.label).toBe("15:30");

    const near = await listAvailabilitySlotOptions(ctx.tenantId, { ...base, limit: 3, near: "14:30" });
    expect(near.options.map((o) => o.label)).toEqual(["14:30", "14:00", "15:00"]);
    expect(near.exact).toBe(true);
    const nearOff = await listAvailabilitySlotOptions(ctx.tenantId, { ...base, limit: 3, near: "19:00" });
    expect(nearOff.options[0].label).toBe("17:30");
    expect(nearOff.exact).toBe(false);

    expect(morning.dateLabel).toBe(formatDayLabelFromISO(date, "America/Sao_Paulo"));
    expect(morning.dateLongLabel).toMatch(/-feira, \d\d\/\d\d$|^(sábado|domingo), /);
    expect(morning.reason).toBeNull();
    expect(morning.nextDay).toBeNull();
    expect(morning.exact).toBeUndefined();
  });

  it("reason: PAST, BEYOND_HORIZON, CLOSED (com nextDay) e FULL", async () => {
    const { ctx } = await makeTenant("slots-reason");
    const { service, professional } = await makeBookable(ctx.tenantId);
    // Fecha o dia D+2 pela empresa (feriado).
    const closedISO = todayISO("America/Sao_Paulo", 2);
    await prisma.scheduleException.create({
      data: { tenantId: ctx.tenantId, professionalId: null, startsAt: new Date(`${closedISO}T00:00:00-03:00`), endsAt: new Date(`${closedISO}T23:59:59-03:00`), reason: "Feriado", type: "HOLIDAY" },
    });
    const base = { serviceId: service.id, professionalId: professional.id, offset: 0, limit: 7 };

    const past = await listAvailabilitySlotOptions(ctx.tenantId, { ...base, date: todayISO("America/Sao_Paulo", -2) });
    expect(past).toMatchObject({ options: [], reason: "PAST" });
    expect((past.nextDay?.id ?? "") >= todayISO("America/Sao_Paulo", 0)).toBe(true);

    const beyond = await listAvailabilitySlotOptions(ctx.tenantId, { ...base, date: todayISO("America/Sao_Paulo", 60) });
    expect(beyond).toMatchObject({ options: [], reason: "BEYOND_HORIZON", nextDay: null });

    const closed = await listAvailabilitySlotOptions(ctx.tenantId, { ...base, date: closedISO });
    expect(closed.reason).toBe("CLOSED");
    expect(closed.nextDay?.id).toBe(todayISO("America/Sao_Paulo", 3));
    expect(closed.nextDay?.label).toBe(formatDayLabelFromISO(todayISO("America/Sao_Paulo", 3), "America/Sao_Paulo"));

    // Lotado: um agendamento de 10h ocupando todo o expediente do dia D+4.
    const fullISO = todayISO("America/Sao_Paulo", 4);
    const contact = await makeContact(ctx.tenantId, "10");
    await prisma.appointment.create({
      data: {
        tenantId: ctx.tenantId, contactId: contact.id, serviceId: service.id, professionalId: professional.id,
        startsAt: new Date(`${fullISO}T08:00:00-03:00`), endsAt: new Date(`${fullISO}T18:00:00-03:00`), blockEndsAt: new Date(`${fullISO}T18:00:00-03:00`),
        status: "SCHEDULED", source: "PANEL",
      },
    });
    const full = await listAvailabilitySlotOptions(ctx.tenantId, { ...base, date: fullISO });
    expect(full.reason).toBe("FULL");
    expect(full.nextDay?.id).toBe(todayISO("America/Sao_Paulo", 5));
  });

  it("offset pagina sem repetir", async () => {
    const { ctx } = await makeTenant("slots-page");
    const { service, professional } = await makeBookable(ctx.tenantId);
    const date = todayISO("America/Sao_Paulo", 3);
    const p1 = await listAvailabilitySlotOptions(ctx.tenantId, { serviceId: service.id, professionalId: professional.id, date, offset: 0, limit: 7 });
    const p2 = await listAvailabilitySlotOptions(ctx.tenantId, { serviceId: service.id, professionalId: professional.id, date, offset: 7, limit: 7 });
    expect(p1.options).toHaveLength(7);
    expect(p1.hasMore).toBe(true);
    expect(p2.options[0].label).toBe("11:30");
  });
});

describe("API-08 grade de 15/30 minutos ancorada", () => {
  it("serviço de 45 min com grade de 30 nunca oferece :15/:45; com 15 oferece", async () => {
    const { ctx, tenant } = await makeTenant("grid");
    const { service, professional } = await makeBookable(ctx.tenantId, { durationMin: 45 });
    const date = todayISO("America/Sao_Paulo", 3);
    const q = { serviceId: service.id, professionalId: professional.id, date, offset: 0, limit: 8 };

    const g30 = await listAvailabilitySlotOptions(ctx.tenantId, q);
    expect(g30.options.map((o) => o.label).every((l) => l.endsWith(":00") || l.endsWith(":30"))).toBe(true);

    await prisma.tenant.update({ where: { id: tenant.id }, data: { slotGranularityMin: 15 } });
    const g15 = await listAvailabilitySlotOptions(ctx.tenantId, q);
    expect(g15.options.map((o) => o.label).slice(0, 3)).toEqual(["08:00", "08:15", "08:30"]);
  });
});

describe("API-03 próximos horários", () => {
  it("devolve N horários em ordem, com rótulo relativo ao dia", async () => {
    const { ctx } = await makeTenant("next");
    const { service, professional } = await makeBookable(ctx.tenantId);
    // Só de amanhã em diante (hoje pode estar fora do expediente em qualquer hora do teste).
    await prisma.tenant.update({ where: { id: ctx.tenantId }, data: { minLeadTimeMin: 24 * 60 } });
    const r = await listNextAvailableSlots(ctx.tenantId, { serviceId: service.id, professionalId: professional.id, limit: 6 });
    expect(r.options).toHaveLength(6);
    const ids = r.options.map((o) => o.id);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(6);
    for (const o of r.options) expect(o.label).toMatch(/ · \d\d:\d\d$/);
    // Com 24h de antecedência, depois do fim do expediente "Amanhã" já não existe: o rótulo cai
    // para a data curta ("Sex 02/10 · 09:00"). Aceita as duas formas para não depender da hora.
    const hasLabelPrefix = r.options.every((o) => /^(Hoje|Amanhã|[A-Za-zÀ-ú]{3,} \d\d\/\d\d) · /.test(o.label));
    expect(hasLabelPrefix).toBe(true);
    expect(r.options[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("API-06 meus agendamentos: canChange e rótulos", () => {
  it("canChange respeita cancelMinLeadMin; rótulos prontos", async () => {
    const { ctx } = await makeTenant("mine", { tenant: { cancelMinLeadMin: 120 } });
    const { service, professional } = await makeBookable(ctx.tenantId, { serviceName: "Corte", durationMin: 60 });
    const contact = await makeContact(ctx.tenantId, "20");
    const mk = (startsAt: Date) =>
      prisma.appointment.create({
        data: {
          tenantId: ctx.tenantId, contactId: contact.id, serviceId: service.id, professionalId: professional.id,
          startsAt, endsAt: new Date(startsAt.getTime() + 3_600_000), blockEndsAt: new Date(startsAt.getTime() + 3_600_000),
          status: "SCHEDULED", source: "WHATSAPP",
        },
      });
    await mk(new Date(Date.now() + 60 * 60_000));
    await mk(new Date(Date.now() + 3 * 86_400_000));

    const { options } = await listMyAppointmentOptions(ctx.tenantId, contact.id, true);
    expect(options).toHaveLength(2);
    expect(options[0].canChange).toBe(false);
    expect(options[1].canChange).toBe(true);
    for (const o of options) {
      expect(o.changeDeadlineLabel).toBe("2 horas");
      expect(o.durationLabel).toBe("1h");
      expect(o.priceLabel).toBe("R$ 80,00");
      expect(o.dataLonga).toMatch(/^[a-zçá-]+, \d\d\/\d\d$/);
    }
    expect(options[1].relativeLabel).toBe(options[1].data);
  });
});

describe("API-07 contactName e summary", () => {
  it("grava o nome junto da reserva e devolve summary v2 com o profissional real", async () => {
    const { ctx } = await makeTenant("name");
    const { service, professional } = await makeBookable(ctx.tenantId, { durationMin: 60 });
    const contact = await makeContact(ctx.tenantId, "30");
    const [slot] = await futureSlots(ctx.tenantId, service.id, professional.id, 2);

    const r = await createAppointmentBot(ctx, {
      contactId: contact.id, serviceId: service.id, professionalId: null, startsAt: slot, idempotencyKey: "name-1", contactName: "  Maria   da Silva ",
    });
    expect(r.appointment.summary).toMatchObject({ servico: "Corte", profissional: "Ana", duracao: "1h", preco: "R$ 80,00" });
    expect(r.appointment.summary.data_longa).toMatch(/, \d\d\/\d\d$/);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).name).toBe("Maria da Silva");

    // Repetição (alreadyExisted) também grava o nome.
    const again = await createAppointmentBot(ctx, {
      contactId: contact.id, serviceId: service.id, professionalId: null, startsAt: slot, idempotencyKey: "name-1", contactName: "Maria Souza",
    });
    expect(again.alreadyExisted).toBe(true);
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).name).toBe("Maria Souza");
  });

  it("nome inválido → 422 INVALID_NAME e nada é gravado nem reservado", async () => {
    const { ctx } = await makeTenant("name-bad");
    const { service, professional } = await makeBookable(ctx.tenantId);
    const contact = await makeContact(ctx.tenantId, "31");
    const [slot] = await futureSlots(ctx.tenantId, service.id, professional.id, 2);

    for (const bad of ["sim", "12345", "a@b.com", "x".repeat(61)]) {
      await expect(
        createAppointmentBot(ctx, { contactId: contact.id, serviceId: service.id, professionalId: professional.id, startsAt: slot, idempotencyKey: `bad-${bad.length}`, contactName: bad }),
      ).rejects.toMatchObject({ code: "INVALID_NAME" });
    }
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).name).toBeNull();
    expect(await prisma.appointment.count({ where: { contactId: contact.id } })).toBe(0);
  });
});

describe("API-05 limite de agendamentos futuros (só com X-InnoChat-Flow: 2)", () => {
  it("v2: o (max+1)-ésimo é 422 LIMIT_REACHED com details e NÃO grava o nome; v1 não é barrado", async () => {
    const { ctx } = await makeTenant("limit", { tenant: { maxFutureAppointmentsPerContact: 2 } });
    const { service, professional } = await makeBookable(ctx.tenantId);
    const contact = await makeContact(ctx.tenantId, "40");
    const slots = await futureSlots(ctx.tenantId, service.id, professional.id, 2);
    const book = (i: number, flow: 1 | 2, contactName?: string) =>
      createAppointmentBot(ctx, { contactId: contact.id, serviceId: service.id, professionalId: professional.id, startsAt: slots[i], idempotencyKey: `lim-${i}-${flow}`, flow, contactName });

    await book(0, 2);
    await book(1, 2);
    await expect(book(2, 2, "Nome Novo")).rejects.toMatchObject({ code: "LIMIT_REACHED", details: { max: 2, count: 2 } });
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).name).toBeNull();

    // Repetir uma reserva já existente não bate no limite (idempotência).
    expect((await book(1, 2)).alreadyExisted).toBe(true);

    // Sem header (v1): passa do limite.
    await expect(book(2, 1)).resolves.toMatchObject({ alreadyExisted: false });
    expect(await prisma.appointment.count({ where: { contactId: contact.id, status: "SCHEDULED" } })).toBe(3);
  });

  it("max = 0 não limita; concorrência: 5 reservas simultâneas com limite 2 → exatamente 2", async () => {
    const unlimited = await makeTenant("limit-zero", { tenant: { maxFutureAppointmentsPerContact: 0 } });
    const u = await makeBookable(unlimited.ctx.tenantId);
    const uc = await makeContact(unlimited.ctx.tenantId, "41");
    const us = await futureSlots(unlimited.ctx.tenantId, u.service.id, u.professional.id, 2);
    for (let i = 0; i < 4; i++) {
      await createAppointmentBot(unlimited.ctx, { contactId: uc.id, serviceId: u.service.id, professionalId: u.professional.id, startsAt: us[i], idempotencyKey: `u-${i}`, flow: 2 });
    }

    const { ctx } = await makeTenant("limit-race", { tenant: { maxFutureAppointmentsPerContact: 2 } });
    const { service, professional } = await makeBookable(ctx.tenantId);
    const contact = await makeContact(ctx.tenantId, "42");
    const slots = await futureSlots(ctx.tenantId, service.id, professional.id, 2);
    const results = await Promise.allSettled(
      slots.slice(0, 5).map((s, i) =>
        createAppointmentBot(ctx, { contactId: contact.id, serviceId: service.id, professionalId: professional.id, startsAt: s, idempotencyKey: `race-${i}`, flow: 2 }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected" && (r.reason as { code?: string }).code === "LIMIT_REACHED")).toHaveLength(3);
    expect(await prisma.appointment.count({ where: { contactId: contact.id, status: "SCHEDULED" } })).toBe(2);
  });

  it("rota: 422 LIMIT_REACHED com header 2; 201 sem header", async () => {
    await ensureSecret();
    const { ctx, instance } = await makeTenant("limit-route", { tenant: { maxFutureAppointmentsPerContact: 1 } });
    const { service, professional } = await makeBookable(ctx.tenantId);
    const contact = await makeContact(ctx.tenantId, "43");
    const slots = await futureSlots(ctx.tenantId, service.id, professional.id, 2);

    const call = (i: number, flow?: "2") =>
      postAppointment(
        new Request("http://localhost/api/internal/v1/appointments", {
          method: "POST",
          headers: {
            authorization: `Bearer ${SECRET}`,
            "x-innochat-instance": instance.webhookToken,
            "content-type": "application/json",
            ...(flow ? { "x-innochat-flow": flow } : {}),
          },
          body: JSON.stringify({ contactId: contact.id, serviceId: service.id, professionalId: professional.id, startsAt: slots[i].toISOString(), idempotencyKey: `route-${i}-${flow ?? 1}` }),
        }),
      );

    expect((await call(0, "2")).status).toBe(201);
    const blocked = await call(1, "2");
    expect(blocked.status).toBe(422);
    expect(await blocked.json()).toEqual({ error: expect.objectContaining({ code: "LIMIT_REACHED", details: { max: 1, count: 1 } }) });
    expect((await call(1)).status).toBe(201);
  });
});

describe("SLOT_TAKEN: alternativas com o dia (BUG-07/15)", () => {
  it("traz date, dateISO e dateRelativeLabel no criar e no remarcar", async () => {
    const { ctx } = await makeTenant("taken");
    const { service, professional } = await makeBookable(ctx.tenantId);
    const [slot, slot2] = await futureSlots(ctx.tenantId, service.id, professional.id, 2);
    const first = await makeContact(ctx.tenantId, "50");
    const other = await makeContact(ctx.tenantId, "51");
    await createAppointmentBot(ctx, { contactId: first.id, serviceId: service.id, professionalId: professional.id, startsAt: slot, idempotencyKey: "t-1" });

    const dateISO = todayISO("America/Sao_Paulo", 2);
    await expect(
      createAppointmentBot(ctx, { contactId: other.id, serviceId: service.id, professionalId: professional.id, startsAt: slot, idempotencyKey: "t-2" }),
    ).rejects.toMatchObject({
      code: "SLOT_TAKEN",
      details: { alternatives: { date: formatDayLabelFromISO(dateISO, "America/Sao_Paulo"), dateISO, dateRelativeLabel: formatDayLabelFromISO(dateISO, "America/Sao_Paulo") } },
    });

    const mine = await createAppointmentBot(ctx, { contactId: other.id, serviceId: service.id, professionalId: professional.id, startsAt: slot2, idempotencyKey: "t-3" });
    await expect(rescheduleAppointmentBot(ctx, mine.appointment.id, other.id, slot)).rejects.toMatchObject({
      code: "SLOT_TAKEN",
      details: { alternatives: { dateISO } },
    });
  });
});
