/**
 * Logger estruturado mínimo (JSON em produção, legível em dev).
 *
 * Regra dura (docs/arquitetura.md §11, §14): NUNCA logar conteúdo de
 * mensagem do WhatsApp, senha, token, segredo ou dado pessoal (telefone
 * completo, e-mail) em texto livre. `redact()` existe para isso — use nos
 * pontos de entrada de requisição e nos erros de integração, sempre.
 */

type Level = "debug" | "info" | "warn" | "error";

type LogFields = Record<string, unknown>;

const SENSITIVE_KEYS = new Set([
  "password",
  "passwordHash",
  "token",
  "tokenHash",
  "secret",
  "apiKey",
  "authorization",
  "text",
  "message",
  "webhookToken",
]);

/**
 * Remove campos sensíveis de um objeto antes de logar. Superficial de
 * propósito (1 nível) — quem loga um payload aninhado deve extrair os campos
 * que importam, não jogar o objeto inteiro.
 */
export function redact(fields: LogFields): LogFields {
  const safe: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    safe[key] = SENSITIVE_KEYS.has(key) ? "[redacted]" : value;
  }
  return safe;
}

/**
 * Gancho opcional para `logger.error` (monitor de erros). Guardado em `globalThis` por Symbol: o código de
 * instrumentação e o das rotas podem ser bundles distintos, cada um com a SUA cópia deste módulo.
 * O sink recebe os campos já redigidos e nunca pode lançar nem chamar `logger.error` (loop).
 */
export type ErrorSink = (event: string, fields: LogFields) => void;
const SINK_KEY = Symbol.for("innochat.logger.errorSink");

export function setErrorSink(sink: ErrorSink | null): void {
  (globalThis as Record<symbol, unknown>)[SINK_KEY] = sink ?? undefined;
}

function emit(level: Level, message: string, fields?: LogFields) {
  const safeFields = fields ? redact(fields) : {};
  const entry = {
    level,
    message,
    time: new Date().toISOString(),
    ...safeFields,
  };

  const line = process.env.NODE_ENV === "production" ? JSON.stringify(entry) : entry;
  console[level === "debug" ? "log" : level](line);

  if (level === "error") {
    const sink = (globalThis as Record<symbol, unknown>)[SINK_KEY] as ErrorSink | undefined;
    if (sink) {
      try {
        sink(message, safeFields);
      } catch {
        // O monitor jamais pode quebrar quem loga.
      }
    }
  }
}

export const logger = {
  debug: (message: string, fields?: LogFields) => emit("debug", message, fields),
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
  error: (message: string, fields?: LogFields) => emit("error", message, fields),
};
