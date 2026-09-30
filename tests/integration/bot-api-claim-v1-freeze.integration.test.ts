/**
 * Congela o formato v1 do `POST /messages/claim` (regressão da B-2, achada no simulador): enquanto o
 * "Publicar fluxo" não roda, o bot em produção é o workflow v1 e NÃO manda `X-InnoChat-Flow`. Sem o
 * header a resposta tem de ser idêntica à do claim anterior à B-2 (commit 5f327cf):
 * mesmas chaves, sem `flow`, sem os campos do v2 e com a base de textos v1 (`MAIN_MENU` numerado).
 *
 * Diferenças CONSCIENTES do v1 depois da B-2 (Órion I3, aceitas pelo dono; o v2 é publicado logo após o deploy):
 *   - release em falha técnica avisa o cliente (TECH_ERROR);
 *   - pedido de atendente feito pelo v1 cria `HandoffRequest` LEGACY_FLOW (com sino no painel);
 *   - o atendente que vence sem "menu" reinicia a sessão (`TIMEOUT`).
 * Nada disso muda o FORMATO do claim, que é o que este arquivo congela.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import type { InternalApiContext } from "@/modules/bot-api/internal-auth";
import { claimMessage } from "@/modules/bot-api/claim";
import { listAvailabilityDayOptions } from "@/modules/bot-api/booking-bot";
import { flowVersionOf } from "@/modules/bot-api/flow-version";
import { BOT_TEXT_KEYS_V2 } from "@/core/bot/texts-v2";

const prisma = getPrisma();
const tenantIds: string[] = [];
let planId: string | null = null;

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  if (planId) await prisma.plan.delete({ where: { id: planId } });
  await prisma.$disconnect();
});

async function world(): Promise<{ ctx: InternalApiContext; jid: string }> {
  const tenant = await prisma.tenant.create({ data: { slug: `it-v1f-${randomUUID().slice(0, 8)}`, name: "Freeze V1", timezone: "UTC" } });
  tenantIds.push(tenant.id);
  const plan = await prisma.plan.create({
    data: { code: `it-v1f-${Date.now()}-${randomUUID().slice(0, 6)}`, name: "Plano IT freeze v1", priceCents: 0, maxWhatsappNumbers: 3, maxProfessionals: null, active: false, sortOrder: 999 },
  });
  planId = plan.id;
  await prisma.subscription.create({ data: { tenantId: tenant.id, planId: plan.id, status: "ACTIVE", currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000) } });
  const instance = await prisma.whatsappInstance.create({
    data: { tenantId: tenant.id, instanceName: `innochat-v1f-${randomUUID().slice(0, 6)}`, label: "Principal", webhookToken: randomUUID() },
  });
  const ctx: InternalApiContext = {
    tenantId: tenant.id,
    instance: { id: instance.id, tenantId: tenant.id, instanceName: instance.instanceName, sandbox: instance.sandbox, status: instance.status },
  };
  return { ctx, jid: `5511${Math.floor(900000000 + Math.random() * 99999999)}@s.whatsapp.net` };
}

function payload(instance: string, jid: string, text: string) {
  return {
    event: "messages.upsert",
    instance,
    data: {
      key: { remoteJid: jid, fromMe: false, id: `m-${randomUUID()}` },
      pushName: "Maria Souza",
      message: { conversation: text },
      messageType: "conversation",
      messageTimestamp: Math.floor(Date.now() / 1000),
    },
  };
}

/** As 34 chaves de `texts` do claim v1 (26 mensagens + 8 rótulos), congeladas por extenso. */
const V1_TEXT_KEYS = [
  "APPOINTMENT_ACTIONS", "ASK_NAME", "BOOKED", "CANCELED", "CHOOSE_DAY", "CHOOSE_PROFESSIONAL", "CHOOSE_SERVICE", "CHOOSE_TIME",
  "CONFIRM_CANCEL", "CONFIRM_SUMMARY", "GOODBYE", "GREETING", "HUMAN_HANDOFF", "INVALID_OPTION", "LABEL_BACK_TO_MENU", "LABEL_CANCEL_NO",
  "LABEL_CANCEL_YES", "LABEL_CONFIRM", "LABEL_MORE", "LABEL_MORE_DAYS", "LABEL_MORE_TIMES", "LABEL_OTHER_TIME", "MAIN_MENU", "MY_APPOINTMENTS",
  "NO_APPOINTMENTS", "NO_AVAILABILITY", "NO_SLOTS_DAY", "ONLY_TEXT", "REMINDER", "RESCHEDULED", "SESSION_EXPIRED", "SLOT_TAKEN",
  "TOO_LATE", "TOO_MANY_INVALID",
];

describe("claim SEM o header X-InnoChat-Flow: formato v1 congelado", () => {
  it("chaves, ausência de campos do v2 e textos v1 literais", async () => {
    const w = await world();
    const r = await claimMessage(w.ctx, payload(w.ctx.instance.instanceName, w.jid, "oi"));
    if (r.action !== "process") throw new Error(`esperava process, veio ${JSON.stringify(r)}`);

    expect(Object.keys(r).sort()).toEqual(["action", "contact", "inboundEventId", "instance", "message", "session", "tenant", "texts", "to"]);
    expect("flow" in r).toBe(false);
    expect(Object.keys(r.contact).sort()).toEqual(["id", "name", "pushName"]);
    expect(Object.keys(r.session).sort()).toEqual(["context", "expired", "id", "invalidCount", "lockToken", "state", "version"]);
    expect(Object.keys(r.tenant).sort()).toEqual(["askProfessional", "name", "timezone"]);
    expect(Object.keys(r.instance).sort()).toEqual(["name", "sandbox"]);
    expect(r.message).toEqual({ type: "text", text: "oi" });
    expect(r.session.state).toBe("MAIN_MENU");

    expect(Object.keys(r.texts).sort()).toEqual(V1_TEXT_KEYS);
    for (const keyV2 of BOT_TEXT_KEYS_V2) {
      if (!V1_TEXT_KEYS.includes(keyV2)) expect(r.texts).not.toHaveProperty(keyV2);
    }
    expect(r.texts.MAIN_MENU).toBe("Como posso ajudar?\n1. Agendar horário\n2. Meus agendamentos\n3. Falar com atendente");
    expect(r.texts.GREETING).toBe("Olá, {nome}! Bem-vindo(a) à {empresa}. 😊");
    expect(r.texts.CHOOSE_SERVICE).toBe("Qual serviço você quer agendar?");
    expect(r.texts.CHOOSE_DAY).toBe("Para qual dia?");
    expect(r.texts.HUMAN_HANDOFF).toBe("Ok! Um atendente humano vai continuar essa conversa.");
    expect(r.texts.TOO_MANY_INVALID).toBe("Não consegui entender. Vou chamar um atendente para te ajudar.");
    expect(r.texts.GOODBYE).toBe("Até logo! 👋");
  });

  it("a edição da empresa no MAIN_MENU continua chegando no claim v1", async () => {
    const w = await world();
    const custom = "Oi! Escolha:\n1. Marcar\n2. Ver\n3. Humano";
    await prisma.botText.create({ data: { tenantId: w.ctx.tenantId, key: "MAIN_MENU", text: custom } });
    const r = await claimMessage(w.ctx, payload(w.ctx.instance.instanceName, w.jid, "oi"), { flow: 1 });
    if (r.action !== "process") throw new Error("esperava process");
    expect(r.texts.MAIN_MENU).toBe(custom);
  });
});

describe("flowVersionOf: só o valor exato 2 liga o v2", () => {
  const req = (value?: string) => new Request("http://x/api", { headers: value === undefined ? {} : { "X-InnoChat-Flow": value } });
  it("sem header, vazio, 1, 3 ou lixo → v1", () => {
    for (const v of [undefined, "", "1", "3", "v2", "2.0", "true"]) expect(flowVersionOf(req(v))).toBe(1);
  });
  it("2 (com espaços) → v2", () => {
    expect(flowVersionOf(req("2"))).toBe(2);
    expect(flowVersionOf(req(" 2 "))).toBe(2);
  });
});

describe("claim v2 e /availability/days: a mesma data limite", () => {
  it("tenant.lastBookableDate (claim) = lastBookableDate.id (dias): hoje + maxHorizonDays - 1", async () => {
    const w = await world();
    const service = await prisma.service.create({ data: { tenantId: w.ctx.tenantId, name: "Corte", durationMin: 30, priceCents: 5000 } });
    const pro = await prisma.professional.create({
      data: { tenantId: w.ctx.tenantId, name: "Ana", workingHours: { create: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: "08:00", endTime: "18:00" })) } },
    });
    await prisma.professionalService.create({ data: { professionalId: pro.id, serviceId: service.id } });
    const claim = await claimMessage(w.ctx, payload(w.ctx.instance.instanceName, w.jid, "oi"), { flow: 2 });
    if (claim.action !== "process" || !("flow" in claim)) throw new Error("esperava process v2");
    const days = await listAvailabilityDayOptions(w.ctx.tenantId, { serviceId: service.id, professionalId: null, from: null, limit: 6 });
    const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: w.ctx.tenantId } });
    expect(claim.tenant.lastBookableDate).toBe(days.lastBookableDate.id);
    const today = new Date(`${claim.tenant.today}T00:00:00Z`);
    expect(claim.tenant.lastBookableDate).toBe(new Date(today.getTime() + (tenant.maxHorizonDays - 1) * 86_400_000).toISOString().slice(0, 10));
  });
});
