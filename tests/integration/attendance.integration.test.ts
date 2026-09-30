/**
 * Atendimento humano pelo painel (fila, responder, encerrar) e aviso ao cliente nas mudanças da equipe
 * (criar/remarcar/cancelar), contra Postgres real. A Evolution é um dublê devolvido por
 * `getEvolutionClient` (mock do módulo); o guard de membro é simulado por `session.ctx`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import type { TenantContext } from "@/lib/auth/guards";
import { EvolutionApiError, type EvolutionClient } from "@/modules/whatsapp/evolution-client";

const session: { ctx: TenantContext | null } = { ctx: null };
vi.mock("@/lib/auth/guards", () => ({
  requireTenantMember: async (slug: string, roles?: string[]) => {
    const { DomainError } = await import("@/lib/errors");
    if (!session.ctx || session.ctx.tenant.slug !== slug) throw new DomainError("NOT_FOUND", "Empresa não encontrada.");
    if (roles && roles.length > 0 && !roles.includes(session.ctx.membership.role)) throw new DomainError("FORBIDDEN", "Sem permissão para esta ação.");
    return session.ctx;
  },
}));

type Sent = { instanceName: string; number: string; text: string };
const evo: { sent: Sent[]; fail: boolean | Error; available: boolean; beforeSend: (() => Promise<void>) | null } = {
  sent: [],
  fail: false,
  available: true,
  beforeSend: null,
};
vi.mock("@/modules/whatsapp/evolution-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/modules/whatsapp/evolution-client")>();
  return {
    ...original,
    getEvolutionClient: async () => {
      if (!evo.available) throw new Error("sem evolution");
      return {
        sendText: async (instanceName: string, number: string, text: string) => {
          if (evo.beforeSend) {
            const hook = evo.beforeSend;
            evo.beforeSend = null; // dispara uma vez (o encerrar do teste também envia)
            await hook();
          }
          if (evo.fail) throw evo.fail instanceof Error ? evo.fail : new original.EvolutionApiError("fora do ar", 503);
          evo.sent.push({ instanceName, number, text });
          return { messageId: `MSG-${randomUUID()}` };
        },
      } as unknown as EvolutionClient;
    },
  };
});

import { __resetIdempotencyForTests } from "@/lib/idempotency";
import { __resetRateLimitsForTests } from "@/lib/rate-limit";
import { OUTBOUND_LIMIT_PER_CONTACT_PER_HOUR, OUTBOUND_LIMIT_PER_TENANT_PER_HOUR, sendTextToContact } from "@/modules/attendance/outbound";
import {
  closeAttendanceAction,
  getAttendanceConversationAction,
  listAttendanceQueueAction,
  sendAgentMessageAction,
} from "@/modules/attendance/actions";
import {
  cancelAppointmentAction,
  completeAppointmentAction,
  createAppointmentAction,
  rescheduleAppointmentAction,
} from "@/modules/agenda/appointment-actions";
import { pollNotificationsAction, listNotificationsAction } from "@/modules/notifications/actions";
import { getBotRulesAction, updateBotRulesAction } from "@/modules/tenant/actions";
import { createProfessional, createService, setProfessionalServices, setProfessionalWorkingHours } from "@/modules/agenda/catalog";

const prisma = getPrisma();
const HOUR = 3_600_000;
const tenantIds: string[] = [];
const planIds: string[] = [];
const userIds: string[] = [];

async function makeWorld(
  label: string,
  opts: { subscription?: "ACTIVE" | "SUSPENDED"; instance?: { status?: "CONNECTED" | "DISCONNECTED"; sandbox?: boolean } | null; role?: "OWNER" | "STAFF"; notify?: boolean } = {},
) {
  const tenant = await prisma.tenant.create({
    data: {
      slug: `it-att-${label}-${randomUUID().slice(0, 8)}`,
      name: `Studio ${label}`,
      timezone: "America/Sao_Paulo",
      notifyClientOnStaffChanges: opts.notify ?? true,
    },
  });
  tenantIds.push(tenant.id);
  const plan = await prisma.plan.create({
    data: { code: `it-att-${randomUUID().slice(0, 8)}`, name: "Plano IT", priceCents: 4990, maxWhatsappNumbers: 5, maxProfessionals: 50, active: false, sortOrder: 999 },
  });
  planIds.push(plan.id);
  const suspended = opts.subscription === "SUSPENDED";
  const periodEnd = new Date(suspended ? "2026-01-01T00:00:00Z" : Date.now() + 60 * 24 * HOUR);
  await prisma.subscription.create({
    data: { tenantId: tenant.id, planId: plan.id, status: suspended ? "SUSPENDED" : "ACTIVE", currentPeriodEnd: periodEnd },
  });
  const instance =
    opts.instance === null
      ? null
      : await prisma.whatsappInstance.create({
          data: {
            tenantId: tenant.id,
            instanceName: `inst-att-${label}-${randomUUID().slice(0, 8)}`,
            label: "Principal",
            webhookToken: randomUUID(),
            status: opts.instance?.status ?? "CONNECTED",
            sandbox: opts.instance?.sandbox ?? false,
          },
        });
  const service = await createService(tenant.id, { name: "Corte", durationMin: 30, bufferAfterMin: 0, priceCents: null, active: true, sortOrder: 0 });
  const professional = await createProfessional(tenant.id, { name: "Ana", active: true, sortOrder: 0 });
  await setProfessionalServices(tenant.id, professional.id, [service.id]);
  await setProfessionalWorkingHours(tenant.id, professional.id, [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: "00:00", endTime: "23:59" })));
  const user = await prisma.user.create({ data: { email: `att-${randomUUID().slice(0, 8)}@example.test`, passwordHash: "x", name: "Bia Atendente" } });
  userIds.push(user.id);
  const role = opts.role ?? "OWNER";
  const membership = await prisma.membership.create({ data: { userId: user.id, tenantId: tenant.id, role } });
  const ctx: TenantContext = {
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, timezone: tenant.timezone },
    membership: { id: membership.id, role },
    user: { id: user.id },
  };
  return { tenant, instance, service, professional, ctx };
}
type World = Awaited<ReturnType<typeof makeWorld>>;

let seq = 0;
async function makeContact(w: World, opts: { name?: string; noPhone?: boolean; botPausedUntil?: Date } = {}) {
  seq += 1;
  const digits = `5511${String(900000000 + seq * 1000 + Math.floor(Math.random() * 1000))}`;
  return prisma.contact.create({
    data: {
      tenantId: w.tenant.id,
      waJid: opts.noPhone ? `panel-${randomUUID()}@panel.local` : `${digits}@s.whatsapp.net`,
      name: opts.name ?? "Júnior Rocha",
      botPausedUntil: opts.botPausedUntil ?? null,
    },
  });
}

async function makeHandoff(w: World, contactId: string, opts: { requestedAgoMin?: number; answered?: boolean; endedAgoMin?: number } = {}) {
  if (!w.instance) throw new Error("mundo sem instância");
  const session = await prisma.chatSession.upsert({
    where: { whatsappInstanceId_contactId: { whatsappInstanceId: w.instance.id, contactId } },
    update: {},
    create: { whatsappInstanceId: w.instance.id, contactId, state: "HUMAN" },
  });
  const requestedAt = new Date(Date.now() - (opts.requestedAgoMin ?? 10) * 60_000);
  return prisma.handoffRequest.create({
    data: {
      tenantId: w.tenant.id,
      whatsappInstanceId: w.instance.id,
      contactId,
      chatSessionId: session.id,
      reason: "CLIENT_REQUEST",
      requestedAt,
      answeredAt: opts.answered ? new Date(requestedAt.getTime() + 60_000) : null,
      endedAt: opts.endedAgoMin !== undefined ? new Date(Date.now() - opts.endedAgoMin * 60_000) : null,
      endReason: opts.endedAgoMin !== undefined ? "PANEL_RESUME" : null,
    },
  });
}

function as(w: World) {
  session.ctx = w.ctx;
}

beforeEach(() => {
  evo.sent = [];
  evo.fail = false;
  evo.available = true;
  evo.beforeSend = null;
  session.ctx = null;
  __resetRateLimitsForTests();
  __resetIdempotencyForTests();
});

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.plan.deleteMany({ where: { id: { in: planIds } } });
  await prisma.$disconnect();
});

describe("fila de atendimento", () => {
  it("classifica WAITING, IN_PROGRESS (respondido e pausa pela equipe) e RECENT, na ordem, sem telefone", async () => {
    const w = await makeWorld("fila");
    const waitingOld = await makeContact(w, { name: "Antiga" });
    const waitingNew = await makeContact(w, { name: "Nova" });
    const answered = await makeContact(w, { name: "Respondida" });
    const staffLed = await makeContact(w, { name: "Puxada" });
    const recent = await makeContact(w, { name: "Encerrada" });
    const old = await makeContact(w, { name: "Velha" });
    await makeHandoff(w, waitingNew.id, { requestedAgoMin: 5 });
    await makeHandoff(w, waitingOld.id, { requestedAgoMin: 50 });
    await makeHandoff(w, answered.id, { requestedAgoMin: 30, answered: true });
    await prisma.chatSession.create({
      data: { whatsappInstanceId: w.instance!.id, contactId: staffLed.id, state: "HUMAN", humanUntil: new Date(Date.now() + HOUR) },
    });
    await makeHandoff(w, recent.id, { requestedAgoMin: 120, endedAgoMin: 60 });
    await makeHandoff(w, old.id, { requestedAgoMin: 2000, endedAgoMin: 30 * 60 });
    await prisma.chatMessage.create({ data: { tenantId: w.tenant.id, contactId: waitingOld.id, direction: "INBOUND", body: "quero falar com alguém" } });

    as(w);
    const res = await listAttendanceQueueAction({ tenantSlug: w.tenant.slug });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.waitingCount).toBe(2);
    expect(res.data.items.map((i) => [i.contactName, i.status])).toEqual([
      ["Antiga", "WAITING"],
      ["Nova", "WAITING"],
      expect.arrayContaining(["IN_PROGRESS"]),
      expect.arrayContaining(["IN_PROGRESS"]),
      ["Encerrada", "RECENT"],
    ]);
    const inProgress = res.data.items.filter((i) => i.status === "IN_PROGRESS").map((i) => i.contactName).sort();
    expect(inProgress).toEqual(["Puxada", "Respondida"]);
    const first = res.data.items[0];
    expect(first.lastMessage).toMatchObject({ body: "quero falar com alguém", direction: "INBOUND", author: "CLIENT" });
    expect(first.handoffId).toBeTruthy();
    expect(res.data.items.find((i) => i.contactName === "Puxada")).toMatchObject({ handoffId: null, requestedAt: null });
    expect(res.data.items.find((i) => i.contactName === "Puxada")?.botPausedUntil).toBeTruthy();
    // Nunca telefone/JID na resposta.
    expect(JSON.stringify(res.data)).not.toMatch(/\d{10,}/);
    expect(JSON.stringify(res.data)).not.toContain("@s.whatsapp.net");
  });

  it("isolamento: não lista, não lê, não responde e não encerra cliente de outra empresa", async () => {
    const a = await makeWorld("isoA");
    const b = await makeWorld("isoB");
    const contactB = await makeContact(b, { name: "Cliente da B" });
    await makeHandoff(b, contactB.id);

    as(a);
    const queue = await listAttendanceQueueAction({ tenantSlug: a.tenant.slug });
    expect(queue.ok && queue.data.items).toEqual([]);
    expect(queue.ok && queue.data.waitingCount).toBe(0);
    const conv = await getAttendanceConversationAction({ tenantSlug: a.tenant.slug, contactId: contactB.id });
    expect(conv).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    const send = await sendAgentMessageAction({ tenantSlug: a.tenant.slug, contactId: contactB.id, text: "oi" });
    expect(send).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    const close = await closeAttendanceAction({ tenantSlug: a.tenant.slug, contactId: contactB.id });
    expect(close).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(evo.sent).toHaveLength(0);
    expect(await prisma.handoffRequest.count({ where: { contactId: contactB.id, endedAt: null } })).toBe(1);

    // Outra empresa (sem membership na primeira) também não passa pelo slug.
    const foreignSlug = await listAttendanceQueueAction({ tenantSlug: b.tenant.slug });
    expect(foreignSlug).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("o poll e a lista de notificações trazem attendanceWaitingCount", async () => {
    const w = await makeWorld("badge");
    const c1 = await makeContact(w);
    const c2 = await makeContact(w);
    await makeHandoff(w, c1.id);
    await makeHandoff(w, c2.id, { answered: true });
    as(w);
    const poll = await pollNotificationsAction({ tenantSlug: w.tenant.slug, since: new Date(Date.now() - HOUR).toISOString() });
    expect(poll.ok && poll.data.attendanceWaitingCount).toBe(1);
    const list = await listNotificationsAction({ tenantSlug: w.tenant.slug });
    expect(list.ok && list.data.attendanceWaitingCount).toBe(1);
  });
});

describe("responder pelo painel", () => {
  it("envia, registra o eco ANTES, grava ChatMessage com autor, marca answeredAt e estende a pausa", async () => {
    const w = await makeWorld("send");
    const contact = await makeContact(w);
    const handoff = await makeHandoff(w, contact.id);
    as(w);

    const res = await sendAgentMessageAction({ tenantSlug: w.tenant.slug, contactId: contact.id, text: "  Oi! Já vou te ajudar.  " });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.message).toMatchObject({ direction: "OUTBOUND", body: "Oi! Já vou te ajudar.", author: "AGENT", authorName: "Bia Atendente" });
    expect(evo.sent).toHaveLength(1);
    expect(evo.sent[0]).toMatchObject({ instanceName: w.instance!.instanceName, text: "Oi! Já vou te ajudar." });

    const row = await prisma.chatMessage.findFirstOrThrow({ where: { contactId: contact.id, direction: "OUTBOUND" } });
    expect(row.authorUserId).toBe(w.ctx.user.id);
    const chatSession = await prisma.chatSession.findFirstOrThrow({ where: { contactId: contact.id } });
    expect(Array.isArray(chatSession.recentOutbound) ? (chatSession.recentOutbound as unknown[]).length : 0).toBeGreaterThan(0);
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: w.tenant.id } });
    expect(chatSession.humanUntil!.getTime()).toBeGreaterThan(Date.now() + (tenant.handoffResumeMinutes - 2) * 60_000);
    expect(chatSession.state).toBe("HUMAN");
    const after = await prisma.handoffRequest.findUniqueOrThrow({ where: { id: handoff.id } });
    expect(after.answeredAt).not.toBeNull();
    expect(after.endedAt).toBeNull();

    const conv = await getAttendanceConversationAction({ tenantSlug: w.tenant.slug, contactId: contact.id });
    expect(conv.ok && conv.data.items.at(-1)).toMatchObject({ author: "AGENT", authorName: "Bia Atendente" });
  });

  it("sem pedido aberto (equipe puxou a conversa): pausa o contato e a sessão", async () => {
    const w = await makeWorld("pull");
    const contact = await makeContact(w);
    as(w);
    const res = await sendAgentMessageAction({ tenantSlug: w.tenant.slug, contactId: contact.id, text: "Olá, tudo bem?" });
    expect(res.ok).toBe(true);
    const c = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(c.botPausedUntil!.getTime()).toBeGreaterThan(Date.now());
    const s = await prisma.chatSession.findFirstOrThrow({ where: { contactId: contact.id } });
    expect(s.state).toBe("HUMAN");
    const queue = await listAttendanceQueueAction({ tenantSlug: w.tenant.slug });
    expect(queue.ok && queue.data.items.map((i) => [i.contactName, i.status])).toEqual([["Júnior Rocha", "IN_PROGRESS"]]);
  });

  it("não encurta uma pausa maior que já existia", async () => {
    const w = await makeWorld("longpause");
    const far = new Date(Date.now() + 100 * 24 * HOUR);
    const contact = await makeContact(w, { botPausedUntil: far });
    as(w);
    await sendAgentMessageAction({ tenantSlug: w.tenant.slug, contactId: contact.id, text: "Oi" });
    const c = await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(c.botPausedUntil!.getTime()).toBe(far.getTime());
  });

  it("erros estruturados: TEXT_EMPTY, TEXT_TOO_LONG, CONTACT_HAS_NO_PHONE, WHATSAPP_NOT_CONNECTED, SEND_FAILED e TENANT_SUSPENDED", async () => {
    const w = await makeWorld("errs");
    const contact = await makeContact(w);
    as(w);
    const code = async (text: string, contactId = contact.id) => {
      const r = await sendAgentMessageAction({ tenantSlug: w.tenant.slug, contactId, text });
      return r.ok ? "ok" : r.error.code;
    };
    expect(await code("   ")).toBe("TEXT_EMPTY");
    expect(await code("a".repeat(4001))).toBe("TEXT_TOO_LONG");
    expect(await code("a".repeat(4000))).toBe("ok");
    const noPhone = await makeContact(w, { noPhone: true });
    expect(await code("oi", noPhone.id)).toBe("CONTACT_HAS_NO_PHONE");
    evo.fail = true;
    expect(await code("oi")).toBe("SEND_FAILED");
    expect(await prisma.chatMessage.count({ where: { contactId: contact.id, body: "oi" } })).toBe(0);
    evo.fail = false;

    const disconnected = await makeWorld("desconectado", { instance: { status: "DISCONNECTED" } });
    const c2 = await makeContact(disconnected);
    as(disconnected);
    expect(await sendAgentMessageAction({ tenantSlug: disconnected.tenant.slug, contactId: c2.id, text: "oi" })).toMatchObject({ ok: false, error: { code: "WHATSAPP_NOT_CONNECTED" } });
    const sandbox = await makeWorld("sandbox", { instance: { sandbox: true } });
    const c3 = await makeContact(sandbox);
    as(sandbox);
    expect(await sendAgentMessageAction({ tenantSlug: sandbox.tenant.slug, contactId: c3.id, text: "oi" })).toMatchObject({ ok: false, error: { code: "WHATSAPP_NOT_CONNECTED" } });
    const none = await makeWorld("semnumero", { instance: null });
    const c4 = await makeContact(none);
    as(none);
    expect(await sendAgentMessageAction({ tenantSlug: none.tenant.slug, contactId: c4.id, text: "oi" })).toMatchObject({ ok: false, error: { code: "WHATSAPP_NOT_CONNECTED" } });

    const suspended = await makeWorld("susp", { subscription: "SUSPENDED" });
    const c5 = await makeContact(suspended);
    as(suspended);
    expect(await sendAgentMessageAction({ tenantSlug: suspended.tenant.slug, contactId: c5.id, text: "oi" })).toMatchObject({ ok: false, error: { code: "TENANT_SUSPENDED" } });
    expect(await closeAttendanceAction({ tenantSlug: suspended.tenant.slug, contactId: c5.id })).toMatchObject({ ok: false, error: { code: "TENANT_SUSPENDED" } });
  });

  it("limite de envio: 20 por minuto por usuário; a 21ª volta RATE_LIMITED", async () => {
    const w = await makeWorld("rate");
    as(w);
    // Um contato por mensagem: o teto por contato (10/h) é outro limite, testado no bloco de endurecimento.
    for (let i = 0; i < 20; i += 1) {
      const contact = await makeContact(w);
      const r = await sendAgentMessageAction({ tenantSlug: w.tenant.slug, contactId: contact.id, text: `msg ${i}` });
      expect(r.ok).toBe(true);
    }
    const contact = await makeContact(w);
    const blocked = await sendAgentMessageAction({ tenantSlug: w.tenant.slug, contactId: contact.id, text: "msg 21" });
    expect(blocked).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    expect(evo.sent).toHaveLength(20);
  });
});

describe("encerrar atendimento", () => {
  it("fecha o pedido (PANEL_RESUME), tira a pausa, avisa o cliente com HANDOFF_CLOSED e é idempotente", async () => {
    const w = await makeWorld("close");
    const contact = await makeContact(w, { name: "Júnior Rocha" });
    const handoff = await makeHandoff(w, contact.id, { answered: true });
    await prisma.chatSession.updateMany({ where: { contactId: contact.id }, data: { humanUntil: new Date(Date.now() + HOUR) } });
    await prisma.contact.update({ where: { id: contact.id }, data: { botPausedUntil: new Date(Date.now() + HOUR) } });
    as(w);

    const first = await closeAttendanceAction({ tenantSlug: w.tenant.slug, contactId: contact.id });
    expect(first).toEqual({ ok: true, data: { closed: true, clientNotified: true } });
    expect(evo.sent).toHaveLength(1);
    expect(evo.sent[0].text).toContain("Atendimento encerrado pela equipe da *Studio close*");
    expect(evo.sent[0].text).toContain("Júnior");
    expect(evo.sent[0].text).not.toMatch(/\{\w+\}/);
    const h = await prisma.handoffRequest.findUniqueOrThrow({ where: { id: handoff.id } });
    expect(h.endedAt).not.toBeNull();
    expect(h.endReason).toBe("PANEL_RESUME");
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).botPausedUntil).toBeNull();
    const s = await prisma.chatSession.findFirstOrThrow({ where: { contactId: contact.id } });
    expect(s.humanUntil).toBeNull();
    expect(s.state).toBe("MAIN_MENU");
    const msg = await prisma.chatMessage.findFirstOrThrow({ where: { contactId: contact.id, direction: "OUTBOUND" } });
    expect(msg.authorUserId).toBeNull();
    expect(Array.isArray(s.recentOutbound) ? (s.recentOutbound as unknown[]).length : 0).toBeGreaterThan(0);

    const second = await closeAttendanceAction({ tenantSlug: w.tenant.slug, contactId: contact.id });
    expect(second).toEqual({ ok: true, data: { closed: true, clientNotified: false } });
    expect(evo.sent).toHaveLength(1);
  });

  it("dois encerramentos simultâneos avisam o cliente uma única vez", async () => {
    const w = await makeWorld("closerace");
    const contact = await makeContact(w);
    await makeHandoff(w, contact.id);
    as(w);
    const results = await Promise.all([
      closeAttendanceAction({ tenantSlug: w.tenant.slug, contactId: contact.id }),
      closeAttendanceAction({ tenantSlug: w.tenant.slug, contactId: contact.id }),
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(evo.sent).toHaveLength(1);
  });

  it("falha no envio do aviso não desfaz o encerramento (clientNotified=false)", async () => {
    const w = await makeWorld("closefail");
    const contact = await makeContact(w);
    const handoff = await makeHandoff(w, contact.id);
    evo.fail = true;
    as(w);
    const r = await closeAttendanceAction({ tenantSlug: w.tenant.slug, contactId: contact.id });
    expect(r).toEqual({ ok: true, data: { closed: true, clientNotified: false } });
    expect((await prisma.handoffRequest.findUniqueOrThrow({ where: { id: handoff.id } })).endedAt).not.toBeNull();
  });
});

describe("aviso ao cliente nas mudanças da equipe", () => {
  const startsAt = () => {
    const d = new Date(Date.now() + 5 * 24 * HOUR);
    d.setUTCHours(15, 0, 0, 0); // 12:00 em São Paulo
    return d.toISOString();
  };

  async function book(w: World, contactId: string, at = startsAt()) {
    const r = await createAppointmentAction(w.tenant.slug, { contactId, serviceId: w.service.id, professionalId: w.professional.id, startsAt: at });
    if (!r.ok) throw new Error(`criar falhou: ${r.error.code}`);
    return r.data as { appointment: { id: string }; alreadyExisted: boolean; clientNotification: string };
  }

  it("criar, remarcar e cancelar avisam (STAFF_BOOKED/RESCHEDULED/CANCELED), com eco e ChatMessage", async () => {
    const w = await makeWorld("notify");
    const contact = await makeContact(w, { name: "Maria Souza" });
    as(w);

    const created = await book(w, contact.id);
    expect(created.clientNotification).toBe("SENT");
    expect(evo.sent).toHaveLength(1);
    expect(evo.sent[0].text).toContain("agendado pela equipe da *Studio notify*");
    expect(evo.sent[0].text).toContain("Corte");
    expect(evo.sent[0].text).toContain("Ana");
    expect(evo.sent[0].text).toContain("12:00");
    expect(evo.sent[0].text).toContain("Maria");
    expect(evo.sent[0].text).not.toMatch(/\{\w+\}/);

    const moved = new Date(new Date(startsAt()).getTime() + 2 * HOUR).toISOString();
    const rescheduled = await rescheduleAppointmentAction(w.tenant.slug, created.appointment.id, { startsAt: moved });
    expect(rescheduled).toMatchObject({ ok: true, data: { id: created.appointment.id, clientNotification: "SENT" } });
    expect(evo.sent[1].text).toContain("remarcado pela equipe");
    expect(evo.sent[1].text).toContain("14:00");

    const canceled = await cancelAppointmentAction(w.tenant.slug, created.appointment.id);
    expect(canceled).toMatchObject({ ok: true, data: { status: "CANCELED", clientNotification: "SENT" } });
    expect(evo.sent[2].text).toContain("cancelado");

    // Cancelar de novo é idempotente e NÃO reavisa.
    const again = await cancelAppointmentAction(w.tenant.slug, created.appointment.id);
    expect(again).toMatchObject({ ok: true, data: { status: "CANCELED", clientNotification: "DISABLED" } });
    expect(evo.sent).toHaveLength(3);

    const logged = await prisma.chatMessage.findMany({ where: { contactId: contact.id, direction: "OUTBOUND" } });
    expect(logged).toHaveLength(3);
    const s = await prisma.chatSession.findFirstOrThrow({ where: { contactId: contact.id } });
    expect((s.recentOutbound as unknown[]).length).toBe(3);
    // O aviso não pausa o bot do cliente.
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).botPausedUntil).toBeNull();
  });

  it("repetir a criação (idempotência) e remarcar para o mesmo horário não reavisam", async () => {
    const w = await makeWorld("idem");
    const contact = await makeContact(w);
    as(w);
    const at = startsAt();
    const key = randomUUID();
    const r1 = await createAppointmentAction(w.tenant.slug, { contactId: contact.id, serviceId: w.service.id, professionalId: w.professional.id, startsAt: at, idempotencyKey: key });
    const r2 = await createAppointmentAction(w.tenant.slug, { contactId: contact.id, serviceId: w.service.id, professionalId: w.professional.id, startsAt: at, idempotencyKey: key });
    expect(r1.ok && (r1.data as { clientNotification: string }).clientNotification).toBe("SENT");
    expect(r2.ok && (r2.data as { clientNotification: string }).clientNotification).toBe("DISABLED");
    expect(evo.sent).toHaveLength(1);
    const id = (r1.ok && (r1.data as { appointment: { id: string } }).appointment.id) as string;
    const same = await rescheduleAppointmentAction(w.tenant.slug, id, { startsAt: at });
    expect(same).toMatchObject({ ok: true, data: { clientNotification: "DISABLED" } });
    expect(evo.sent).toHaveLength(1);
  });

  it("toggle desligado: DISABLED, nada enviado", async () => {
    const w = await makeWorld("off", { notify: false });
    const contact = await makeContact(w);
    as(w);
    const created = await book(w, contact.id);
    expect(created.clientNotification).toBe("DISABLED");
    expect(evo.sent).toHaveLength(0);
    expect(await prisma.chatMessage.count({ where: { contactId: contact.id } })).toBe(0);
  });

  it("sem telefone: NO_PHONE; sem instância conectada: NO_WHATSAPP — e o agendamento existe nos dois casos", async () => {
    const w = await makeWorld("nophone");
    const noPhone = await makeContact(w, { noPhone: true });
    as(w);
    const a = await book(w, noPhone.id);
    expect(a.clientNotification).toBe("NO_PHONE");
    expect(await prisma.appointment.count({ where: { id: a.appointment.id, status: "SCHEDULED" } })).toBe(1);

    const w2 = await makeWorld("nowa", { instance: { status: "DISCONNECTED" } });
    const c2 = await makeContact(w2);
    as(w2);
    const b = await book(w2, c2.id);
    expect(b.clientNotification).toBe("NO_WHATSAPP");
    expect(await prisma.appointment.count({ where: { id: b.appointment.id, status: "SCHEDULED" } })).toBe(1);
    expect(evo.sent).toHaveLength(0);
  });

  it("falha de envio devolve FAILED e NÃO desfaz a operação (criar, remarcar e cancelar)", async () => {
    const w = await makeWorld("fail");
    const contact = await makeContact(w);
    as(w);
    evo.fail = new EvolutionApiError("boom", 503);
    const created = await book(w, contact.id);
    expect(created.clientNotification).toBe("FAILED");
    expect(await prisma.appointment.count({ where: { id: created.appointment.id, status: "SCHEDULED" } })).toBe(1);

    const moved = new Date(new Date(startsAt()).getTime() + 3 * HOUR).toISOString();
    const rescheduled = await rescheduleAppointmentAction(w.tenant.slug, created.appointment.id, { startsAt: moved });
    expect(rescheduled).toMatchObject({ ok: true, data: { clientNotification: "FAILED" } });
    expect((await prisma.appointment.findUniqueOrThrow({ where: { id: created.appointment.id } })).startsAt.toISOString()).toBe(moved);

    const canceled = await cancelAppointmentAction(w.tenant.slug, created.appointment.id);
    expect(canceled).toMatchObject({ ok: true, data: { status: "CANCELED", clientNotification: "FAILED" } });
    expect(await prisma.chatMessage.count({ where: { contactId: contact.id } })).toBe(0);
  });

  it("Evolution não configurada também vira NO_WHATSAPP, sem lançar", async () => {
    const w = await makeWorld("noevo");
    const contact = await makeContact(w);
    as(w);
    evo.available = false;
    const created = await book(w, contact.id);
    expect(created.clientNotification).toBe("NO_WHATSAPP");
  });

  it("concluir NÃO avisa o cliente", async () => {
    const w = await makeWorld("finish");
    const contact = await makeContact(w);
    as(w);
    const past = await prisma.appointment.create({
      data: {
        tenantId: w.tenant.id,
        contactId: contact.id,
        serviceId: w.service.id,
        professionalId: w.professional.id,
        startsAt: new Date(Date.now() - 3 * HOUR),
        endsAt: new Date(Date.now() - 2 * HOUR),
        blockEndsAt: new Date(Date.now() - 2 * HOUR),
        status: "SCHEDULED",
        source: "PANEL",
      },
    });
    const r = await completeAppointmentAction({ tenantSlug: w.tenant.slug, appointmentId: past.id });
    expect(r.ok).toBe(true);
    expect(evo.sent).toHaveLength(0);
  });
});

describe("configurações: notifyClientOnStaffChanges", () => {
  it("leitura por qualquer membro, escrita só pelo OWNER, e omitir o campo não altera", async () => {
    const owner = await makeWorld("rules");
    as(owner);
    const read = await getBotRulesAction(owner.tenant.slug);
    expect(read.ok && read.data.notifyClientOnStaffChanges).toBe(true);
    const base = { maxFutureAppointmentsPerContact: 3, slotGranularityMin: 30, handoffResumeMinutes: 120 };
    const off = await updateBotRulesAction(owner.tenant.slug, { ...base, notifyClientOnStaffChanges: false });
    expect(off.ok && off.data.notifyClientOnStaffChanges).toBe(false);
    const keep = await updateBotRulesAction(owner.tenant.slug, base);
    expect(keep.ok && keep.data.notifyClientOnStaffChanges).toBe(false);
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: owner.tenant.id } })).notifyClientOnStaffChanges).toBe(false);
    const bad = await updateBotRulesAction(owner.tenant.slug, { ...base, notifyClientOnStaffChanges: "sim" });
    expect(bad).toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });

    const staff = await makeWorld("rulesstaff", { role: "STAFF" });
    as(staff);
    expect((await getBotRulesAction(staff.tenant.slug)).ok).toBe(true);
    expect(await updateBotRulesAction(staff.tenant.slug, { ...base, notifyClientOnStaffChanges: false })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });
});

describe("endurecimento pós-revisão (Órion)", () => {
  const send = (w: World, contactId: string, text: string, clientMessageId?: string) =>
    sendAgentMessageAction({ tenantSlug: w.tenant.slug, contactId, text, clientMessageId });

  describe("1. dedup por clientMessageId", () => {
    it("repetir o mesmo id devolve a mesma resposta e envia UMA vez", async () => {
      const w = await makeWorld("dedup");
      const contact = await makeContact(w);
      as(w);
      const id = randomUUID();
      const first = await send(w, contact.id, "Já te respondo", id);
      const again = await send(w, contact.id, "Já te respondo", id);
      expect(first.ok && again.ok).toBe(true);
      if (!first.ok || !again.ok) return;
      expect(again.data.message.id).toBe(first.data.message.id);
      expect(evo.sent).toHaveLength(1);
      expect(await prisma.chatMessage.count({ where: { contactId: contact.id, direction: "OUTBOUND" } })).toBe(1);
      // Outro id = outra mensagem.
      await send(w, contact.id, "Já te respondo", randomUUID());
      expect(evo.sent).toHaveLength(2);
    });

    it("duas chamadas simultâneas com o mesmo id: uma execução só, ambas recebem o mesmo resultado", async () => {
      const w = await makeWorld("dedupconc");
      const contact = await makeContact(w);
      as(w);
      const id = randomUUID();
      const [a, b] = await Promise.all([send(w, contact.id, "Oi", id), send(w, contact.id, "Oi", id)]);
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) return;
      expect(a.data.message.id).toBe(b.data.message.id);
      expect(evo.sent).toHaveLength(1);
    });

    it("falha não fica guardada: repetir o mesmo id depois de SEND_FAILED envia de verdade", async () => {
      const w = await makeWorld("dedupfail");
      const contact = await makeContact(w);
      as(w);
      const id = randomUUID();
      evo.fail = true;
      expect(await send(w, contact.id, "Oi", id)).toMatchObject({ ok: false, error: { code: "SEND_FAILED" } });
      evo.fail = false;
      expect((await send(w, contact.id, "Oi", id)).ok).toBe(true);
      expect(evo.sent).toHaveLength(1);
    });

    it("a repetição deduplicada não gasta o teto de 20/min; id que não é uuid é INVALID_PAYLOAD", async () => {
      const w = await makeWorld("dedupcap");
      const contact = await makeContact(w);
      as(w);
      const id = randomUUID();
      for (let i = 0; i < 30; i += 1) expect((await send(w, contact.id, "Oi", id)).ok).toBe(true);
      expect(evo.sent).toHaveLength(1);
      expect(await send(w, contact.id, "Oi", "nao-e-uuid")).toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });
    });

    it("a chave inclui empresa e usuário: o mesmo id em OUTRA empresa não é deduplicado", async () => {
      const w1 = await makeWorld("dedupu1");
      const w2 = await makeWorld("dedupu2");
      const c1 = await makeContact(w1);
      const c2 = await makeContact(w2);
      const id = randomUUID();
      as(w1);
      await send(w1, c1.id, "Oi", id);
      as(w2);
      await send(w2, c2.id, "Oi", id);
      expect(evo.sent).toHaveLength(2);
    });
  });

  describe("2. teto por contato e por empresa", () => {
    it("envio manual: passou do teto por contato na hora dá RATE_LIMITED com retryAfterMs; outro contato segue", async () => {
      const w = await makeWorld("capmanual");
      const contact = await makeContact(w);
      const other = await makeContact(w);
      as(w);
      for (let i = 0; i < OUTBOUND_LIMIT_PER_CONTACT_PER_HOUR; i += 1) expect((await send(w, contact.id, `m${i}`)).ok).toBe(true);
      const blocked = await send(w, contact.id, "estourou");
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.error.code).toBe("RATE_LIMITED");
      const details = blocked.error.details as { retryAfterMs: number };
      expect(details.retryAfterMs).toBeGreaterThan(0);
      expect(evo.sent).toHaveLength(OUTBOUND_LIMIT_PER_CONTACT_PER_HOUR);
      expect(await prisma.chatMessage.count({ where: { contactId: contact.id, body: "estourou" } })).toBe(0);
      expect((await send(w, other.id, "outro")).ok).toBe(true);
    });

    it("aviso automático estourado: não envia, devolve RATE_LIMITED e o agendamento é salvo mesmo assim", async () => {
      const w = await makeWorld("capnotify");
      const contact = await makeContact(w);
      as(w);
      for (let i = 0; i < OUTBOUND_LIMIT_PER_CONTACT_PER_HOUR; i += 1) await send(w, contact.id, `m${i}`);
      const at = new Date(Date.now() + 5 * 24 * HOUR);
      at.setUTCHours(15, 0, 0, 0);
      const r = await createAppointmentAction(w.tenant.slug, {
        contactId: contact.id,
        serviceId: w.service.id,
        professionalId: w.professional.id,
        startsAt: at.toISOString(),
      });
      expect(r).toMatchObject({ ok: true, data: { clientNotification: "RATE_LIMITED" } });
      expect(evo.sent).toHaveLength(OUTBOUND_LIMIT_PER_CONTACT_PER_HOUR);
      expect(await prisma.appointment.count({ where: { contactId: contact.id, status: "SCHEDULED" } })).toBe(1);
    });

    it("HANDOFF_CLOSED estourado: encerra do mesmo jeito, clientNotified=false, nada enviado", async () => {
      const w = await makeWorld("capclose");
      const contact = await makeContact(w);
      const handoff = await makeHandoff(w, contact.id);
      as(w);
      for (let i = 0; i < OUTBOUND_LIMIT_PER_CONTACT_PER_HOUR; i += 1) await send(w, contact.id, `m${i}`);
      const r = await closeAttendanceAction({ tenantSlug: w.tenant.slug, contactId: contact.id });
      expect(r).toEqual({ ok: true, data: { closed: true, clientNotified: false } });
      expect(evo.sent).toHaveLength(OUTBOUND_LIMIT_PER_CONTACT_PER_HOUR);
      expect((await prisma.handoffRequest.findUniqueOrThrow({ where: { id: handoff.id } })).endedAt).not.toBeNull();
    });

    it("teto da empresa vale para todos os contatos e não vaza para outra empresa", async () => {
      const w = await makeWorld("captenant");
      const other = await makeWorld("captenant2");
      const perContact = OUTBOUND_LIMIT_PER_CONTACT_PER_HOUR;
      const contacts = [];
      for (let i = 0; i < OUTBOUND_LIMIT_PER_TENANT_PER_HOUR / perContact; i += 1) contacts.push(await makeContact(w));
      for (const c of contacts) {
        for (let i = 0; i < perContact; i += 1) {
          const r = await sendTextToContact({ tenantId: w.tenant.id, contactId: c.id, text: `x${i}` });
          expect(r.outcome).toBe("SENT");
        }
      }
      const extra = await makeContact(w);
      const blocked = await sendTextToContact({ tenantId: w.tenant.id, contactId: extra.id, text: "estourou" });
      expect(blocked).toMatchObject({ outcome: "RATE_LIMITED", scope: "TENANT" });
      const otherContact = await makeContact(other);
      expect((await sendTextToContact({ tenantId: other.tenant.id, contactId: otherContact.id, text: "livre" })).outcome).toBe("SENT");
    }, 60_000);
  });

  describe("3. corrida enviar x encerrar", () => {
    it("envio concorrente com o encerrar (pedido aberto) NÃO re-pausa o bot", async () => {
      const w = await makeWorld("racecl");
      const contact = await makeContact(w);
      const handoff = await makeHandoff(w, contact.id);
      // Como no bot real: a sessão em HUMAN tem humanUntil (é o que o "Encerrar" limpa).
      await prisma.chatSession.updateMany({ where: { contactId: contact.id }, data: { humanUntil: new Date(Date.now() + HOUR) } });
      as(w);
      // O "Encerrar" acontece enquanto a Evolution ainda está enviando a mensagem do atendente.
      evo.beforeSend = async () => {
        const r = await closeAttendanceAction({ tenantSlug: w.tenant.slug, contactId: contact.id });
        expect(r.ok).toBe(true);
      };
      const sent = await send(w, contact.id, "Só um instante");
      expect(sent.ok).toBe(true);
      const s = await prisma.chatSession.findFirstOrThrow({ where: { contactId: contact.id } });
      expect(s.state).toBe("MAIN_MENU");
      expect(s.humanUntil).toBeNull();
      const h = await prisma.handoffRequest.findUniqueOrThrow({ where: { id: handoff.id } });
      expect(h.endedAt).not.toBeNull();
      expect(h.answeredAt).toBeNull();
      expect((await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).botPausedUntil).toBeNull();
    });

    it("sem corrida, com pedido aberto, continua estendendo a pausa e marcando a resposta", async () => {
      const w = await makeWorld("raceok");
      const contact = await makeContact(w);
      const handoff = await makeHandoff(w, contact.id);
      as(w);
      await send(w, contact.id, "Oi");
      const s = await prisma.chatSession.findFirstOrThrow({ where: { contactId: contact.id } });
      expect(s.state).toBe("HUMAN");
      expect(s.humanUntil!.getTime()).toBeGreaterThan(Date.now());
      expect((await prisma.handoffRequest.findUniqueOrThrow({ where: { id: handoff.id } })).answeredAt).not.toBeNull();
    });

    it("sem pedido aberto o envio manual continua pausando (comportamento anterior)", async () => {
      const w = await makeWorld("racenoreq");
      const contact = await makeContact(w);
      as(w);
      await send(w, contact.id, "Oi");
      expect((await prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).botPausedUntil!.getTime()).toBeGreaterThan(Date.now());
      expect((await prisma.chatSession.findFirstOrThrow({ where: { contactId: contact.id } })).state).toBe("HUMAN");
    });
  });

  describe("4. texto sanitizado", () => {
    it("a Evolution recebe o mesmo texto sanitizado que vai para o histórico (sem caracteres de controle)", async () => {
      const w = await makeWorld("sanit");
      const contact = await makeContact(w);
      as(w);
      const res = await send(w, contact.id, "  Ol\u0000á\u0007, tudo\u001F bem?  ");
      expect(res.ok).toBe(true);
      expect(evo.sent).toHaveLength(1);
      expect(evo.sent[0].text).toBe("Olá, tudo bem?");
      const row = await prisma.chatMessage.findFirstOrThrow({ where: { contactId: contact.id, direction: "OUTBOUND" } });
      expect(row.body).toBe(evo.sent[0].text);
      if (res.ok) expect(res.data.message.body).toBe(evo.sent[0].text);
    });

    it("só caracteres de controle vira TEXT_EMPTY (nada enviado)", async () => {
      const w = await makeWorld("sanitempty");
      const contact = await makeContact(w);
      as(w);
      expect(await send(w, contact.id, "\u0000\u0007")).toMatchObject({ ok: false, error: { code: "TEXT_EMPTY" } });
      expect(evo.sent).toHaveLength(0);
    });
  });
});
