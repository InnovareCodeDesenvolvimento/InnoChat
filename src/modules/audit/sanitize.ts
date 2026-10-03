import { isIP } from "node:net";

/**
 * Funções puras do registro de auditoria: redação de segredos, tamanho do de/para e truncamento de IP.
 * Ficam separadas de `record.ts` (que fala com banco e com o pedido atual) para serem testáveis sem nada disso.
 */

export type AuditChange = { de: unknown; para: unknown };
export type AuditChanges = Record<string, AuditChange>;

/** Limite da coluna `changes` no banco (CHECK em octet_length = 8192). Ficamos abaixo para sobrar folga. */
export const MAX_CHANGES_BYTES = 7000;
export const MAX_SUMMARY_CHARS = 300;
export const MAX_ACTION_CHARS = 80;
const MAX_VALUE_CHARS = 200;

export const REDACTED = "[oculto]";

/** Nome de campo que nunca pode ter o valor gravado: chaves cifradas (*Enc), senha, token, segredo, credencial. */
const SECRET_KEY = /(enc$|senha|passw|token|secret|segredo|credential|apikey|api_key|privatekey|hash$|accesskey|key$|chave)/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** Campos que guardam endereço (evolutionApiUrl, n8nWebhookBaseUrl, s3Endpoint, publicBaseUrl...). */
const URL_KEY = /(url|endpoint)$/i;

export function isUrlKey(key: string): boolean {
  return URL_KEY.test(key);
}

/**
 * Endereço sem o que pode carregar segredo: usuário e senha (`https://user:pass@host`) e a query string / âncora
 * (`?token=...`). Fica protocolo, servidor e caminho. Texto que não é URL perde tudo depois de `?` ou `#` e antes de `@`.
 */
export function stripUrlSecrets(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text) return value;
  try {
    const url = new URL(text);
    if (url.protocol === "http:" || url.protocol === "https:") return `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    // não é uma URL completa: cai na limpeza por texto
  }
  const noQuery = text.split("?")[0]!.split("#")[0]!;
  const at = noQuery.lastIndexOf("@");
  return at >= 0 ? noQuery.slice(at + 1) : noQuery;
}

function shorten(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS - 1)}…` : value;
  let text: string;
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    text = String(value);
  }
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS - 1)}…` : text;
}

/**
 * Prepara o de/para para gravar: campo secreto vira "[oculto]" nos dois lados (só se sabe QUE mudou, nunca o valor),
 * valores longos são encurtados e o conjunto todo respeita o teto de bytes. Devolve `null` se não sobrou nada.
 */
export function sanitizeChanges(changes: AuditChanges | null | undefined): AuditChanges | null {
  if (!changes) return null;
  const out: AuditChanges = {};
  let size = 2;
  let dropped = 0;
  for (const [field, change] of Object.entries(changes)) {
    const safe: AuditChange = isSecretKey(field)
      ? { de: REDACTED, para: REDACTED }
      : isUrlKey(field)
        ? { de: shorten(stripUrlSecrets(change?.de)), para: shorten(stripUrlSecrets(change?.para)) }
        : { de: shorten(change?.de), para: shorten(change?.para) };
    const cost = Buffer.byteLength(JSON.stringify({ [field]: safe }), "utf8");
    if (size + cost > MAX_CHANGES_BYTES) {
      dropped += 1;
      continue;
    }
    out[field] = safe;
    size += cost;
  }
  if (dropped > 0) out._omitidos = { de: null, para: dropped };
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeForCompare(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (value instanceof Date) return `d:${value.getTime()}`;
  return typeof value === "object" ? JSON.stringify(value) : `${typeof value}:${String(value)}`;
}

/** Monta o de/para só com os campos que mudaram de verdade (comparação por valor, datas por instante). */
export function diffChanges(before: Record<string, unknown>, after: Record<string, unknown>, fields: readonly string[]): AuditChanges {
  const out: AuditChanges = {};
  for (const field of fields) {
    if (normalizeForCompare(before[field]) !== normalizeForCompare(after[field])) {
      out[field] = { de: before[field] ?? null, para: after[field] ?? null };
    }
  }
  return out;
}

export function clampText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function expandIPv6(ip: string): number[] | null {
  const withoutZone = ip.split("%")[0]!;
  const hasGap = withoutZone.includes("::");
  const [head, tail] = withoutZone.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  if (hasGap ? missing < 0 : missing !== 0) return null;
  const all = [...headParts, ...(hasGap ? Array<string>(missing).fill("0") : []), ...tailParts];
  const nums = all.map((g) => parseInt(g, 16));
  return nums.length === 8 && nums.every((n) => Number.isFinite(n)) ? nums : null;
}

/**
 * IP para guardar: IPv4 com o último octeto zerado (/24), IPv6 só com os 48 bits do prefixo (/48). Isso basta para
 * "de onde veio" sem identificar uma pessoa. Valor que não é IP vira `null`.
 */
export function truncateIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const value = ip.trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(value);
  const candidate = mapped ? mapped[1]! : value;
  const kind = isIP(candidate);
  if (kind === 4) {
    const parts = candidate.split(".");
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }
  if (kind === 6) {
    const groups = expandIPv6(candidate);
    if (!groups) return null;
    return `${groups.slice(0, 3).map((g) => g.toString(16)).join(":")}::`;
  }
  return null;
}
