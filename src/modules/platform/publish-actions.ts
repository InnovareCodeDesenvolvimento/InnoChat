"use server";

import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { runAction, type Result } from "@/lib/result";
import { platformAdminActor, recordAudit } from "@/modules/audit/record";
import {
  downloadLiveBotFlow,
  getBotFlowStatus,
  publishBotFlow,
  rollbackBotFlow,
  type BotFlowStatus,
  type PublishResult,
} from "./n8n-publish";

/**
 * "Publicar fluxo" do bot (docs/bot-v2-plano.md §3.5). Só o admin da plataforma.
 * Erros (`Result.error.code`): N8N_NOT_CONFIGURED, N8N_NOT_SYNCED, N8N_WORKFLOW_NOT_FOUND,
 * N8N_API_ERROR, N8N_UNREACHABLE, CONFIRMATION_REQUIRED, FLOW_DRIFT (details { liveHash,
 * publishedHash }), WEBHOOK_PATH_CHANGED, PUBLISH_VERIFY_FAILED (details { restored }),
 * NO_SNAPSHOT, INVALID_PAYLOAD.
 */

export async function getBotFlowStatusAction(): Promise<Result<BotFlowStatus>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    return getBotFlowStatus();
  });
}

const publishSchema = z.object({ confirm: z.enum(["PUBLICAR", "SOBRESCREVER"]).optional() });

export async function publishBotFlowAction(input: unknown): Promise<Result<PublishResult>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const data = publishSchema.parse(input ?? {});
    const result = await publishBotFlow(admin.id, data.confirm);
    await recordAudit({
      tenantId: null,
      actor: platformAdminActor(admin.id),
      action: "bot_flow.published",
      targetType: "bot_flow",
      summary: `Publicou o fluxo do bot na versão ${result.version}${data.confirm === "SOBRESCREVER" ? " (sobrescrevendo mudanças feitas direto no n8n)" : ""}.`,
      changes: { versao: { de: null, para: result.version } },
    });
    return result;
  });
}

const rollbackSchema = z.object({ confirm: z.literal("VOLTAR") });

export async function rollbackBotFlowAction(input: unknown): Promise<Result<PublishResult>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    rollbackSchema.parse(input);
    const result = await rollbackBotFlow(admin.id);
    await recordAudit({
      tenantId: null,
      actor: platformAdminActor(admin.id),
      action: "bot_flow.rolled_back",
      targetType: "bot_flow",
      summary: `Voltou o fluxo do bot para a versão ${result.version}.`,
      changes: { versao: { de: null, para: result.version } },
    });
    return result;
  });
}

export async function downloadLiveBotFlowAction(): Promise<Result<{ filename: string; json: string }>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    return downloadLiveBotFlow();
  });
}
