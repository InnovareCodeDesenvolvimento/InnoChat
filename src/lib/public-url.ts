import { headers } from "next/headers";
import { getPrisma } from "@/lib/db/prisma";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { extractEdgeHop, isFromCloudflareEdge } from "@/lib/http/client-ip";

/**
 * URL pública do painel — decisão do dono (2026-09-28): nenhuma URL/credencial solta em env
 * var. Todo link de e-mail (verificação, reset, convite, cobrança), o `n8nWebhookBaseUrl` mostrado
 * ao admin, a URL do painel enviada ao n8n e a base do Auth.js (`redirect_uri` do Google) passam
 * por aqui.
 *
 * SEGURANÇA (revisão do Órion, I3 — host header poisoning): cabeçalhos `Host`/`x-forwarded-*` vêm
 * do cliente (o proxy só os sobrescreve se estiver configurado para isso — nunca verificado), então
 * NÃO podem decidir o destino de um link de e-mail: um atacante pediria "esqueci a senha" da
 * vítima com `Host: evil.com` e o token de reset iria para o domínio dele. Por isso:
 *
 *  1. `PlatformSettings.publicBaseUrl` (gravada pelo admin da plataforma) é a fonte CONFIÁVEL e
 *     tem prioridade absoluta.
 *  2. Cabeçalhos da requisição só valem como fallback enquanto NÃO há `publicBaseUrl` — a janela
 *     de instalação, antes de o primeiro admin salvar Configurações. Nessa janela não há e-mail de
 *     usuário real a atacar (ninguém tem conta além do admin recém-criado).
 *
 * Como a base muda (ex.: endereço do Easypanel -> domínio próprio): ver
 * `ensurePublicBaseUrlFromCurrentRequest` (só preenche se vazia) e `setPublicBaseUrl` (troca
 * EXPLÍCITA, confirmada pelo admin).
 *
 * Só lança fora de uma requisição sem `publicBaseUrl` configurado ainda (ex.: tick antes do
 * primeiro admin salvar Configurações) — quem chama decide se isso é fatal (docs/contratos.md).
 */
export async function getPublicBaseUrl(): Promise<string> {
  const stored = await getStoredPublicBaseUrl();
  if (stored) return stored;

  const fromRequest = await tryBaseUrlFromRequestHeaders();
  if (fromRequest) return fromRequest;

  throw new DomainError(
    "PUBLIC_URL_UNKNOWN",
    "URL pública do painel ainda não configurada. Acesse Admin > Configurações uma vez para gravá-la automaticamente.",
  );
}

/**
 * Igual a `getPublicBaseUrl`, mas nunca lança — usada em caminhos que já têm um fallback
 * aceitável (ex.: exibir "não configurada" na tela em vez de quebrar a página).
 */
export async function tryGetPublicBaseUrl(): Promise<string | null> {
  try {
    return await getPublicBaseUrl();
  } catch {
    return null;
  }
}

/**
 * Normaliza e valida uma base: só origem (`https://host[:porta]`, sem caminho, credenciais, query
 * ou hash). `http` só para localhost/127.0.0.1 (desenvolvimento). Devolve `null` se não servir.
 */
export function normalizeBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLocal)) return null;
  if (url.username || url.password) return null;
  if (url.pathname !== "/" || url.search || url.hash) return null;
  return url.origin;
}

// Host de cabeçalho: nome DNS/IPv4 + porta opcional. Recusa espaços, barras, `@`, etc.
const PLAUSIBLE_HOST = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/i;

/**
 * Cloudflare grava `CF-Visitor: {"scheme":"https"|"http"}` com o esquema que o VISITANTE usou até
 * a borda da Cloudflare — e sobrescreve qualquer valor que o cliente tente mandar nesse cabeçalho
 * (igual ao `CF-Connecting-IP`, nunca repassa o que chegou). É por isso que ele é mais confiável que
 * `x-forwarded-proto` quando a Cloudflare está na frente: se o modo de SSL da Cloudflare for
 * "Flexible" (ou a conexão Cloudflare → Traefik/origem não usa TLS), o hop que chega até o Next.js
 * traz `x-forwarded-proto: http` mesmo com o visitante em `https://...` — sem isso, `getPublicBaseUrl`
 * nunca grava a URL automaticamente (bug relatado pelo dono, 2026-10-19: troca de servidor passou a
 * ficar atrás da Cloudflare, "URL pública... Ainda não detectada").
 *
 * ANTI-SPOOF (revisão do Órion): `cf-visitor` só é confiável se a requisição REALMENTE passou pela
 * Cloudflare — senão qualquer um bateria direto na origem com `CF-Visitor: {"scheme":"https"}`
 * forjado. Por isso só vale quando o hop que de fato conectou no nosso proxy confiável
 * (`extractEdgeHop`, o mesmo usado por `CF-Connecting-IP` em `src/lib/http/client-ip.ts`) é uma
 * faixa oficial da Cloudflare (`isFromCloudflareEdge`) — a MESMA checagem dos dois headers.
 */
function cloudflareVisitorScheme(raw: string | null): "https" | "http" | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    const scheme = (parsed as { scheme?: unknown } | null)?.scheme;
    if (scheme === "https" || scheme === "http") return scheme;
  } catch {
    // JSON malformado (ou de alguém fingindo ser a Cloudflare sem ela na frente) — ignora e cai
    // no `x-forwarded-proto` normal, não derruba a detecção da URL pública por isso.
  }
  return null;
}

/** Só os dois primeiros blocos do IP — o resto nunca vai para o log (diagnóstico, não auditoria de IP). */
function maskIpForLog(ip: string | null): string | null {
  if (!ip) return null;
  if (ip.includes(".")) {
    const parts = ip.split(".");
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.x.x` : "x";
  }
  if (ip.includes(":")) {
    const parts = ip.split(":").filter(Boolean);
    return parts.length > 0 ? `${parts.slice(0, 2).join(":")}:x` : "x";
  }
  return "x";
}

/**
 * Diagnóstico de produção (dono pediu, 2026-10-19): quando a detecção automática não grava nada,
 * registra quais cabeçalhos chegaram — sem nenhum IP completo (`maskIpForLog`) — para o próximo
 * teste em produção mostrar a causa real nos logs do Easypanel, em vez de só "Ainda não detectada"
 * na tela. Só é chamado quando `tryBaseUrlFromRequestHeaders` já falhou.
 */
async function logPublicUrlDetectionFailure(): Promise<void> {
  try {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    const cfVisitorRaw = h.get("cf-visitor");
    const edgeHop = extractEdgeHop(h.get("x-forwarded-for"), h.get("x-real-ip"));
    logger.warn("public_url.detect_failed", {
      host: host ?? null,
      xForwardedProto: h.get("x-forwarded-proto"),
      cfVisitorPresent: cfVisitorRaw != null,
      cfVisitorValue: cfVisitorRaw,
      edgeHopIsCloudflare: edgeHop ? isFromCloudflareEdge(edgeHop) : false,
      edgeHopMasked: maskIpForLog(edgeHop),
    });
  } catch {
    logger.warn("public_url.detect_failed", { reason: "headers_unavailable_outside_request_scope" });
  }
}

async function tryBaseUrlFromRequestHeaders(): Promise<string | null> {
  try {
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (!host) return null;
    // `x-forwarded-proto`/`x-forwarded-host` podem vir com múltiplos valores separados por
    // vírgula quando há mais de um proxy na cadeia — o mais próximo do cliente vem primeiro.
    const firstHost = host.split(",")[0]!.trim();
    const headerProto = (h.get("x-forwarded-proto") ?? "https").split(",")[0]!.trim().toLowerCase();
    const edgeHop = extractEdgeHop(h.get("x-forwarded-for"), h.get("x-real-ip"));
    const cfVisitorProto = edgeHop && isFromCloudflareEdge(edgeHop) ? cloudflareVisitorScheme(h.get("cf-visitor")) : null;
    const firstProto = cfVisitorProto ?? headerProto;
    if (!PLAUSIBLE_HOST.test(firstHost)) return null;
    if (firstProto !== "https" && firstProto !== "http") return null;
    return normalizeBaseUrl(`${firstProto}://${firstHost}`);
  } catch {
    // `headers()` lança fora de um escopo de requisição (Server Action/Route Handler/RSC) —
    // é o caso do job/tick chamado fora do handler HTTP.
    return null;
  }
}

export async function getStoredPublicBaseUrl(): Promise<string | null> {
  const settings = await getPrisma().platformSettings.findUnique({ where: { id: 1 }, select: { publicBaseUrl: true } });
  return settings?.publicBaseUrl ?? null;
}

// Cache curto para o caminho quente do Auth.js (config montada a cada requisição de auth).
const TRUSTED_CACHE_TTL_MS = 30_000;
let trustedCache: { value: string | null; at: number } | null = null;

/** `publicBaseUrl` gravada (SÓ ela, nunca cabeçalho), com cache de 30 s. Usada por `src/lib/auth.ts`. */
export async function getTrustedPublicBaseUrlCached(nowMs = Date.now()): Promise<string | null> {
  if (trustedCache && nowMs - trustedCache.at < TRUSTED_CACHE_TTL_MS) return trustedCache.value;
  const stored = await getStoredPublicBaseUrl();
  trustedCache = { value: stored ? normalizeBaseUrl(stored) : null, at: nowMs };
  return trustedCache.value;
}

export function clearTrustedPublicBaseUrlCache(): void {
  trustedCache = null;
}

/**
 * Preenche `publicBaseUrl` a partir da requisição atual — chamada só de Server Actions do admin da
 * plataforma (salvar configurações, sincronizar n8n) — e SÓ quando ainda está vazia (instalação).
 *
 * Antes (até 2026-09-30) ela SOBRESCREVIA a base sempre que o host da requisição do admin fosse
 * outro, para acompanhar a troca de domínio do primeiro deploy. Isso deixava uma requisição de
 * admin com `Host` forjado trocar a base dos links de e-mail de todo mundo. Decisão (a mais simples
 * e segura, sem UI nova e sem env var): a base gravada só muda por `setPublicBaseUrl`, uma ação
 * EXPLÍCITA do admin com a URL digitada. Se a requisição vier de outro host, apenas registra um
 * aviso (`public_url.host_differs`) para o operador perceber e confirmar a troca.
 */
export async function ensurePublicBaseUrlFromCurrentRequest(): Promise<void> {
  const candidate = await tryBaseUrlFromRequestHeaders();
  if (!candidate) {
    await logPublicUrlDetectionFailure();
    return;
  }

  const prisma = getPrisma();
  const current = await prisma.platformSettings.findUnique({ where: { id: 1 }, select: { publicBaseUrl: true } });
  if (current?.publicBaseUrl) {
    if (current.publicBaseUrl !== candidate) logger.warn("public_url.host_differs", { stored: current.publicBaseUrl, requestHost: candidate });
    return;
  }

  await prisma.platformSettings.upsert({
    where: { id: 1 },
    create: { id: 1, publicBaseUrl: candidate },
    update: { publicBaseUrl: candidate },
  });
  clearTrustedPublicBaseUrlCache();
}

/**
 * Troca EXPLÍCITA da base pública (ação do admin da plataforma com a URL digitada). Valida o
 * formato (só origem, https). Devolve a base gravada.
 */
export async function setPublicBaseUrl(raw: string): Promise<string> {
  const normalized = normalizeBaseUrl(raw);
  if (!normalized) {
    throw new DomainError("INVALID_PAYLOAD", "Informe só o endereço (ex.: https://painel.seudominio.com.br), com https e sem caminho.");
  }
  await getPrisma().platformSettings.upsert({
    where: { id: 1 },
    create: { id: 1, publicBaseUrl: normalized },
    update: { publicBaseUrl: normalized },
  });
  clearTrustedPublicBaseUrlCache();
  return normalized;
}
