import { getPrisma } from "@/lib/db/prisma";
import { isUniqueViolation } from "@/lib/db/prisma-errors";
import { logger } from "@/lib/logger";
import { describeSkipReason, PLATFORM_DIAG_PROVIDER } from "@/core/platform-whatsapp/rules";

/**
 * Diagnóstico do WhatsApp de cobrança (2026-10-03): quando a resposta automática "some", o admin precisa ver
 * no card se a mensagem chegou, se foi respondida e, se não, por quê. Uma linha por conexão em `ProviderEvent`
 * (`providerEventId` = id da conexão). Só instantes, número MASCARADO e códigos: nada de texto do cliente.
 * Gravar diagnóstico NUNCA pode quebrar o webhook: toda falha vira aviso no log.
 */

export type DiagnosticsPayload = {
  /** Qualquer evento autenticado que chegou do webhook (inclusive o eco das nossas próprias mensagens). */
  lastEventAt?: string;
  lastInboundAt?: string;
  lastInboundFrom?: string | null;
  /** `REPLIED` (resposta enviada), `SKIPPED` (de propósito, ver `skipReason`) ou `FAILED` (tentou e falhou). */
  lastInboundOutcome?: "REPLIED" | "SKIPPED" | "FAILED";
  skipReason?: string | null;
  skipMinutes?: number | null;
  lastAutoreplyAt?: string;
  /** Conferência do webhook na Evolution pela manutenção. */
  webhookCheckedAt?: string;
  webhookState?: "OK" | "REPAIRED" | "REPAIR_FAILED" | "CHECK_FAILED" | "UNSUPPORTED";
  webhookRepairedAt?: string;
};

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asPayload(value: unknown): DiagnosticsPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as DiagnosticsPayload) : {};
}

/** Mescla `patch` no diagnóstico da conexão (cria se não existe). Nunca lança. */
export async function patchDiagnostics(connectionId: string, patch: DiagnosticsPayload): Promise<void> {
  try {
    const prisma = getPrisma();
    const where = { provider_providerEventId: { provider: PLATFORM_DIAG_PROVIDER, providerEventId: connectionId } };
    const existing = await prisma.providerEvent.findUnique({ where, select: { payload: true } });
    if (existing) {
      await prisma.providerEvent.update({ where, data: { payload: { ...asPayload(existing.payload), ...patch } as object, processedAt: new Date() } });
      return;
    }
    try {
      await prisma.providerEvent.create({ data: { provider: PLATFORM_DIAG_PROVIDER, providerEventId: connectionId, payload: patch as object, processedAt: new Date() } });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await prisma.providerEvent.findUnique({ where, select: { payload: true } });
      await prisma.providerEvent.update({ where, data: { payload: { ...asPayload(raced?.payload), ...patch } as object } });
    }
  } catch (error) {
    logger.warn("platform_whatsapp.diag_write_failed", { connectionId, errorMessage: errMsg(error) });
  }
}

export type PlatformWhatsappDiagnostics = {
  lastInboundAt: string | null;
  lastInboundFrom: string | null;
  lastAutoreplyAt: string | null;
  lastEventAt: string | null;
  /** `null` quando a última mensagem recebida foi respondida (ou ainda não chegou nenhuma). */
  notRepliedReason: string | null;
  /** Texto pronto para o card sobre o webhook (só quando há algo a dizer). */
  webhookNote: string | null;
};

const WEBHOOK_NOTES: Record<string, string> = {
  REPAIRED: "O endereço de recebimento estava diferente e foi corrigido sozinho",
  REPAIR_FAILED: "O endereço de recebimento está diferente e não deu para corrigir sozinho. Reconecte o número",
  CHECK_FAILED: "Não deu para conferir o endereço de recebimento na Evolution",
};

function dateOrNull(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

export async function getPlatformWhatsappDiagnostics(connectionId: string): Promise<PlatformWhatsappDiagnostics> {
  const row = await getPrisma().providerEvent.findUnique({
    where: { provider_providerEventId: { provider: PLATFORM_DIAG_PROVIDER, providerEventId: connectionId } },
    select: { payload: true },
  });
  const p = asPayload(row?.payload);
  const failed = p.lastInboundOutcome === "SKIPPED" || p.lastInboundOutcome === "FAILED";
  return {
    lastInboundAt: dateOrNull(p.lastInboundAt),
    lastInboundFrom: typeof p.lastInboundFrom === "string" ? p.lastInboundFrom : null,
    lastAutoreplyAt: dateOrNull(p.lastAutoreplyAt),
    lastEventAt: dateOrNull(p.lastEventAt),
    notRepliedReason: failed ? describeSkipReason(p.lastInboundOutcome === "FAILED" ? "SEND_FAILED" : p.skipReason, p.skipMinutes) : null,
    webhookNote: p.webhookState ? (WEBHOOK_NOTES[p.webhookState] ?? null) : null,
  };
}
