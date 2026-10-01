/**
 * Central de notificações (docs/contratos.md — "Notificações") contra Postgres real: cada kind,
 * leitura (uma / todas), isolamento entre empresas, poll com `since`, upcoming e timeline.
 * Usa os services direto (as actions só acrescentam Zod + requireTenantMember).
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import type { TenantContext } from "@/lib/auth/guards";
import {
  getAppointmentTimeline,
  getUpcomingAppointments,
  listNotifications,
  markNotificationsRead,
  pollNotifications,
} from "@/modules/notifications/service";
import { applyConnectionEvent } from "@/modules/bot-api/connection-events";
import { maintenanceTickForTest } from "./notifications.helpers";

const prisma = getPrisma();
const tenantIds: string[] = [];
const userIds: string[] = [];
const planIds: string[] = [];

const MIN = 60_000;
const HOUR = 60 * MIN;

async function makeWorld(label: string, role: "OWNER" | "STAFF" = "OWNER") {
  const tenant = await prisma.tenant.create({
    data: { slug: `it-ntf-${label}-${randomUUID().slice(0, 8)}`, name: `Ntf ${label}`, timezone: "America/Sao_Paulo" },
  });
  tenantIds.push(tenant.id);
  const user = await prisma.user.create({ data: { email: `it-ntf-${label}-${randomUUID().slice(0, 6)}@example.test`, passwordHash: "x" } });
  userIds.push(user.id);
  const membership = await prisma.membership.create({ data: { userId: user.id, tenantId: tenant.id, role } });
  const service = await prisma.service.create({ data: { tenantId: tenant.id, name: "Corte", durationMin: 30 } });
  const professional = await prisma.professional.create({ data: { tenantId: tenant.id, name: "Ana" } });
  const contact = await prisma.contact.create({
    data: { tenantId: tenant.id, waJid: `5511${Math.floor(Math.random() * 1e9)}@s.whatsapp.net`, phoneE164: "+5511987654321", name: "Maria" },
  });
  const ctx: TenantContext = {
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, timezone: tenant.timezone },
    membership: { id: membership.id, role },
    user: { id: user.id },
  };
  return { tenant, user, membership, service, professional, contact, ctx };
}

type World = Awaited<ReturnType<typeof makeWorld>>;

async function makeAppointment(w: World, startsAt: Date, source: "WHATSAPP" | "PANEL" = "WHATSAPP") {
  // Um profissional por agendamento: o EXCLUDE de sobreposição impede dois no mesmo horário/profissional.
  const professional = await prisma.professional.create({ data: { tenantId: w.tenant.id, name: "Ana" } });
  return prisma.appointment.create({
    data: {
      tenantId: w.tenant.id,
      contactId: w.contact.id,
      serviceId: w.service.id,
      professionalId: professional.id,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * MIN),
      blockEndsAt: new Date(startsAt.getTime() + 30 * MIN),
      source,
    },
  });
}

async function makeEvent(
  appointmentId: string,
  action: "CREATED" | "CANCELED" | "RESCHEDULED" | "COMPLETED" | "NO_SHOW",
  authorType: "CONTACT" | "USER" | "SYSTEM",
  extra: { createdAt?: Date; authorId?: string; note?: string } = {},
) {
  return prisma.appointmentEvent.create({ data: { appointmentId, action, authorType, ...extra } });
}

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.plan.deleteMany({ where: { id: { in: planIds } } });
  await prisma.$disconnect();
});

describe("notificações — eventos de agendamento", () => {
  it("trigger preenche AppointmentEvent.tenantId sem a aplicação informar", async () => {
    const w = await makeWorld("trigger");
    const appt = await makeAppointment(w, new Date(Date.now() + 5 * 24 * HOUR));
    const ev = await makeEvent(appt.id, "CREATED", "CONTACT");
    const row = await prisma.appointmentEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect(row.tenantId).toBe(w.tenant.id);
  });

  it("cada kind: título com origem, corpo 'Maria • Corte • com Ana • data', href da agenda, sem telefone", async () => {
    const w = await makeWorld("kinds");
    // 2026-10-15T17:00Z = qui 15/10 14:00 em São Paulo
    const appt = await makeAppointment(w, new Date("2026-10-15T17:00:00Z"), "WHATSAPP");
    const t0 = Date.now();
    await makeEvent(appt.id, "CREATED", "CONTACT", { createdAt: new Date(t0 - 6 * MIN) });
    await makeEvent(appt.id, "RESCHEDULED", "USER", { createdAt: new Date(t0 - 5 * MIN), authorId: w.user.id });
    await makeEvent(appt.id, "CANCELED", "CONTACT", { createdAt: new Date(t0 - 4 * MIN) });
    await makeEvent(appt.id, "COMPLETED", "USER", { createdAt: new Date(t0 - 3 * MIN) });
    await makeEvent(appt.id, "NO_SHOW", "SYSTEM", { createdAt: new Date(t0 - 2 * MIN) });

    const { items, unreadCount, nextCursor } = await listNotifications(w.ctx);
    expect(nextCursor).toBeNull();
    expect(unreadCount).toBe(5);
    const byKind = Object.fromEntries(items.map((i) => [i.kind, i]));
    expect(Object.keys(byKind).sort()).toEqual(
      ["APPOINTMENT_CANCELED", "APPOINTMENT_COMPLETED", "APPOINTMENT_CREATED", "APPOINTMENT_NO_SHOW", "APPOINTMENT_RESCHEDULED"].sort(),
    );
    expect(byKind.APPOINTMENT_CREATED.title).toBe("Novo agendamento pelo WhatsApp");
    expect(byKind.APPOINTMENT_CREATED.source).toBe("WHATSAPP");
    expect(byKind.APPOINTMENT_CREATED.body).toBe("Maria • Corte • com Ana • qui 15/10 às 14:00");
    expect(byKind.APPOINTMENT_CREATED.href).toBe(`/${w.tenant.slug}/agenda?data=2026-10-15`);
    expect(byKind.APPOINTMENT_CREATED.appointment).toMatchObject({ id: appt.id, contactName: "Maria", serviceName: "Corte", professionalName: "Ana" });
    expect(byKind.APPOINTMENT_RESCHEDULED.title).toBe("Agendamento remarcado pelo painel");
    expect(byKind.APPOINTMENT_RESCHEDULED.byMe).toBe(true);
    expect(byKind.APPOINTMENT_CANCELED.title).toBe("Agendamento cancelado pelo WhatsApp");
    expect(byKind.APPOINTMENT_COMPLETED.severity).toBe("success");
    expect(byKind.APPOINTMENT_NO_SHOW.source).toBe("SYSTEM");
    // mais recentes primeiro
    expect(items.map((i) => i.kind)[0]).toBe("APPOINTMENT_NO_SHOW");
    // nunca o telefone
    expect(JSON.stringify(items)).not.toContain("987654321");
    expect(JSON.stringify(items)).not.toContain("5511");
  });

  it("agendamento criado pelo painel diz 'pelo painel'", async () => {
    const w = await makeWorld("painel");
    const appt = await makeAppointment(w, new Date(Date.now() + 3 * 24 * HOUR), "PANEL");
    await makeEvent(appt.id, "CREATED", "USER", { authorId: w.user.id });
    const { items } = await listNotifications(w.ctx);
    expect(items[0].title).toBe("Novo agendamento pelo painel");
    expect(items[0].source).toBe("PANEL");
  });

  it("janela de 30 dias e paginação de 20 com cursor", async () => {
    const w = await makeWorld("pag");
    const appt = await makeAppointment(w, new Date(Date.now() + 9 * 24 * HOUR));
    const now = Date.now();
    await makeEvent(appt.id, "CREATED", "CONTACT", { createdAt: new Date(now - 31 * 24 * HOUR) }); // fora da janela
    for (let i = 1; i <= 25; i++) {
      await makeEvent(appt.id, "RESCHEDULED", "CONTACT", { createdAt: new Date(now - i * MIN) });
    }
    const p1 = await listNotifications(w.ctx);
    expect(p1.items).toHaveLength(20);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = await listNotifications(w.ctx, p1.nextCursor!);
    expect(p2.items).toHaveLength(5);
    expect(p2.nextCursor).toBeNull();
    const ids = new Set([...p1.items, ...p2.items].map((i) => i.id));
    expect(ids.size).toBe(25);
    expect(p1.unreadCount).toBe(25);
    await expect(listNotifications(w.ctx, "lixo")).rejects.toMatchObject({ code: "INVALID_CURSOR" });
  });
});

describe("notificações — leitura por usuário", () => {
  it("marcar uma, marcar todas, e estado por usuário (outro membro não é afetado)", async () => {
    const w = await makeWorld("read");
    const otherUser = await prisma.user.create({ data: { email: `it-ntf-o-${randomUUID().slice(0, 6)}@example.test`, passwordHash: "x" } });
    userIds.push(otherUser.id);
    const otherMembership = await prisma.membership.create({ data: { userId: otherUser.id, tenantId: w.tenant.id, role: "STAFF" } });
    const otherCtx: TenantContext = { ...w.ctx, membership: { id: otherMembership.id, role: "STAFF" }, user: { id: otherUser.id } };

    const appt = await makeAppointment(w, new Date(Date.now() + 4 * 24 * HOUR));
    const e1 = await makeEvent(appt.id, "CREATED", "CONTACT", { createdAt: new Date(Date.now() - 3 * MIN) });
    const e2 = await makeEvent(appt.id, "CANCELED", "CONTACT", { createdAt: new Date(Date.now() - 2 * MIN) });

    expect((await listNotifications(w.ctx)).unreadCount).toBe(2);

    const one = await markNotificationsRead(w.ctx, { ids: [`ev:${e1.id}`] });
    expect(one.unreadCount).toBe(1);
    const afterOne = await listNotifications(w.ctx);
    expect(afterOne.items.find((i) => i.id === `ev:${e1.id}`)?.read).toBe(true);
    expect(afterOne.items.find((i) => i.id === `ev:${e2.id}`)?.read).toBe(false);
    // idempotente
    expect((await markNotificationsRead(w.ctx, { ids: [`ev:${e1.id}`] })).unreadCount).toBe(1);
    // o outro membro continua com 2
    expect((await listNotifications(otherCtx)).unreadCount).toBe(2);

    const all = await markNotificationsRead(w.ctx, { all: true });
    expect(all.unreadCount).toBe(0);
    expect((await listNotifications(w.ctx)).items.every((i) => i.read)).toBe(true);
    expect((await listNotifications(otherCtx)).unreadCount).toBe(2);

    // nova notificação depois de "marcar todas" volta a contar
    const e3 = await makeEvent(appt.id, "RESCHEDULED", "CONTACT");
    const again = await listNotifications(w.ctx);
    expect(again.unreadCount).toBe(1);
    expect(again.items[0].id).toBe(`ev:${e3.id}`);
    expect(again.items[0].read).toBe(false);
  });

  it("valida entrada: sem ids/all e id malformado", async () => {
    const w = await makeWorld("val");
    await expect(markNotificationsRead(w.ctx, {})).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    await expect(markNotificationsRead(w.ctx, { ids: ["bobagem"] })).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
  });
});

describe("notificações — isolamento entre empresas", () => {
  it("eventos, upcoming e timeline de outra empresa não aparecem", async () => {
    const a = await makeWorld("isoA");
    const b = await makeWorld("isoB");
    const apptB = await makeAppointment(b, new Date(Date.now() + 20 * MIN));
    await makeEvent(apptB.id, "CREATED", "CONTACT");

    expect((await listNotifications(a.ctx)).items).toHaveLength(0);
    expect((await pollNotifications(a.ctx, new Date(Date.now() - HOUR))).fresh).toHaveLength(0);
    expect((await getUpcomingAppointments(a.ctx)).items).toHaveLength(0);
    await expect(getAppointmentTimeline(a.ctx, apptB.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await listNotifications(b.ctx)).items.length).toBeGreaterThan(0);
  });
});

describe("notificações — poll", () => {
  it("fresh = só depois de since, no máximo 10; unreadCount é o total", async () => {
    const w = await makeWorld("poll");
    const appt = await makeAppointment(w, new Date(Date.now() + 6 * 24 * HOUR));
    const now = Date.now();
    await makeEvent(appt.id, "CREATED", "CONTACT", { createdAt: new Date(now - 10 * MIN) }); // antes do since
    const since = new Date(now - 5 * MIN);
    for (let i = 1; i <= 12; i++) {
      await makeEvent(appt.id, "RESCHEDULED", "CONTACT", { createdAt: new Date(now - 4 * MIN + i * 1000) });
    }
    const r = await pollNotifications(w.ctx, since);
    expect(r.fresh).toHaveLength(10);
    expect(r.fresh.every((f) => new Date(f.createdAt) > since)).toBe(true);
    expect(r.unreadCount).toBe(13);
    // ordenado do mais novo para o mais antigo
    const times = r.fresh.map((f) => f.createdAt);
    expect([...times].sort().reverse()).toEqual(times);

    const none = await pollNotifications(w.ctx, new Date());
    expect(none.fresh).toHaveLength(0);
    expect(none.unreadCount).toBe(13);
  });
});

describe("notificações — lembrete de atendimento próximo (derivado)", () => {
  it("só SCHEDULED que começa em até 60 min; id estável e 'lido' persiste", async () => {
    const w = await makeWorld("upc");
    const soon = await makeAppointment(w, new Date(Date.now() + 25 * MIN));
    await makeAppointment(w, new Date(Date.now() + 90 * MIN)); // longe demais
    const canceled = await makeAppointment(w, new Date(Date.now() + 10 * MIN));
    await prisma.appointment.update({ where: { id: canceled.id }, data: { status: "CANCELED" } });

    const list = await listNotifications(w.ctx);
    const upcoming = list.items.filter((i) => i.kind === "APPOINTMENT_UPCOMING");
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0].id.startsWith(`upcoming:${soon.id}:`)).toBe(true);
    expect(upcoming[0].title).toMatch(/^Atendimento começa em \d+ min$/);
    expect(upcoming[0].source).toBe("SYSTEM");
    expect(new Date(upcoming[0].createdAt).getTime()).toBeLessThanOrEqual(Date.now());
    expect(list.unreadCount).toBe(1);

    await markNotificationsRead(w.ctx, { ids: [upcoming[0].id] });
    const after = await listNotifications(w.ctx);
    expect(after.items.find((i) => i.kind === "APPOINTMENT_UPCOMING")?.read).toBe(true);
    expect(after.unreadCount).toBe(0);
  });

  it("getUpcomingAppointments: próximos de hoje a partir de agora, só SCHEDULED, no máximo 5, com minutesUntil", async () => {
    const w = await makeWorld("upcact");
    // Horários curtos à frente: sempre "hoje" salvo virada de dia (evita flake escolhendo dentro de 1h só se não cruzar meia-noite local).
    const base = Date.now();
    for (let i = 1; i <= 7; i++) await makeAppointment(w, new Date(base + i * 2 * MIN));
    const past = await makeAppointment(w, new Date(base - 30 * MIN));
    void past;
    const canceled = await makeAppointment(w, new Date(base + 1 * MIN));
    await prisma.appointment.update({ where: { id: canceled.id }, data: { status: "CANCELED" } });

    const { items } = await getUpcomingAppointments(w.ctx);
    // Se o teste rodar colado na meia-noite local, alguns cairiam em "amanhã": aceita 0..5 mas valida a ordem/forma.
    expect(items.length).toBeLessThanOrEqual(5);
    for (const it of items) {
      expect(it.status).toBe("SCHEDULED");
      expect(it.contactName).toBe("Maria");
      expect(it.minutesUntil).toBeGreaterThanOrEqual(0);
    }
    const starts = items.map((i) => i.startsAt);
    expect([...starts].sort()).toEqual(starts);
    expect(items.some((i) => i.id === canceled.id)).toBe(false);
  });
});

describe("notificações — alertas do sistema", () => {
  it("WHATSAPP_DISCONNECTED: só instância que caiu (disconnectedAt), some ao reconectar; sandbox e removida não contam", async () => {
    const w = await makeWorld("wa");
    const down = await prisma.whatsappInstance.create({
      data: { tenantId: w.tenant.id, instanceName: `it-ntf-${randomUUID()}`, label: "Recepção", status: "DISCONNECTED", webhookToken: randomUUID(), disconnectedAt: new Date(Date.now() - 2 * MIN) },
    });
    await prisma.whatsappInstance.create({
      data: { tenantId: w.tenant.id, instanceName: `it-ntf-${randomUUID()}`, label: "Nunca conectou", status: "DISCONNECTED", webhookToken: randomUUID() },
    });
    await prisma.whatsappInstance.create({
      data: { tenantId: w.tenant.id, instanceName: `it-ntf-${randomUUID()}`, label: "Sandbox", status: "DISCONNECTED", sandbox: true, webhookToken: randomUUID(), disconnectedAt: new Date() },
    });

    const list = await listNotifications(w.ctx);
    const wa = list.items.filter((i) => i.kind === "WHATSAPP_DISCONNECTED");
    expect(wa).toHaveLength(1);
    expect(wa[0].severity).toBe("danger");
    expect(wa[0].body).toContain("Recepção");
    expect(wa[0].href).toBe(`/${w.tenant.slug}/whatsapp`);

    // aparece no poll como fresh
    expect((await pollNotifications(w.ctx, new Date(Date.now() - 10 * MIN))).fresh.some((f) => f.kind === "WHATSAPP_DISCONNECTED")).toBe(true);

    await prisma.whatsappInstance.update({ where: { id: down.id }, data: { status: "CONNECTED", disconnectedAt: null } });
    expect((await listNotifications(w.ctx)).items.filter((i) => i.kind === "WHATSAPP_DISCONNECTED")).toHaveLength(0);
  });

  it("TRIAL_ENDING (véspera e dia do fim, derivado da régua) e PAYMENT_CONFIRMED (fatura paga) — só para o OWNER", async () => {
    const owner = await makeWorld("bill", "OWNER");
    const plan = await prisma.plan.create({
      data: { code: `it-ntf-${randomUUID().slice(0, 8)}`, name: "Plano IT", priceCents: 4990, maxWhatsappNumbers: 1, maxProfessionals: 1, active: false, sortOrder: 999 },
    });
    planIds.push(plan.id);
    const trialEndsAt = new Date(Date.now() + 10 * HOUR);
    const sub = await prisma.subscription.create({
      data: { tenantId: owner.tenant.id, planId: plan.id, status: "TRIALING", trialEndsAt, currentPeriodEnd: trialEndsAt },
    });
    const invoice = await prisma.invoice.create({
      data: {
        subscriptionId: sub.id,
        amountCents: 4990,
        periodStart: new Date(),
        periodEnd: trialEndsAt,
        dueAt: trialEndsAt,
        status: "PAID",
        paidAt: new Date(Date.now() - 1 * MIN),
      },
    });

    const list = await listNotifications(owner.ctx);
    const trial = list.items.find((i) => i.kind === "TRIAL_ENDING");
    const pay = list.items.find((i) => i.kind === "PAYMENT_CONFIRMED");
    // Vem da régua de cobrança (`billing/dunning/bell.ts`): uma etapa por vez, id `bill:<assinatura>:<etapa>:<instante>`.
    expect(trial?.id).toMatch(new RegExp(`^bill:${sub.id}:TRIAL_(T1|T0):[0-9]+$`));
    expect(trial?.severity).toBe("warning");
    expect(trial?.href).toBe(`/${owner.tenant.slug}/assinatura`);
    expect(pay?.id).toBe(`pay:${invoice.id}`);
    expect(pay?.body).toContain("49,90");
    expect(pay?.href).toBe(`/${owner.tenant.slug}/assinatura`);

    // STAFF da mesma empresa não vê cobrança
    const staff = await prisma.user.create({ data: { email: `it-ntf-s-${randomUUID().slice(0, 6)}@example.test`, passwordHash: "x" } });
    userIds.push(staff.id);
    const sm = await prisma.membership.create({ data: { userId: staff.id, tenantId: owner.tenant.id, role: "STAFF" } });
    const staffCtx: TenantContext = { ...owner.ctx, membership: { id: sm.id, role: "STAFF" }, user: { id: staff.id } };
    const staffList = await listNotifications(staffCtx);
    expect(staffList.items.some((i) => i.kind === "TRIAL_ENDING" || i.kind === "PAYMENT_CONFIRMED")).toBe(false);

    // trial com 3+ dias de sobra (a véspera é um dia LOCAL, então não vale "30 h", que depende da hora): sem alerta
    await prisma.subscription.update({ where: { id: sub.id }, data: { trialEndsAt: new Date(Date.now() + 80 * HOUR) } });
    expect((await listNotifications(owner.ctx)).items.some((i) => i.kind === "TRIAL_ENDING")).toBe(false);

    // marcar todas zera o que já existia
    expect((await markNotificationsRead(owner.ctx, { all: true })).unreadCount).toBe(0);
  });
});

describe("notificações — ponto de escrita da queda do WhatsApp", () => {
  it("connection.update close carimba disconnectedAt só na transição CONNECTED → DISCONNECTED (repetição não renova)", async () => {
    const w = await makeWorld("wae");
    const inst = await prisma.whatsappInstance.create({
      data: { tenantId: w.tenant.id, instanceName: `it-ntf-${randomUUID()}`, label: "Balcão", status: "CONNECTED", webhookToken: randomUUID() },
    });
    const mkCtx = (status: string) => ({
      tenantId: w.tenant.id,
      instance: { id: inst.id, tenantId: w.tenant.id, instanceName: inst.instanceName, sandbox: false, status },
    });
    const payload = { event: "connection.update", data: { state: "close" } };

    await applyConnectionEvent(mkCtx("CONNECTED"), payload);
    const first = await prisma.whatsappInstance.findUniqueOrThrow({ where: { id: inst.id } });
    expect(first.status).toBe("DISCONNECTED");
    expect(first.disconnectedAt).not.toBeNull();
    expect((await listNotifications(w.ctx)).items.some((i) => i.kind === "WHATSAPP_DISCONNECTED")).toBe(true);

    await applyConnectionEvent(mkCtx("DISCONNECTED"), payload);
    const second = await prisma.whatsappInstance.findUniqueOrThrow({ where: { id: inst.id } });
    expect(second.disconnectedAt?.getTime()).toBe(first.disconnectedAt?.getTime());

    await applyConnectionEvent(mkCtx("DISCONNECTED"), { event: "connection.update", data: { state: "open" } });
    const back = await prisma.whatsappInstance.findUniqueOrThrow({ where: { id: inst.id } });
    expect(back.status).toBe("CONNECTED");
    expect(back.disconnectedAt).toBeNull();
  });
});

describe("notificações — linha do tempo do agendamento", () => {
  it("ordem cronológica, rótulos em pt-BR, autor por tipo (sem e-mail completo nem telefone)", async () => {
    const w = await makeWorld("tl");
    const appt = await makeAppointment(w, new Date(Date.now() + 5 * 24 * HOUR));
    const now = Date.now();
    await makeEvent(appt.id, "CREATED", "CONTACT", { createdAt: new Date(now - 3 * MIN) });
    await makeEvent(appt.id, "RESCHEDULED", "USER", { createdAt: new Date(now - 2 * MIN), authorId: w.user.id });
    await makeEvent(appt.id, "CANCELED", "SYSTEM", { createdAt: new Date(now - 1 * MIN), note: "motivo" });

    const { items } = await getAppointmentTimeline(w.ctx, appt.id);
    expect(items.map((i) => i.action)).toEqual(["CREATED", "RESCHEDULED", "CANCELED"]);
    expect(items.map((i) => i.label)).toEqual(["Cliente agendou pelo WhatsApp", "Remarcado pelo painel", "Cancelado pelo sistema"]);
    expect(items[0].authorLabel).toBe("Maria");
    expect(items[1].authorLabel).toBe(w.user.email.split("@")[0]);
    expect(items[1].authorLabel).not.toContain("@");
    expect(items[2].authorLabel).toBe("Sistema");
    expect(items[2].note).toBe("motivo");
    expect(JSON.stringify(items)).not.toContain("987654321");
  });
});

describe("notificações — manutenção", () => {
  it("o tick purga leituras individuais com mais de 45 dias", async () => {
    const w = await makeWorld("purge");
    await prisma.notificationRead.create({ data: { membershipId: w.membership.id, notificationKey: "ev:velho", readAt: new Date(Date.now() - 50 * 24 * HOUR) } });
    await prisma.notificationRead.create({ data: { membershipId: w.membership.id, notificationKey: "ev:novo" } });
    await maintenanceTickForTest();
    const keys = (await prisma.notificationRead.findMany({ where: { membershipId: w.membership.id } })).map((r) => r.notificationKey);
    expect(keys).toEqual(["ev:novo"]);
  });
});
