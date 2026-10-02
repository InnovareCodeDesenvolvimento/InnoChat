"use server";

import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { checkRateLimit } from "@/lib/rate-limit";
import { DomainError } from "@/lib/errors";
import { runAction, type Result } from "@/lib/result";
import { platformAdminActor, recordAudit } from "@/modules/audit/record";
import { diffChanges } from "@/modules/audit/sanitize";
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
    const data = saveSchema.parse(input);
    const before = await getMetaConfig();
    const saved = await saveMetaConfig(data, admin.id);
    const changes = diffChanges(before, saved, ["enabled", "pixelId", "testEventCode"]);
    if (data.capiToken?.trim()) changes["capiToken"] = { de: null, para: null };
    if (Object.keys(changes).length > 0) {
      await recordAudit({
        tenantId: null,
        actor: platformAdminActor(admin.id),
        action: "pixel.config_changed",
        targetType: "pixel",
        summary: `Alterou o Pixel do Meta: ${Object.keys(changes).join(", ")}. O token da API de Conversões não é guardado aqui.`,
        changes,
      });
    }
    return saved;
  });
}

export async function removeMetaCapiTokenAction(): Promise<Result<MetaConfigView>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const saved = await removeMetaCapiToken(admin.id);
    await recordAudit({
      tenantId: null,
      actor: platformAdminActor(admin.id),
      action: "pixel.token_removed",
      targetType: "pixel",
      summary: "Removeu o token da API de Conversões do Pixel do Meta.",
      changes: { capiToken: { de: null, para: null } },
    });
    return saved;
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
