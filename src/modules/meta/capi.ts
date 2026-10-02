import { createHash } from "node:crypto";
import { logger } from "@/lib/logger";
import type { MetaEventName } from "@/core/meta/pixel";

/**
 * API de Conversões do Meta (servidor -> Meta). Tudo aqui é FIRE-AND-FORGET: nada lança, nada
 * espera mais que `CAPI_TIMEOUT_MS`, e o token NUNCA vai para log (vai no corpo, não na URL).
 *
 * Dados do usuário seguem a regra da Meta: e-mail, telefone e ids externos em minúsculas/normalizados
 * e com hash SHA-256 em hexadecimal; IP, user agent, `fbp` e `fbc` seguem em claro (a Meta pede assim).
 */

export const META_GRAPH_VERSION = "v23.0";
export const CAPI_TIMEOUT_MS = 4000;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashEmail(email: string): string {
  return sha256Hex(email.trim().toLowerCase());
}

/** Telefone: só dígitos com DDI (o cadastro já guarda assim). Sem 10 dígitos no mínimo, não manda. */
export function hashPhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 ? sha256Hex(digits) : null;
}

export type MetaUserInput = {
  email?: string | null;
  phone?: string | null;
  externalId?: string | null;
  clientIp?: string | null;
  clientUserAgent?: string | null;
  fbp?: string | null;
  fbc?: string | null;
};

type UserData = Record<string, string | string[]>;

export function buildUserData(user: MetaUserInput): UserData {
  const data: UserData = {};
  if (user.email) data.em = [hashEmail(user.email)];
  const ph = user.phone ? hashPhone(user.phone) : null;
  if (ph) data.ph = [ph];
  if (user.externalId) data.external_id = [sha256Hex(user.externalId)];
  if (user.clientIp && user.clientIp !== "unknown") data.client_ip_address = user.clientIp;
  if (user.clientUserAgent) data.client_user_agent = user.clientUserAgent.slice(0, 500);
  if (user.fbp) data.fbp = user.fbp.slice(0, 200);
  if (user.fbc) data.fbc = user.fbc.slice(0, 300);
  return data;
}

export type MetaServerEvent = {
  name: MetaEventName;
  eventId: string;
  /** Segundos desde 1970; padrão = agora. */
  eventTime?: number;
  sourceUrl: string;
  user: MetaUserInput;
  customData?: Record<string, string | number | boolean>;
};

export function buildCapiBody(event: MetaServerEvent, testEventCode?: string | null): Record<string, unknown> {
  return {
    data: [
      {
        event_name: event.name,
        event_time: event.eventTime ?? Math.floor(Date.now() / 1000),
        event_id: event.eventId,
        action_source: "website",
        event_source_url: event.sourceUrl,
        user_data: buildUserData(event.user),
        ...(event.customData ? { custom_data: event.customData } : {}),
      },
    ],
    ...(testEventCode ? { test_event_code: testEventCode } : {}),
  };
}

export type CapiCredentials = { pixelId: string; token: string; testEventCode?: string | null };
export type CapiSendResult = { ok: boolean; detail: string };

/**
 * Envia UM evento. Nunca lança. `fetchImpl` existe para teste. A resposta da Meta é resumida
 * (status + `error.message` quando houver); o corpo inteiro e o token não entram no retorno.
 */
export async function sendCapiEvent(
  creds: CapiCredentials,
  event: MetaServerEvent,
  fetchImpl: typeof fetch = fetch,
): Promise<CapiSendResult> {
  try {
    const response = await fetchImpl(`https://graph.facebook.com/${META_GRAPH_VERSION}/${creds.pixelId}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...buildCapiBody(event, creds.testEventCode), access_token: creds.token }),
      signal: AbortSignal.timeout(CAPI_TIMEOUT_MS),
      cache: "no-store",
    });
    if (response.ok) return { ok: true, detail: "A Meta recebeu o evento." };
    let message = `A Meta respondeu ${response.status}.`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) message = `A Meta recusou: ${body.error.message}`;
    } catch {
      // corpo que não é JSON: fica a mensagem com o status
    }
    logger.warn("meta.capi.rejected", { status: response.status, event: event.name });
    return { ok: false, detail: message };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    logger.warn("meta.capi.failed", { event: event.name, timedOut });
    return { ok: false, detail: timedOut ? "A Meta não respondeu a tempo." : "Não deu para falar com a Meta." };
  }
}
