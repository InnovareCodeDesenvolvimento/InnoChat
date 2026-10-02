import { getPrisma } from "@/lib/db/prisma";
import type { Prisma } from "@/lib/db/types";
import { encryptSecret } from "@/lib/crypto";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { isValidPixelId, isValidTestEventCode, normalizePixelId } from "@/core/meta/pixel";
import { loadPlatformSettingsRow, readEncryptedSecret } from "@/modules/platform/secrets";

/**
 * Pixel do Meta + API de Conversões, configurados no banco (`PlatformSettings`), nunca em env.
 * O ID do Pixel não é segredo (vai no HTML público); o token da CAPI é cifrado e NUNCA volta à tela.
 * FAIL-CLOSED: token que não decifra vale como ausente (a CAPI não envia, o Pixel do navegador continua).
 */

export type MetaRuntimeConfig = {
  pixelId: string;
  /** `null` = só o Pixel do navegador (sem Purchase pelo servidor). */
  capiToken: string | null;
  testEventCode: string | null;
};

const CACHE_TTL_MS = 30_000;
let cache: { at: number; value: MetaRuntimeConfig | null } | null = null;

export function invalidateMetaConfigCache(): void {
  cache = null;
}

/** Config viva (ligada e com ID válido) ou `null`. Nunca lança: falha de banco = sem Pixel. */
export async function getMetaRuntimeConfig(now = Date.now()): Promise<MetaRuntimeConfig | null> {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.value;
  let value: MetaRuntimeConfig | null = null;
  try {
    const row = await loadPlatformSettingsRow();
    if (row?.metaEnabled && row.metaPixelId && isValidPixelId(row.metaPixelId)) {
      value = {
        pixelId: row.metaPixelId,
        capiToken: readEncryptedSecret(row.metaCapiTokenEnc, "metaCapiTokenEnc"),
        testEventCode: row.metaTestEventCode && isValidTestEventCode(row.metaTestEventCode) ? row.metaTestEventCode : null,
      };
    }
  } catch (error) {
    logger.error("meta.config.load_failed", { errorMessage: error instanceof Error ? error.message : String(error) });
    return null; // não cacheia a falha
  }
  cache = { at: now, value };
  return value;
}

/** O que a área pública precisa: só o ID, e só se estiver ligado. */
export async function getPublicPixelId(): Promise<string | null> {
  return (await getMetaRuntimeConfig())?.pixelId ?? null;
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export type MetaConfigView = {
  enabled: boolean;
  pixelId: string | null;
  capiTokenSaved: boolean;
  testEventCode: string | null;
};

async function buildView(): Promise<MetaConfigView> {
  const row = await loadPlatformSettingsRow();
  return {
    enabled: row?.metaEnabled ?? false,
    pixelId: row?.metaPixelId ?? null,
    capiTokenSaved: !!readEncryptedSecret(row?.metaCapiTokenEnc, "metaCapiTokenEnc"),
    testEventCode: row?.metaTestEventCode ?? null,
  };
}

export async function getMetaConfig(): Promise<MetaConfigView> {
  return buildView();
}

export type SaveMetaConfigInput = {
  enabled?: boolean;
  pixelId?: string;
  /** Vazio mantém o atual. */
  capiToken?: string;
  /** `""` apaga o código de teste. */
  testEventCode?: string;
};

export async function saveMetaConfig(input: SaveMetaConfigInput, updatedByUserId: string): Promise<MetaConfigView> {
  const current = await loadPlatformSettingsRow();
  const data: Prisma.PlatformSettingsUncheckedUpdateInput = {};

  let newPixelId: string | undefined;
  if (input.pixelId !== undefined) {
    const pixelId = normalizePixelId(input.pixelId);
    if (!pixelId || !isValidPixelId(pixelId)) {
      throw new DomainError("INVALID_PIXEL_ID", "O ID do Pixel tem só números, de 5 a 20 dígitos. Confira o valor copiado do Gerenciador de Eventos.");
    }
    newPixelId = pixelId;
    data.metaPixelId = pixelId;
  }
  const token = input.capiToken?.trim();
  if (token) {
    if (token.length < 20 || token.length > 1000 || /\s/.test(token)) {
      throw new DomainError("INVALID_CAPI_TOKEN", "O token da API de Conversões é uma sequência longa, sem espaços. Copie de novo, inteiro.");
    }
    data.metaCapiTokenEnc = encryptSecret(token);
  }
  if (input.testEventCode !== undefined) {
    const code = input.testEventCode.trim();
    if (code && !isValidTestEventCode(code)) {
      throw new DomainError("INVALID_TEST_EVENT_CODE", "O código de teste tem só letras e números, como TEST12345.");
    }
    data.metaTestEventCode = code || null;
  }
  if (input.enabled !== undefined) {
    data.metaEnabled = input.enabled;
    if (input.enabled && !(newPixelId ?? current?.metaPixelId)) {
      throw new DomainError("META_CONFIG_INCOMPLETE", "Informe o ID do Pixel antes de ligar.");
    }
  }

  logger.info("platform.meta.saved", { enabled: input.enabled ?? null, pixelId: input.pixelId !== undefined, capiToken: !!token });
  await getPrisma().platformSettings.upsert({
    where: { id: 1 },
    create: { id: 1, ...data, updatedByUserId } as Prisma.PlatformSettingsUncheckedCreateInput,
    update: { ...data, updatedByUserId },
  });
  invalidateMetaConfigCache();
  return buildView();
}

export async function removeMetaCapiToken(updatedByUserId: string): Promise<MetaConfigView> {
  logger.info("platform.meta.token_removed", {});
  await getPrisma().platformSettings.upsert({
    where: { id: 1 },
    create: { id: 1, metaCapiTokenEnc: null, updatedByUserId },
    update: { metaCapiTokenEnc: null, updatedByUserId },
  });
  invalidateMetaConfigCache();
  return buildView();
}
