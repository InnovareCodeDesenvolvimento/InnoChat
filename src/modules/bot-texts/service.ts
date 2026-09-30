import { getPrisma } from "@/lib/db/prisma";
import { forTenant } from "@/lib/db/tenant-client";
import { DomainError } from "@/lib/errors";
import type { BotTextKey } from "@/lib/db/types";
import { BOT_TEXT_KEYS, DEFAULT_BOT_TEXTS, findUnknownVariables, renderTemplate, type BotTextKeyLiteral } from "@/core/bot/texts";
import {
  BOT_TEXT_KEYS_V2,
  BOT_TEXT_VARIABLES_V2,
  DEFAULT_BOT_TEXTS_V2,
  LEGACY_V1_KEYS,
  findDisallowedVariables,
  type BotTextKeyV2,
} from "@/core/bot/texts-v2";

export { BOT_TEXT_KEYS, BOT_TEXT_VARIABLES } from "@/core/bot/texts";

export type FlowVersion = 1 | 2;

/** Major de `PlatformSettings.n8nBotFlowVersion` ("2.0.0" → 2). Nulo/ilegível/desconhecido → 1. */
export function parseFlowMajor(version: string | null | undefined): FlowVersion {
  const major = Number.parseInt((version ?? "").split(".")[0] ?? "", 10);
  return major === 2 ? 2 : 1;
}

/** Versão do fluxo publicado hoje (decide o catálogo que o painel mostra). Sem `select` de segredos. */
export async function getPublishedFlowVersion(): Promise<FlowVersion> {
  const row = await getPrisma().platformSettings.findUnique({ where: { id: 1 }, select: { n8nBotFlowVersion: true } });
  return parseFlowMajor(row?.n8nBotFlowVersion);
}

/**
 * Lê as edições da empresa SÓ das chaves que esta versão conhece (`key IN (...)`). Sem o filtro,
 * uma imagem antiga (rollback/janela de deploy) faria o Prisma quebrar ao ler linhas com chaves
 * novas do enum. `keys` são chaves do código, nunca do cliente.
 */
async function loadOverrides(tenantId: string, keys: readonly string[]): Promise<Map<string, string>> {
  const rows = await forTenant(tenantId).botText.findMany({ where: { key: { in: keys as BotTextKey[] } } });
  return new Map(rows.map((row) => [row.key as string, row.text]));
}

/**
 * Mescla os padrões com as edições da empresa (`BotText`, docs/arquitetura.md §6.7) — usado pelo
 * `claim` (campo `texts`) e pela tela "Mensagens do bot". Chave sem linha vale o padrão do código.
 * `flowVersion` 1 (padrão) = catálogo v1 congelado; 2 = catálogo v2 (`MENU_PROMPT` etc. já com o
 * texto portado pela migration).
 */
export async function getMergedBotTexts(tenantId: string): Promise<Record<BotTextKeyLiteral, string>>;
export async function getMergedBotTexts(tenantId: string, flowVersion: 1): Promise<Record<BotTextKeyLiteral, string>>;
export async function getMergedBotTexts(tenantId: string, flowVersion: 2): Promise<Record<BotTextKeyV2, string>>;
export async function getMergedBotTexts(tenantId: string, flowVersion: FlowVersion = 1): Promise<Record<string, string>> {
  if (flowVersion === 2) {
    const overrides = await loadOverrides(tenantId, BOT_TEXT_KEYS_V2);
    const merged = {} as Record<BotTextKeyV2, string>;
    for (const key of BOT_TEXT_KEYS_V2) merged[key] = overrides.get(key) ?? DEFAULT_BOT_TEXTS_V2[key];
    return merged;
  }
  const overrides = await loadOverrides(tenantId, BOT_TEXT_KEYS);
  const merged = {} as Record<BotTextKeyLiteral, string>;
  for (const key of BOT_TEXT_KEYS) merged[key] = overrides.get(key) ?? DEFAULT_BOT_TEXTS[key];
  return merged;
}

export type BotTextItem = { key: string; text: string; isDefault: boolean; legacy: boolean };
export type BotTextsView = { flowVersion: FlowVersion; items: BotTextItem[] };

/**
 * Itens da tela. v1: `BOT_TEXT_KEYS`. v2: `BOT_TEXT_KEYS_V2` + chaves legadas que a empresa EDITOU
 * (`legacy: true`, só leitura na UI — guardam o texto antigo para consulta/rollback).
 */
export async function listBotTexts(tenantId: string, flowVersion: FlowVersion = 1): Promise<BotTextsView> {
  if (flowVersion === 2) {
    const overrides = await loadOverrides(tenantId, [...BOT_TEXT_KEYS_V2, ...LEGACY_V1_KEYS]);
    const items: BotTextItem[] = BOT_TEXT_KEYS_V2.map((key) => {
      const override = overrides.get(key);
      return { key, text: override ?? DEFAULT_BOT_TEXTS_V2[key], isDefault: override === undefined, legacy: false };
    });
    for (const key of LEGACY_V1_KEYS) {
      const override = overrides.get(key);
      if (override !== undefined) items.push({ key, text: override, isDefault: false, legacy: true });
    }
    return { flowVersion: 2, items };
  }
  const overrides = await loadOverrides(tenantId, BOT_TEXT_KEYS);
  const items: BotTextItem[] = BOT_TEXT_KEYS.map((key) => {
    const override = overrides.get(key);
    return { key, text: override ?? DEFAULT_BOT_TEXTS[key], isDefault: override === undefined, legacy: false };
  });
  return { flowVersion: 1, items };
}

/** Chave editável na versão? (v2 exclui as legadas.) Usada pela action para validar a entrada. */
export function isEditableKey(key: string, flowVersion: FlowVersion): boolean {
  return flowVersion === 2 ? (BOT_TEXT_KEYS_V2 as readonly string[]).includes(key) : (BOT_TEXT_KEYS as readonly string[]).includes(key);
}

function assertKnownVariables(key: string, text: string, flowVersion: FlowVersion) {
  if (flowVersion === 2) {
    const disallowed = findDisallowedVariables(key as BotTextKeyV2, text);
    if (disallowed.length > 0) {
      throw new DomainError("INVALID_PAYLOAD", `Variáveis não permitidas neste texto: ${disallowed.map((v) => `{${v}}`).join(", ")}`, {
        disallowedVariables: disallowed,
      });
    }
    return;
  }
  const unknown = findUnknownVariables(text);
  if (unknown.length > 0) {
    throw new DomainError("INVALID_PAYLOAD", `Variáveis desconhecidas no texto: ${unknown.map((v) => `{${v}}`).join(", ")}`, {
      unknownVariables: unknown,
    });
  }
}

export async function upsertBotText(tenantId: string, key: string, text: string, flowVersion: FlowVersion = 1) {
  if (!isEditableKey(key, flowVersion)) {
    throw new DomainError("INVALID_PAYLOAD", "Este texto não pode ser editado nesta versão do bot.", { field: "key" });
  }
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 1000) {
    throw new DomainError("INVALID_PAYLOAD", "O texto precisa ter entre 1 e 1000 caracteres.");
  }
  assertKnownVariables(key, trimmed, flowVersion);

  return forTenant(tenantId).botText.upsert({
    where: { tenantId_key: { tenantId, key: key as BotTextKey } },
    update: { text: trimmed },
    create: { tenantId, key: key as BotTextKey, text: trimmed },
  });
}

/** "Restaurar padrão" (docs/arquitetura.md §6.7) — remove a edição do tenant, se existir. */
export async function resetBotText(tenantId: string, key: string) {
  await forTenant(tenantId).botText.deleteMany({ where: { key: key as BotTextKey } });
}

const PREVIEW_SAMPLE_VARS = {
  nome: "Maria",
  empresa: "Studio Bela",
  servico: "Corte feminino",
  profissional: "Ana",
  data: "Ter 30/09",
  hora: "14:30",
  preco: "R$ 80,00",
  quando: "amanhã",
};

const PREVIEW_SAMPLE_VARS_V2 = {
  ...PREVIEW_SAMPLE_VARS,
  duracao: "45 min",
  data_longa: "terça, 30/09",
  prazo: "2 horas",
  retorno: "11:30",
  proximo: "Ter 07/10",
  anterior: "Seg 29/09",
  limite: 3,
};

/**
 * Pré-visualização com valores de exemplo (docs/arquitetura.md §6.7, tela de edição). Na v2 com
 * `key`, `unknownVariables` traz as variáveis NÃO permitidas para aquela chave (mesma regra do upsert).
 */
export function previewBotText(text: string, options?: { flowVersion?: FlowVersion; key?: string }): { preview: string; unknownVariables: string[] } {
  if (options?.flowVersion === 2) {
    const key = options.key as BotTextKeyV2 | undefined;
    const unknownVariables = key && (BOT_TEXT_KEYS_V2 as readonly string[]).includes(key) ? findDisallowedVariables(key, text) : findUnknownVariablesV2(text);
    return { preview: renderTemplate(text, PREVIEW_SAMPLE_VARS_V2), unknownVariables };
  }
  const unknownVariables = findUnknownVariables(text);
  return { preview: renderTemplate(text, PREVIEW_SAMPLE_VARS), unknownVariables };
}

function findUnknownVariablesV2(text: string): string[] {
  const known = BOT_TEXT_VARIABLES_V2 as readonly string[];
  const found: string[] = [];
  for (const match of text.matchAll(/\{(\w+)\}/g)) {
    if (!known.includes(match[1]) && !found.includes(match[1])) found.push(match[1]);
  }
  return found;
}
