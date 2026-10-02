"use server";

import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { checkRateLimit } from "@/lib/rate-limit";
import { DomainError } from "@/lib/errors";
import { runAction, type Result } from "@/lib/result";
import { getMetaConfig, removeMetaCapiToken, saveMetaConfig, type MetaConfigView } from "./config";
import { sendMetaTestEvent } from "./tracking";

/** Admin > Configurações > Pixel do Meta. NUNCA devolvem o token da CAPI, só `capiTokenSaved`. */

export async function getMetaConfigAction(): Promise<Result<MetaConfigView>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    return getMetaConfig();
  });
}

const saveSchema = z.object({
  enabled: z.boolean().optional(),
  pixelId: z.string().max(60).optional(),
  capiToken: z.string().max(1200).optional(),
  testEventCode: z.string().max(60).optional(),
});

export async function saveMetaConfigAction(input: unknown): Promise<Result<MetaConfigView>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    return saveMetaConfig(saveSchema.parse(input), admin.id);
  });
}

export async function removeMetaCapiTokenAction(): Promise<Result<MetaConfigView>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    return removeMetaCapiToken(admin.id);
  });
}

export async function testMetaConfigAction(): Promise<Result<{ ok: boolean; detail: string }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const limit = checkRateLimit(`meta-test:${admin.id}`, 10, 60_000);
    if (!limit.allowed) throw new DomainError("RATE_LIMITED", "Muitos testes seguidos. Espere um minuto.");
    return sendMetaTestEvent();
  });
}
