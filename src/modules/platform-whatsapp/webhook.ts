import { getPublicSalesWhatsapp } from "@/modules/platform/sales-contact";
import { randomBytes } from "node:crypto";
import { getPrisma } from "@/lib/db/prisma";
import { isUniqueViolation } from "@/lib/db/prisma-errors";
import { logger } from "@/lib/logger";
import { normalizeEvolutionMessage, resolveSenderIdentity } from "@/core/bot/evolution-normalize";
import { parseConnectionEvent } from "@/core/whatsapp/connection-event";
import {
  AUTOREPLY_INTERVAL_MS,
  autoreplyText,
  CONFIRM_REPLY,
  digitsOnly,
  hashPhoneForDedup,
  hashWebhookToken,
  isConfirmText,
  isOptOutText,
  maskPhone,
  OPT_OUT_CONFIRMATION,
  PLATFORM_AUTOREPLY_PROVIDER,
  PLATFORM_REPLY_PROVIDER,
  phoneDigitVariants,
} from "@/core/platform-whatsapp/rules";
import { getEvolutionClient, type EvolutionClient } from "@/modules/whatsapp/evolution-client";
import { applyOpenConnection, markActiveDisconnected, type PlatformWhatsappDeps } from "./connections";
import { isPlatformSender } from "./sender-guard";

/**
 * Webhook PRÓPRIO do WhatsApp da plataforma (`POST /api/webhooks/platform-whatsapp/[token]`,
 * docs/regua-de-cobranca.md §2.4). Nunca passa pelo n8n/bot. O token identifica a conexão (só o hash
 * fica no banco); token desconhecido = 401; conexão aposentada = 410 (a Evolution para de insistir).
 * Qualquer outro evento, reconhecido ou não, devolve 200: nunca 5xx para payload estranho.
 */

export const REPLY_PROVIDER = PLATFORM_REPLY_PROVIDER;
const AUTOREPLY_PROVIDER = PLATFORM_AUTOREPLY_PROVIDER;
const PREVIEW_MAX = 200;

export type PlatformWebhookOutcome = { status: 200 | 401 | 410; body: Record<string, unknown> };

type ConnectionRow = NonNullable<Awaited<ReturnType<ReturnType<typeof getPrisma>["platformWhatsappConnection"]["findUnique"]>>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function handlePlatformWhatsappWebhook(token: string, body: unknown, deps?: PlatformWhatsappDeps): Promise<PlatformWebhookOutcome> {
  const unauthorized: PlatformWebhookOutcome = { status: 401, body: { error: { code: "UNAUTHORIZED", message: "Token inválido." } } };
  if (!token || token.length > 200) return unauthorized;
  const prisma = getPrisma();
  const connection = await prisma.platformWhatsappConnection.findUnique({ where: { webhookTokenHash: hashWebhookToken(token) } });
  if (!connection) return unauthorized;
  if (connection.role === "RETIRED") return { status: 410, body: { error: { code: "GONE", message: "Esta conexão foi encerrada." } } };

  const eventName = isRecord(body) && typeof body.event === "string" ? body.event.toUpperCase().replace(/\./g, "_") : "";
  try {
    if (eventName === "CONNECTION_UPDATE") {
      await handleConnectionUpdate(connection, body, deps);
    } else if (eventName === "MESSAGES_UPSERT") {
      await handleInboundMessage(connection.id, { ...(body as Record<string, unknown>), event: "messages.upsert" }, deps);
    } else {
      return { status: 200, body: { status: "ignored" } };
    }
  } catch (error) {
    // Nunca 5xx: a Evolution reentregaria em loop. O erro vai para o log (sem o corpo do evento).
    logger.error("platform_whatsapp.webhook_error", { connectionId: connection.id, event: eventName, errorMessage: error instanceof Error ? error.message : String(error) });
  }
  return { status: 200, body: { status: "ok" } };
}

async function handleConnectionUpdate(connection: ConnectionRow, body: unknown, deps?: PlatformWhatsappDeps): Promise<void> {
  const event = parseConnectionEvent(body);
  if (!event) return;
  if (event.state === "CONNECTED") {
    let ownerJid = event.ownerJid;
    if (!ownerJid) {
      try {
        const evolution = deps?.evolution ?? (await getEvolutionClient());
        ownerJid = await evolution.fetchOwnerJid(connection.instanceName);
      } catch {
        // sem o dono agora: o polling da tela ou o tick resolvem
      }
    }
    await applyOpenConnection(connection, ownerJid, deps);
    return;
  }
  // Evento (diferente de consulta) vale direto. Só a ACTIVE que estava conectada "cai"; PENDING esperando QR fica como está.
  if (event.state === "DISCONNECTED" && connection.role === "ACTIVE") await markActiveDisconnected(connection.id, deps?.now ?? new Date());
}

// ---------------------------------------------------------------------------------------------
// Resposta de assinante
// ---------------------------------------------------------------------------------------------

async function handleInboundMessage(connectionId: string, payload: Record<string, unknown>, deps?: PlatformWhatsappDeps): Promise<void> {
  const normalized = normalizeEvolutionMessage(payload);
  if (normalized.kind !== "message" || normalized.fromMe) return;

  const identity = resolveSenderIdentity(normalized);
  const senderDigits = identity.waJid ? digitsOnly(identity.waJid.split("@")[0] ?? "") : "";
  if (!senderDigits) return;

  // Trava 1: a plataforma nunca responde a si mesma (nem a um chip que já foi da plataforma).
  if (await isPlatformSender(senderDigits)) return;

  const prisma = getPrisma();
  const now = deps?.now ?? new Date();
  const variants = phoneDigitVariants(senderDigits);
  const text = normalized.content.type === "text" ? normalized.content.text : normalized.content.label;
  const optOut = normalized.content.type === "text" && isOptOutText(text);
  const confirm = !optOut && normalized.content.type === "text" && isConfirmText(text);

  const tenant = await prisma.tenant.findFirst({
    where: { billingWhatsappE164: { in: variants } },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });
  // Trava 3: nunca responde automaticamente a um número que seja o bot de alguma empresa.
  const botNumber = await prisma.whatsappInstance.findFirst({
    where: { deletedAt: null, phoneE164: { in: variants.flatMap((v) => [v, `+${v}`]) } },
    select: { id: true },
  });

  // Dedup + registro para o sino (a própria linha É o item PLATFORM_WHATSAPP_REPLY).
  try {
    await prisma.providerEvent.create({
      data: {
        provider: REPLY_PROVIDER,
        providerEventId: `${connectionId}:${normalized.providerMessageId}`,
        payload: {
          connectionId,
          tenantId: tenant?.id ?? null,
          tenantName: tenant?.name ?? null,
          from: maskPhone(senderDigits),
          preview: Array.from(text).slice(0, PREVIEW_MAX).join(""),
          optOut,
        },
        processedAt: now,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) return;
    throw error;
  }

  if (optOut && tenant) {
    const res = await prisma.tenant.updateMany({
      where: { billingWhatsappE164: { in: variants }, billingWhatsappOptOutAt: null },
      data: { billingWhatsappOptOutAt: now },
    });
    logger.info("platform_whatsapp.opt_out", { tenantId: tenant.id, tenantsUpdated: res.count });
  }

  // "SIM" do dono do número: confirma a posse (o WhatsApp deixa de ser limitado a 1 por dia).
  let confirmed = false;
  if (confirm && tenant) {
    const res = await prisma.tenant.updateMany({
      where: { billingWhatsappE164: { in: variants }, billingWhatsappConfirmedAt: null },
      data: { billingWhatsappConfirmedAt: now },
    });
    confirmed = true;
    logger.info("platform_whatsapp.contact_confirmed", { tenantId: tenant.id, tenantsUpdated: res.count });
  }

  if (botNumber) return;
  if (!optOut && !confirmed && (await autoreplySentRecently(senderDigits, now))) return;

  let evolution: EvolutionClient;
  try {
    evolution = deps?.evolution ?? (await getEvolutionClient());
  } catch {
    return;
  }
  const connection = await prisma.platformWhatsappConnection.findUnique({ where: { id: connectionId }, select: { instanceName: true, role: true } });
  if (!connection || connection.role === "RETIRED") return;
  try {
    await prisma.providerEvent.create({
      data: { provider: AUTOREPLY_PROVIDER, providerEventId: `${hashPhoneForDedup(senderDigits)}:${now.getTime()}-${randomBytes(2).toString("hex")}`, payload: {}, processedAt: now },
    });
    await evolution.sendText(
      connection.instanceName,
      senderDigits,
      optOut && tenant ? OPT_OUT_CONFIRMATION : confirmed ? CONFIRM_REPLY : autoreplyText((await getPublicSalesWhatsapp())?.display ?? null),
    );
  } catch (error) {
    logger.warn("platform_whatsapp.autoreply_failed", { connectionId, errorMessage: error instanceof Error ? error.message : String(error) });
  }
}

/** Trava 2: a mensagem automática sai no máximo 1 vez por contato a cada 24 h. */
async function autoreplySentRecently(senderDigits: string, now: Date): Promise<boolean> {
  const recent = await getPrisma().providerEvent.findFirst({
    where: { provider: AUTOREPLY_PROVIDER, providerEventId: { startsWith: `${hashPhoneForDedup(senderDigits)}:` }, createdAt: { gte: new Date(now.getTime() - AUTOREPLY_INTERVAL_MS) } },
    select: { id: true },
  });
  return recent !== null;
}
