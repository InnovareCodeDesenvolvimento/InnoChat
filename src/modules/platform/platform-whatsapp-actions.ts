"use server";

import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { DomainError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { getPrisma } from "@/lib/db/prisma";
import { runAction, type Result } from "@/lib/result";
import { platformAdminActor, recordAudit } from "@/modules/audit/record";
import { parseBrazilianPhoneToE164 } from "@/core/whatsapp/phone";
import {
  cancelPlatformConnection,
  disconnectPlatformWhatsapp,
  getPlatformQr,
  getPlatformWhatsappState,
  setPlatformWhatsappEnabled,
  startPlatformConnection,
  type PlatformQrView,
  type PlatformWhatsappPurpose,
  type PlatformWhatsappState,
} from "@/modules/platform-whatsapp/connections";
import { sendPlatformWhatsappTest, type PlatformWhatsappTestResult } from "@/modules/platform-whatsapp/sender";

export type { PlatformQrView, PlatformWhatsappPurpose, PlatformWhatsappState, PlatformWhatsappTestResult };

/**
 * Server Actions do card "WhatsApp de cobrança" no Admin (docs/regua-de-cobranca.md §2.4). Todas
 * guardadas por `requirePlatformAdmin()`. As que mexem em número (conectar/trocar, cancelar, desconectar
 * e testar) têm limite de 10 ações a cada 10 minutos por admin (`RATE_LIMITED`); leituras e o polling do
 * QR (a cada 3 s) não contam.
 */

const ACTION_LIMIT = 10;
const ACTION_WINDOW_MS = 10 * 60 * 1000;

function enforceActionLimit(adminId: string): void {
  const rate = checkRateLimit(`platform-whatsapp:${adminId}`, ACTION_LIMIT, ACTION_WINDOW_MS);
  if (!rate.allowed) {
    throw new DomainError("RATE_LIMITED", "Muitas ações em pouco tempo. Aguarde alguns minutos antes de tentar de novo.", { retryAfterMs: rate.retryAfterMs });
  }
}

async function auditWhatsapp(adminId: string, action: string, summary: string, changes?: { [k: string]: { de: unknown; para: unknown } } | null, targetId?: string) {
  await recordAudit({ tenantId: null, actor: platformAdminActor(adminId), action, targetType: "platform_whatsapp", targetId: targetId ?? null, summary, changes: changes ?? null });
}

const connectionIdSchema = z.string().trim().min(1).max(60);
const purposeSchema = z.enum(["BILLING", "RESCUE"]).default("BILLING");

export async function getPlatformWhatsappAction(input?: unknown): Promise<Result<PlatformWhatsappState>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    const purpose = input ? purposeSchema.parse(input) : "BILLING";
    return getPlatformWhatsappState(purpose);
  });
}

export async function setPlatformWhatsappEnabledAction(input: unknown): Promise<Result<{ enabled: boolean }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const data = z.object({ enabled: z.boolean() }).parse(input);
    const before = await getPrisma().platformSettings.findUnique({ where: { id: 1 }, select: { platformWhatsappEnabled: true } });
    const result = await setPlatformWhatsappEnabled(data.enabled, admin.id);
    if ((before?.platformWhatsappEnabled ?? false) !== result.enabled) {
      await auditWhatsapp(admin.id, "platform_whatsapp.enabled_changed", `${result.enabled ? "Ligou" : "Desligou"} os avisos de cobrança pelo WhatsApp da plataforma.`, { enabled: { de: !result.enabled, para: result.enabled } });
    }
    return result;
  });
}

/** Conectar o 1º número ou trocar (com um número ativo, a ativa continua enviando até a nova conectar). */
export async function startPlatformWhatsappConnectionAction(input: unknown): Promise<Result<{ connectionId: string }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const data = z.object({ label: z.string(), purpose: z.enum(["BILLING", "RESCUE"]).optional() }).parse(input);
    enforceActionLimit(admin.id);
    const purpose = data.purpose ?? "BILLING";
    const started = await startPlatformConnection({ label: data.label, adminId: admin.id, purpose });
    const purposeLabel = purpose === "RESCUE" ? "resgate" : "cobrança";
    await auditWhatsapp(admin.id, "platform_whatsapp.connection_started", `Começou a conectar um número no WhatsApp de ${purposeLabel} da plataforma.`, null, started.connectionId);
    return started;
  });
}

/** Polling de 3 s: devolve o QR vigente, ou `CONNECTED` quando já foi lido. Serve também para reconectar a ativa caída. */
export async function getPlatformWhatsappQrAction(connectionId: unknown): Promise<Result<PlatformQrView>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    return getPlatformQr(connectionIdSchema.parse(connectionId));
  });
}

export async function cancelPlatformWhatsappConnectionAction(connectionId: unknown): Promise<Result<{ canceled: boolean }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const id = connectionIdSchema.parse(connectionId);
    enforceActionLimit(admin.id);
    const canceled = await cancelPlatformConnection(id, admin.id);
    if (canceled.canceled) await auditWhatsapp(admin.id, "platform_whatsapp.connection_canceled", "Cancelou a conexão de número em andamento no WhatsApp da plataforma.", null, id);
    return canceled;
  });
}

export async function disconnectPlatformWhatsappAction(input: unknown): Promise<Result<{ retired: boolean }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const data = z.object({ confirm: z.literal("DESCONECTAR"), purpose: z.enum(["BILLING", "RESCUE"]).optional() }).parse(input);
    enforceActionLimit(admin.id);
    const purpose = data.purpose ?? "BILLING";
    const retired = await disconnectPlatformWhatsapp(admin.id, purpose);
    const purposeLabel = purpose === "RESCUE" ? "resgate" : "cobrança";
    if (retired.retired) await auditWhatsapp(admin.id, "platform_whatsapp.disconnected", `Desconectou o número do WhatsApp de ${purposeLabel} da plataforma.`);
    return retired;
  });
}

export async function sendPlatformWhatsappTestAction(input: unknown): Promise<Result<PlatformWhatsappTestResult>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const data = z.object({ toE164: z.string().trim().min(8).max(30), purpose: z.enum(["BILLING", "RESCUE"]).optional() }).parse(input);
    enforceActionLimit(admin.id);
    const parsed = parseBrazilianPhoneToE164(data.toE164);
    const purpose = data.purpose ?? "BILLING";
    return sendPlatformWhatsappTest({ toE164: parsed ?? data.toE164, adminId: admin.id, purpose });
  });
}
