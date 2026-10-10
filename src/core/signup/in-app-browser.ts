/**
 * Navegador embutido do Instagram/Facebook (WebView). O Google recusa o login ali
 * (`disallowed_useragent`), então o cadastro troca o botão do Google por um que abre a mesma página
 * no navegador do sistema, onde o Google funciona. Funções puras (sem I/O), testadas à parte.
 * Na dúvida, devolve "não é embutido": o formulário com e-mail e senha sempre funciona.
 */
const IN_APP_MARKERS = /\b(Instagram|FBAN|FBAV|FB_IAB|FBIOS|FB4A)\b/i;

export type InAppBrowserInfo = { inApp: boolean; platform: "android" | "ios" | "other" };

export function isInAppBrowser(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  return IN_APP_MARKERS.test(userAgent);
}

export function detectInAppBrowser(userAgent: string | null | undefined): InAppBrowserInfo {
  if (!isInAppBrowser(userAgent)) return { inApp: false, platform: "other" };
  const ua = userAgent ?? "";
  if (/Android/i.test(ua)) return { inApp: true, platform: "android" };
  if (/iPhone|iPad|iPod/i.test(ua)) return { inApp: true, platform: "ios" };
  return { inApp: true, platform: "other" };
}

/** Parâmetros que acompanham a pessoa para o outro navegador: cupom e campanha (para a Meta atribuir). */
const CARRIED_PARAMS = ["cupom", "utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid"] as const;

/** `?cupom=...&utm_*=...&fbclid=...&via=google`: só o que está na lista, com tamanho limitado. */
export function carriedQuery(params: Record<string, string | string[] | undefined>, extra: Record<string, string> = {}): string {
  const out = new URLSearchParams();
  for (const key of CARRIED_PARAMS) {
    const raw = params[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value) out.set(key, value.slice(0, 200));
  }
  for (const [key, value] of Object.entries(extra)) out.set(key, value);
  return out.toString();
}

/**
 * Link que abre `https://<host><path>?<query>` fora do navegador embutido.
 * - Android: `intent://` pedindo o Chrome; se não der, o Android volta para a URL https (`browser_fallback_url`).
 * - iOS: `x-safari-https://` (iOS 17+); em versões antigas nada acontece e a tela mostra a instrução manual.
 * - Outros: a própria URL https.
 */
export function externalBrowserHref(platform: InAppBrowserInfo["platform"], host: string, path: string, query: string): string {
  const suffix = query ? `?${query}` : "";
  const httpsUrl = `https://${host}${path}${suffix}`;
  if (platform === "android") {
    return `intent://${host}${path}${suffix}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(httpsUrl)};end`;
  }
  if (platform === "ios") return `x-safari-https://${host}${path}${suffix}`;
  return httpsUrl;
}
