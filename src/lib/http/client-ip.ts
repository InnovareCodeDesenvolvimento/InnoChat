import { isIP } from "node:net";
import { headers } from "next/headers";

/**
 * IP do cliente a partir dos headers do proxy reverso (Easypanel/Traefik) — usado pelo rate limit
 * de login/cadastro (`auth.ts`, `modules/auth/service.ts`, `signup/actions.ts`,
 * `platform/install-actions.ts`).
 *
 * SUPOSIÇÃO (revisão do Órion S4): há exatamente `TRUSTED_PROXY_HOPS` = 1 proxy confiável na frente
 * do app (o Traefik do Easypanel), e ele ACRESCENTA o IP de quem conectou ao FIM de
 * `X-Forwarded-For`. O 1º valor da lista é o que o cliente mandou — forjável (`X-Forwarded-For:
 * 1.2.3.4` faria cada requisição contar num "IP" novo e fugir do rate limit). Por isso usa-se o
 * valor a `TRUSTED_PROXY_HOPS` posições do fim, adicionado por quem confiamos.
 *
 * CLOUDFLARE NA FRENTE (desde a troca de servidor, 2026-10-19): a Cloudflare passou a terminar a
 * conexão do visitante e falar com o Traefik por dentro. O Traefik, sem IP da Cloudflare na sua
 * lista `trustedIPs`, DESCARTA o `X-Forwarded-For` que a Cloudflare mandou e grava o dele próprio
 * com só o IP de quem conectou nele — ou seja, o IP da BORDA da Cloudflare, igual para todo
 * visitante (bug real: rate limit de cadastro/login virou compartilhado por todo mundo atrás da
 * mesma borda). Subir `TRUSTED_PROXY_HOPS` para 2 não resolve direito — o hop da Cloudflare não é
 * um proxy fixo, é um dos milhares de IPs de borda dela.
 *
 * A correção confiável é o `CF-Connecting-IP`: a Cloudflare grava esse header com o IP real do
 * visitante e SOBRESCREVE qualquer valor que o próprio cliente tente mandar — nunca repassa o que
 * chegou (igual o `CF-Visitor`, ver `src/lib/public-url.ts`). O risco é alguém pular a Cloudflare e
 * bater direto na origem forjando esse header — por isso só confiamos nele quando o último hop do
 * `X-Forwarded-For` (quem de fato conectou no nosso proxy confiável) é um IP conhecido da própria
 * Cloudflare (`isFromCloudflareEdge`, lista oficial em cloudflare.com/ips). Se não bate, cai no
 * comportamento de sempre (hops no XFF) — não muda nada para quem ainda não está atrás da
 * Cloudflare (dev local, outro provedor).
 *
 * Fallback: sem XFF válido usa `X-Real-IP` (também validado como IP); sem nada, `"unknown"`
 * (rate limit "global" nesse caso raro — melhor que quebrar o fluxo). Valores que não são um IP
 * (`isIP`) são ignorados: nunca viram chave de rate limit nem entram em log.
 */
export const TRUSTED_PROXY_HOPS = 1;

// Faixas oficiais da Cloudflare (https://www.cloudflare.com/ips/, conferido 2026-10-19) — revisar
// periodicamente; a Cloudflare raramente muda essa lista, mas pode acrescentar faixas novas.
// `CLOUDFLARE_EXTRA_IPV4_CIDRS`/`CLOUDFLARE_EXTRA_IPV6_CIDRS` (env, separado por vírgula) dão um
// jeito de acrescentar faixa sem precisar de deploy, se a lista ficar desatualizada em produção.
const CLOUDFLARE_IPV4_CIDRS = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  ...(process.env.CLOUDFLARE_EXTRA_IPV4_CIDRS?.split(",").map((s) => s.trim()).filter(Boolean) ?? []),
];

const CLOUDFLARE_IPV6_CIDRS = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
  ...(process.env.CLOUDFLARE_EXTRA_IPV6_CIDRS?.split(",").map((s) => s.trim()).filter(Boolean) ?? []),
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255 || part === "") return null;
    value = value * 256 + n;
  }
  return value;
}

function isIpv4InCidr(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const ipInt = ipv4ToInt(ip);
  const rangeInt = range ? ipv4ToInt(range) : null;
  if (ipInt === null || rangeInt === null || !Number.isInteger(bits)) return false;
  const mask = bits <= 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

/**
 * Expande `::` e converte os 8 grupos de 16 bits do IPv6 num único BigInt de 128 bits. Aceita
 * IPv4-mapped (`::ffff:a.b.c.d`) e descarta zona de escopo (`%eth0`, só tem sentido local).
 */
function ipv6ToBigInt(ip: string): bigint | null {
  const zoneIdx = ip.indexOf("%");
  const addr = zoneIdx !== -1 ? ip.slice(0, zoneIdx) : ip;
  if (isIP(addr) !== 6) return null;
  let head = addr;
  let tail = "";
  const doubleColon = addr.indexOf("::");
  if (doubleColon !== -1) {
    head = addr.slice(0, doubleColon);
    tail = addr.slice(doubleColon + 2);
  }
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];

  // IPv4-mapped (ex. "::ffff:192.0.2.1"): o último grupo vem com pontos — expande para 2 grupos hex.
  const lastArr = tailParts.length > 0 ? tailParts : headParts;
  if (lastArr.length > 0 && lastArr[lastArr.length - 1]!.includes(".")) {
    const v4 = ipv4ToInt(lastArr[lastArr.length - 1]!);
    if (v4 === null) return null;
    lastArr.splice(lastArr.length - 1, 1, ((v4 >>> 16) & 0xffff).toString(16), (v4 & 0xffff).toString(16));
  }

  const missing = 8 - headParts.length - tailParts.length;
  if (missing < 0) return null;
  const allParts = [...headParts, ...Array(missing).fill("0"), ...tailParts];
  if (allParts.length !== 8) return null;
  let value = BigInt(0);
  for (const part of allParts) {
    if (!/^[0-9a-fA-F]{0,4}$/.test(part)) return null;
    value = (value << BigInt(16)) | BigInt(part === "" ? 0 : parseInt(part, 16));
  }
  return value;
}

function isIpv6InCidr(ip: string, cidr: string): boolean {
  const [range, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const ipVal = ipv6ToBigInt(ip);
  const rangeVal = range ? ipv6ToBigInt(range) : null;
  if (ipVal === null || rangeVal === null || !Number.isInteger(bits)) return false;
  const mask = bits <= 0 ? BigInt(0) : (((BigInt(1) << BigInt(bits)) - BigInt(1)) << BigInt(128 - bits));
  return (ipVal & mask) === (rangeVal & mask);
}

/** O IP (que conectou no nosso proxy confiável) é da borda da Cloudflare? */
export function isFromCloudflareEdge(ip: string): boolean {
  const zoneIdx = ip.indexOf("%");
  const addr = zoneIdx !== -1 ? ip.slice(0, zoneIdx) : ip;
  // IPv4-mapped (`::ffff:a.b.c.d`) representa um host IPv4 — compara contra as faixas IPv4 da
  // Cloudflare, não contra as IPv6 (os `/32` dela são blocos próprios, não têm esse prefixo).
  const mappedV4 = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(addr)?.[1];
  if (mappedV4) return CLOUDFLARE_IPV4_CIDRS.some((c) => isIpv4InCidr(mappedV4, c));
  const family = isIP(addr);
  if (family === 4) return CLOUDFLARE_IPV4_CIDRS.some((c) => isIpv4InCidr(addr, c));
  if (family === 6) return CLOUDFLARE_IPV6_CIDRS.some((c) => isIpv6InCidr(addr, c));
  return false;
}

/**
 * Hop que de fato conectou no nosso proxy confiável (último valor do XFF, ou `X-Real-IP` sem XFF).
 * Reaproveitado por `pickClientIp` e por `src/lib/public-url.ts` (`cf-visitor`/`cf-connecting-ip`
 * só valem se este hop for realmente a borda da Cloudflare — mesma checagem anti-spoof nos dois).
 */
export function extractEdgeHop(forwardedFor: string | null, realIp: string | null): string | null {
  const parts = forwardedFor ? forwardedFor.split(",").map((p) => p.trim()).filter(Boolean) : [];
  if (parts.length > 0) return parts[parts.length - 1]!;
  return realIp?.trim() || null;
}

export function pickClientIp(
  forwardedFor: string | null,
  realIp: string | null,
  hops = TRUSTED_PROXY_HOPS,
  cfConnectingIp: string | null = null,
): string {
  const parts = forwardedFor ? forwardedFor.split(",").map((p) => p.trim()).filter(Boolean) : [];

  // Só confia no `CF-Connecting-IP` se o hop que de fato conectou no nosso proxy confiável for
  // uma faixa conhecida da Cloudflare (sem isso, bastaria forjar o header batendo direto na origem).
  const edgeHop = extractEdgeHop(forwardedFor, realIp);
  if (cfConnectingIp && isIP(cfConnectingIp) && edgeHop && isFromCloudflareEdge(edgeHop)) {
    return cfConnectingIp;
  }

  if (parts.length > 0) {
    const candidate = parts[Math.max(0, parts.length - hops)]!;
    if (isIP(candidate)) return candidate;
  }
  const real = realIp?.trim();
  if (real && isIP(real)) return real;
  return "unknown";
}

export async function clientIp(): Promise<string> {
  const h = await headers();
  return pickClientIp(h.get("x-forwarded-for"), h.get("x-real-ip"), TRUSTED_PROXY_HOPS, h.get("cf-connecting-ip"));
}
