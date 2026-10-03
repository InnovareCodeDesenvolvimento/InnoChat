import { z } from "zod";
import { isBrowserExtensionOnlyStack } from "@/core/error-monitor/extension-noise";
import { checkRateLimit } from "@/lib/rate-limit";
import { recordError } from "./capture";

/**
 * Relato de erro vindo do navegador (`POST /api/client-errors`). Rota PÚBLICA de propósito (a tela de login também
 * quebra), então nada do que chega é confiável: corpo pequeno, formato validado, limite por IP e limite global,
 * mesma origem, e tudo passa pela mesma redação de dado pessoal da captura do servidor.
 * `tenantId` nunca vem do navegador; `userId` só entra se quem chama tem sessão (a rota resolve, não o corpo).
 */

export const CLIENT_ERROR_MAX_BODY_BYTES = 16 * 1024;
export const CLIENT_ERROR_PER_IP_PER_MINUTE = 20;
export const CLIENT_ERROR_GLOBAL_PER_MINUTE = 300;

export const clientErrorSchema = z.object({
  type: z.string().max(120).optional(),
  message: z.string().min(1).max(2000),
  stack: z.string().max(12_000).optional(),
  route: z.string().max(300).optional(),
  version: z.string().max(32).optional(),
  kind: z.enum(["window-error", "unhandled-rejection", "boundary"]).optional(),
});

export type ClientErrorReport = z.infer<typeof clientErrorSchema>;

export type ClientErrorOutcome =
  | { status: 202 }
  | { status: 400 | 413 | 429; code: "INVALID_PAYLOAD" | "PAYLOAD_TOO_LARGE" | "RATE_LIMITED"; message: string; retryAfterSeconds?: number };

/**
 * Lê o corpo contando os bytes e para ao passar do limite (não bufferiza o que o atacante mandar sem `Content-Length`,
 * nem com `Transfer-Encoding: chunked`). Devolve `null` se passou do limite.
 */
export async function readBodyWithLimit(request: { body: ReadableStream<Uint8Array<ArrayBufferLike>> | null }, maxBytes: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Mesma origem: se o navegador mandou `Origin`, ele tem que ser o do próprio site (barra relato forjado de outro domínio). */
export function isSameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function handleClientErrorReport(input: {
  rawBody: string;
  contentLength: number | null;
  ip: string;
  /** Resolvido só depois de o relato passar nos limites e na validação (não gasta consulta com lixo). */
  resolveUserId: () => Promise<string | null>;
}): Promise<ClientErrorOutcome> {
  if ((input.contentLength ?? 0) > CLIENT_ERROR_MAX_BODY_BYTES || Buffer.byteLength(input.rawBody, "utf8") > CLIENT_ERROR_MAX_BODY_BYTES) {
    return { status: 413, code: "PAYLOAD_TOO_LARGE", message: "Relato grande demais." };
  }

  const perIp = checkRateLimit(`client-error:${input.ip}`, CLIENT_ERROR_PER_IP_PER_MINUTE, 60_000);
  const global = perIp.allowed ? checkRateLimit("client-error:all", CLIENT_ERROR_GLOBAL_PER_MINUTE, 60_000) : perIp;
  if (!perIp.allowed || !global.allowed) {
    return { status: 429, code: "RATE_LIMITED", message: "Muitos relatos em pouco tempo.", retryAfterSeconds: Math.ceil(Math.max(perIp.retryAfterMs, global.retryAfterMs) / 1000) };
  }

  let parsed: ClientErrorReport;
  try {
    parsed = clientErrorSchema.parse(JSON.parse(input.rawBody));
  } catch {
    return { status: 400, code: "INVALID_PAYLOAD", message: "Relato inválido." };
  }

  // Erro de extensão do navegador: aceita (o navegador não precisa saber) e descarta sem gravar.
  if (isBrowserExtensionOnlyStack(parsed.stack)) return { status: 202 };

  try {
    await recordError({
      source: "CLIENT",
      type: parsed.type,
      message: parsed.message,
      stack: parsed.stack,
      route: parsed.route,
      version: parsed.version,
      userId: await input.resolveUserId(),
      context: parsed.kind ? { kind: parsed.kind } : null,
    });
  } catch (error) {
    // Falha ao gravar não é problema de quem relatou: o navegador não tem o que fazer com isso.
    console.warn("error-monitor: falha ao gravar relato do navegador", error instanceof Error ? error.name : "unknown");
  }
  return { status: 202 };
}
