/**
 * Ruído de navegador e WebView: erros gerados pelo ambiente do cliente (WebViews com wrappers nativos quebrados,
 * requisições de fetch canceladas pela navegação imediata da página, etc.) que não representam defeito no nosso código.
 *
 * Puro, sem I/O: serve ao navegador (antes de enviar) e ao servidor (antes de gravar), porque a rota é pública e aceita
 * relato de qualquer cliente.
 */

/**
 * iabjs (In-App Browser JS) do Chrome Android WebView: wrappers de injeção como
 * `iabjs://navigation_performance_logger_android:1:...` que quebram quando a página navega ou o host nativo é destruído.
 * Identificado por frames iniciando com `iabjs://` ou pela mensagem exata de objeto Java destruído.
 */
const IABJS_STACK_LINE = /^\s*at\s+.*\(?iabjs:\/\//im;
const IABJS_URL_IN_STACK = /\biabjs:\/\//i;
const IABJS_MESSAGE = /^Error invoking postMessage: Java object is gone$/;

/**
 * Erros de fetch abortado ou cancelado pelo navegador ao navegar ou fechar a página.
 * No Safari/WebKit vira "TypeError: Load failed", no Chrome "TypeError: Failed to fetch",
 * no Firefox "TypeError: NetworkError when attempting to fetch resource".
 */
const FETCH_ABORT_MESSAGES = [
  /^Load failed$/i,
  /^Failed to load$/i,
  /^NetworkError when attempting to fetch resource$/i,
];

/** Frame com caminho de build do Next.js (nosso app). */
const NEXT_APP_FRAME = /https?:\/\/[^\s)\/]+\/_next\//i;

export interface BrowserNoiseOptions {
  appHost?: string | RegExp;
}

export function isBrowserNoiseError(
  type: string | null | undefined,
  message: string | null | undefined,
  stack: string | null | undefined,
  opts?: BrowserNoiseOptions,
): boolean {
  const msg = (message ?? "").trim();

  // (a) iabjs (Chrome Android WebView)
  if (IABJS_MESSAGE.test(msg)) return true;
  if (stack && (IABJS_URL_IN_STACK.test(stack) || IABJS_STACK_LINE.test(stack))) return true;

  // (b) Load failed do fetch abortado pela navegação
  const matchesFetchAbort = FETCH_ABORT_MESSAGES.some((re) => re.test(msg));
  if (matchesFetchAbort) {
    // Se não há stack, ou o stack NÃO contém nenhum frame do nosso app, é ruído de fetch abortado
    if (!stack) return true;

    // Checa se tem frame com /_next/
    if (NEXT_APP_FRAME.test(stack)) {
      return false;
    }

    // Checa se tem frame com o host do nosso app (se fornecido)
    if (opts?.appHost) {
      if (typeof opts.appHost === "string") {
        if (opts.appHost.length > 0 && stack.includes(opts.appHost)) {
          return false;
        }
      } else if (opts.appHost.test(stack)) {
        return false;
      }
    }

    // Não tem nenhum frame do nosso app
    return true;
  }

  return false;
}
