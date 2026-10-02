/**
 * Lista de espera / encaixe (melhoria 7), contra Postgres real: fila FIFO, oferta ao primeiro compatível quando um
 * horário abre, SIM concorrente, horário ocupado por outro canal, NÃO, vencimento por tick, índice único de oferta
 * (P2002), oferta manual, `claim` v2 com oferta pendente e as rotas da API interna. O WhatsApp é uma Evolution
 * falsa injetada em `setWaitlistDepsForTests`.
 */
import { randomUUID } from "node:crypto";
import { fromZonedTime } from "date-fns-tz";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import { isUniqueViolation } from "@/lib/db/prisma-errors";
import { DomainError } from "@/lib/errors";
import { hashInternalApiSecret } from "@/modules/platform/service";
import type { EvolutionClient } from "@/modules/whatsapp/evolution-client";
import { cancelAppointment, createAppointmentManual, rescheduleAppointment } from "@/modules/agenda/appointments";
import { claimMessage } from "@/modules/bot-api/claim";
import type { InternalApiContext } from "@/modules/bot-api/internal-auth";
import { offerEntryManually, offerFreedSlot, setWaitlistDepsForTests } from "@/modules/waitlist/offer";
import { drainWaitlistHook } from "@/modules/waitlist/hook";
import { acceptWaitlistOffer, declineWaitlistOffer, runWaitlistTick } from "@/modules/waitlist/respond";
import { createWaitlistEntry, listContactWaitlist, listWaitlist, removeWaitlistEntry } from "@/modules/waitlist/service";
import { POST as postJoin } from "@/app/api/internal/v1/waitlist/route";
import { POST as postRespond } from "@/app/api/internal/v1/waitlist/[id]/respond/route";
import { POST as postLeave } from "@/app/api/internal/v1/waitlist/[id]/leave/route";
import { GET as getContactWaitlist } from "@/app/api/internal/v1/contacts/[contactId]/waitlist/route";
import { POST as postTick } from "@/app/api/internal/v1/waitlist/tick/route";
import { drainWaitlistTriggers } from "@/modules/waitlist/offer";

const prisma = getPrisma();
const TZ = "America/Sao_Paulo";
const SECRET = ["test", "internal", "secret", "waitlist"].join("-");
const tenantIds: string[] = [];
let planId: string | null = null;

type Sent = { instanceName: string; number: string; text: string };
let sent: Sent[] = [];
function installFakeEvolution(opts: { fail?: boolean } = {}) {
  sent = [];
  const client = {
    sendText: vi.fn(async (instanceName: string, number: string, text: string) => {
      if (opts.fail) throw new Error("evolution fora do ar");
      sent.push({ instanceName, number, text });
      return { messageId: `MSG-${randomUUID()}` };
    }),
  } as unknown as EvolutionClient;
  setWaitlistDepsForTests({ evolution: client });
}

beforeEach(() => installFakeEvolution());

afterAll(async () => {
  setWaitlistDepsForTests({});
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  if (planId) await prisma.plan.delete({ where: { id: planId } }).catch(() => undefined);
  await prisma.$disconnect();
});

function isoPlus(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
const at = (iso: string, hhmm: string) => fromZonedTime(`${iso}T${hhmm}:00`, TZ);

async function world(label: string) {
  if (!planId) {
    planId = (
      await prisma.plan.create({
        data: { code: `it-wl-${Date.now()}-${randomUUID().slice(0, 6)}`, name: "Plano IT espera", priceCents: 0, maxWhatsappNumbers: 3, maxProfessionals: null, active: false, sortOrder: 999 },
      })
    ).id;
  }
  const tenant = await prisma.tenant.create({
    data: { slug: `it-wl-${label}-${randomUUID().slice(0, 8)}`, name: `Espera ${label}`, timezone: TZ, minLeadTimeMin: 0, maxHorizonDays: 30, slotGranularityMin: 30 },
  });
  tenantIds.push(tenant.id);
  await prisma.subscription.create({ data: { tenantId: tenant.id, planId, status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) } });
  const instance = await prisma.whatsappInstance.create({
    data: { tenantId: tenant.id, instanceName: `inst-wl-${label}-${randomUUID().slice(0, 6)}`, label: "Principal", webhookToken: randomUUID(), status: "CONNECTED", sandbox: false },
  });
  const corte = await prisma.service.create({ data: { tenantId: tenant.id, name: "Corte", durationMin: 30 } });
  const barba = await prisma.service.create({ data: { tenantId: tenant.id, name: "Barba", durationMin: 30 } });
  const ana = await prisma.professional.create({ data: { tenantId: tenant.id, name: "Ana", sortOrder: 0 } });
  const bia = await prisma.professional.create({ data: { tenantId: tenant.id, name: "Bia", sortOrder: 1 } });
  await prisma.professionalService.createMany({
    data: [
      { professionalId: ana.id, serviceId: corte.id },
      { professionalId: bia.id, serviceId: corte.id },
      { professionalId: bia.id, serviceId: barba.id },
    ],
  });
  for (const pro of [ana, bia]) {
    await prisma.workingHour.createMany({ data: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ professionalId: pro.id, weekday, startTime: "08:00", endTime: "18:00" })) });
  }
  const contacts: { id: string; waJid: string }[] = [];
  for (let i = 0; i < 7; i += 1) {
    contacts.push(await prisma.contact.create({ data: { tenantId: tenant.id, waJid: `5511${9000 + Math.floor(Math.random() * 999)}${Date.now().toString().slice(-6)}${i}@s.whatsapp.net`, name: `Cliente ${i}` } }));
  }
  const ctx: InternalApiContext = {
    tenantId: tenant.id,
    instance: { id: instance.id, tenantId: tenant.id, instanceName: instance.instanceName, sandbox: false, status: "CONNECTED" },
  };
  return { tenant, instance, corte, barba, ana, bia, contacts, ctx };
}
type World = Awaited<ReturnType<typeof world>>;

async function book(w: World, contactIndex: number, serviceId: string, professionalId: string, iso: string, hhmm: string) {
  const { appointment } = await createAppointmentManual(w.tenant.id, { contactId: w.contacts[contactIndex].id, serviceId, professionalId, startsAt: at(iso, hhmm) }, "system");
  return appointment as { id: string };
}

async function join(w: World, contactIndex: number, o: { serviceId?: string; professionalId?: string | null; date: string; period?: "ANY" | "MORNING" | "AFTERNOON" | "EVENING"; windowStartMin?: number; windowEndMin?: number }) {
  const { entry } = await createWaitlistEntry(w.tenant.id, {
    contactId: w.contacts[contactIndex].id,
    serviceId: o.serviceId ?? w.corte.id,
    professionalId: o.professionalId ?? null,
    date: o.date,
    period: o.period,
    windowStartMin: o.windowStartMin ?? null,
    windowEndMin: o.windowEndMin ?? null,
    source: "BOT",
  });
  return entry;
}

const entryOf = (w: World, id: string) => prisma.waitlistEntry.findUniqueOrThrow({ where: { id } });
const numberOf = (w: World, i: number) => w.contacts[i].waJid.split("@")[0];

describe("entrar na fila", () => {
  it("valida, não duplica a mesma fila e respeita FIFO", async () => {
    const w = await world("fila");
    const day = isoPlus(3);
    const first = await createWaitlistEntry(w.tenant.id, { contactId: w.contacts[0].id, serviceId: w.corte.id, professionalId: null, date: day, source: "BOT" });
    expect(first.alreadyExisted).toBe(false);
    const again = await createWaitlistEntry(w.tenant.id, { contactId: w.contacts[0].id, serviceId: w.corte.id, professionalId: null, date: day, source: "BOT" });
    expect(again.alreadyExisted).toBe(true);
    expect(again.entry.id).toBe(first.entry.id);
    // Outro profissional é outra fila.
    const other = await createWaitlistEntry(w.tenant.id, { contactId: w.contacts[0].id, serviceId: w.corte.id, professionalId: w.ana.id, date: day, source: "PANEL" });
    expect(other.alreadyExisted).toBe(false);

    await expect(createWaitlistEntry(w.tenant.id, { contactId: w.contacts[1].id, serviceId: w.corte.id, professionalId: null, date: isoPlus(-1), source: "BOT" })).rejects.toMatchObject({ code: "RULE_VIOLATION" });
    await expect(createWaitlistEntry(w.tenant.id, { contactId: w.contacts[1].id, serviceId: w.corte.id, professionalId: null, date: isoPlus(90), source: "BOT" })).rejects.toMatchObject({ code: "RULE_VIOLATION" });
    await expect(createWaitlistEntry(w.tenant.id, { contactId: w.contacts[1].id, serviceId: w.barba.id, professionalId: w.ana.id, date: day, source: "BOT" })).rejects.toMatchObject({ code: "RULE_VIOLATION" });
    await expect(createWaitlistEntry(w.tenant.id, { contactId: w.contacts[1].id, serviceId: w.corte.id, professionalId: null, date: day, windowStartMin: 600, windowEndMin: null, source: "BOT" })).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    await expect(createWaitlistEntry(w.tenant.id, { contactId: "nao-existe", serviceId: w.corte.id, professionalId: null, date: day, source: "BOT" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("duas requisições simultâneas da mesma pessoa criam UMA linha (P2002 vira 'já estava')", async () => {
    const w = await world("race");
    const day = isoPlus(4);
    const input = { contactId: w.contacts[0].id, serviceId: w.corte.id, professionalId: null, date: day, source: "BOT" as const };
    const results = await Promise.all([createWaitlistEntry(w.tenant.id, input), createWaitlistEntry(w.tenant.id, input), createWaitlistEntry(w.tenant.id, input)]);
    expect(results.filter((r) => !r.alreadyExisted)).toHaveLength(1);
    expect(await prisma.waitlistEntry.count({ where: { tenantId: w.tenant.id, contactId: w.contacts[0].id } })).toBe(1);
  });

  it("o índice único do banco recusa a fila duplicada mesmo sem a checagem do código", async () => {
    const w = await world("uniq");
    const data = { tenantId: w.tenant.id, contactId: w.contacts[0].id, serviceId: w.corte.id, professionalId: null, desiredDate: new Date(`${isoPlus(5)}T00:00:00.000Z`) };
    await prisma.waitlistEntry.create({ data });
    await prisma.waitlistEntry.create({ data }).then(
      () => {
        throw new Error("devia violar o único");
      },
      (error) => expect(isUniqueViolation(error)).toBe(true),
    );
  });

  it("lista paginada por dia e profissional, e lista do contato", async () => {
    const w = await world("lista");
    const d1 = isoPlus(3);
    const d2 = isoPlus(4);
    await join(w, 0, { date: d2 });
    await join(w, 1, { date: d1, professionalId: w.ana.id });
    await join(w, 2, { date: d1 });
    const all = await listWaitlist(w.tenant.id, { page: 1, pageSize: 25 });
    expect(all.total).toBe(3);
    expect(all.items.map((i) => i.date)).toEqual([d1, d1, d2]);
    const oneDay = await listWaitlist(w.tenant.id, { date: d1, page: 1, pageSize: 10 });
    expect(oneDay.total).toBe(2);
    const bia = await listWaitlist(w.tenant.id, { date: d1, professionalId: w.bia.id, page: 1, pageSize: 10 });
    expect(bia.total).toBe(1); // só "qualquer profissional" atende a Bia; quem pediu a Ana fica de fora
    const paged = await listWaitlist(w.tenant.id, { page: 2, pageSize: 10 });
    expect(paged.items).toHaveLength(0);
    expect(paged.pageCount).toBe(1);
    const mine = await listContactWaitlist(w.tenant.id, w.contacts[1].id);
    expect(mine).toHaveLength(1);
    expect(mine[0].servico).toBe("Corte");
  });
});

describe("horário abriu: oferta ao primeiro compatível", () => {
  it("cancelamento oferece ao primeiro da fila que combina e pula quem não combina", async () => {
    const w = await world("oferta");
    const day = isoPlus(3);
    const appt = await book(w, 6, w.corte.id, w.ana.id, day, "10:00");

    const evening = await join(w, 0, { date: day, period: "EVENING" }); // 1º, mas só quer a noite
    const onlyBia = await join(w, 1, { date: day, professionalId: w.bia.id }); // 2º, quer a Bia
    const barber = await join(w, 2, { date: day, serviceId: w.barba.id }); // 3º, serviço que a Ana não faz
    const morning = await join(w, 3, { date: day, period: "MORNING" }); // 4º, serve
    const anyone = await join(w, 4, { date: day }); // 5º, serve, mas é depois

    await cancelAppointment(w.tenant.id, appt.id, "system");
    await drainWaitlistHook();

    expect((await entryOf(w, morning.id)).status).toBe("OFFERED");
    for (const e of [evening, onlyBia, barber, anyone]) expect((await entryOf(w, e.id)).status).toBe("WAITING");
    const offered = await entryOf(w, morning.id);
    expect(offered.offeredSlotStart?.toISOString()).toBe(at(day, "10:00").toISOString());
    expect(offered.offeredProfessionalId).toBe(w.ana.id);
    expect(offered.offerExpiresAt!.getTime() - offered.offeredAt!.getTime()).toBe(30 * 60_000);

    expect(sent).toHaveLength(1);
    expect(sent[0].number).toBe(numberOf(w, 3));
    expect(sent[0].text).toContain("10:00");
    expect(sent[0].text).toContain("30 minutos");
    expect(sent[0].text).toContain("Ana");
  });

  it("janela fina vale no lugar do período, e a duração tem que caber", async () => {
    const w = await world("janela");
    const day = isoPlus(3);
    // O serviço longo (60 min) só cabe se o horário seguinte também estiver livre.
    const longo = await prisma.service.create({ data: { tenantId: w.tenant.id, name: "Longo", durationMin: 60 } });
    await prisma.professionalService.create({ data: { professionalId: w.ana.id, serviceId: longo.id } });
    const appt = await book(w, 6, w.corte.id, w.ana.id, day, "10:00");
    await book(w, 5, w.corte.id, w.ana.id, day, "10:30"); // o horário seguinte segue ocupado
    await book(w, 4, w.corte.id, w.ana.id, day, "09:30"); // e o anterior também: 60 min não cabe nem às 9:30 nem às 10:00
    const tooLong = await join(w, 0, { date: day, serviceId: longo.id });
    const fine = await join(w, 1, { date: day, period: "MORNING", windowStartMin: 14 * 60, windowEndMin: 16 * 60 }); // janela à tarde vence o período
    const okOne = await join(w, 2, { date: day, windowStartMin: 9 * 60 + 30, windowEndMin: 10 * 60 + 30 });

    await cancelAppointment(w.tenant.id, appt.id, "system");
    await drainWaitlistHook();

    expect((await entryOf(w, tooLong.id)).status).toBe("WAITING");
    expect((await entryOf(w, fine.id)).status).toBe("WAITING");
    expect((await entryOf(w, okOne.id)).status).toBe("OFFERED");
  });

  it("remarcação também abre o horário antigo", async () => {
    const w = await world("remarca");
    const day = isoPlus(3);
    const appt = await book(w, 6, w.corte.id, w.ana.id, day, "11:00");
    const waiting = await join(w, 0, { date: day });
    await rescheduleAppointment(w.tenant.id, appt.id, at(day, "15:00"), "system");
    await drainWaitlistHook();
    const row = await entryOf(w, waiting.id);
    expect(row.status).toBe("OFFERED");
    expect(row.offeredSlotStart?.toISOString()).toBe(at(day, "11:00").toISOString());
  });

  it("pula cliente com bot pausado ou com oferta aberta, e não oferece com WhatsApp fora do ar", async () => {
    const w = await world("pulos");
    const day = isoPlus(3);
    const appt = await book(w, 6, w.corte.id, w.ana.id, day, "10:00");
    await prisma.contact.update({ where: { id: w.contacts[0].id }, data: { botPausedUntil: new Date(Date.now() + 3_600_000) } });
    const paused = await join(w, 0, { date: day });
    const next = await join(w, 1, { date: day });
    await cancelAppointment(w.tenant.id, appt.id, "system");
    await drainWaitlistHook();
    expect((await entryOf(w, paused.id)).status).toBe("WAITING");
    expect((await entryOf(w, next.id)).status).toBe("OFFERED");

    // Falha de envio devolve a pessoa à fila (mantém a posição) e tenta a seguinte.
    const w2 = await world("falha");
    installFakeEvolution({ fail: true });
    const a2 = await book(w2, 6, w2.corte.id, w2.ana.id, day, "10:00");
    const e1 = await join(w2, 0, { date: day });
    const e2 = await join(w2, 1, { date: day });
    await cancelAppointment(w2.tenant.id, a2.id, "system");
    await drainWaitlistHook();
    expect((await entryOf(w2, e1.id)).status).toBe("WAITING");
    expect((await entryOf(w2, e2.id)).status).toBe("WAITING");
    expect((await entryOf(w2, e1.id)).offeredSlotStart).toBeNull();
  });

  it("dois gatilhos juntos para o mesmo horário geram UMA oferta (índice único + troca condicional)", async () => {
    const w = await world("dupla");
    const day = isoPlus(3);
    const appt = await book(w, 6, w.corte.id, w.ana.id, day, "10:00");
    await join(w, 0, { date: day });
    await join(w, 1, { date: day });
    await prisma.appointment.update({ where: { id: appt.id }, data: { status: "CANCELED" } });
    const freed = { professionalId: w.ana.id, from: at(day, "10:00"), to: at(day, "10:30") };
    await Promise.all([offerFreedSlot(w.tenant.id, freed), offerFreedSlot(w.tenant.id, freed)]);
    const offers = await prisma.waitlistEntry.findMany({ where: { tenantId: w.tenant.id, status: "OFFERED" } });
    expect(offers).toHaveLength(1);
    expect(sent.length).toBeLessThanOrEqual(2);
    // O banco recusa o mesmo horário a duas pessoas.
    const other = await prisma.waitlistEntry.findFirstOrThrow({ where: { tenantId: w.tenant.id, status: "WAITING" } });
    await prisma.waitlistEntry
      .update({ where: { id: other.id }, data: { status: "OFFERED", offeredSlotStart: offers[0].offeredSlotStart, offeredProfessionalId: offers[0].offeredProfessionalId, offeredAt: new Date(), offerExpiresAt: new Date(Date.now() + 60_000) } })
      .then(
        () => {
          throw new Error("devia violar o único");
        },
        (error) => expect(isUniqueViolation(error)).toBe(true),
      );
  });
});

describe("resposta do cliente", () => {
  async function offered(label: string) {
    const w = await world(label);
    const day = isoPlus(3);
    const appt = await book(w, 6, w.corte.id, w.ana.id, day, "10:00");
    const first = await join(w, 0, { date: day });
    const second = await join(w, 1, { date: day });
    await cancelAppointment(w.tenant.id, appt.id, "system");
    await drainWaitlistHook();
    expect((await entryOf(w, first.id)).status).toBe("OFFERED");
    return { w, day, first, second };
  }

  it("SIM marca o horário e é idempotente; só o dono da oferta responde", async () => {
    const { w, day, first } = await offered("sim");
    await expect(acceptWaitlistOffer(w.tenant.id, { entryId: first.id, contactId: w.contacts[2].id })).rejects.toMatchObject({ code: "OFFER_GONE" });
    const done = await acceptWaitlistOffer(w.tenant.id, { entryId: first.id, contactId: w.contacts[0].id, whatsappInstanceId: w.instance.id });
    expect(done.alreadyExisted).toBe(false);
    expect(done.appointment.summary.hora).toBe("10:00");
    const row = await entryOf(w, first.id);
    expect(row.status).toBe("FULFILLED");
    expect(row.appointmentId).toBe(done.appointment.id);
    const appt = await prisma.appointment.findUniqueOrThrow({ where: { id: row.appointmentId! } });
    expect(appt.contactId).toBe(w.contacts[0].id);
    expect(appt.startsAt.toISOString()).toBe(at(day, "10:00").toISOString());
    expect(appt.source).toBe("WHATSAPP");
    const repeat = await acceptWaitlistOffer(w.tenant.id, { entryId: first.id, contactId: w.contacts[0].id });
    expect(repeat.alreadyExisted).toBe(true);
    expect(await prisma.appointment.count({ where: { tenantId: w.tenant.id, status: "SCHEDULED", startsAt: at(day, "10:00") } })).toBe(1);
  });

  it("dois SIM simultâneos criam UM agendamento", async () => {
    const { w, day, first } = await offered("simsim");
    const results = await Promise.allSettled([
      acceptWaitlistOffer(w.tenant.id, { entryId: first.id, contactId: w.contacts[0].id }),
      acceptWaitlistOffer(w.tenant.id, { entryId: first.id, contactId: w.contacts[0].id }),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(await prisma.appointment.count({ where: { tenantId: w.tenant.id, status: "SCHEDULED", startsAt: at(day, "10:00") } })).toBe(1);
    expect((await entryOf(w, first.id)).status).toBe("FULFILLED");
  });

  it("horário ocupado por outro canal durante o prazo: SLOT_TAKEN e a pessoa continua na fila", async () => {
    const { w, day, first } = await offered("ocupado");
    await book(w, 5, w.corte.id, w.ana.id, day, "10:00"); // painel/bot/outro cliente pegou
    const error = await acceptWaitlistOffer(w.tenant.id, { entryId: first.id, contactId: w.contacts[0].id }).catch((e) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe("SLOT_TAKEN");
    expect(error.details).toMatchObject({ servico: "Corte" });
    const row = await entryOf(w, first.id);
    expect(row.status).toBe("WAITING");
    expect(row.offeredSlotStart).toBeNull();
    expect(row.appointmentId).toBeNull();
  });

  it("NÃO sai da fila e passa o horário ao próximo", async () => {
    const { w, first, second } = await offered("nao");
    sent.length = 0;
    const result = await declineWaitlistOffer(w.tenant.id, { entryId: first.id, contactId: w.contacts[0].id });
    expect(result.declined).toBe(true);
    await drainWaitlistTriggers();
    expect((await entryOf(w, first.id)).status).toBe("CANCELED");
    expect((await entryOf(w, second.id)).status).toBe("OFFERED");
    expect(sent).toHaveLength(1);
    expect(sent[0].number).toBe(numberOf(w, 1));
    expect((await declineWaitlistOffer(w.tenant.id, { entryId: first.id, contactId: w.contacts[0].id })).declined).toBe(false); // idempotente
  });

  it("oferta vencida: o tick dá baixa e passa ao próximo; responder atrasado leva OFFER_GONE", async () => {
    const { w, first, second } = await offered("vence");
    sent.length = 0;
    await prisma.waitlistEntry.update({ where: { id: first.id }, data: { offerExpiresAt: new Date(Date.now() - 60_000) } });
    const summary = await runWaitlistTick(new Date());
    expect(summary.offersExpired).toBeGreaterThanOrEqual(1);
    await drainWaitlistTriggers();
    expect((await entryOf(w, first.id)).status).toBe("EXPIRED");
    expect((await entryOf(w, second.id)).status).toBe("OFFERED");
    expect(sent).toHaveLength(1);
    await expect(acceptWaitlistOffer(w.tenant.id, { entryId: first.id, contactId: w.contacts[0].id })).rejects.toMatchObject({ code: "OFFER_GONE" });
    // Rodar o tick de novo não faz nada de novo.
    const again = await runWaitlistTick(new Date());
    expect(again.offersExpired).toBe(0);
  });

  it("aceite em cima do prazo vencido (tick ainda não rodou) é recusado e já passa ao próximo", async () => {
    const { w, first, second } = await offered("atrasado");
    await prisma.waitlistEntry.update({ where: { id: first.id }, data: { offerExpiresAt: new Date(Date.now() - 1_000) } });
    await expect(acceptWaitlistOffer(w.tenant.id, { entryId: first.id, contactId: w.contacts[0].id })).rejects.toMatchObject({ code: "OFFER_GONE" });
    await drainWaitlistTriggers();
    expect((await entryOf(w, first.id)).status).toBe("EXPIRED");
    expect((await entryOf(w, second.id)).status).toBe("OFFERED");
  });

  it("remover quem tem oferta aberta passa o horário ao próximo", async () => {
    const { w, first, second } = await offered("remove");
    const result = await removeWaitlistEntry(w.tenant.id, first.id);
    expect(result.removed).toBe(true);
    await drainWaitlistTriggers();
    expect((await entryOf(w, first.id)).status).toBe("CANCELED");
    expect((await entryOf(w, second.id)).status).toBe("OFFERED");
    expect((await removeWaitlistEntry(w.tenant.id, first.id)).removed).toBe(false);
  });

  it("ACCEPTED preso (queda no meio do aceite) é resolvido pelo tick", async () => {
    const w = await world("preso");
    const day = isoPlus(3);
    const stuck = await join(w, 0, { date: day });
    await prisma.waitlistEntry.update({ where: { id: stuck.id }, data: { status: "ACCEPTED", updatedAt: new Date(Date.now() - 3_600_000) } });
    // updatedAt é @updatedAt: força o valor antigo por SQL.
    await prisma.$executeRaw`UPDATE "waitlist_entries" SET "updatedAt" = now() - interval '1 hour' WHERE "id" = ${stuck.id}`;
    await runWaitlistTick(new Date());
    expect((await entryOf(w, stuck.id)).status).toBe("WAITING");
  });

  it("dia que já passou sai da fila no tick", async () => {
    const w = await world("passado");
    const old = await prisma.waitlistEntry.create({
      data: { tenantId: w.tenant.id, contactId: w.contacts[0].id, serviceId: w.corte.id, desiredDate: new Date(Date.now() - 5 * 86_400_000) },
    });
    const summary = await runWaitlistTick(new Date());
    expect(summary.pastEntriesExpired).toBeGreaterThanOrEqual(1);
    expect((await entryOf(w, old.id)).status).toBe("EXPIRED");
  });
});

describe("oferecer encaixe manual", () => {
  it("oferece o primeiro horário livre que cabe no pedido, e avisa quando não há", async () => {
    const w = await world("manual");
    const day = isoPlus(3);
    const afternoon = await join(w, 0, { date: day, period: "AFTERNOON" });
    const result = await offerEntryManually(w.tenant.id, afternoon.id);
    expect(result.slotStart.toISOString()).toBe(at(day, "12:00").toISOString());
    expect((await entryOf(w, afternoon.id)).status).toBe("OFFERED");
    expect(sent).toHaveLength(1);
    await expect(offerEntryManually(w.tenant.id, afternoon.id)).rejects.toMatchObject({ code: "INVALID_STATE" });

    const night = await join(w, 1, { date: day, windowStartMin: 3 * 60, windowEndMin: 4 * 60 }); // ninguém trabalha às 3h
    await expect(offerEntryManually(w.tenant.id, night.id)).rejects.toMatchObject({ code: "NO_SLOT" });
    expect((await entryOf(w, night.id)).status).toBe("WAITING");
  });

  it("sem WhatsApp conectado a oferta não fica pendurada", async () => {
    const w = await world("semzap");
    await prisma.whatsappInstance.update({ where: { id: w.instance.id }, data: { status: "DISCONNECTED" } });
    const day = isoPlus(3);
    const entry = await join(w, 0, { date: day });
    await expect(offerEntryManually(w.tenant.id, entry.id)).rejects.toMatchObject({ code: "NO_WHATSAPP" });
    const row = await entryOf(w, entry.id);
    expect(row.status).toBe("WAITING");
    expect(row.offeredSlotStart).toBeNull();
  });
});

describe("claim v2 com oferta pendente", () => {
  function payload(instance: string, jid: string, text: string) {
    return {
      event: "messages.upsert",
      instance,
      data: { key: { remoteJid: jid, fromMe: false, id: `m-${randomUUID()}` }, pushName: "Cliente", message: { conversation: text }, messageType: "conversation", messageTimestamp: Math.floor(Date.now() / 1000) },
    };
  }

  it("a próxima mensagem de quem recebeu a oferta cai em WAITLIST_OFFER, com as opções 1 e 2", async () => {
    const w = await world("claim");
    const day = isoPlus(3);
    const appt = await book(w, 6, w.corte.id, w.ana.id, day, "10:00");
    const entry = await join(w, 0, { date: day });
    // Sessão antiga no meio de outro passo: a oferta vale mesmo assim.
    await prisma.chatSession.create({
      data: { whatsappInstanceId: w.instance.id, contactId: w.contacts[0].id, state: "SELECT_TIME", context: { v: 2, serviceId: w.corte.id }, lastInboundAt: new Date(Date.now() - 5 * 3_600_000) },
    });
    await cancelAppointment(w.tenant.id, appt.id, "system");
    await drainWaitlistHook();
    expect((await entryOf(w, entry.id)).status).toBe("OFFERED");

    const result = await claimMessage(w.ctx, payload(w.instance.instanceName, w.contacts[0].waJid, "sim"), { flow: 2 });
    if (result.action !== "process" || !("flow" in result)) throw new Error("esperava process v2");
    expect(result.session.state).toBe("WAITLIST_OFFER");
    expect(result.session.expired).toBe(false);
    const context = result.session.context as { waitlistEntryId: string; options: { id: string }[]; lastTextKey: string };
    expect(context.waitlistEntryId).toBe(entry.id);
    expect(context.options.map((o) => o.id)).toEqual(["ACCEPT", "DECLINE"]);
    expect(context.lastTextKey).toBe("WAITLIST_OFFER");
    expect(result.contact.waitlistCount).toBe(1);

    // Depois da primeira resposta o fluxo segue a sessão normal (a oferta não "prende" o cliente).
    await prisma.chatSession.updateMany({ where: { whatsappInstanceId: w.instance.id, contactId: w.contacts[0].id }, data: { lockToken: null, lockedUntil: null, state: "MAIN_MENU", context: { v: 2 } } });
    const second = await claimMessage(w.ctx, payload(w.instance.instanceName, w.contacts[0].waJid, "menu"), { flow: 2 });
    if (second.action !== "process") throw new Error("esperava process");
    expect(second.session.state).toBe("MAIN_MENU");
  });

  it("'sim' atrasado (oferta já vencida) ainda cai em WAITLIST_OFFER; conversa comum depois do prazo não", async () => {
    const w = await world("claimlate");
    const day = isoPlus(3);
    const appt = await book(w, 6, w.corte.id, w.ana.id, day, "10:00");
    const entry = await join(w, 0, { date: day });
    await cancelAppointment(w.tenant.id, appt.id, "system");
    await drainWaitlistHook();
    await prisma.waitlistEntry.update({ where: { id: entry.id }, data: { offerExpiresAt: new Date(Date.now() - 60_000) } });
    await runWaitlistTick(new Date());
    await drainWaitlistTriggers();
    expect((await entryOf(w, entry.id)).status).toBe("EXPIRED");

    const oi = await claimMessage(w.ctx, payload(w.instance.instanceName, w.contacts[0].waJid, "oi"), { flow: 2 });
    if (oi.action !== "process") throw new Error("esperava process");
    expect(oi.session.state).not.toBe("WAITLIST_OFFER");
    await prisma.chatSession.updateMany({ where: { whatsappInstanceId: w.instance.id, contactId: w.contacts[0].id }, data: { lockToken: null, lockedUntil: null, lastInboundAt: new Date(Date.now() - 3_600_000) } });

    const late = await claimMessage(w.ctx, payload(w.instance.instanceName, w.contacts[0].waJid, "Sim!"), { flow: 2 });
    if (late.action !== "process") throw new Error("esperava process");
    expect(late.session.state).toBe("WAITLIST_OFFER");
    expect((late.session.context as { waitlistEntryId: string }).waitlistEntryId).toBe(entry.id);
    await expect(acceptWaitlistOffer(w.tenant.id, { entryId: entry.id, contactId: w.contacts[0].id })).rejects.toMatchObject({ code: "OFFER_GONE" });
  });

  it("o fluxo v1 não é afetado (o estado novo é só do v2)", async () => {
    const w = await world("claimv1");
    const day = isoPlus(3);
    const appt = await book(w, 6, w.corte.id, w.ana.id, day, "10:00");
    await join(w, 0, { date: day });
    await cancelAppointment(w.tenant.id, appt.id, "system");
    await drainWaitlistHook();
    const result = await claimMessage(w.ctx, payload(w.instance.instanceName, w.contacts[0].waJid, "oi"));
    if (result.action !== "process") throw new Error("esperava process");
    expect(result.session.state).not.toBe("WAITLIST_OFFER");
  });
});

describe("rotas da API interna", () => {
  async function headers(w: World) {
    await prisma.platformSettings.upsert({
      where: { id: 1 },
      create: { id: 1, internalApiSecretHash: hashInternalApiSecret(SECRET) },
      update: { internalApiSecretHash: hashInternalApiSecret(SECRET) },
    });
    return { authorization: `Bearer ${SECRET}`, "x-innochat-instance": w.instance.webhookToken, "x-innochat-flow": "2", "content-type": "application/json" };
  }
  const req = (url: string, h: Record<string, string>, body?: unknown, method = "POST") => new Request(`http://localhost${url}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });

  it("entrar (201/200), listar, SIM (200), SIM repetido (200 idempotente), sair e erros estruturados", async () => {
    const w = await world("rotas");
    const h = await headers(w);
    const day = isoPlus(3);
    const body = { contactId: w.contacts[0].id, serviceId: w.corte.id, professionalId: "any", date: day, period: "morning" };
    const created = await postJoin(req("/api/internal/v1/waitlist", h, body));
    expect(created.status).toBe(201);
    const createdBody = await created.json();
    expect(createdBody.entry).toMatchObject({ servico: "Corte", alreadyExisted: false, dateISO: day });
    const repeated = await postJoin(req("/api/internal/v1/waitlist", h, body));
    expect(repeated.status).toBe(200);
    expect((await repeated.json()).entry.alreadyExisted).toBe(true);

    const invalid = await postJoin(req("/api/internal/v1/waitlist", h, { ...body, date: "amanhã" }));
    expect(invalid.status).toBe(422);
    expect((await invalid.json()).error.code).toBe("INVALID_PAYLOAD");
    const unauth = await postJoin(req("/api/internal/v1/waitlist", { ...h, authorization: "Bearer errado" }, body));
    expect(unauth.status).toBe(401);

    const listed = await getContactWaitlist(req(`/api/internal/v1/contacts/${w.contacts[0].id}/waitlist`, h, undefined, "GET"), { params: Promise.resolve({ contactId: w.contacts[0].id }) });
    const listedBody = await listed.json();
    expect(listedBody.options).toHaveLength(1);
    const entryId = createdBody.entry.id as string;

    // Responder sem oferta aberta: 409 OFFER_GONE.
    const gone = await postRespond(req(`/api/internal/v1/waitlist/${entryId}/respond`, h, { contactId: w.contacts[0].id, accept: true }), { params: Promise.resolve({ id: entryId }) });
    expect(gone.status).toBe(409);
    expect((await gone.json()).error.code).toBe("OFFER_GONE");

    // Abre um horário, oferece e aceita pela rota.
    const appt = await book(w, 6, w.corte.id, w.ana.id, day, "09:00");
    await cancelAppointment(w.tenant.id, appt.id, "system");
    await drainWaitlistHook();
    expect((await entryOf(w, entryId)).status).toBe("OFFERED");
    const ok = await postRespond(req(`/api/internal/v1/waitlist/${entryId}/respond`, h, { contactId: w.contacts[0].id, accept: true }), { params: Promise.resolve({ id: entryId }) });
    expect(ok.status).toBe(200);
    const okBody = await ok.json();
    expect(okBody).toMatchObject({ accepted: true, appointment: { summary: { servico: "Corte", hora: "09:00" } } });
    const okAgain = await postRespond(req(`/api/internal/v1/waitlist/${entryId}/respond`, h, { contactId: w.contacts[0].id, accept: true }), { params: Promise.resolve({ id: entryId }) });
    expect(okAgain.status).toBe(200);
    expect((await okAgain.json()).alreadyExisted).toBe(true);

    // Sair da fila: 200 e depois 200 com left=false.
    const other = await postJoin(req("/api/internal/v1/waitlist", h, { ...body, contactId: w.contacts[1].id }));
    const otherId = (await other.json()).entry.id as string;
    const left = await postLeave(req(`/api/internal/v1/waitlist/${otherId}/leave`, h, { contactId: w.contacts[1].id }), { params: Promise.resolve({ id: otherId }) });
    expect(left.status).toBe(200);
    expect(await left.json()).toMatchObject({ left: true, servico: "Corte" });
    const wrongOwner = await postLeave(req(`/api/internal/v1/waitlist/${otherId}/leave`, h, { contactId: w.contacts[2].id }), { params: Promise.resolve({ id: otherId }) });
    expect(wrongOwner.status).toBe(404);
  });

  it("tick exige o segredo interno e responde o resumo", async () => {
    const w = await world("tickrota");
    const h = await headers(w);
    const denied = await postTick(new Request("http://localhost/api/internal/v1/waitlist/tick", { method: "POST" }));
    expect(denied.status).toBe(401);
    const res = await postTick(new Request("http://localhost/api/internal/v1/waitlist/tick", { method: "POST", headers: { authorization: h.authorization } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ offersExpired: expect.any(Number), acceptedRecovered: expect.any(Number), pastEntriesExpired: expect.any(Number) });
  });
});
