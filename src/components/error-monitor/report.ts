import { APP_VERSION } from "@/lib/app-info";

/**
 * Envio de erro do navegador ao monitor (`POST /api/client-errors`). Nunca lança e nunca espera: um erro ao relatar
 * erro não pode virar outro erro. Tetos por página aberta (sem metralhadora quando algo quebra em loop) e sem repetir
 * o mesmo relato. O servidor redige dado pessoal e valida de novo; aqui só se corta o tamanho.
 */

export type ClientErrorKind = "window-error" | "unhandled-rejection" | "boundary";

const MAX_REPORTS_PER_PAGE = 10;
const sent = new Set<string>();

/** Ruído sem ação possível: não adianta ao dono ver. */
const IGNORED_MESSAGES = [/^ResizeObserver loop/i, /^Script error\.?$/i, /^Non-Error promise rejection captured/i, /Loading chunk [\w-]+ failed/i];

export function reportClientError(error: unknown, kind: ClientErrorKind): void {
  try {
    if (typeof window === "undefined" || sent.size >= MAX_REPORTS_PER_PAGE) return;
    const e = error as { name?: unknown; message?: unknown; stack?: unknown } | null;
    const message = String(e && typeof e === "object" && "message" in e ? e.message : error ?? "Erro sem mensagem").slice(0, 1500);
    if (!message || IGNORED_MESSAGES.some((re) => re.test(message))) return;
    const type = e && typeof e.name === "string" ? e.name.slice(0, 100) : "Error";
    const stack = e && typeof e.stack === "string" ? e.stack.slice(0, 8000) : undefined;
    const key = `${type}|${message}|${(stack ?? "").slice(0, 200)}`;
    if (sent.has(key)) return;
    sent.add(key);

    void fetch("/api/client-errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, message, stack, route: window.location.pathname, version: APP_VERSION, kind }),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Silêncio de propósito.
  }
}
