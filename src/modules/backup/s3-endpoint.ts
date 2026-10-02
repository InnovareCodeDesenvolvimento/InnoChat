import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Endereço do bucket S3 que o admin digita (Admin > Backup). O dump inteiro sai por ele e o "Testar conexão" mostra o
 * resultado na tela, então o endereço é um vetor de SSRF e de envio em texto puro. Regras:
 * - só `https:` (o dump nunca vai por HTTP puro);
 * - sem usuário e senha embutidos na URL;
 * - nada de `localhost`, nomes internos (`.internal`, `.local`, `.localhost`, sem ponto) nem IP privado, loopback,
 *   link-local (inclui 169.254.169.254, o endereço de metadados de nuvem), CGNAT, multicast ou reservado, IPv4 ou IPv6;
 * - o nome é RESOLVIDO na hora (teste e backup): se qualquer endereço resolvido for desses, recusa.
 *
 * Limite conhecido: entre resolver aqui e o SDK conectar há uma segunda resolução (DNS rebinding). Para fechar isso
 * seria preciso fixar o IP na conexão; com `requirePlatformAdmin` + 2FA e esta checagem, o risco restante é baixo.
 */

export type EndpointCheck = { ok: true; url: URL } | { ok: false; message: string };

const MSG_HTTPS = "O endereço do bucket precisa começar com https://.";
const MSG_PRIVATE = "Esse endereço aponta para a rede interna ou para um IP reservado. Use o endereço público do seu provedor de bucket.";

/** IPv4 em 4 octetos, ou `null` se não for. */
function v4Octets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null;
}

/** `true` para qualquer IP que não deve ser alvo de uma chamada a partir do servidor. */
export function isPrivateOrReservedIp(rawIp: string): boolean {
  const ip = rawIp.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(ip);
  if (family === 4) {
    const o = v4Octets(ip);
    if (!o) return true;
    const [a, b] = o as [number, number, number, number];
    return (
      a === 0 || // 0.0.0.0/8
      a === 10 ||
      a === 127 || // loopback
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 169 && b === 254) || // link-local e metadados de nuvem
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && o[2] === 0) || // 192.0.0.0/24
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) || // benchmark
      a >= 224 // multicast e reservado
    );
  }
  if (family === 6) {
    if (ip === "::" || ip === "::1") return true;
    // IPv4 mapeado (::ffff:a.b.c.d ou ::ffff:xxxx:xxxx): vale a regra do IPv4 embutido.
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateOrReservedIp(mapped[1]!);
    if (/^::ffff:/.test(ip)) return true; // forma hexadecimal: recusa por prudência
    const first = parseInt(ip.split(":")[0] || "0", 16);
    if (Number.isNaN(first)) return true;
    return (
      (first & 0xfe00) === 0xfc00 || // fc00::/7 (ULA)
      (first & 0xffc0) === 0xfe80 || // fe80::/10 (link-local)
      (first & 0xff00) === 0xff00 // multicast
    );
  }
  return true;
}

/** Nome de host claramente interno (sem consultar DNS). */
function isInternalHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  return !h.includes("."); // "minio", "db": nome de rede interna
}

/** Checagem de forma (sem rede): vale para salvar a configuração. */
export function checkS3EndpointShape(raw: string): EndpointCheck {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, message: MSG_HTTPS };
  }
  if (url.protocol !== "https:") return { ok: false, message: MSG_HTTPS };
  if (url.username || url.password) return { ok: false, message: "Não coloque usuário e senha no endereço. Eles vão nos campos de chave e segredo." };
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateOrReservedIp(host)) return { ok: false, message: MSG_PRIVATE };
  } else if (isInternalHostname(host)) {
    return { ok: false, message: MSG_PRIVATE };
  }
  return { ok: true, url };
}

export type ResolveHost = (host: string) => Promise<string[]>;

const defaultResolve: ResolveHost = async (host) => (await lookup(host, { all: true, verbatim: true })).map((r) => r.address);

/** Forma + DNS na hora: usada antes de testar a conexão e antes de cada backup. Devolve a mensagem de recusa ou `null`. */
export async function checkS3EndpointResolved(raw: string, resolve: ResolveHost = defaultResolve): Promise<string | null> {
  const shape = checkS3EndpointShape(raw);
  if (!shape.ok) return shape.message;
  const host = shape.url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return null; // já conferido na forma
  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch {
    return "Não consegui encontrar esse endereço na internet. Confira se está escrito certo.";
  }
  if (addresses.length === 0) return "Não consegui encontrar esse endereço na internet. Confira se está escrito certo.";
  if (addresses.some(isPrivateOrReservedIp)) return MSG_PRIVATE;
  return null;
}
