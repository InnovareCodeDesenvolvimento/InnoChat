import { getPublicSalesWhatsapp } from "@/modules/platform/sales-contact";
import { randomBytes } from "node:crypto";
import { withBlockingAdvisoryLock } from "@/lib/db/advisory-lock";
import { getPrisma } from "@/lib/db/prisma";
import { isUniqueViolation } from "@/lib/db/prisma-errors";
import { logger } from "@/lib/logger";
import { normalizeEvolutionMessage, resolveSenderIdentity } from "@/core/bot/evolution-normalize";
import { parseConnectionEvent } from "@/core/whatsapp/connection-event";
import {
  AUTOREPLY_PRIORITY_HARD_CAP,
  AUTOREPLY_WINDOW_MS,
  autoreplyText,
  CONFIRM_REPLY,
  decideAutoreply,
  digitsOnly,
  hashLidForDedup,
  hashPhoneForDedup,
  hashWebhookToken,
  isConfirmText,
  isOptOutText,
  maskPhone,
  OPT_OUT_CONFIRMATION,
  optOutNotFoundText,
  PLATFORM_AUTOREPLY_PROVIDER,
  PLATFORM_REPLY_PROVIDER,
  phoneDigitVariants,
  type SkipReason,
} from "@/core/platform-whatsapp/rules";
import { getEvolutionClient, type EvolutionClient } from "@/modules/whatsapp/evolution-client";
import { handleRescueInboundMessage } from "@/modules/rescue/webhook";
import { applyOpenConnection, markActiveDisconnected, type PlatformWhatsappDeps } from "./connections";
import { patchDiagnostics } from "./diagnostics";
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
  // Prova de vida do webhook (inclusive o eco das nossas mensagens): separa "o evento não chega" de "chega e não responde".
  await patchDiagnostics(connection.id, { lastEventAt: (deps?.now ?? new Date()).toISOString() });
  try {
    if (eventName === "CONNECTION_UPDATE") {
      await handleConnectionUpdate(connection, body, deps);
    } else if (eventName === "MESSAGES_UPSERT") {
      await handleInboundMessage(connection, { ...(body as Record<string, unknown>), event: "messages.upsert" }, deps);
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

async function handleInboundMessage(connection: ConnectionRow, payload: Record<string, unknown>, deps?: PlatformWhatsappDeps): Promise<void> {
  const connectionId = connection.id;
  const normalized = normalizeEvolutionMessage(payload);
  if (normalized.kind !== "message" || normalized.fromMe) return;
  // Status/canal não são conversa com ninguém: sem resposta e sem ruído no diagnóstico.
  if (/@(broadcast|newsletter)$/.test(normalized.jid)) return;

  const now = deps?.now ?? new Date();
  const identity = resolveSenderIdentity(normalized);
  const senderDigits = identity.waJid ? digitsOnly(identity.waJid.split("@")[0] ?? "") : "";
  // Remetente só com LID (a Evolution não trouxe o telefone): responde ao próprio @lid.
  // Empresa e opt-out dependem do telefone, então ficam de fora nesse caso.
  const lidJid = !senderDigits && identity.lid ? identity.lid : null;
  const replyTo = senderDigits || lidJid || "";
  const contactKey = senderDigits ? hashPhoneForDedup(senderDigits) : lidJid ? hashLidForDedup(lidJid) : "";
  const fromMasked = senderDigits ? maskPhone(senderDigits) : lidJid ? "contato sem número" : null;

  await patchDiagnostics(connectionId, { lastInboundAt: now.toISOString(), lastInboundFrom: fromMasked });
  const skip = async (reason: SkipReason, minutes?: number): Promise<void> => {
    logger.info("platform_whatsapp.autoreply_skipped", { connectionId, reason });
    await patchDiagnostics(connectionId, { lastInboundOutcome: "SKIPPED", skipReason: reason, skipMinutes: minutes ?? null });
  };

  if (!replyTo) return skip("NO_SENDER");
  // Trava 1: a plataforma nunca responde a si mesma (nem a um chip que já foi da plataforma).
  if (senderDigits && (await isPlatformSender(senderDigits))) return skip("OWN_NUMBER");

  const prisma = getPrisma();
  const variants = senderDigits ? phoneDigitVariants(senderDigits) : [];
  const text = normalized.content.type === "text" ? normalized.content.text : normalized.content.label;

  // Se a conexão for de propósito RESCUE, desvia para o fluxo de resgate
  if (connection.purpose === "RESCUE") {
    if (senderDigits) {
      await handleRescueInboundMessage(
        {
          connectionId,
          senderDigits,
          text,
          replyTo,
        },
        deps,
      );
    }
    return;
  }
  const optOut = normalized.content.type === "text" && isOptOutText(text);
  const confirm = !optOut && normalized.content.type === "text" && isConfirmText(text);

  const tenant =
    variants.length > 0
      ? await prisma.tenant.findFirst({ where: { billingWhatsappE164: { in: variants } }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } })
      : null;
  // Trava 3: nunca responde automaticamente a um número que seja o bot de alguma empresa.
  const botNumber =
    variants.length > 0
      ? await prisma.whatsappInstance.findFirst({ where: { deletedAt: null, phoneE164: { in: variants.flatMap((v) => [v, `+${v}`]) } }, select: { id: true } })
      : null;

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
          from: fromMasked,
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
    // Só a PRIMEIRA confirmação responde com prioridade; "SIM" repetido cai na trava por contato.
    confirmed = res.count > 0;
    logger.info("platform_whatsapp.contact_confirmed", { tenantId: tenant.id, tenantsUpdated: res.count });
  }

  if (botNumber) return skip("COMPANY_BOT");
  const decision = decideAutoreply(await recentAutoreplyTimes(contactKey, now), now, optOut || confirmed);
  if (!decision.allow) return skip(decision.reason, decision.reason === "RECENT" ? decision.minutesAgo : undefined);

  let evolution: EvolutionClient;
  try {
    evolution = deps?.evolution ?? (await getEvolutionClient());
  } catch {
    return skip("NO_EVOLUTION");
  }
  if (!connection || connection.role === "RETIRED") return skip("CONNECTION_RETIRED");

  // Reserva atômica: a checagem do teto e a gravação da reserva rodam sob uma trava por contato. Duas entregas
  // simultâneas esperam a vez; a segunda enxerga a reserva da primeira e cai em RECENT, então não há resposta dupla.
  let reservationId: string | null = null;
  try {
    const reserved = await withBlockingAdvisoryLock(`platform-autoreply:${contactKey}`, async () => {
      const again = decideAutoreply(await recentAutoreplyTimes(contactKey, now), now, optOut || confirmed);
      if (!again.allow) return { ok: false as const, decision: again };
      const reservation = await prisma.providerEvent.create({
        data: { provider: AUTOREPLY_PROVIDER, providerEventId: `${contactKey}:${now.getTime()}-${randomBytes(2).toString("hex")}`, payload: {}, processedAt: now },
        select: { id: true },
      });
      return { ok: true as const, id: reservation.id };
    });
    if (!reserved.ok) return skip(reserved.decision.reason, reserved.decision.reason === "RECENT" ? reserved.decision.minutesAgo : undefined);
    reservationId = reserved.id;
    const support = (await getPublicSalesWhatsapp().catch(() => null))?.display ?? null;
    const replyText = optOut ? (tenant ? OPT_OUT_CONFIRMATION : optOutNotFoundText(support)) : confirmed ? CONFIRM_REPLY : autoreplyText(support);
    await evolution.sendText(connection.instanceName, replyTo, replyText);
    await patchDiagnostics(connectionId, { lastInboundOutcome: "REPLIED", skipReason: null, skipMinutes: null, lastAutoreplyAt: now.toISOString() });
  } catch (error) {
    logger.warn("platform_whatsapp.autoreply_failed", { connectionId, viaLid: lidJid !== null, errorMessage: error instanceof Error ? error.message : String(error) });
    // A reserva de um envio que não saiu não pode travar o contato por 10 min.
    if (reservationId) await prisma.providerEvent.delete({ where: { id: reservationId } }).catch(() => undefined);
    await patchDiagnostics(connectionId, { lastInboundOutcome: "FAILED", skipReason: "SEND_FAILED", skipMinutes: null });
  }
}

/** Instantes das respostas automáticas da janela de 24 h ao contato, da mais recente para a mais antiga. */
async function recentAutoreplyTimes(contactKey: string, now: Date): Promise<Date[]> {
  const rows = await getPrisma().providerEvent.findMany({
    where: { provider: AUTOREPLY_PROVIDER, providerEventId: { startsWith: `${contactKey}:` }, createdAt: { gte: new Date(now.getTime() - AUTOREPLY_WINDOW_MS) } },
    orderBy: { createdAt: "desc" },
    take: AUTOREPLY_PRIORITY_HARD_CAP + 1,
    select: { createdAt: true },
  });
  return rows.map((r) => r.createdAt);
}
