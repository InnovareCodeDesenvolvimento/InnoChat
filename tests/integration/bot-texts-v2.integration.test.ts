/**
 * B-3: textos por versão do fluxo e regras da empresa, contra Postgres real.
 * v1 congelada (CA-45 no nível de unidade), v2 com edições/legados, upsert por versão (BUG-12),
 * leitura filtrada por chave e regras do bot.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPrisma } from "@/lib/db/prisma";
import { BOT_TEXT_KEYS, DEFAULT_BOT_TEXTS } from "@/core/bot/texts";
import { BOT_TEXT_KEYS_V2, DEFAULT_BOT_TEXTS_V2 } from "@/core/bot/texts-v2";
import { getMergedBotTexts, listBotTexts, parseFlowMajor, upsertBotText, resetBotText } from "@/modules/bot-texts/service";
import { getBotRules, updateBotRules } from "@/modules/tenant/service";

const prisma = getPrisma();
const run = randomUUID().slice(0, 8);
let tenantId: string;
let emptyTenantId: string;

beforeAll(async () => {
  const t = await prisma.tenant.create({ data: { slug: `it-b3-a-${run}`, name: "B3 A", timezone: "America/Sao_Paulo" } });
  const e = await prisma.tenant.create({ data: { slug: `it-b3-b-${run}`, name: "B3 B", timezone: "America/Sao_Paulo" } });
  tenantId = t.id;
  emptyTenantId = e.id;
  await prisma.botText.createMany({
    data: [
      { tenantId, key: "GREETING", text: "Oi, {nome}!" },
      { tenantId, key: "MENU_PROMPT", text: "Cabeçalho portado" },
      { tenantId, key: "MAIN_MENU", text: "1. Antigo" },
    ],
  });
});

afterAll(async () => {
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, emptyTenantId] } } });
});

describe("getMergedBotTexts", () => {
  it("v1 (padrão): só chaves v1, edição aplicada, sem vazar chave v2", async () => {
    const texts = await getMergedBotTexts(tenantId);
    expect(Object.keys(texts).sort()).toEqual([...BOT_TEXT_KEYS].sort());
    expect(texts.GREETING).toBe("Oi, {nome}!");
    expect(texts.MAIN_MENU).toBe("1. Antigo");
    expect(texts.CHOOSE_SERVICE).toBe(DEFAULT_BOT_TEXTS.CHOOSE_SERVICE);
    expect("MENU_PROMPT" in texts).toBe(false);
  });

  it("v1 explícito é idêntico ao padrão", async () => {
    expect(await getMergedBotTexts(tenantId, 1)).toEqual(await getMergedBotTexts(tenantId));
  });

  it("v2: chaves v2, MENU_PROMPT portado, legadas fora, padrões v2 nas demais", async () => {
    const texts = await getMergedBotTexts(tenantId, 2);
    expect(Object.keys(texts).sort()).toEqual([...BOT_TEXT_KEYS_V2].sort());
    expect(texts.MENU_PROMPT).toBe("Cabeçalho portado");
    expect(texts.GREETING).toBe("Oi, {nome}!");
    expect(texts.BOOKED).toBe(DEFAULT_BOT_TEXTS_V2.BOOKED);
    expect("MAIN_MENU" in texts).toBe(false);
  });

  it("empresa sem edição: tudo padrão em v1 e v2", async () => {
    expect((await getMergedBotTexts(emptyTenantId, 2)).MENU_PROMPT).toBe(DEFAULT_BOT_TEXTS_V2.MENU_PROMPT);
    expect((await getMergedBotTexts(emptyTenantId, 1)).GREETING).toBe(DEFAULT_BOT_TEXTS.GREETING);
  });
});

describe("listBotTexts", () => {
  it("v1: itens = BOT_TEXT_KEYS, sem legacy", async () => {
    const view = await listBotTexts(tenantId, 1);
    expect(view.flowVersion).toBe(1);
    expect(view.items.map((i) => i.key).sort()).toEqual([...BOT_TEXT_KEYS].sort());
    expect(view.items.every((i) => !i.legacy)).toBe(true);
    expect(view.items.find((i) => i.key === "GREETING")).toMatchObject({ isDefault: false, text: "Oi, {nome}!" });
  });

  it("v2: chaves v2 + só legadas EDITADAS (legacy=true)", async () => {
    const view = await listBotTexts(tenantId, 2);
    expect(view.flowVersion).toBe(2);
    const legacy = view.items.filter((i) => i.legacy);
    expect(legacy.map((i) => i.key)).toEqual(["MAIN_MENU"]);
    expect(view.items.filter((i) => !i.legacy).map((i) => i.key)).toEqual([...BOT_TEXT_KEYS_V2]);
    expect((await listBotTexts(emptyTenantId, 2)).items.some((i) => i.legacy)).toBe(false);
  });
});

describe("upsertBotText", () => {
  it("v2 recusa {limite} em GREETING com disallowedVariables (BUG-12)", async () => {
    await expect(upsertBotText(tenantId, "GREETING", "Oi {limite}", 2)).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
      details: { disallowedVariables: ["limite"] },
    });
  });

  it("v2 aceita variável permitida e grava; reset volta ao padrão", async () => {
    await upsertBotText(emptyTenantId, "APPOINTMENT_LIMIT", "  Máximo de {limite}.  ", 2);
    expect((await getMergedBotTexts(emptyTenantId, 2)).APPOINTMENT_LIMIT).toBe("Máximo de {limite}.");
    await resetBotText(emptyTenantId, "APPOINTMENT_LIMIT");
    expect((await getMergedBotTexts(emptyTenantId, 2)).APPOINTMENT_LIMIT).toBe(DEFAULT_BOT_TEXTS_V2.APPOINTMENT_LIMIT);
  });

  it("v2 recusa chave legada (só leitura) e v1 recusa chave v2", async () => {
    await expect(upsertBotText(tenantId, "MAIN_MENU", "x", 2)).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    await expect(upsertBotText(tenantId, "MENU_PROMPT", "x", 1)).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
  });

  it("v1 mantém a regra antiga (variável desconhecida)", async () => {
    await expect(upsertBotText(tenantId, "GREETING", "Oi {limite}", 1)).rejects.toMatchObject({
      code: "INVALID_PAYLOAD",
      details: { unknownVariables: ["limite"] },
    });
  });
});

describe("parseFlowMajor", () => {
  it("major 2 → 2; nulo, ilegível ou 1.x → 1", () => {
    expect(parseFlowMajor("2.0.0")).toBe(2);
    expect(parseFlowMajor("2")).toBe(2);
    expect(parseFlowMajor("1.4.0")).toBe(1);
    expect(parseFlowMajor(null)).toBe(1);
    expect(parseFlowMajor("abc")).toBe(1);
    expect(parseFlowMajor("3.0.0")).toBe(1);
  });
});

describe("regras do bot da empresa", () => {
  it("padrões, atualização e leitura (humanPauseMin intacto)", async () => {
    expect(await getBotRules(emptyTenantId)).toEqual({ maxFutureAppointmentsPerContact: 3, slotGranularityMin: 30, handoffResumeMinutes: 120, humanPauseMin: 720, notifyClientOnStaffChanges: true });
    const updated = await updateBotRules(emptyTenantId, { maxFutureAppointmentsPerContact: 0, slotGranularityMin: 15, handoffResumeMinutes: 45 });
    expect(updated).toEqual({ maxFutureAppointmentsPerContact: 0, slotGranularityMin: 15, handoffResumeMinutes: 45, humanPauseMin: 720, notifyClientOnStaffChanges: true });
    expect(await getBotRules(emptyTenantId)).toEqual(updated);
  });
});
