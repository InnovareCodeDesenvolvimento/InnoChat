/**
 * Bot v2 — conversa (B-2, docs/bot-v2-plano.md §3.4/§3.5): claim v2, ciclo do atendente
 * (HandoffRequest), release com aviso TECH_ERROR e notificação derivada. Mesma convenção de
 * `bot-api-gaps.integration.test.ts`: chama a lógica de módulo direto, contra Postgres real.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import type { TenantContext } from "@/lib/auth/guards";
import type { InternalApiContext } from "@/modules/bot-api/internal-auth";
import { claimMessage, type ClaimProcessResult, type ClaimProcessResultV2 } from "@/modules/bot-api/claim";
import { releaseSession, updateSession } from "@/modules/bot-api/session";
import { ensureOpenHandoff } from "@/modules/bot-api/handoff";
import { readSandboxOutbox } from "@/modules/bot-api/sandbox-outbox";
import { setContactBotPaused } from "@/modules/contacts/contacts";
import { listNotifications, pollNotifications } from "@/modules/notifications/service";
import { BOT_TEXT_KEYS } from "@/core/bot/texts";
import { BOT_TEXT_KEYS_V2, DEFAULT_BOT_TEXTS_V2 } from "@/core/bot/texts-v2";

const evolutionSends: { instance: string; number: string; text: string }[] = [];
let evolutionShouldFail = false;

vi.mock("@/modules/whatsapp/evolution-client", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/modules/whatsapp/evolution-client")>();
  return {
    ...original,
    getEvolutionClient: async () => ({
      sendText: async (instance: string, number: string, text: string) => {
        if (evolutionShouldFail) throw new Error("evolution fora do ar");
        evolutionSends.push({ instance, number, text });
        return { messageId: `MSG-${evolutionSends.length}` };
      },
    }),
  };
});

const prisma = getPrisma();
const tenantIds: string[] = [];
const userIds: string[] = [];
let planId: string | null = null;

const MIN = 60_000;

beforeEach(() => {
  evolutionSends.length = 0;
  evolutionShouldFail = false;
});

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  if (planId) await prisma.plan.delete({ where: { id: planId } });
  await prisma.$disconnect();
});

function payload(p: { instance: string; jid: string; text: string; fromMe?: boolean; id?: string }) {
  return {
    event: "messages.upsert",
    instance: p.instance,
    data: {
      key: { remoteJid: p.jid, fromMe: p.fromMe ?? false, id: p.id ?? `m-${randomUUID()}` },
      pushName: "Maria Souza",
      message: { conversation: p.text },
      messageType: "conversation",
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
  };
}

async function world(label: string, opts: { sandbox?: boolean; workingAllDay?: boolean; suspended?: boolean } = {}) {
  const tenant = await prisma.tenant.create({
    data: { slug: `it-v2c-${label}-${randomUUID().slice(0, 8)}`, name: `V2 Conversa ${label}`, timezone: "UTC", minLeadTimeMin: 0 },
  });
  tenantIds.push(tenant.id);
  if (!planId) {
    const plan = await prisma.plan.create({
      data: { code: `it-v2c-${Date.now()}-${randomUUID().slice(0, 6)}`, name: "Plano IT v2 conversa", priceCents: 0, maxWhatsappNumbers: 3, maxProfessionals: null, active: false, sortOrder: 999 },
    });
    planId = plan.id;
  }
  await prisma.subscription.create({
    data: opts.suspended
      ? { tenantId: tenant.id, planId, status: "SUSPENDED", currentPeriodEnd: new Date(Date.now() - 90 * 86_400_000) }
      : { tenantId: tenant.id, planId, status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) },
  });
  if (opts.workingAllDay) {
    await prisma.professional.create({
      data: {
        tenantId: tenant.id,
        name: "Ana",
        workingHours: { create: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: "00:00", endTime: "23:59" })) },
      },
    });
  }
  const instance = await prisma.whatsappInstance.create({
    data: { tenantId: tenant.id, instanceName: `innochat-v2c-${label}-${randomUUID().slice(0, 6)}`, label: "Principal", webhookToken: randomUUID(), sandbox: opts.sandbox ?? false },
  });
  const ctx: InternalApiContext = {
    tenantId: tenant.id,
    instance: { id: instance.id, tenantId: tenant.id, instanceName: instance.instanceName, sandbox: instance.sandbox, status: instance.status },
  };
  const jid = `5511${Math.floor(900000000 + Math.random() * 99999999)}@s.whatsapp.net`;
  return { tenant, instance, ctx, jid };
}

type World = Awaited<ReturnType<typeof world>>;

async function say(w: World, text: string, flow: 1 | 2 = 2) {
  return claimMessage(w.ctx, payload({ instance: w.ctx.instance.instanceName, jid: w.jid, text }), { flow });
}

function expectProcess(r: Awaited<ReturnType<typeof claimMessage>>): ClaimProcessResultV2 {
  if (r.action !== "process") throw new Error(`esperava process, veio ${JSON.stringify(r)}`);
  return r as ClaimProcessResultV2;
}

/** Cliente diz "oi", o bot "responde" pedindo atendente: sessão salva em HUMAN com o pedido aberto. */
async function requestHuman(w: World, reason?: "CLIENT_REQUEST") {
  const first = expectProcess(await say(w, "atendente"));
  await updateSession(w.ctx, first.session.id, {
    lockToken: first.session.lockToken,
    version: first.session.version,
    state: "MAIN_MENU",
    context: {},
    invalidCount: 0,
    outbound: ["Chamando a equipe"],
    handoff: true,
    ...(reason ? { handoffReason: reason } : {}),
  });
  return first.session.id;
}

const openRequests = (sessionId: string) => prisma.handoffRequest.findMany({ where: { chatSessionId: sessionId, endedAt: null } });

describe("claim v2", () => {
  it("devolve o contrato v2 (flow, firstName, relógio local, rótulos, textos v2) e o v1 fica como era", async () => {
    const w = await world("claim");
    const v2 = expectProcess(await say(w, "oi"));
    expect(v2.flow).toBe(2);
    expect(v2.contact.firstName).toBe("Maria");
    expect(v2.session.previous).toBeNull();
    expect(v2.session.resumedFromHuman).toBeNull();
    expect(v2.tenant.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(v2.tenant.nowLocal).toMatch(/^\d{2}:\d{2}$/);
    expect(v2.tenant.openNow).toBe(false); // sem profissional com expediente
    expect(v2.tenant.teamNextOpenLabel).toBeNull();
    expect(v2.tenant.handoffUntilLabel.length).toBeGreaterThan(0);
    expect(v2.tenant.changeLeadLabel).toBe("2 horas");
    expect(v2.tenant.lastBookableDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(v2.tenant.slotGranularityMin).toBe(30);
    expect(v2.texts.TECH_ERROR).toBe(DEFAULT_BOT_TEXTS_V2.TECH_ERROR);

    const w1 = await world("claim-v1");
    const v1 = (await say(w1, "oi", 1)) as ClaimProcessResult;
    expect(v1.action).toBe("process");
    expect("flow" in v1).toBe(false);
    expect("firstName" in v1.contact).toBe(false);
  });

  it("texts: com o header 2 vem o catálogo v2 (com edição da empresa); sem o header, o catálogo v1", async () => {
    const w = await world("texts");
    await prisma.botText.create({ data: { tenantId: w.tenant.id, key: "TECH_ERROR", text: "Erro editado" } });
    const v2 = expectProcess(await say(w, "oi"));
    expect(Object.keys(v2.texts).sort()).toEqual([...BOT_TEXT_KEYS_V2].sort());
    expect(v2.texts.TECH_ERROR).toBe("Erro editado");
    await prisma.chatSession.update({ where: { id: v2.session.id }, data: { lockToken: null, lockedUntil: null } });
    const v1 = (await say(w, "oi", 1)) as ClaimProcessResult;
    expect(Object.keys(v1.texts).sort()).toEqual([...BOT_TEXT_KEYS].sort());
    expect("TECH_ERROR" in v1.texts).toBe(false);
  });

  it("openNow/teamNextOpenLabel usam a união dos expedientes dos profissionais ativos", async () => {
    const w = await world("open", { workingAllDay: true });
    const v2 = expectProcess(await say(w, "oi"));
    expect(v2.tenant.openNow).toBe(true);
  });

  it("session.previous traz estado e contexto anteriores quando a sessão expirou há <= 24 h; só com o header 2", async () => {
    const w = await world("prev");
    const first = expectProcess(await say(w, "oi"));
    await updateSession(w.ctx, first.session.id, {
      lockToken: first.session.lockToken,
      version: first.session.version,
      state: "CHOOSE_DAY",
      context: { serviceId: "abc" },
      invalidCount: 0,
      outbound: ["escolha o dia"],
      handoff: false,
    });
    await prisma.chatSession.update({ where: { id: first.session.id }, data: { lastInboundAt: new Date(Date.now() - 90 * MIN) } });
    const second = expectProcess(await say(w, "oi de novo"));
    expect(second.session.expired).toBe(true);
    expect(second.session.previous).toMatchObject({ state: "CHOOSE_DAY", context: { serviceId: "abc" } });
    expect(second.session.previous?.idleMin).toBeGreaterThanOrEqual(90);
    await prisma.chatSession.update({ where: { id: first.session.id }, data: { lockToken: null, lockedUntil: null, lastInboundAt: new Date(Date.now() - 30 * 3600_000) } });
    const third = expectProcess(await say(w, "outra vez"));
    expect(third.session.previous).toBeNull(); // > 24 h
  });
});

describe("ciclo do atendente (§3.10)", () => {
  it("pedir cria HandoffRequest CLIENT_REQUEST, pausa por handoffResumeMinutes e ignora o resto; 'menu' devolve o bot", async () => {
    const w = await world("menu");
    const sessionId = await requestHuman(w, "CLIENT_REQUEST");

    const session = await prisma.chatSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.state).toBe("HUMAN");
    const minutes = Math.round((session.humanUntil!.getTime() - Date.now()) / MIN);
    expect(minutes).toBeGreaterThanOrEqual(119);
    expect(minutes).toBeLessThanOrEqual(120);
    const open = await openRequests(sessionId);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ reason: "CLIENT_REQUEST", tenantId: w.tenant.id, offHours: true });

    expect(await say(w, "alguém aí?")).toEqual({ action: "ignore", reason: "HUMAN_MODE" });

    const back = expectProcess(await say(w, "Menu!"));
    expect(back.session.resumedFromHuman).toBe("CLIENT_MENU");
    expect(back.session.state).toBe("MAIN_MENU");
    expect(back.session.expired).toBe(false);
    expect(await openRequests(sessionId)).toHaveLength(0);
    const ended = await prisma.handoffRequest.findFirstOrThrow({ where: { chatSessionId: sessionId } });
    expect(ended.endReason).toBe("CLIENT_MENU");
    const after = await prisma.chatSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(after.humanUntil).toBeNull();
    expect(after.state).toBe("MAIN_MENU");
  });

  it("'0' também devolve o bot", async () => {
    const w = await world("zero");
    await requestHuman(w, "CLIENT_REQUEST");
    const back = expectProcess(await say(w, "0"));
    expect(back.session.resumedFromHuman).toBe("CLIENT_MENU");
  });

  it("pedir → prazo vence → a próxima mensagem encerra (TIMEOUT) e entra como sessão nova", async () => {
    const w = await world("timeout");
    const sessionId = await requestHuman(w, "CLIENT_REQUEST");
    await prisma.chatSession.update({ where: { id: sessionId }, data: { humanUntil: new Date(Date.now() - MIN), lastInboundAt: new Date(Date.now() - 200 * MIN) } });

    const back = expectProcess(await say(w, "oi, e agora?"));
    expect(back.session.resumedFromHuman).toBe("TIMEOUT");
    expect(back.session.state).toBe("MAIN_MENU");
    expect(back.session.expired).toBe(false);
    expect(back.session.previous).toBeNull();
    const ended = await prisma.handoffRequest.findFirstOrThrow({ where: { chatSessionId: sessionId } });
    expect(ended.endReason).toBe("TIMEOUT");
  });

  it("pedir → equipe responde (fromMe) → estende por humanPauseMin, marca answeredAt e não pausa o contato; 'menu' ainda vale", async () => {
    const w = await world("answer");
    await prisma.tenant.update({ where: { id: w.tenant.id }, data: { humanPauseMin: 600 } });
    const sessionId = await requestHuman(w, "CLIENT_REQUEST");

    const first = await claimMessage(w.ctx, payload({ instance: w.ctx.instance.instanceName, jid: w.jid, text: "Já vou te atender", fromMe: true }), { flow: 2 });
    expect(first).toEqual({ action: "ignore", reason: "HUMAN_TOOK_OVER" });
    const session = await prisma.chatSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.state).toBe("HUMAN");
    expect(session.lockToken).toBeNull();
    const minutes = Math.round((session.humanUntil!.getTime() - Date.now()) / MIN);
    expect(minutes).toBeGreaterThanOrEqual(599);
    const req = await prisma.handoffRequest.findFirstOrThrow({ where: { chatSessionId: sessionId } });
    expect(req.answeredAt).not.toBeNull();
    const contact = await prisma.contact.findFirstOrThrow({ where: { tenantId: w.tenant.id } });
    expect(contact.botPausedUntil).toBeNull();

    const firstAnswer = req.answeredAt!;
    await claimMessage(w.ctx, payload({ instance: w.ctx.instance.instanceName, jid: w.jid, text: "Pronto, resolvido", fromMe: true }), { flow: 2 });
    const req2 = await prisma.handoffRequest.findFirstOrThrow({ where: { chatSessionId: sessionId } });
    expect(req2.answeredAt!.getTime()).toBe(firstAnswer.getTime()); // 1ª resposta é preservada

    const back = expectProcess(await say(w, "menu"));
    expect(back.session.resumedFromHuman).toBe("CLIENT_MENU");
  });

  it("eco do próprio bot com pedido aberto não é 'equipe respondeu'", async () => {
    const w = await world("echo");
    const sessionId = await requestHuman(w, "CLIENT_REQUEST");
    const before = await prisma.handoffRequest.findFirstOrThrow({ where: { chatSessionId: sessionId } });
    const echo = await claimMessage(w.ctx, payload({ instance: w.ctx.instance.instanceName, jid: w.jid, text: "Chamando a equipe", fromMe: true }), { flow: 2 });
    expect(echo).toEqual({ action: "ignore", reason: "HUMAN_MODE" }); // ainda em HUMAN; nada de estender
    const after = await prisma.handoffRequest.findFirstOrThrow({ where: { chatSessionId: sessionId } });
    expect(after.answeredAt).toBeNull();
    expect(before.answeredAt).toBeNull();
  });

  it("fromMe SEM pedido aberto: comportamento v1 (HUMAN_TOOK_OVER + Contact.botPausedUntil)", async () => {
    const w = await world("v1fromme");
    const first = expectProcess(await say(w, "oi"));
    await prisma.chatSession.update({ where: { id: first.session.id }, data: { lockToken: null, lockedUntil: null } });
    const r = await claimMessage(w.ctx, payload({ instance: w.ctx.instance.instanceName, jid: w.jid, text: "Oi, aqui é a Ana", fromMe: true }), { flow: 2 });
    expect(r).toEqual({ action: "ignore", reason: "HUMAN_TOOK_OVER" });
    const contact = await prisma.contact.findFirstOrThrow({ where: { tenantId: w.tenant.id } });
    expect(contact.botPausedUntil).not.toBeNull();
    expect(await prisma.handoffRequest.count({ where: { tenantId: w.tenant.id } })).toBe(0);
  });

  it("fluxo v1 (handoff sem handoffReason): LEGACY_FLOW, pausa humanPauseMin e 'menu' NÃO é honrado", async () => {
    const w = await world("legacy");
    const sessionId = await requestHuman(w);
    const session = await prisma.chatSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(Math.round((session.humanUntil!.getTime() - Date.now()) / MIN)).toBeGreaterThanOrEqual(719);
    const req = await prisma.handoffRequest.findFirstOrThrow({ where: { chatSessionId: sessionId } });
    expect(req.reason).toBe("LEGACY_FLOW");
    expect(await say(w, "menu", 1)).toEqual({ action: "ignore", reason: "HUMAN_MODE" });
  });

  it("pedido repetido reaproveita o aberto; corrida entre transações termina com UM aberto (índice parcial)", async () => {
    const w = await world("repeat");
    const sessionId = await requestHuman(w, "CLIENT_REQUEST");
    const contact = await prisma.contact.findFirstOrThrow({ where: { tenantId: w.tenant.id } });
    // 2º pedido pelo caminho normal (nova mensagem "menu" → bot volta → pede de novo é outro ciclo;
    // aqui repete SEM encerrar): a mesma sessão pede de novo.
    const again = await prisma.chatSession.update({ where: { id: sessionId }, data: { lockToken: "x", lockedUntil: new Date(Date.now() + 20_000) } });
    await updateSession(w.ctx, sessionId, {
      lockToken: "x", version: again.version, state: "MAIN_MENU", context: {}, invalidCount: 0, outbound: [], handoff: true, handoffReason: "CLIENT_REQUEST",
    });
    expect(await openRequests(sessionId)).toHaveLength(1);

    await prisma.handoffRequest.updateMany({ where: { chatSessionId: sessionId }, data: { endedAt: new Date(), endReason: "PANEL_RESUME" } });
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        prisma.$transaction((tx) =>
          ensureOpenHandoff(tx, { tenantId: w.tenant.id, whatsappInstanceId: w.instance.id, contactId: contact.id, chatSessionId: sessionId, reason: "CLIENT_REQUEST", offHours: false }),
        ),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await openRequests(sessionId)).toHaveLength(1);
  });

  it("offHours = !openNow da equipe (com expediente aberto → false)", async () => {
    const closed = await world("off-closed");
    const closedSession = await requestHuman(closed, "CLIENT_REQUEST");
    expect((await prisma.handoffRequest.findFirstOrThrow({ where: { chatSessionId: closedSession } })).offHours).toBe(true);

    const open = await world("off-open", { workingAllDay: true });
    const openSession = await requestHuman(open, "CLIENT_REQUEST");
    expect((await prisma.handoffRequest.findFirstOrThrow({ where: { chatSessionId: openSession } })).offHours).toBe(false);
  });

  it("'Retomar bot' do painel encerra o pedido aberto com PANEL_RESUME", async () => {
    const w = await world("panel");
    const sessionId = await requestHuman(w, "CLIENT_REQUEST");
    const contact = await prisma.contact.findFirstOrThrow({ where: { tenantId: w.tenant.id } });
    await setContactBotPaused(w.tenant.id, contact.id, { paused: false });
    expect(await openRequests(sessionId)).toHaveLength(0);
    expect((await prisma.handoffRequest.findFirstOrThrow({ where: { chatSessionId: sessionId } })).endReason).toBe("PANEL_RESUME");
  });
});

describe("release com aviso TECH_ERROR (BUG-04)", () => {
  async function dieHoldingLock(w: World) {
    const c = expectProcess(await say(w, "quero agendar"));
    return c.session;
  }

  it("instância sandbox: 1 aviso no outbox; o 2º release em 10 min não envia; grava ChatMessage OUTBOUND", async () => {
    const w = await world("rel-sandbox", { sandbox: true });
    const s1 = await dieHoldingLock(w);
    const r1 = await releaseSession(w.ctx, s1.id, s1.lockToken);
    expect(r1).toEqual({ released: true, notified: true });
    const outbox = readSandboxOutbox(w.ctx, s1.id).messages;
    expect(outbox).toHaveLength(1);
    expect(outbox[0].message).toBe(DEFAULT_BOT_TEXTS_V2.TECH_ERROR);
    expect(evolutionSends).toHaveLength(0);
    const logged = await prisma.chatMessage.count({ where: { tenantId: w.tenant.id, direction: "OUTBOUND", body: DEFAULT_BOT_TEXTS_V2.TECH_ERROR } });
    expect(logged).toBe(1);

    const s2 = await dieHoldingLock(w);
    const r2 = await releaseSession(w.ctx, s2.id, s2.lockToken);
    expect(r2).toEqual({ released: true, notified: false });
    expect(readSandboxOutbox(w.ctx, s1.id).messages).toHaveLength(1);
    const session = await prisma.chatSession.findUniqueOrThrow({ where: { id: s2.id } });
    expect(session.lockToken).toBeNull(); // liberou mesmo sem avisar
  });

  it("instância real: envia pela Evolution para os dígitos do cliente e registra o eco (fromMe do aviso não pausa o bot)", async () => {
    const w = await world("rel-real");
    const s = await dieHoldingLock(w);
    const r = await releaseSession(w.ctx, s.id, s.lockToken);
    expect(r).toEqual({ released: true, notified: true });
    expect(evolutionSends).toHaveLength(1);
    expect(evolutionSends[0].instance).toBe(w.instance.instanceName);
    expect(evolutionSends[0].number).toBe(w.jid.split("@")[0]);
    expect(evolutionSends[0].text).toBe(DEFAULT_BOT_TEXTS_V2.TECH_ERROR);

    // O webhook devolve o nosso envio como fromMe: tem de ser reconhecido como eco.
    const echo = await claimMessage(w.ctx, payload({ instance: w.ctx.instance.instanceName, jid: w.jid, text: DEFAULT_BOT_TEXTS_V2.TECH_ERROR, fromMe: true }), { flow: 2 });
    expect(echo).toEqual({ action: "ignore", reason: "FROM_ME_ECHO" });
    const contact = await prisma.contact.findFirstOrThrow({ where: { tenantId: w.tenant.id } });
    expect(contact.botPausedUntil).toBeNull();
  });

  it("trava de OUTRA execução, notify:false, HUMAN, bot pausado, assinatura suspensa e mensagem antiga → não avisa (mas libera quando é a trava certa)", async () => {
    // trava de outra execução: idempotente, não mexe na trava e não avisa
    const a = await world("rel-other");
    const sa = await dieHoldingLock(a);
    expect(await releaseSession(a.ctx, sa.id, "token-de-outra-execucao")).toEqual({ released: true, notified: false });
    expect((await prisma.chatSession.findUniqueOrThrow({ where: { id: sa.id } })).lockToken).toBe(sa.lockToken);

    // notify:false
    const b = await world("rel-nonotify");
    const sb = await dieHoldingLock(b);
    expect(await releaseSession(b.ctx, sb.id, sb.lockToken, { notify: false })).toEqual({ released: true, notified: false });

    // HUMAN
    const c = await world("rel-human");
    const sc = await dieHoldingLock(c);
    await prisma.chatSession.update({ where: { id: sc.id }, data: { state: "HUMAN", humanUntil: new Date(Date.now() + 60 * MIN) } });
    expect(await releaseSession(c.ctx, sc.id, sc.lockToken)).toEqual({ released: true, notified: false });

    // bot pausado
    const d = await world("rel-paused");
    const sd = await dieHoldingLock(d);
    await prisma.contact.updateMany({ where: { tenantId: d.tenant.id }, data: { botPausedUntil: new Date(Date.now() + 60 * MIN) } });
    expect(await releaseSession(d.ctx, sd.id, sd.lockToken)).toEqual({ released: true, notified: false });

    // assinatura suspensa (o claim já ignora; monta a sessão travada na mão)
    const e = await world("rel-suspended");
    const se = await dieHoldingLock(e);
    await prisma.subscription.updateMany({ where: { tenantId: e.tenant.id }, data: { status: "SUSPENDED", currentPeriodEnd: new Date(Date.now() - 90 * 86_400_000) } });
    expect(await releaseSession(e.ctx, se.id, se.lockToken)).toEqual({ released: true, notified: false });

    // última mensagem do cliente há mais de 5 min
    const f = await world("rel-old");
    const sf = await dieHoldingLock(f);
    await prisma.chatSession.update({ where: { id: sf.id }, data: { lastInboundAt: new Date(Date.now() - 6 * MIN) } });
    expect(await releaseSession(f.ctx, sf.id, sf.lockToken)).toEqual({ released: true, notified: false });

    expect(evolutionSends).toHaveLength(0);
    for (const s of [sb, sc, sd, se, sf]) {
      expect((await prisma.chatSession.findUniqueOrThrow({ where: { id: s.id } })).lockToken).toBeNull();
    }
  });

  it("dois releases simultâneos com a mesma trava avisam UMA vez", async () => {
    const w = await world("rel-race");
    const s = await dieHoldingLock(w);
    const [r1, r2] = await Promise.all([releaseSession(w.ctx, s.id, s.lockToken), releaseSession(w.ctx, s.id, s.lockToken)]);
    expect([r1.notified, r2.notified].filter(Boolean)).toHaveLength(1);
    expect(evolutionSends).toHaveLength(1);
  });

  it("falha no envio: released true, notified false, sem exceção; o release seguinte pode tentar de novo", async () => {
    const w = await world("rel-fail");
    const s = await dieHoldingLock(w);
    evolutionShouldFail = true;
    expect(await releaseSession(w.ctx, s.id, s.lockToken)).toEqual({ released: true, notified: false });
    expect(await prisma.chatMessage.count({ where: { tenantId: w.tenant.id, direction: "OUTBOUND" } })).toBe(0);

    evolutionShouldFail = false;
    await prisma.chatSession.update({ where: { id: s.id }, data: { recentOutbound: [] } });
    const s2 = await dieHoldingLock(w);
    expect(await releaseSession(w.ctx, s2.id, s2.lockToken)).toEqual({ released: true, notified: true });
  });

  it("texto TECH_ERROR editado pela empresa é o que sai", async () => {
    const w = await world("rel-custom", { sandbox: true });
    await prisma.botText.create({ data: { tenantId: w.tenant.id, key: "TECH_ERROR", text: "Ops, deu ruim aqui. Tente de novo." } });
    const s = await dieHoldingLock(w);
    expect((await releaseSession(w.ctx, s.id, s.lockToken)).notified).toBe(true);
    expect(readSandboxOutbox(w.ctx, s.id).messages[0].message).toBe("Ops, deu ruim aqui. Tente de novo.");
  });
});

describe("notificação HANDOFF_REQUESTED (derivada)", () => {
  async function member(w: World, role: "OWNER" | "STAFF"): Promise<TenantContext> {
    const user = await prisma.user.create({ data: { email: `it-v2c-${randomUUID().slice(0, 8)}@example.test`, passwordHash: "x" } });
    userIds.push(user.id);
    const membership = await prisma.membership.create({ data: { userId: user.id, tenantId: w.tenant.id, role } });
    return {
      tenant: { id: w.tenant.id, slug: w.tenant.slug, name: w.tenant.name, timezone: w.tenant.timezone },
      membership: { id: membership.id, role },
      user: { id: user.id },
    };
  }

  it("aparece para OWNER e STAFF com href do contato, fora do horário, e reflete respondido/encerrado", async () => {
    const w = await world("ntf");
    const sessionId = await requestHuman(w, "CLIENT_REQUEST");
    const contact = await prisma.contact.findFirstOrThrow({ where: { tenantId: w.tenant.id } });
    const owner = await member(w, "OWNER");
    const staff = await member(w, "STAFF");

    for (const ctx of [owner, staff]) {
      const { items } = await listNotifications(ctx);
      const item = items.find((i) => i.kind === "HANDOFF_REQUESTED");
      expect(item).toBeDefined();
      const req = await prisma.handoffRequest.findFirstOrThrow({ where: { chatSessionId: sessionId } });
      expect(item).toMatchObject({
        id: `handoff:${req.id}`,
        severity: "warning",
        source: "WHATSAPP",
        title: "Cliente pediu atendente",
        body: "Maria Souza · fora do horário",
        href: `/${w.tenant.slug}/clientes?contato=${contact.id}`,
        handoff: { contactId: contact.id, contactName: "Maria Souza", offHours: true, answered: false, ended: false },
        read: false,
      });
    }

    await claimMessage(w.ctx, payload({ instance: w.ctx.instance.instanceName, jid: w.jid, text: "Já te atendo", fromMe: true }), { flow: 2 });
    await say(w, "menu");
    const after = (await listNotifications(owner)).items.find((i) => i.kind === "HANDOFF_REQUESTED");
    expect(after?.handoff).toMatchObject({ answered: true, ended: true });

    const poll = await pollNotifications(staff, new Date(Date.now() - 10 * MIN));
    expect(poll.fresh.some((f) => f.kind === "HANDOFF_REQUESTED")).toBe(true);
  });

  it("sem nome do contato usa pushName; dentro do horário não diz 'fora do horário'; outra empresa não vê", async () => {
    const w = await world("ntf2", { workingAllDay: true });
    await requestHuman(w, "CLIENT_REQUEST");
    const other = await world("ntf3");
    const ownerOther = await member(other, "OWNER");
    const owner = await member(w, "OWNER");
    const item = (await listNotifications(owner)).items.find((i) => i.kind === "HANDOFF_REQUESTED");
    expect(item?.body).toBe("Maria Souza");
    expect(item?.handoff?.offHours).toBe(false);
    expect((await listNotifications(ownerOther)).items.some((i) => i.kind === "HANDOFF_REQUESTED")).toBe(false);
  });
});
