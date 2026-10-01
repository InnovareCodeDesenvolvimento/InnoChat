/**
 * Lembrete de véspera ao cliente final (WhatsApp) + configurações do lembrete, contra Postgres real.
 * O cliente da Evolution é um dublê injetado (`runReminderTick(now, { evolution })`); o "agora" é
 * fixo (2026-10-01 12:00 em São Paulo) para a janela de silêncio e o "hoje/amanhã" serem
 * determinísticos. As asserções filtram pelas instâncias DESTE arquivo — o tick varre o banco
 * inteiro e sobras de outros testes não podem contaminar a contagem.
 */
import { createHash, randomUUID } from "node:crypto";
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

import {
  REMINDER_MAX_ATTEMPTS,
  REMINDER_SEND_GAP_MAX_MS,
  REMINDER_SEND_GAP_MIN_MS,
  REMINDER_TENANT_BATCH_LIMIT,
  registerOutboundEcho,
  resetReminderFailureMemory,
  runReminderTick,
} from "@/modules/reminders/tick";
import { getReminderSettingsAction, updateReminderSettingsAction } from "@/modules/reminders/actions";
import { rescheduleAppointment } from "@/modules/agenda/appointments";
import { createProfessional, createService, setProfessionalServices, setProfessionalWorkingHours } from "@/modules/agenda/catalog";
import { DEFAULT_BOT_TEXTS } from "@/core/bot/texts";

const prisma = getPrisma();
/** Sem pausa real entre envios (o ritmo é testado à parte, com relógio falso). */
const FAST = { sleep: async () => {} };
const HOUR = 3_600_000;
const NOW = new Date("2026-10-01T15:00:00Z"); // 12:00 em America/Sao_Paulo
const tenantIds: string[] = [];
const planIds: string[] = [];
const userIds: string[] = [];

type Sent = { instanceName: string; number: string; text: string };

function fakeEvolution(opts: { fail?: boolean | Error } = {}) {
  const sent: Sent[] = [];
  const client = {
    sendText: vi.fn(async (instanceName: string, number: string, text: string) => {
      if (opts.fail) throw opts.fail instanceof Error ? opts.fail : new Error("evolution fora do ar");
      sent.push({ instanceName, number, text });
      return { messageId: `MSG-${randomUUID()}` };
    }),
  } as unknown as EvolutionClient;
  return { client, sent };
}

async function makeWorld(
  label: string,
  opts: {
    subscription?: "TRIALING" | "SUSPENDED";
    reminderEnabled?: boolean;
    hoursBefore?: number;
    instance?: { status?: "CONNECTED" | "DISCONNECTED"; sandbox?: boolean } | null;
    role?: "OWNER" | "STAFF";
  } = {},
) {
  const tenant = await prisma.tenant.create({
    data: {
      slug: `it-rem-${label}-${randomUUID().slice(0, 8)}`,
      name: `Studio ${label}`,
      timezone: "America/Sao_Paulo",
      reminderEnabled: opts.reminderEnabled ?? true,
      reminderHoursBefore: opts.hoursBefore ?? 24,
    },
  });
  tenantIds.push(tenant.id);
  const plan = await prisma.plan.create({
    data: { code: `it-rem-${randomUUID().slice(0, 8)}`, name: "Plano IT", priceCents: 4990, maxWhatsappNumbers: 5, maxProfessionals: 50, active: false, sortOrder: 999 },
  });
  planIds.push(plan.id);
  const suspended = opts.subscription === "SUSPENDED";
  const periodEnd = new Date(suspended ? "2026-01-01T00:00:00Z" : "2026-12-01T00:00:00Z");
  await prisma.subscription.create({
    data: { tenantId: tenant.id, planId: plan.id, status: suspended ? "SUSPENDED" : "TRIALING", trialEndsAt: suspended ? null : periodEnd, currentPeriodEnd: periodEnd },
  });
  const instance =
    opts.instance === null
      ? null
      : await prisma.whatsappInstance.create({
          data: {
            tenantId: tenant.id,
            instanceName: `inst-rem-${label}-${randomUUID().slice(0, 8)}`,
            label: "Principal",
            webhookToken: randomUUID(),
            status: opts.instance?.status ?? "CONNECTED",
            sandbox: opts.instance?.sandbox ?? false,
          },
        });
  const service = await prisma.service.create({ data: { tenantId: tenant.id, name: "Massagem", durationMin: 30 } });
  const professional = await prisma.professional.create({ data: { tenantId: tenant.id, name: "Ana" } });
  const user = await prisma.user.create({ data: { email: `rem-${randomUUID().slice(0, 8)}@example.test`, passwordHash: "x" } });
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

async function makeContact(w: World, opts: { name?: string | null; botPausedUntil?: Date | null; humanUntil?: Date | null } = {}) {
  const contact = await prisma.contact.create({
    data: {
      tenantId: w.tenant.id,
      waJid: `5511${Math.floor(100000000 + Math.random() * 899999999)}@s.whatsapp.net`,
      name: opts.name === undefined ? "Júnior Rocha" : opts.name,
      botPausedUntil: opts.botPausedUntil ?? null,
    },
  });
  if (opts.humanUntil && w.instance) {
    await prisma.chatSession.create({
      data: { whatsappInstanceId: w.instance.id, contactId: contact.id, state: "HUMAN", humanUntil: opts.humanUntil },
    });
  }
  return contact;
}

async function makeAppointment(
  w: World,
  contactId: string,
  startsAt: Date,
  opts: { status?: "SCHEDULED" | "CANCELED"; reminderSentAt?: Date | null; whatsappInstanceId?: string | null } = {},
) {
  const professional = await prisma.professional.create({ data: { tenantId: w.tenant.id, name: "Ana" } });
  return prisma.appointment.create({
    data: {
      tenantId: w.tenant.id,
      contactId,
      serviceId: w.service.id,
      professionalId: professional.id,
      whatsappInstanceId: opts.whatsappInstanceId === undefined ? (w.instance?.id ?? null) : opts.whatsappInstanceId,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 30 * 60_000),
      blockEndsAt: new Date(startsAt.getTime() + 30 * 60_000),
      status: opts.status ?? "SCHEDULED",
      reminderSentAt: opts.reminderSentAt ?? null,
    },
  });
}

const at = (hoursFromNow: number) => new Date(NOW.getTime() + hoursFromNow * HOUR);
const sentBy = (sent: Sent[], w: World) => sent.filter((s) => s.instanceName === w.instance?.instanceName);
const reminderOf = async (id: string) => (await prisma.appointment.findUniqueOrThrow({ where: { id } })).reminderSentAt;

beforeEach(() => {
  session.ctx = null;
  resetReminderFailureMemory();
});

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.plan.deleteMany({ where: { id: { in: planIds } } });
  await prisma.$disconnect();
});

describe("lembrete de véspera — seleção e envio", () => {
  it("envia só para SCHEDULED dentro de (2h, hoursBefore]; marca reminderSentAt, grava ChatMessage OUTBOUND e registra o eco na sessão", async () => {
    const w = await makeWorld("sel");
    const contact = await makeContact(w);
    const inWindow = await makeAppointment(w, contact.id, at(20));
    const edge = await makeAppointment(w, contact.id, at(24)); // limite superior é inclusivo
    const tooFar = await makeAppointment(w, contact.id, at(30));
    const tooSoon = await makeAppointment(w, contact.id, at(1.5));
    const exactly2h = await makeAppointment(w, contact.id, at(2)); // limite inferior é exclusivo
    const canceled = await makeAppointment(w, contact.id, at(10), { status: "CANCELED" });
    const alreadySent = await makeAppointment(w, contact.id, at(12), { reminderSentAt: new Date("2026-10-01T10:00:00Z") });
    const { client, sent } = fakeEvolution();

    await runReminderTick(NOW, { evolution: client, ...FAST });

    expect(sentBy(sent, w)).toHaveLength(2);
    expect(await reminderOf(inWindow.id)).toEqual(NOW);
    expect(await reminderOf(edge.id)).toEqual(NOW);
    for (const a of [tooFar, tooSoon, exactly2h, canceled]) expect(await reminderOf(a.id)).toBeNull();
    expect((await reminderOf(alreadySent.id))?.toISOString()).toBe("2026-10-01T10:00:00.000Z");

    const first = sentBy(sent, w)[0]!;
    expect(first.number).toBe(contact.waJid.split("@")[0]);
    expect(first.text).toContain("Júnior");
    expect(first.text).toContain("Massagem");
    expect(first.text).toContain("Ana");
    expect(first.text).toContain("amanhã"); // +20h a partir das 12:00 de 01/10 = 08:00 de 02/10
  });

  it("texto: {quando} = 'amanhã' para o dia seguinte e termina com a instrução 'responda *menu*'", async () => {
    const w = await makeWorld("txt");
    const contact = await makeContact(w, { name: "Maria Souza" });
    await makeAppointment(w, contact.id, at(22)); // 10:00 de 02/10 (local)
    const { client, sent } = fakeEvolution();

    await runReminderTick(NOW, { evolution: client, ...FAST });

    const [only] = sentBy(sent, w);
    expect(only!.text).toBe("Oi, Maria! Passando pra lembrar: você tem Massagem com Ana amanhã às 10:00.\nSe precisar remarcar ou cancelar, responda *menu*.");
    expect(DEFAULT_BOT_TEXTS.REMINDER).toContain("{quando}");

    const messages = await prisma.chatMessage.findMany({ where: { tenantId: w.tenant.id } });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ direction: "OUTBOUND", contactId: contact.id, whatsappInstanceId: w.instance!.id, body: only!.text });
    expect(messages[0]!.providerMessageId).toMatch(/^MSG-/);

    // Eco registrado: o `claim` não pode tratar o `fromMe` do lembrete como "humano assumiu".
    const chatSession = await prisma.chatSession.findFirstOrThrow({ where: { contactId: contact.id } });
    expect(Array.isArray(chatSession.recentOutbound) && (chatSession.recentOutbound as unknown[]).length).toBe(1);
  });

  it("usa o BotText REMINDER editado pela empresa, com as variáveis (inclui {data} e {empresa})", async () => {
    const w = await makeWorld("custom");
    await prisma.botText.create({ data: { tenantId: w.tenant.id, key: "REMINDER", text: "Oi {nome}, {empresa}: {servico} dia {data} às {hora} ({quando})." } });
    const contact = await makeContact(w, { name: "Ana Paula" });
    await makeAppointment(w, contact.id, at(22));
    const { client, sent } = fakeEvolution();

    await runReminderTick(NOW, { evolution: client, ...FAST });

    expect(sentBy(sent, w)[0]!.text).toBe("Oi Ana, Studio custom: Massagem dia Sex 02/10 às 10:00 (amanhã).");
  });

  it("respeita reminderHoursBefore da empresa (2h a 48h)", async () => {
    const w = await makeWorld("hours", { hoursBefore: 6 });
    const contact = await makeContact(w);
    const near = await makeAppointment(w, contact.id, at(5));
    const far = await makeAppointment(w, contact.id, at(20));
    const { client, sent } = fakeEvolution();

    await runReminderTick(NOW, { evolution: client, ...FAST });

    expect(sentBy(sent, w)).toHaveLength(1);
    expect(await reminderOf(near.id)).not.toBeNull();
    expect(await reminderOf(far.id)).toBeNull();
  });

  it("empresa com lembrete desligado, sem número CONNECTED ou só com instância sandbox não envia", async () => {
    const off = await makeWorld("off", { reminderEnabled: false });
    const disconnected = await makeWorld("disc", { instance: { status: "DISCONNECTED" } });
    const sandbox = await makeWorld("sbx", { instance: { sandbox: true } });
    const none = await makeWorld("none", { instance: null });
    const appts: string[] = [];
    for (const w of [off, disconnected, sandbox, none]) {
      const c = await makeContact(w);
      appts.push((await makeAppointment(w, c.id, at(10), { whatsappInstanceId: null })).id);
    }
    const { client, sent } = fakeEvolution();

    await runReminderTick(NOW, { evolution: client, ...FAST });

    for (const id of appts) expect(await reminderOf(id)).toBeNull();
    for (const w of [off, disconnected, sandbox, none]) expect(sentBy(sent, w)).toHaveLength(0);
  });

  it("usa a instância do agendamento; se ela caiu, a primeira conectada da empresa", async () => {
    const w = await makeWorld("inst");
    const other = await prisma.whatsappInstance.create({
      data: { tenantId: w.tenant.id, instanceName: `inst-rem-other-${randomUUID().slice(0, 8)}`, label: "Segundo", webhookToken: randomUUID(), status: "CONNECTED" },
    });
    const dead = await prisma.whatsappInstance.create({
      data: { tenantId: w.tenant.id, instanceName: `inst-rem-dead-${randomUUID().slice(0, 8)}`, label: "Caído", webhookToken: randomUUID(), status: "DISCONNECTED" },
    });
    const c1 = await makeContact(w);
    const c2 = await makeContact(w);
    await makeAppointment(w, c1.id, at(10), { whatsappInstanceId: other.id });
    await makeAppointment(w, c2.id, at(11), { whatsappInstanceId: dead.id });
    const { client, sent } = fakeEvolution();

    await runReminderTick(NOW, { evolution: client, ...FAST });

    const names = sent.filter((s) => [w.instance!.instanceName, other.instanceName, dead.instanceName].includes(s.instanceName)).map((s) => s.instanceName);
    expect(names).toEqual([other.instanceName, w.instance!.instanceName]); // ordenado por horário
  });
});

describe("lembrete de véspera — pausado, suspenso e silêncio", () => {
  it("bot pausado para o cliente (Clientes → pausar, ou atendente humano ativo) não recebe; pausa vencida recebe", async () => {
    const w = await makeWorld("pause");
    const paused = await makeContact(w, { botPausedUntil: at(5) });
    const human = await makeContact(w, { humanUntil: at(5) });
    const expired = await makeContact(w, { botPausedUntil: at(-1) });
    const a1 = await makeAppointment(w, paused.id, at(10));
    const a2 = await makeAppointment(w, human.id, at(10));
    const a3 = await makeAppointment(w, expired.id, at(10));
    const { client, sent } = fakeEvolution();

    await runReminderTick(NOW, { evolution: client, ...FAST });

    expect(sentBy(sent, w)).toHaveLength(1);
    expect(await reminderOf(a1.id)).toBeNull();
    expect(await reminderOf(a2.id)).toBeNull();
    expect(await reminderOf(a3.id)).not.toBeNull();
  });

  it("assinatura SUSPENDED (efetiva) não recebe", async () => {
    const w = await makeWorld("susp", { subscription: "SUSPENDED" });
    const contact = await makeContact(w);
    const appt = await makeAppointment(w, contact.id, at(10));
    const { client, sent } = fakeEvolution();

    await runReminderTick(NOW, { evolution: client, ...FAST });

    expect(sentBy(sent, w)).toHaveLength(0);
    expect(await reminderOf(appt.id)).toBeNull();
  });

  it("fora de 08:00–21:00 locais não envia; no próximo tick dentro da janela (ainda > 2h) envia", async () => {
    const w = await makeWorld("quiet");
    const contact = await makeContact(w);
    // 02/10 12:00Z = 09:00 local. Às 23:00 locais de 01/10 (02:00Z) faltam 10h.
    const appt = await makeAppointment(w, contact.id, new Date("2026-10-02T12:00:00Z"));
    const night = new Date("2026-10-02T02:00:00Z"); // 23:00 local
    const { client, sent } = fakeEvolution();

    await runReminderTick(night, { evolution: client, ...FAST });
    expect(sentBy(sent, w)).toHaveLength(0);
    expect(await reminderOf(appt.id)).toBeNull();

    const morning = new Date("2026-10-02T11:00:00Z"); // 08:00 local — faltam 1h → NÃO envia (< 2h)
    await runReminderTick(morning, { evolution: client, ...FAST });
    expect(sentBy(sent, w)).toHaveLength(0);

    const early = new Date("2026-10-02T09:59:00Z"); // 06:59 local → silêncio
    await runReminderTick(early, { evolution: client, ...FAST });
    expect(sentBy(sent, w)).toHaveLength(0);

    // Compromisso mais tarde (13:00 local): às 08:00 local faltam 5h → envia no 1º tick da janela.
    const later = await makeAppointment(w, contact.id, new Date("2026-10-02T16:00:00Z"));
    await runReminderTick(morning, { evolution: client, ...FAST });
    expect(sentBy(sent, w)).toHaveLength(1);
    expect(await reminderOf(later.id)).toEqual(morning);
  });
});

describe("lembrete de véspera — idempotência, concorrência e falha", () => {
  it("rodar de novo não reenvia; dois ticks concorrentes enviam UMA vez", async () => {
    const w = await makeWorld("idem");
    const contact = await makeContact(w);
    const appt = await makeAppointment(w, contact.id, at(10));
    const { client, sent } = fakeEvolution();

    await Promise.all([runReminderTick(NOW, { evolution: client, ...FAST }), runReminderTick(NOW, { evolution: client, ...FAST }), runReminderTick(NOW, { evolution: client, ...FAST })]);
    expect(sentBy(sent, w)).toHaveLength(1);

    await runReminderTick(new Date(NOW.getTime() + HOUR), { evolution: client, ...FAST });
    expect(sentBy(sent, w)).toHaveLength(1);
    expect(await reminderOf(appt.id)).toEqual(NOW);
  });

  it("falha no envio desfaz a reserva (reminderSentAt volta a nulo), não grava histórico e para de tentar após o limite", async () => {
    const w = await makeWorld("fail");
    const contact = await makeContact(w);
    const appt = await makeAppointment(w, contact.id, at(10));
    const failing = fakeEvolution({ fail: true });

    const first = await runReminderTick(NOW, { evolution: failing.client, ...FAST });
    expect(first.remindersToClientsFailed).toBeGreaterThanOrEqual(1);
    expect(await reminderOf(appt.id)).toBeNull();
    expect(await prisma.chatMessage.count({ where: { tenantId: w.tenant.id } })).toBe(0);

    for (let i = 1; i < REMINDER_MAX_ATTEMPTS + 2; i++) await runReminderTick(new Date(NOW.getTime() + i * HOUR), { evolution: failing.client, ...FAST });
    const callsForMine = (failing.client.sendText as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === w.instance!.instanceName);
    expect(callsForMine).toHaveLength(REMINDER_MAX_ATTEMPTS); // sem retry infinito
    expect(await reminderOf(appt.id)).toBeNull();
  });

  it("falha numa tentativa e sucesso na seguinte: envia e marca", async () => {
    const w = await makeWorld("retry");
    const contact = await makeContact(w);
    const appt = await makeAppointment(w, contact.id, at(10));

    await runReminderTick(NOW, { evolution: fakeEvolution({ fail: true }).client, ...FAST });
    expect(await reminderOf(appt.id)).toBeNull();

    const ok = fakeEvolution();
    const later = new Date(NOW.getTime() + HOUR);
    await runReminderTick(later, { evolution: ok.client, ...FAST });
    expect(sentBy(ok.sent, w)).toHaveLength(1);
    expect(await reminderOf(appt.id)).toEqual(later);
  });
});

describe("remarcar zera reminderSentAt", () => {
  it("rescheduleAppointment (painel, bot e arrastar usam esta função) → reminderSentAt volta a nulo", async () => {
    const tenant = await prisma.tenant.create({
      data: { slug: `it-rem-resch-${randomUUID().slice(0, 8)}`, name: "Resch", timezone: "UTC", minLeadTimeMin: 0, cancelMinLeadMin: 0, maxHorizonDays: 60 },
    });
    tenantIds.push(tenant.id);
    const service = await createService(tenant.id, { name: "Corte", durationMin: 30, bufferAfterMin: 0, priceCents: null, active: true, sortOrder: 0 });
    const professional = await createProfessional(tenant.id, { name: "Pro", active: true, sortOrder: 0 });
    await setProfessionalServices(tenant.id, professional.id, [service.id]);
    const first = new Date(Date.now() + 5 * 24 * HOUR);
    first.setUTCHours(14, 0, 0, 0);
    const next = new Date(first.getTime() + 2 * HOUR);
    await setProfessionalWorkingHours(
      tenant.id,
      professional.id,
      [first.getUTCDay()].map((weekday) => ({ weekday, startTime: "00:00", endTime: "23:59" })),
    );
    const contact = await prisma.contact.create({ data: { tenantId: tenant.id, waJid: `5511${Math.floor(100000000 + Math.random() * 899999999)}@s.whatsapp.net` } });
    const appt = await prisma.appointment.create({
      data: {
        tenantId: tenant.id,
        contactId: contact.id,
        serviceId: service.id,
        professionalId: professional.id,
        startsAt: first,
        endsAt: new Date(first.getTime() + 30 * 60_000),
        blockEndsAt: new Date(first.getTime() + 30 * 60_000),
        reminderSentAt: new Date(),
      },
    });

    await rescheduleAppointment(tenant.id, appt.id, next, "actor-x");

    const after = await prisma.appointment.findUniqueOrThrow({ where: { id: appt.id } });
    expect(after.startsAt).toEqual(next);
    expect(after.reminderSentAt).toBeNull();
  });
});

describe("get/updateReminderSettingsAction", () => {
  it("lê o padrão (ligado, 24h); OWNER edita; STAFF só lê", async () => {
    const owner = await makeWorld("set-owner");
    session.ctx = owner.ctx;
    expect(await getReminderSettingsAction({ tenantSlug: owner.tenant.slug })).toEqual({ ok: true, data: { enabled: true, hoursBefore: 24 } });

    const updated = await updateReminderSettingsAction({ tenantSlug: owner.tenant.slug, enabled: false, hoursBefore: 48 });
    expect(updated).toEqual({ ok: true, data: { enabled: false, hoursBefore: 48 } });
    expect(await getReminderSettingsAction({ tenantSlug: owner.tenant.slug })).toEqual({ ok: true, data: { enabled: false, hoursBefore: 48 } });

    const staff = await makeWorld("set-staff", { role: "STAFF" });
    session.ctx = staff.ctx;
    expect((await getReminderSettingsAction({ tenantSlug: staff.tenant.slug })).ok).toBe(true);
    const denied = await updateReminderSettingsAction({ tenantSlug: staff.tenant.slug, enabled: false, hoursBefore: 12 });
    expect(denied).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: staff.tenant.id } })).reminderEnabled).toBe(true);
  });

  it.each([
    [1, "abaixo de 2"],
    [49, "acima de 48"],
    [12.5, "não inteiro"],
    ["24", "string"],
  ])("hoursBefore=%s (%s) é rejeitado com INVALID_PAYLOAD e nada muda", async (...[hoursBefore]) => {
    const w = await makeWorld("set-val");
    session.ctx = w.ctx;
    const r = await updateReminderSettingsAction({ tenantSlug: w.tenant.slug, enabled: true, hoursBefore });
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: w.tenant.id } })).reminderHoursBefore).toBe(24);
  });

  it("aceita os limites 2 e 48 e exige enabled booleano", async () => {
    const w = await makeWorld("set-lim");
    session.ctx = w.ctx;
    expect(await updateReminderSettingsAction({ tenantSlug: w.tenant.slug, enabled: true, hoursBefore: 2 })).toMatchObject({ ok: true });
    expect(await updateReminderSettingsAction({ tenantSlug: w.tenant.slug, enabled: true, hoursBefore: 48 })).toMatchObject({ ok: true });
    expect(await updateReminderSettingsAction({ tenantSlug: w.tenant.slug, enabled: "sim", hoursBefore: 24 })).toMatchObject({ ok: false, error: { code: "INVALID_PAYLOAD" } });
  });

  it("empresa suspensa não edita (TENANT_SUSPENDED); outra empresa não é acessível (NOT_FOUND)", async () => {
    const w = await makeWorld("set-susp", { subscription: "SUSPENDED" });
    session.ctx = w.ctx;
    expect(await updateReminderSettingsAction({ tenantSlug: w.tenant.slug, enabled: false, hoursBefore: 24 })).toMatchObject({ ok: false, error: { code: "TENANT_SUSPENDED" } });

    const other = await makeWorld("set-other");
    expect(await getReminderSettingsAction({ tenantSlug: other.tenant.slug })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});

describe("lembrete de véspera — ritmo (teto por empresa, intervalo com jitter, orçamento de tempo)", () => {
  async function manyAppointments(w: World, n: number) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const contact = await makeContact(w);
      ids.push((await makeAppointment(w, contact.id, at(10 + i / 100))).id);
    }
    return ids;
  }

  it(`no máximo ${REMINDER_TENANT_BATCH_LIMIT} por empresa por rodada; o resto entra na rodada seguinte`, async () => {
    const w = await makeWorld("tenantcap");
    await manyAppointments(w, REMINDER_TENANT_BATCH_LIMIT + 5);
    const { client, sent } = fakeEvolution();

    await runReminderTick(NOW, { evolution: client, ...FAST });
    expect(sentBy(sent, w)).toHaveLength(REMINDER_TENANT_BATCH_LIMIT);

    await runReminderTick(new Date(NOW.getTime() + 60_000), { evolution: client, ...FAST });
    expect(sentBy(sent, w)).toHaveLength(REMINDER_TENANT_BATCH_LIMIT + 5);
  });

  it("pausa entre envios pelo mesmo número, dentro de 1,5–3 s (jitter), e nenhuma antes do primeiro", async () => {
    const w = await makeWorld("gap");
    await manyAppointments(w, 4);
    const { client, sent } = fakeEvolution();
    const pauses: number[] = [];
    let n = 0;

    await runReminderTick(NOW, { evolution: client, sleep: async (ms) => void pauses.push(ms), random: () => (n++ % 2 === 0 ? 0 : 1) });

    expect(sentBy(sent, w)).toHaveLength(4);
    expect(pauses).toHaveLength(3);
    for (const ms of pauses) {
      expect(ms).toBeGreaterThanOrEqual(REMINDER_SEND_GAP_MIN_MS);
      expect(ms).toBeLessThanOrEqual(REMINDER_SEND_GAP_MAX_MS);
    }
    expect(new Set(pauses).size).toBeGreaterThan(1); // não é constante
  });

  it("estourou o orçamento de tempo: para, deixa o resto sem reserva e a próxima rodada continua", async () => {
    const w = await makeWorld("budget");
    const ids = await manyAppointments(w, 10);
    const { client, sent } = fakeEvolution();
    let clock = 0;
    const deps = { evolution: client, clockMs: () => clock, sleep: async (ms: number) => void (clock += ms), random: () => 0, timeBudgetMs: 5_000 };

    await runReminderTick(NOW, deps);
    const firstRound = sentBy(sent, w).length;
    expect(firstRound).toBeGreaterThan(0);
    expect(firstRound).toBeLessThan(10);
    const pending = await prisma.appointment.count({ where: { id: { in: ids }, reminderSentAt: null } });
    expect(pending).toBe(10 - firstRound);

    clock = 0;
    await runReminderTick(new Date(NOW.getTime() + 60_000), deps);
    expect(sentBy(sent, w).length).toBeGreaterThan(firstRound);
  });
});

describe("lembrete de véspera — rollback só em falha transitória", () => {
  it("4xx permanente (número inválido): NÃO devolve a reserva e não tenta de novo", async () => {
    const w = await makeWorld("perm");
    const contact = await makeContact(w);
    const appt = await makeAppointment(w, contact.id, at(10));
    const rejecting = fakeEvolution({ fail: new EvolutionApiError("número não existe", 400) });

    const first = await runReminderTick(NOW, { evolution: rejecting.client, ...FAST });
    expect(first.remindersToClientsFailed).toBeGreaterThanOrEqual(1);
    expect(await reminderOf(appt.id)).toEqual(NOW);
    expect(await prisma.chatMessage.count({ where: { tenantId: w.tenant.id } })).toBe(0);

    const ok = fakeEvolution();
    await runReminderTick(new Date(NOW.getTime() + HOUR), { evolution: ok.client, ...FAST });
    expect(sentBy(ok.sent, w)).toHaveLength(0);
  });

  it.each([
    ["5xx", new EvolutionApiError("indisponível", 503)],
    ["429", new EvolutionApiError("muitas requisições", 429)],
    ["timeout/rede (sem status)", new EvolutionApiError("timeout")],
  ])("%s: devolve a reserva (tenta de novo depois)", async (_label, error) => {
    const w = await makeWorld("trans");
    const contact = await makeContact(w);
    const appt = await makeAppointment(w, contact.id, at(10));

    await runReminderTick(NOW, { evolution: fakeEvolution({ fail: error }).client, ...FAST });
    expect(await reminderOf(appt.id)).toBeNull();
  });
});

describe("lembrete de véspera — corrida com o bot em recentOutbound", () => {
  it("conversa com trava ativa (bot atendendo): não envia, não marca; liberada a trava, envia", async () => {
    const w = await makeWorld("lock");
    const contact = await makeContact(w);
    const appt = await makeAppointment(w, contact.id, at(10));
    const chatSession = await prisma.chatSession.create({
      data: {
        whatsappInstanceId: w.instance!.id,
        contactId: contact.id,
        state: "MAIN_MENU",
        lockToken: "tok",
        lockedUntil: new Date(Date.now() + 20_000),
      },
    });
    const { client, sent } = fakeEvolution();

    await runReminderTick(NOW, { evolution: client, ...FAST });
    expect(sentBy(sent, w)).toHaveLength(0);
    expect(await reminderOf(appt.id)).toBeNull();

    await prisma.chatSession.update({ where: { id: chatSession.id }, data: { lockToken: null, lockedUntil: null } });
    await runReminderTick(new Date(NOW.getTime() + 60_000), { evolution: client, ...FAST });
    expect(sentBy(sent, w)).toHaveLength(1);
  });

  it("appends concorrentes ao recentOutbound não perdem nenhum hash", async () => {
    const w = await makeWorld("echo");
    const contact = await makeContact(w);
    const texts = ["um", "dois", "três", "quatro"].map((t) => `lembrete ${t}`);

    const results = await Promise.all(texts.map((t) => registerOutboundEcho(w.instance!.id, contact.id, t, NOW)));

    expect(results).toEqual(["ok", "ok", "ok", "ok"]);
    const row = await prisma.chatSession.findUniqueOrThrow({
      where: { whatsappInstanceId_contactId: { whatsappInstanceId: w.instance!.id, contactId: contact.id } },
    });
    const hashes = (row.recentOutbound as { hash: string }[]).map((e) => e.hash);
    for (const t of texts) expect(hashes).toContain(createHash("sha256").update(t).digest("hex"));
  });

  it("trava ativa: registerOutboundEcho devolve busy e não altera a sessão", async () => {
    const w = await makeWorld("echobusy");
    const contact = await makeContact(w);
    const chatSession = await prisma.chatSession.create({
      data: { whatsappInstanceId: w.instance!.id, contactId: contact.id, state: "MAIN_MENU", lockToken: "t", lockedUntil: new Date(Date.now() + 20_000) },
    });

    expect(await registerOutboundEcho(w.instance!.id, contact.id, "x", NOW)).toBe("busy");
    expect((await prisma.chatSession.findUniqueOrThrow({ where: { id: chatSession.id } })).recentOutbound).toEqual([]);
  });
});
