/**
 * Migrations do bot v2 (C-1) contra Postgres real: porta de textos legados (idempotente), CHECKs
 * da Tenant e índice único parcial de HandoffRequest. A porta é a migration SQL de verdade, lida do
 * disco e reexecutada (o DO $$ é idempotente por desenho — é justamente o que o teste (d) prova).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPrisma } from "@/lib/db/prisma";

const prisma = getPrisma();
const run = randomUUID().slice(0, 8);
const PORT_SQL = readFileSync(join(process.cwd(), "prisma/migrations/20261001200100_bot_v2_port_texts/migration.sql"), "utf8");
const tenantIds: string[] = [];

async function newTenant(label: string) {
  const t = await prisma.tenant.create({ data: { slug: `it-bv2-${label}-${run}`, name: `Bot v2 ${label}`, timezone: "America/Sao_Paulo" } });
  tenantIds.push(t.id);
  return t;
}
const port = () => prisma.$executeRawUnsafe(PORT_SQL);
const textOf = async (tenantId: string, key: "MENU_PROMPT" | "APPOINTMENT_DETAIL") =>
  (await prisma.botText.findUnique({ where: { tenantId_key: { tenantId, key } } }))?.text ?? null;

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
});

describe("bot v2 — porta de textos", () => {
  let a: string, b: string, c: string, d: string, e: string;
  beforeAll(async () => {
    a = (await newTenant("a")).id;
    b = (await newTenant("b")).id;
    c = (await newTenant("c")).id;
    d = (await newTenant("d")).id;
    e = (await newTenant("e")).id;
    await prisma.botText.createMany({
      data: [
        { tenantId: a, key: "MAIN_MENU", text: "Oi!\n1. A\n2. B" },
        { tenantId: b, key: "MAIN_MENU", text: "1. A\n2. B" },
        // c: sem edição nenhuma
        { tenantId: d, key: "APPOINTMENT_ACTIONS", text: "  Seu horário  \n\n1️⃣ Remarcar\n2️⃣ Cancelar" },
        { tenantId: e, key: "MAIN_MENU", text: "Bem-vindo à clínica" }, // sem linha de opção: texto inteiro
        { tenantId: e, key: "TOO_MANY_INVALID", text: "Chega." }, // não portada
      ],
    });
    await port();
  });

  it("(a) MAIN_MENU com cabeçalho porta só o cabeçalho para MENU_PROMPT", async () => {
    expect(await textOf(a, "MENU_PROMPT")).toBe("Oi!");
  });
  it("(b) MAIN_MENU que já começa com opção não porta nada", async () => {
    expect(await textOf(b, "MENU_PROMPT")).toBeNull();
  });
  it("(c) empresa sem edição não ganha linha nenhuma", async () => {
    expect(await prisma.botText.count({ where: { tenantId: c } })).toBe(0);
  });
  it("APPOINTMENT_ACTIONS vira APPOINTMENT_DETAIL com o prefixo de detalhe e cabeçalho aparado", async () => {
    expect(await textOf(d, "APPOINTMENT_DETAIL")).toBe("*{servico}* com {profissional}\n{data_longa} às *{hora}*\n\nSeu horário");
  });
  it("sem linha de opção o texto inteiro é o cabeçalho; chaves que mudaram de sentido não são portadas", async () => {
    expect(await textOf(e, "MENU_PROMPT")).toBe("Bem-vindo à clínica");
    const keys = (await prisma.botText.findMany({ where: { tenantId: e } })).map((r) => r.key).sort();
    expect(keys).toEqual(["MAIN_MENU", "MENU_PROMPT", "TOO_MANY_INVALID"]);
  });
  it("as linhas legadas continuam onde estavam", async () => {
    expect((await prisma.botText.findUnique({ where: { tenantId_key: { tenantId: a, key: "MAIN_MENU" } } }))?.text).toBe("Oi!\n1. A\n2. B");
  });
  it("(d) rodar a porta de novo não duplica nem sobrescreve edição posterior", async () => {
    await prisma.botText.update({ where: { tenantId_key: { tenantId: a, key: "MENU_PROMPT" } }, data: { text: "Editado depois" } });
    const before = await prisma.botText.count({ where: { tenantId: { in: [a, b, c, d, e] } } });
    await port();
    expect(await prisma.botText.count({ where: { tenantId: { in: [a, b, c, d, e] } } })).toBe(before);
    expect(await textOf(a, "MENU_PROMPT")).toBe("Editado depois");
  });
});

describe("bot v2 — CHECKs da Tenant", () => {
  it("(e) recusa slotGranularityMin=60 e aceita 15/30; padrão novo é 30", async () => {
    const t = await newTenant("chk");
    expect(t.slotGranularityMin).toBe(30);
    expect(t.maxFutureAppointmentsPerContact).toBe(3);
    expect(t.handoffResumeMinutes).toBe(120);
    await expect(prisma.tenant.update({ where: { id: t.id }, data: { slotGranularityMin: 60 } })).rejects.toThrow();
    await prisma.tenant.update({ where: { id: t.id }, data: { slotGranularityMin: 15 } });
    await prisma.tenant.update({ where: { id: t.id }, data: { slotGranularityMin: 30 } });
  });
  it("limita maxFutureAppointmentsPerContact a 0..20 e handoffResumeMinutes a 30..1440", async () => {
    const t = await newTenant("chk2");
    await expect(prisma.tenant.update({ where: { id: t.id }, data: { maxFutureAppointmentsPerContact: 21 } })).rejects.toThrow();
    await expect(prisma.tenant.update({ where: { id: t.id }, data: { maxFutureAppointmentsPerContact: -1 } })).rejects.toThrow();
    await prisma.tenant.update({ where: { id: t.id }, data: { maxFutureAppointmentsPerContact: 0 } });
    await expect(prisma.tenant.update({ where: { id: t.id }, data: { handoffResumeMinutes: 29 } })).rejects.toThrow();
    await expect(prisma.tenant.update({ where: { id: t.id }, data: { handoffResumeMinutes: 1441 } })).rejects.toThrow();
    await prisma.tenant.update({ where: { id: t.id }, data: { handoffResumeMinutes: 1440 } });
  });
});

describe("bot v2 — HandoffRequest", () => {
  it("(f) um 2º pedido aberto na mesma sessão viola o índice único parcial; encerrado libera", async () => {
    const t = await newTenant("ho");
    const inst = await prisma.whatsappInstance.create({ data: { tenantId: t.id, instanceName: `it-bv2-${run}`, label: "x", webhookToken: `tok-${run}` } });
    const contact = await prisma.contact.create({ data: { tenantId: t.id, waJid: `5511${run}@s.whatsapp.net` } });
    const session = await prisma.chatSession.create({ data: { whatsappInstanceId: inst.id, contactId: contact.id, state: "MAIN_MENU" } });
    const base = { tenantId: t.id, whatsappInstanceId: inst.id, contactId: contact.id, chatSessionId: session.id, reason: "CLIENT_REQUEST" as const };
    const first = await prisma.handoffRequest.create({ data: base });
    await expect(prisma.handoffRequest.create({ data: base })).rejects.toThrow(/Unique constraint/i);
    await prisma.handoffRequest.update({ where: { id: first.id }, data: { endedAt: new Date(), endReason: "TIMEOUT" } });
    await prisma.handoffRequest.create({ data: base }); // depois de encerrado, pode abrir outro
    // cascade: apagar a empresa leva os pedidos junto (afterAll)
  });
});
