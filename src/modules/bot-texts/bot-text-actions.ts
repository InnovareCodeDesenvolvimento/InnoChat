"use server";

import { z } from "zod";
import { requireTenantMember } from "@/lib/auth/guards";
import { runAction, type Result } from "@/lib/result";
import { assertTenantCanWrite } from "@/modules/billing/service";
import { BOT_TEXT_KEYS } from "@/core/bot/texts";
import { BOT_TEXT_KEYS_V2, LEGACY_V1_KEYS } from "@/core/bot/texts-v2";
import { getPublishedFlowVersion, listBotTexts, previewBotText, resetBotText, upsertBotText, type BotTextsView } from "./service";

/**
 * CRUD de `BotText` para a futura tela "Mensagens do bot" (Lyra, fora do escopo da Fase 4 —
 * "sem tela" nesta fase). Guardadas por `requireTenantMember(tenantSlug)`, mesma convenção de
 * `docs/contratos.md`.
 *
 * `assertTenantCanWrite` nas duas mutações (revisão de segurança 2026-09-28, achado BAIXA):
 * faltava aqui — uma empresa `SUSPENDED`/`CANCELED` ainda editava textos do bot, inconsistente
 * com "painel só leitura quando suspenso" (§7.4). `listBotTextsAction`/`previewBotTextAction`
 * continuam sem o guard: são leitura, não escrita.
 */

// Chaves aceitas: união v1 + v2 + legadas (reset de legada continua permitido). A versão do fluxo
// publicado decide, no service, quais dessas são EDITÁVEIS (upsert recusa fora do catálogo da versão).
const keySchema = z.enum([...new Set([...BOT_TEXT_KEYS, ...BOT_TEXT_KEYS_V2, ...LEGACY_V1_KEYS])] as [string, ...string[]]);

export async function listBotTextsAction(tenantSlug: string): Promise<Result<BotTextsView>> {
  return runAction(async () => {
    const { tenant } = await requireTenantMember(tenantSlug);
    return listBotTexts(tenant.id, await getPublishedFlowVersion());
  });
}

const upsertSchema = z.object({ key: keySchema, text: z.string().trim().min(1).max(1000) });

export async function upsertBotTextAction(tenantSlug: string, input: unknown): Promise<Result<unknown>> {
  return runAction(async () => {
    const { tenant } = await requireTenantMember(tenantSlug);
    await assertTenantCanWrite(tenant.id);
    const data = upsertSchema.parse(input);
    return upsertBotText(tenant.id, data.key, data.text, await getPublishedFlowVersion());
  });
}

export async function resetBotTextAction(tenantSlug: string, key: unknown): Promise<Result<{ key: string }>> {
  return runAction(async () => {
    const { tenant } = await requireTenantMember(tenantSlug);
    await assertTenantCanWrite(tenant.id);
    const parsedKey = keySchema.parse(key);
    await resetBotText(tenant.id, parsedKey);
    return { key: parsedKey };
  });
}

const previewSchema = z.object({ text: z.string().trim().min(1).max(1000), key: keySchema.optional() });

/** Pré-visualização com valores de exemplo — não exige o texto já estar salvo. */
export async function previewBotTextAction(tenantSlug: string, input: unknown): Promise<Result<{ preview: string; unknownVariables: string[] }>> {
  return runAction(async () => {
    await requireTenantMember(tenantSlug);
    const data = previewSchema.parse(input);
    return previewBotText(data.text, { flowVersion: await getPublishedFlowVersion(), key: data.key });
  });
}
