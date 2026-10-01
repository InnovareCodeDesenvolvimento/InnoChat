"use server";

import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { DomainError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { runAction, type Result } from "@/lib/result";
import { parseBrazilianPhoneToE164 } from "@/core/whatsapp/phone";
import {
  cancelPlatformConnection,
  disconnectPlatformWhatsapp,
  getPlatformQr,
  getPlatformWhatsappState,
  setPlatformWhatsappEnabled,
  startPlatformConnection,
  type PlatformQrView,
  type PlatformWhatsappState,
} from "@/modules/platform-whatsapp/connections";
import { sendPlatformWhatsappTest, type PlatformWhatsappTestResult } from "@/modules/platform-whatsapp/sender";

export type { PlatformQrView, PlatformWhatsappState, PlatformWhatsappTestResult };

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

const connectionIdSchema = z.string().trim().min(1).max(60);

export async function getPlatformWhatsappAction(): Promise<Result<PlatformWhatsappState>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    return getPlatformWhatsappState();
  });
}

export async function setPlatformWhatsappEnabledAction(input: unknown): Promise<Result<{ enabled: boolean }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const data = z.object({ enabled: z.boolean() }).parse(input);
    return setPlatformWhatsappEnabled(data.enabled, admin.id);
  });
}

/** Conectar o 1º número ou trocar (com um número ativo, a ativa continua enviando até a nova conectar). */
export async function startPlatformWhatsappConnectionAction(input: unknown): Promise<Result<{ connectionId: string }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const data = z.object({ label: z.string() }).parse(input);
    enforceActionLimit(admin.id);
    return startPlatformConnection({ label: data.label, adminId: admin.id });
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
    return cancelPlatformConnection(id, admin.id);
  });
}

export async function disconnectPlatformWhatsappAction(input: unknown): Promise<Result<{ retired: boolean }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const data = z.object({ confirm: z.literal("DESCONECTAR") }).parse(input);
    void data;
    enforceActionLimit(admin.id);
    return disconnectPlatformWhatsapp(admin.id);
  });
}

export async function sendPlatformWhatsappTestAction(input: unknown): Promise<Result<PlatformWhatsappTestResult>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const data = z.object({ toE164: z.string().trim().min(8).max(30) }).parse(input);
    enforceActionLimit(admin.id);
    const parsed = parseBrazilianPhoneToE164(data.toE164);
    return sendPlatformWhatsappTest({ toE164: parsed ?? data.toE164, adminId: admin.id });
  });
}
