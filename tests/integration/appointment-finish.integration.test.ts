/**
 * Concluir / cliente faltou / reabrir (docs/contratos.md — "Encerramento do atendimento") e a
 * regressão do histórico do agendamento criado pelo bot, contra Postgres real. As actions são
 * chamadas de verdade; só `requireTenantMember` é trocado (não há sessão Auth.js fora do Next).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import { listNotifications } from "@/modules/notifications/service";
import type { TenantContext } from "@/lib/auth/guards";

const session: { ctx: TenantContext | null } = { ctx: null };
vi.mock("@/lib/auth/guards", () => ({
  requireTenantMember: async (slug: string) => {
    if (!session.ctx || session.ctx.tenant.slug !== slug) {
      const { DomainError } = await import("@/lib/errors");
      throw new DomainError("NOT_FOUND", "Empresa não encontrada.");
    }
    return session.ctx;
  },
}));

import {
  cancelAppointmentAction,
  completeAppointmentAction,
  markNoShowAppointmentAction,
  reopenAppointmentAction,
} from "@/modules/agenda/appointment-actions";
import { getAppointmentTimelineAction } from "@/modules/notifications/actions";

const prisma = getPrisma();
const tenantIds: string[] = [];
const userIds: string[] = [];
const planIds: string[] = [];
const MIN = 60_000;
const HOUR = 60 * MIN;

async function makeWorld(label: string, opts: { role?: "OWNER" | "STAFF"; subscription?: "TRIALING" | "SUSPENDED" } = {}) {
  const role = opts.role ?? "OWNER";
  const tenant = await prisma.tenant.create({
    data: { slug: `it-fin-${label}-${randomUUID().slice(0, 8)}`, name: `Fin ${label}`, timezone: "America/Sao_Paulo", minLeadTimeMin: 0, cancelMinLeadMin: 0 },
  });
  tenantIds.push(tenant.id);
  const plan = await prisma.plan.create({
    data: { code: `it-fin-${randomUUID().slice(0, 8)}`, name: "Plano IT", priceCents: 4990, maxWhatsappNumbers: 5, maxProfessionals: 50, active: false, sortOrder: 999 },
  });
  planIds.push(plan.id);
  // SUSPENDED: status persistido + período vencido há muito tempo (o status efetivo lê os dois).
  const suspended = opts.subscription === "SUSPENDED";
  const periodEnd = new Date(Date.now() + (suspended ? -90 : 10) * 24 * HOUR);
  await prisma.subscription.create({
    data: { tenantId: tenant.id, planId: plan.id, status: suspended ? "SUSPENDED" : "TRIALING", trialEndsAt: suspended ? null : periodEnd, currentPeriodEnd: periodEnd },
  });
  const user = await prisma.user.create({ data: { email: `ana-${randomUUID().slice(0, 6)}@example.test`, passwordHash: "x" } });
  userIds.push(user.id);
  const membership = await prisma.membership.create({ data: { userId: user.id, tenantId: tenant.id, role } });
  const service = await prisma.service.create({ data: { tenantId: tenant.id, name: "Massagem", durationMin: 30 } });
  const contact = await prisma.contact.create({
    data: { tenantId: tenant.id, waJid: `5511${Math.floor(Math.random() * 1e9)}@s.whatsapp.net`, name: "Júnior Rocha" },
  });
  const ctx: TenantContext = {
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, timezone: tenant.timezone },
    membership: { id: membership.id, role },
    user: { id: user.id },
  };
  return { tenant, user, service, contact, ctx };
}
type World = Awaited<ReturnType<typeof makeWorld>>;

async function makeAppointment(w: World, startsAt: Date, status: "SCHEDULED" | "CANCELED" = "SCHEDULED") {
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
      status,
    },
  });
}

const input = (w: World, appointmentId: string) => ({ tenantSlug: w.tenant.slug, appointmentId });

beforeEach(() => {
  session.ctx = null;
});

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.plan.deleteMany({ where: { id: { in: planIds } } });
  await prisma.$disconnect();
});

describe("concluir / cliente faltou", () => {
  it.each([
    ["COMPLETED", completeAppointmentAction, "APPOINTMENT_COMPLETED"],
    ["NO_SHOW", markNoShowAppointmentAction, "APPOINTMENT_NO_SHOW"],
  ] as const)("SCHEDULED já iniciado → %s, com evento do membro e notificação do kind certo", async (status, action, kind) => {
    const w = await makeWorld(`ok-${status}`);
    session.ctx = w.ctx;
    const appt = await makeAppointment(w, new Date(Date.now() - 20 * MIN));

    const r = await action(input(w, appt.id));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.status).toBe(status);
    expect(r.data.startsAt).toBeInstanceOf(Date); // a UI decide os botões por startsAt

    const events = await prisma.appointmentEvent.findMany({ where: { appointmentId: appt.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: status, authorType: "USER", authorId: w.user.id, tenantId: w.tenant.id });

    const feed = await listNotifications(w.ctx);
    expect(feed.items.map((i) => i.kind)).toContain(kind);
  });

  it("STAFF também pode", async () => {
    const w = await makeWorld("staff", { role: "STAFF" });
    session.ctx = w.ctx;
    const appt = await makeAppointment(w, new Date(Date.now() - 5 * MIN));
    expect((await completeAppointmentAction(input(w, appt.id))).ok).toBe(true);
  });

  it("antes do horário de início → APPOINTMENT_NOT_STARTED, nada muda e nenhum evento é gravado", async () => {
    const w = await makeWorld("future");
    session.ctx = w.ctx;
    const appt = await makeAppointment(w, new Date(Date.now() + 2 * HOUR));
    for (const action of [completeAppointmentAction, markNoShowAppointmentAction]) {
      const r = await action(input(w, appt.id));
      expect(r).toMatchObject({ ok: false, error: { code: "APPOINTMENT_NOT_STARTED" } });
      if (!r.ok) expect(r.error.message.length).toBeGreaterThan(10);
    }
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).status).toBe("SCHEDULED");
    expect(await prisma.appointmentEvent.count({ where: { appointmentId: appt.id } })).toBe(0);
  });

  it("cancelado → INVALID_STATE", async () => {
    const w = await makeWorld("canceled");
    session.ctx = w.ctx;
    const appt = await makeAppointment(w, new Date(Date.now() - HOUR), "CANCELED");
    expect(await completeAppointmentAction(input(w, appt.id))).toMatchObject({ ok: false, error: { code: "INVALID_STATE" } });
    expect(await markNoShowAppointmentAction(input(w, appt.id))).toMatchObject({ ok: false, error: { code: "INVALID_STATE" } });
    expect(await reopenAppointmentAction(input(w, appt.id))).toMatchObject({ ok: false, error: { code: "INVALID_STATE" } });
  });

  it("já concluído + tentar 'faltou' → INVALID_STATE; repetir a mesma ação é idempotente (1 evento só)", async () => {
    const w = await makeWorld("twice");
    session.ctx = w.ctx;
    const appt = await makeAppointment(w, new Date(Date.now() - HOUR));
    expect((await completeAppointmentAction(input(w, appt.id))).ok).toBe(true);
    expect((await completeAppointmentAction(input(w, appt.id))).ok).toBe(true);
    expect(await markNoShowAppointmentAction(input(w, appt.id))).toMatchObject({ ok: false, error: { code: "INVALID_STATE" } });
    expect(await prisma.appointmentEvent.count({ where: { appointmentId: appt.id } })).toBe(1);
  });

  it("corrida com cancelamento: nunca sobra evento sem o estado correspondente", async () => {
    const w = await makeWorld("race");
    session.ctx = w.ctx;
    const appt = await makeAppointment(w, new Date(Date.now() - HOUR));
    await Promise.all([completeAppointmentAction(input(w, appt.id)), cancelAppointmentAction(w.tenant.slug, appt.id)]);
    const final = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    const actions = (await prisma.appointmentEvent.findMany({ where: { appointmentId: appt.id } })).map((e) => e.action);
    // A regra antiga de cancelar aceita qualquer status != CANCELED, então "concluir e depois
    // cancelar" é uma ordem válida; o que não pode existir é o estado final sem o evento dele.
    expect(["COMPLETED", "CANCELED"]).toContain(final.status);
    expect(actions).toContain(final.status);
  });

  it("isolamento de tenant: empresa B não conclui agendamento da empresa A", async () => {
    const a = await makeWorld("isoA");
    const b = await makeWorld("isoB");
    const appt = await makeAppointment(a, new Date(Date.now() - HOUR));
    session.ctx = b.ctx;
    expect(await completeAppointmentAction(input(b, appt.id))).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await markNoShowAppointmentAction(input(b, appt.id))).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await reopenAppointmentAction(input(b, appt.id))).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).status).toBe("SCHEDULED");
  });

  it("conta suspensa → TENANT_SUSPENDED", async () => {
    const w = await makeWorld("suspended", { subscription: "SUSPENDED" });
    session.ctx = w.ctx;
    const appt = await makeAppointment(w, new Date(Date.now() - HOUR));
    expect(await completeAppointmentAction(input(w, appt.id))).toMatchObject({ ok: false, error: { code: "TENANT_SUSPENDED" } });
    expect(await reopenAppointmentAction(input(w, appt.id))).toMatchObject({ ok: false, error: { code: "TENANT_SUSPENDED" } });
  });

  it("payload inválido → INVALID_PAYLOAD", async () => {
    const w = await makeWorld("zod");
    session.ctx = w.ctx;
    expect(await completeAppointmentAction({ tenantSlug: w.tenant.slug, appointmentId: "" })).toMatchObject({
      ok: false,
      error: { code: "INVALID_PAYLOAD" },
    });
  });
});

describe("reabrir", () => {
  it.each([
    ["COMPLETED", completeAppointmentAction],
    ["NO_SHOW", markNoShowAppointmentAction],
  ] as const)("%s → SCHEDULED com evento REOPENED, sem gerar notificação", async (status, action) => {
    const w = await makeWorld(`reopen-${status}`);
    session.ctx = w.ctx;
    const appt = await makeAppointment(w, new Date(Date.now() - HOUR));
    await action(input(w, appt.id));
    const r = await reopenAppointmentAction(input(w, appt.id));
    expect(r).toMatchObject({ ok: true, data: { status: "SCHEDULED" } });
    const events = await prisma.appointmentEvent.findMany({ where: { appointmentId: appt.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.action)).toEqual([status, "REOPENED"]);
    expect(events[1]).toMatchObject({ authorType: "USER", authorId: w.user.id });
    // A central de notificações mostra o encerramento, mas nunca o "reaberto".
    const feed = await listNotifications(w.ctx);
    expect(feed.items).toHaveLength(1);
    // Volta a poder ser concluído.
    expect((await completeAppointmentAction(input(w, appt.id))).ok).toBe(true);
  });

  it("reabrir um SCHEDULED é idempotente (sem evento)", async () => {
    const w = await makeWorld("reopen-idem");
    session.ctx = w.ctx;
    const appt = await makeAppointment(w, new Date(Date.now() - HOUR));
    expect((await reopenAppointmentAction(input(w, appt.id))).ok).toBe(true);
    expect(await prisma.appointmentEvent.count({ where: { appointmentId: appt.id } })).toBe(0);
  });

  it("horário ocupado por outro agendamento do mesmo profissional → SLOT_TAKEN", async () => {
    const w = await makeWorld("reopen-conflict");
    session.ctx = w.ctx;
    const appt = await makeAppointment(w, new Date(Date.now() - HOUR));
    await completeAppointmentAction(input(w, appt.id));
    // Outro SCHEDULED, mesmo profissional e intervalo (o EXCLUDE só vale para SCHEDULED).
    await prisma.appointment.create({
      data: {
        tenantId: w.tenant.id,
        contactId: w.contact.id,
        serviceId: w.service.id,
        professionalId: appt.professionalId,
        startsAt: appt.startsAt,
        endsAt: appt.endsAt,
        blockEndsAt: appt.blockEndsAt,
      },
    });
    expect(await reopenAppointmentAction(input(w, appt.id))).toMatchObject({ ok: false, error: { code: "SLOT_TAKEN" } });
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } })).status).toBe("COMPLETED");
  });
});

describe("histórico do agendamento (regressão: agendamento criado pelo bot)", () => {
  it("bot (CONTACT, authorId = contato) + evento legado sem tenantId → histórico carrega", async () => {
    const w = await makeWorld("timeline");
    session.ctx = w.ctx;
    const professional = await prisma.professional.create({ data: { tenantId: w.tenant.id, name: "Ana" } });
    await prisma.professionalService.create({ data: { professionalId: professional.id, serviceId: w.service.id } });
    const instance = await prisma.whatsappInstance.create({
      data: { tenantId: w.tenant.id, instanceName: `it-fin-${randomUUID().slice(0, 8)}`, label: "Principal", webhookToken: randomUUID(), sandbox: false },
    });
    // O mesmo dado que a API interna do bot grava (booking-bot.ts → createAppointmentManual com
    // source WHATSAPP + authorType CONTACT + authorId = id do contato); direto no banco porque o
    // cenário não precisa montar expediente/regras de agenda.
    const startsAt = new Date(Date.now() + 3 * HOUR);
    const created = await prisma.appointment.create({
      data: {
        tenantId: w.tenant.id,
        contactId: w.contact.id,
        serviceId: w.service.id,
        professionalId: professional.id,
        whatsappInstanceId: instance.id,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 30 * MIN),
        blockEndsAt: new Date(startsAt.getTime() + 30 * MIN),
        source: "WHATSAPP",
      },
    });
    await prisma.appointmentEvent.create({ data: { appointmentId: created.id, action: "CREATED", authorType: "CONTACT", authorId: w.contact.id } });
    const id = created.id;
    // Evento legado (anterior à migration de notificações): tenantId nulo.
    await prisma.$executeRaw`UPDATE appointment_events SET "tenantId" = NULL WHERE "appointmentId" = ${id}`;
    await prisma.appointmentEvent.create({ data: { appointmentId: id, action: "RESCHEDULED", authorType: "CONTACT", authorId: w.contact.id } });

    const r = await getAppointmentTimelineAction(input(w, id));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.items.map((i) => i.label)).toEqual(["Cliente agendou pelo WhatsApp", "Cliente remarcou pelo WhatsApp"]);
    expect(r.data.items[0].authorLabel).toBe("Júnior Rocha");
    expect(() => JSON.stringify(r)).not.toThrow();
  });

  it("rótulos pt-BR dos encerramentos e do reaberto, com o nome do membro", async () => {
    const w = await makeWorld("labels");
    session.ctx = w.ctx;
    const appt = await makeAppointment(w, new Date(Date.now() - HOUR));
    await markNoShowAppointmentAction(input(w, appt.id));
    await reopenAppointmentAction(input(w, appt.id));
    await completeAppointmentAction(input(w, appt.id));
    const r = await getAppointmentTimelineAction(input(w, appt.id));
    if (!r.ok) throw new Error("timeline falhou");
    const who = w.user.email.split("@")[0];
    expect(r.data.items.map((i) => i.label)).toEqual([
      `Cliente faltou (marcado por ${who})`,
      `Atendimento reaberto por ${who}`,
      `Atendimento concluído por ${who}`,
    ]);
  });

  it("falha inesperada é registrada no log (só ids) e vira Result de erro, sem lançar", async () => {
    const w = await makeWorld("logfail");
    session.ctx = w.ctx;
    const appt = await makeAppointment(w, new Date(Date.now() + HOUR));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const findMany = vi.spyOn(prisma.appointmentEvent, "findMany").mockRejectedValueOnce(new Error("boom de teste"));
    const r = await getAppointmentTimelineAction(input(w, appt.id));
    findMany.mockRestore();
    const logged = JSON.stringify(spy.mock.calls);
    spy.mockRestore();
    expect(r).toMatchObject({ ok: false, error: { code: "TIMELINE_UNAVAILABLE" } });
    expect(logged).toContain(appt.id);
    expect(logged).toContain("boom de teste");
    expect(logged).not.toContain("Júnior");
  });
});
