/**
 * Pixel do Meta no navegador: consentimento, carregamento e eventos. Tudo aqui só roda no cliente
 * e só depois do "Aceitar" do banner; sem aceite o script da Meta nunca é pedido.
 */

export const CONSENT_STORAGE_KEY = "innochat-consent-meta";
/** Disparado por quem quer reabrir o banner (rodapé: "Preferências de cookies"). */
export const CONSENT_REOPEN_EVENT = "innochat:consent-reopen";

export type ConsentChoice = "granted" | "denied";

/** Lê o valor salvo; qualquer coisa fora do formato esperado vale como "ainda não escolheu". */
export function parseConsent(raw: string | null): ConsentChoice | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { v?: number; choice?: string };
    if (parsed.v === 1 && (parsed.choice === "granted" || parsed.choice === "denied")) return parsed.choice;
  } catch {
    // valor corrompido: pergunta de novo
  }
  return null;
}

export function serializeConsent(choice: ConsentChoice, now = new Date()): string {
  return JSON.stringify({ v: 1, choice, at: now.toISOString() });
}

export function readConsent(): ConsentChoice | null {
  try {
    return parseConsent(window.localStorage.getItem(CONSENT_STORAGE_KEY));
  } catch {
    return null; // armazenamento bloqueado: trata como sem escolha (o banner aparece, o pixel não)
  }
}

export function writeConsent(choice: ConsentChoice): void {
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, serializeConsent(choice));
  } catch {
    // sem armazenamento: a escolha vale só até recarregar
  }
}

export function clearConsent(): void {
  try {
    window.localStorage.removeItem(CONSENT_STORAGE_KEY);
  } catch {
    // nada a limpar
  }
}

type Fbq = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void;
  queue: unknown[][];
  loaded: boolean;
  version: string;
  push: (...args: unknown[]) => void;
};

declare global {
  interface Window {
    fbq?: Fbq;
    _fbq?: Fbq;
    __innochatPixelId?: string;
  }
}

const FBEVENTS_SRC = "https://connect.facebook.net/en_US/fbevents.js";

/** Carrega o fbevents.js (uma vez) e inicia o Pixel. O ID já foi validado no servidor (só dígitos). */
export function loadPixel(pixelId: string): void {
  if (typeof window === "undefined" || !/^\d{5,20}$/.test(pixelId)) return;
  if (window.__innochatPixelId === pixelId) {
    window.fbq?.("consent", "grant");
    return;
  }
  if (!window.fbq) {
    const fbq = function (...args: unknown[]) {
      if (fbq.callMethod) fbq.callMethod(...args);
      else fbq.queue.push(args);
    } as Fbq;
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = "2.0";
    fbq.queue = [];
    window.fbq = fbq;
    window._fbq = fbq;
    const script = document.createElement("script");
    script.async = true;
    script.src = FBEVENTS_SRC;
    document.head.appendChild(script);
  }
  window.fbq("init", pixelId);
  window.__innochatPixelId = pixelId;
}

/**
 * `true` só se o visitante aceitou (a escolha é relida AGORA, então quem recusa depois de aceitar
 * para de enviar na hora) e o Pixel foi iniciado nesta página.
 */
export function isPixelActive(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.fbq === "function" &&
    !!window.__innochatPixelId &&
    readConsent() === "granted"
  );
}

/** Quem retira o consentimento: avisa o Pixel já carregado para não enviar mais nada. */
export function revokePixel(): void {
  if (typeof window !== "undefined" && typeof window.fbq === "function") window.fbq("consent", "revoke");
}

/** A mesma URL sem query e sem fragmento (função pura, testável). */
export function urlWithoutQuery(href: string): string {
  const url = new URL(href);
  return `${url.origin}${url.pathname}`;
}

/** Tira a query da barra de endereço (sem recarregar) antes de o Pixel ler a URL. */
export function stripQueryFromLocation(): void {
  if (typeof window === "undefined") return;
  if (!window.location.search && !window.location.hash) return;
  window.history.replaceState(window.history.state, "", urlWithoutQuery(window.location.href));
}

/** Dispara um evento do navegador. Sem Pixel ativo, não faz nada. `eventId` é o do par com a CAPI. */
export function trackPixel(name: "PageView" | "Lead" | "CompleteRegistration", eventId?: string): void {
  if (!isPixelActive()) return;
  if (eventId) window.fbq!("track", name, {}, { eventID: eventId });
  else window.fbq!("track", name);
}

export function newEventId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}
