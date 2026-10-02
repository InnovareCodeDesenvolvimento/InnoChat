import { createHash } from "node:crypto";
import { redactText, SENSITIVE_KEY_RE } from "./redact";

/**
 * Transforma "algo que deu errado" (Error, texto solto, relato do navegador) no registro que o monitor grava:
 * tipo, mensagem e stack JÁ sem dado pessoal e dentro dos limites do banco (CHECKs da migration), mais a assinatura
 * (fingerprint) que agrupa ocorrências iguais. Puro: nada de banco, rede ou relógio.
 */

export type ErrorSource = "SERVER" | "CLIENT";

export const MESSAGE_MAX_CHARS = 300;
export const TYPE_MAX_CHARS = 120;
export const STACK_MAX_BYTES = 8000;
/** O CHECK do banco é 4096 bytes do jsonb::text (que ganha espaços); sobra folga. */
export const CONTEXT_MAX_BYTES = 3000;
export const ROUTE_MAX_CHARS = 200;

export type RawErrorInput = {
  source: ErrorSource;
  /** Um Error (ou qualquer coisa lançada). Tem prioridade sobre type/message/stack soltos. */
  error?: unknown;
  type?: string;
  message?: string;
  stack?: string;
  route?: string | null;
  version?: string | null;
  userId?: string | null;
  tenantId?: string | null;
  context?: Record<string, unknown> | null;
};

export type PreparedError = {
  fingerprint: string;
  source: ErrorSource;
  type: string;
  message: string;
  stack: string | null;
  route: string | null;
  version: string | null;
  userId: string | null;
  tenantId: string | null;
  context: Record<string, unknown> | null;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/** Corta em N bytes UTF-8 sem deixar caractere pela metade. */
export function truncateBytes(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  return decoder.decode(bytes.subarray(0, maxBytes)).replace(/�+$/, "");
}

/** Corta por caractere (code point), com reticências quando cortou. */
export function truncateChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** Caminho sem query/hash e com segmentos que parecem id trocados por `:id` (a rota não pode carregar dado pessoal). */
export function sanitizeRoute(route: string | null | undefined): string | null {
  if (!route) return null;
  const path = route.split(/[?#]/)[0] ?? "";
  if (!path.startsWith("/")) return null;
  const cleaned = path
    .split("/")
    .map((seg) => (/^(?:\d{2,}|[0-9a-f]{8}-[0-9a-f-]{27}|c[a-z0-9]{20,}|[A-Za-z0-9_-]{24,})$/.test(seg) ? ":id" : seg))
    .join("/");
  return truncateChars(redactText(cleaned), ROUTE_MAX_CHARS);
}

function cleanId(value: string | null | undefined): string | null {
  return value && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

function cleanVersion(value: string | null | undefined): string | null {
  return value && /^[0-9A-Za-z.+-]{1,32}$/.test(value) ? value : null;
}

function cleanType(value: string | undefined): string {
  const cleaned = (value ?? "").replace(/[^\w$.: -]/g, "").trim();
  return truncateChars(cleaned || "Error", TYPE_MAX_CHARS);
}

/** Texto do contexto: só valores simples, redigidos e curtos; chaves sensíveis somem. Profundidade e tamanho limitados. */
export function sanitizeContext(context: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!context || typeof context !== "object") return null;
  const walk = (value: unknown, depth: number): unknown => {
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "string") return truncateChars(redactText(value), 200);
    if (depth >= 3) return undefined;
    if (Array.isArray(value)) return value.slice(0, 10).map((v) => walk(v, depth + 1)).filter((v) => v !== undefined);
    if (typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 20)) {
        if (SENSITIVE_KEY_RE.test(k)) continue;
        const walked = walk(v, depth + 1);
        if (walked !== undefined) out[truncateChars(redactText(k), 60)] = walked;
      }
      return out;
    }
    return undefined;
  };
  const out = walk(context, 0) as Record<string, unknown>;
  if (Object.keys(out).length === 0) return null;
  return encoder.encode(JSON.stringify(out)).length <= CONTEXT_MAX_BYTES ? out : { truncated: true };
}

/** Mensagem "genérica": ids, números, uuid e hex viram marcadores para que a mesma falha com dados diferentes agrupe. */
export function normalizeMessage(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\bc[a-z0-9]{24}\b/g, "<id>")
    .replace(/\b(?:0x)?[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\d+(?:\.\d+)?/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Primeiro quadro "nosso" da stack (ignora node_modules e internos do Node), reduzido a `função@arquivo` sem linha,
 * coluna nem hash de build: assim o mesmo erro agrupa entre versões publicadas. Sem quadro útil devolve "".
 */
export function normalizeStackTop(stack: string | null | undefined): string {
  if (!stack) return "";
  const frames = stack.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("at ") || /@.+:\d+:\d+$/.test(l));
  const own = frames.find((f) => !/node_modules|node:internal|\(native\)|<anonymous>$/.test(f)) ?? frames[0];
  if (!own) return "";
  const v8 = /^at\s+(?:async\s+)?(?:(.+?)\s+\()?(.+?)(?::\d+)*\)?$/.exec(own);
  const gecko = /^(.*?)@(.+?)(?::\d+)*$/.exec(own);
  const fn = (v8 ? v8[1] : gecko ? gecko[1] : "") ?? "";
  const file = (v8 ? v8[2] : gecko ? gecko[2] : own) ?? "";
  const base = (file.split(/[\\/]/).pop() ?? "").replace(/[?#].*$/, "").replace(/[-_.]?[0-9a-f]{8,}/gi, "");
  return `${fn.trim()}@${base}`;
}

export function computeFingerprint(parts: { source: ErrorSource; type: string; message: string; stack: string | null; route: string | null }): string {
  const top = normalizeStackTop(parts.stack);
  // Sem stack útil (erro de render em produção chega só com mensagem genérica), a rota separa um problema do outro.
  const where = top || parts.route || "";
  const raw = [parts.source, parts.type, normalizeMessage(parts.message), where].join("␟");
  return createHash("sha256").update(raw).digest("hex");
}

function describeThrown(error: unknown): { type: string; message: string; stack: string | undefined } {
  if (error instanceof Error) return { type: error.name, message: error.message, stack: error.stack };
  if (typeof error === "string") return { type: "Error", message: error, stack: undefined };
  if (error && typeof error === "object") {
    const e = error as { name?: unknown; message?: unknown; stack?: unknown };
    return {
      type: typeof e.name === "string" ? e.name : "Error",
      message: typeof e.message === "string" ? e.message : "Erro sem mensagem",
      stack: typeof e.stack === "string" ? e.stack : undefined,
    };
  }
  return { type: "Error", message: String(error), stack: undefined };
}

export function prepareError(input: RawErrorInput): PreparedError {
  const thrown = input.error !== undefined ? describeThrown(input.error) : null;
  const type = cleanType(thrown?.type ?? input.type);
  const message = truncateChars(redactText(thrown?.message ?? input.message ?? "Erro sem mensagem").trim() || "Erro sem mensagem", MESSAGE_MAX_CHARS);
  const rawStack = thrown?.stack ?? input.stack;
  const stack = rawStack ? truncateBytes(redactText(rawStack), STACK_MAX_BYTES) : null;
  const route = sanitizeRoute(input.route);
  return {
    fingerprint: computeFingerprint({ source: input.source, type, message, stack, route }),
    source: input.source,
    type,
    message,
    stack,
    route,
    version: cleanVersion(input.version),
    userId: cleanId(input.userId),
    tenantId: cleanId(input.tenantId),
    context: sanitizeContext(input.context),
  };
}
