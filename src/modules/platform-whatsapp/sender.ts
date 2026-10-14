import { getPrisma } from "@/lib/db/prisma";
import { isUniqueViolation } from "@/lib/db/prisma-errors";
import { logger } from "@/lib/logger";
import { mapEvolutionState } from "@/core/whatsapp/connection-event";
import { digitsOnly, maskPhone, phoneDigitVariants, ROUND_WINDOW_MS, roundCapFor, withNewNumberNotice } from "@/core/platform-whatsapp/rules";
import { EvolutionApiError, getEvolutionClient, type EvolutionClient } from "@/modules/whatsapp/evolution-client";
import { markActiveDisconnected, type PlatformWhatsappPurpose } from "./connections";
import { isPlatformSender } from "./sender-guard";

/**
 * Envio pelo WhatsApp da plataforma (docs/regua-de-cobranca.md §2.4 e F5). É o ÚNICO ponto de saída
 * da cobrança pelo WhatsApp: a régua (F2) só conhece esta função.
 *
 * Contrato:
 * - resolve a conexão ACTIVE NO MOMENTO do envio (trocar de número entre o planejamento e o envio
 *   não quebra nada: o aviso sai pelo número vigente);
 * - `NO_PLATFORM_NUMBER`: chave geral desligada, ou nenhuma conexão ACTIVE;
 * - `CHANNEL_DOWN`: há número ativo, mas caído (ou a Evolution não está configurada/respondeu que a
 *   sessão não está aberta). A conexão é marcada DISCONNECTED nesse caso;
 * - `BLOCKED_LOOP`: o destinatário é um número que é (ou já foi) da plataforma. A plataforma nunca fala
 *   consigo mesma;
 * - `FAILED`: erro de rede/Evolution com a sessão aberta, OU teto de envios da última hora atingido
 *   (aquecimento: 10/h nos 3 primeiros dias, depois 30/h). Reenviar depois é seguro: nada saiu;
 *   Quando a Evolution RECUSA o número (HTTP 400, ou `exists: false` no corpo), `reason: "INVALID_NUMBER"`: o painel
 *   da empresa usa isso para pedir que o dono confira o WhatsApp de cobrança.
 * - `SENT`: `connectionId`, `senderPhoneE164` (só dígitos) e `providerMessageId` para a régua gravar no
 *   `BillingNotice`.
 *
 * Telefones: só dígitos com DDI (como `Tenant.billingWhatsappE164`); aceita "+" e máscara na entrada.
 * UMA tentativa de envio (reenviar após timeout pode duplicar a mensagem no WhatsApp do assinante).
 * Nunca loga o texto nem o telefone inteiro.
 */

export type PlatformWhatsappOutcome = "SENT" | "NO_PLATFORM_NUMBER" | "CHANNEL_DOWN" | "FAILED" | "BLOCKED_LOOP";

export type PlatformWhatsappSendResult = {
  outcome: PlatformWhatsappOutcome;
  connectionId?: string;
  senderPhoneE164?: string;
  providerMessageId?: string;
  /** Só com `FAILED`: a Evolution recusou o NÚMERO do destinatário (não é falha do nosso canal). */
  reason?: "INVALID_NUMBER";
};

export type PlatformWhatsappSendDeps = { evolution?: EvolutionClient; now?: Date };

const NEW_NUMBER_MARKER_PROVIDER = "platform-whatsapp-newnumber";

export async function sendPlatformWhatsapp(
  args: { toE164: string; text: string; tenantId: string; noticeId: string },
  deps?: PlatformWhatsappSendDeps,
): Promise<PlatformWhatsappSendResult> {
  const now = deps?.now ?? new Date();
  const prisma = getPrisma();

  const settings = await prisma.platformSettings.findUnique({ where: { id: 1 }, select: { platformWhatsappEnabled: true } });
  if (!settings?.platformWhatsappEnabled) return { outcome: "NO_PLATFORM_NUMBER" };

  const active = await prisma.platformWhatsappConnection.findFirst({ where: { role: "ACTIVE", purpose: "BILLING" } });
  if (!active || !active.phoneE164) return { outcome: "NO_PLATFORM_NUMBER" };
  const base = { connectionId: active.id, senderPhoneE164: active.phoneE164 };

  if (active.status !== "CONNECTED") return { outcome: "CHANNEL_DOWN", connectionId: active.id };

  const to = digitsOnly(args.toE164);
  if (!to) return { outcome: "FAILED", connectionId: active.id };
  if (await isPlatformSender(to, now.getTime())) {
    logger.warn("platform_whatsapp.send_blocked_loop", { tenantId: args.tenantId, noticeId: args.noticeId });
    return { outcome: "BLOCKED_LOOP", connectionId: active.id };
  }

  const budget = await getRoundBudget(active, now);
  if (budget.used >= budget.cap) {
    logger.info("platform_whatsapp.send_round_cap", { connectionId: active.id, cap: budget.cap, tenantId: args.tenantId, noticeId: args.noticeId });
    return { outcome: "FAILED", connectionId: active.id };
  }

  let evolution: EvolutionClient;
  try {
    evolution = deps?.evolution ?? (await getEvolutionClient());
  } catch {
    return { outcome: "CHANNEL_DOWN", connectionId: active.id };
  }

  const announceNewNumber = await shouldAnnounceNewNumber(args.tenantId, active.phoneE164);
  const text = announceNewNumber ? withNewNumberNotice(args.text) : args.text;

  try {
    const sent = await evolution.sendText(active.instanceName, to, text);
    if (announceNewNumber) await markNewNumberAnnounced(args.tenantId, active.phoneE164);
    logger.info("platform_whatsapp.sent", { connectionId: active.id, tenantId: args.tenantId, noticeId: args.noticeId, announcedNewNumber: announceNewNumber });
    return { outcome: "SENT", ...base, ...(sent.messageId ? { providerMessageId: sent.messageId } : {}) };
  } catch (error) {
    logger.warn("platform_whatsapp.send_failed", {
      connectionId: active.id,
      tenantId: args.tenantId,
      noticeId: args.noticeId,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    // Sessão fechada na Evolution = canal caído (a régua adia/pula conforme a etapa), não falha de envio.
    try {
      const mapped = mapEvolutionState(await evolution.connectionState(active.instanceName));
      if (mapped === "DISCONNECTED") {
        await markActiveDisconnected(active.id, now);
        return { outcome: "CHANNEL_DOWN", connectionId: active.id };
      }
    } catch {
      // Evolution fora do ar: tratado como falha de envio (tenta de novo depois).
    }
    // Sessão aberta e a Evolution respondeu 400 / "exists: false": o número do destinatário não tem WhatsApp (ou está errado).
    if (isRecipientRejection(error)) return { outcome: "FAILED", connectionId: active.id, reason: "INVALID_NUMBER" };
    return { outcome: "FAILED", connectionId: active.id };
  }
}

/** 400 da Evolution no envio, ou corpo com `"exists":false`: quem recusou foi o número, não o canal. */
export function isRecipientRejection(error: unknown): boolean {
  if (!(error instanceof EvolutionApiError)) return false;
  if (error.status === 400) return true;
  return /"exists"\s*:\s*false/.test(error.responseBody ?? "");
}

/**
 * Confere, pelo número da plataforma, se um telefone tem WhatsApp (usado ao salvar o WhatsApp de cobrança).
 * `NOT_FOUND` só quando a Evolution respondeu e NENHUMA das formas do número (com/sem o 9º dígito) existe.
 * Qualquer dúvida (sem número ativo, canal caído, Evolution fora, prazo estourado, resposta estranha) é `UNKNOWN`:
 * quem chama salva normalmente. Nunca lança, nunca loga o número inteiro.
 */
export async function checkPlatformWhatsappNumber(toE164: string, deps?: PlatformWhatsappSendDeps): Promise<"EXISTS" | "NOT_FOUND" | "UNKNOWN"> {
  try {
    const active = await getPrisma().platformWhatsappConnection.findFirst({ where: { role: "ACTIVE", purpose: "BILLING" } });
    if (!active || active.status !== "CONNECTED") return "UNKNOWN";
    const variants = phoneDigitVariants(toE164);
    if (variants.length === 0) return "UNKNOWN";
    const evolution = deps?.evolution ?? (await getEvolutionClient());
    const answers = await evolution.checkWhatsappNumbers(active.instanceName, variants);
    if (answers.length === 0) return "UNKNOWN";
    return answers.some((a) => a.exists) ? "EXISTS" : "NOT_FOUND";
  } catch (error) {
    logger.warn("platform_whatsapp.number_check_failed", { to: maskPhone(toE164), errorName: error instanceof Error ? error.name : "unknown" });
    return "UNKNOWN";
  }
}

// ---------------------------------------------------------------------------------------------
// Ritmo (aquecimento)
// ---------------------------------------------------------------------------------------------

type ActiveRow = { id: string; activatedAt: Date | null };

async function getRoundBudget(active: ActiveRow, now: Date): Promise<{ cap: number; used: number }> {
  const used = await getPrisma().billingNotice.count({
    where: { platformConnectionId: active.id, channel: "WHATSAPP", status: "SENT", sentAt: { gte: new Date(now.getTime() - ROUND_WINDOW_MS) } },
  });
  return { cap: roundCapFor(active.activatedAt, now), used };
}

/**
 * Quanto ainda cabe na rodada (última hora) pelo número vigente, para o despachante da régua limitar o
 * lote ANTES de reservar os avisos. `null` = sem número ativo.
 */
export async function getPlatformWhatsappRoundBudget(now: Date = new Date()): Promise<{ connectionId: string; cap: number; used: number; remaining: number } | null> {
  const active = await getPrisma().platformWhatsappConnection.findFirst({ where: { role: "ACTIVE", purpose: "BILLING" }, select: { id: true, activatedAt: true } });
  if (!active) return null;
  const { cap, used } = await getRoundBudget(active, now);
  return { connectionId: active.id, cap, used, remaining: Math.max(0, cap - used) };
}

// ---------------------------------------------------------------------------------------------
// Aviso de "novo número" (uma vez por empresa e por número)
// ---------------------------------------------------------------------------------------------

/**
 * A 1ª mensagem de um número novo para cada empresa avisa a troca, SE a empresa já recebeu avisos de
 * OUTRO número (quem nunca recebeu nada não tem o que estranhar). Idempotente por marcador
 * (`ProviderEvent` empresa+número), então duas mensagens seguidas depois da troca avisam uma vez só.
 */
async function shouldAnnounceNewNumber(tenantId: string, senderPhone: string): Promise<boolean> {
  const prisma = getPrisma();
  const marker = await prisma.providerEvent.findUnique({
    where: { provider_providerEventId: { provider: NEW_NUMBER_MARKER_PROVIDER, providerEventId: `${tenantId}:${digitsOnly(senderPhone)}` } },
    select: { id: true },
  });
  if (marker) return false;
  const previous = await prisma.billingNotice.findFirst({
    where: { tenantId, channel: "WHATSAPP", status: "SENT", senderPhoneE164: { not: null } },
    orderBy: { sentAt: "desc" },
    select: { senderPhoneE164: true },
  });
  if (!previous?.senderPhoneE164) return false;
  const current = phoneDigitVariants(senderPhone);
  return !phoneDigitVariants(previous.senderPhoneE164).some((v) => current.includes(v));
}

async function markNewNumberAnnounced(tenantId: string, senderPhone: string): Promise<void> {
  try {
    await getPrisma().providerEvent.create({
      data: { provider: NEW_NUMBER_MARKER_PROVIDER, providerEventId: `${tenantId}:${digitsOnly(senderPhone)}`, payload: {}, processedAt: new Date() },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Mensagem de teste do Admin (fora da régua: sem BillingNotice, só log)
// ---------------------------------------------------------------------------------------------

export const TEST_MESSAGE_TEXT = "Teste do WhatsApp de cobrança do InnoChat. Se esta mensagem chegou, o número está funcionando.";
export const RESCUE_TEST_MESSAGE_TEXT = "Teste do WhatsApp de resgate do InnoChat. Se você recebeu esta mensagem, o número está respondendo.";

export type PlatformWhatsappTestResult = { sent: boolean; errorCode?: "NO_PLATFORM_NUMBER" | "CHANNEL_DOWN" | "BLOCKED_LOOP" | "SEND_FAILED" | "INVALID_NUMBER" };

export async function sendPlatformWhatsappTest(
  args: { toE164: string; adminId: string; purpose?: PlatformWhatsappPurpose },
  deps?: PlatformWhatsappSendDeps,
): Promise<PlatformWhatsappTestResult> {
  const purpose: PlatformWhatsappPurpose = args.purpose ?? "BILLING";
  const prisma = getPrisma();
  const active = await prisma.platformWhatsappConnection.findFirst({ where: { role: "ACTIVE", purpose } });
  if (!active) return { sent: false, errorCode: "NO_PLATFORM_NUMBER" };
  if (active.status !== "CONNECTED") return { sent: false, errorCode: "CHANNEL_DOWN" };

  const to = digitsOnly(args.toE164);
  if (to.length < 12 || to.length > 13) return { sent: false, errorCode: "INVALID_NUMBER" };
  if (await isPlatformSender(to, (deps?.now ?? new Date()).getTime())) return { sent: false, errorCode: "BLOCKED_LOOP" };

  let evolution: EvolutionClient;
  try {
    evolution = deps?.evolution ?? (await getEvolutionClient());
  } catch {
    return { sent: false, errorCode: "CHANNEL_DOWN" };
  }
  const text = purpose === "RESCUE" ? RESCUE_TEST_MESSAGE_TEXT : TEST_MESSAGE_TEXT;
  try {
    await evolution.sendText(active.instanceName, to, text);
    logger.info("platform_whatsapp.test_sent", { connectionId: active.id, adminId: args.adminId, purpose, to: maskPhone(to) });
    return { sent: true };
  } catch (error) {
    logger.warn("platform_whatsapp.test_failed", { connectionId: active.id, adminId: args.adminId, purpose, errorMessage: error instanceof Error ? error.message : String(error) });
    return { sent: false, errorCode: "SEND_FAILED" };
  }
}
