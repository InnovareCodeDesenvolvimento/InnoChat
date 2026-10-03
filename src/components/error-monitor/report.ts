import { APP_VERSION } from "@/lib/app-info";
import { isBrowserExtensionOnlyStack } from "@/core/error-monitor/extension-noise";
import { isStaleBuildError } from "@/core/error-monitor/stale-build";

/**
 * Envio de erro do navegador ao monitor (`POST /api/client-errors`). Nunca lança e nunca espera: um erro ao relatar
 * erro não pode virar outro erro. Tetos por página aberta (sem metralhadora quando algo quebra em loop) e sem repetir
 * o mesmo relato. O servidor redige dado pessoal e valida de novo; aqui só se corta o tamanho.
 */

export type ClientErrorKind = "window-error" | "unhandled-rejection" | "boundary";

const MAX_REPORTS_PER_PAGE = 10;
const sent = new Set<string>();

/** Ruído sem ação possível: não adianta ao dono ver. */
const IGNORED_MESSAGES = [/^ResizeObserver loop/i, /^Script error\.?$/i, /^Non-Error promise rejection captured/i];


/** Não recarrega de novo se já recarregou por este motivo há menos disto (evita laço se o problema for outro). */
const STALE_RELOAD_GAP_MS = 30_000;
const STALE_RELOAD_KEY = "innochat:stale-build-reload";

/**
 * Página aberta de uma versão anterior, depois de uma publicação: recarrega uma vez para pegar a versão nova. Devolve
 * `true` se recarregou. Sem `sessionStorage` (aba privada, bloqueio), recarrega mesmo assim só se nunca recarregou
 * nesta página.
 */
let reloadedThisPage = false;
function reloadForNewVersion(): boolean {
  try {
    let last = 0;
    try {
      last = Number(window.sessionStorage.getItem(STALE_RELOAD_KEY) ?? 0) || 0;
    } catch {
      if (reloadedThisPage) return false;
    }
    if (Date.now() - last < STALE_RELOAD_GAP_MS) return false;
    try {
      window.sessionStorage.setItem(STALE_RELOAD_KEY, String(Date.now()));
    } catch {
      // segue sem a marca
    }
    reloadedThisPage = true;
    window.location.reload();
    return true;
  } catch {
    return false;
  }
}

export function reportClientError(error: unknown, kind: ClientErrorKind): void {
  try {
    if (typeof window === "undefined" || sent.size >= MAX_REPORTS_PER_PAGE) return;
    const e = error as { name?: unknown; message?: unknown; stack?: unknown } | null;
    const message = String(e && typeof e === "object" && "message" in e ? e.message : error ?? "Erro sem mensagem").slice(0, 1500);
    if (!message || IGNORED_MESSAGES.some((re) => re.test(message))) return;
    const type = e && typeof e.name === "string" ? e.name.slice(0, 100) : "Error";
    // Versão antiga aberta depois de uma publicação: recarregar resolve, e não é erro do sistema. Se já recarregou há
    // pouco e continua, aí sim relata (pode ser outra causa, como rede ou CDN).
    if (isStaleBuildError(type, message) && reloadForNewVersion()) return;
    const stack = e && typeof e.stack === "string" ? e.stack.slice(0, 8000) : undefined;
    // Extensão do navegador (stack só com chrome-extension://, moz-extension://...): não é erro nosso.
    if (isBrowserExtensionOnlyStack(stack)) return;
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
