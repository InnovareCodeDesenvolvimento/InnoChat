/**
 * Regras puras de slug de empresa (docs/contratos.md, cadastro público). `Tenant.slug` é
 * `@unique` e vira segmento de URL (`/[tenantSlug]/...`) — por isso não pode colidir com uma
 * rota fixa do painel (`src/app/(public)`, `src/app/(auth)`, `src/app/api`, `src/app/(platform)`).
 *
 * Lista fechada e explícita, não "tudo que já existe em src/app hoje": um slug reservado é uma
 * decisão de produto (evitar colisão de rota), não um espelho automático do filesystem — adicionar
 * uma rota nova em `src/app/(public)` não deveria silenciosamente liberar/reservar um slug sem
 * alguém decidir isso.
 */
export const RESERVED_SLUGS = [
  "login",
  "cadastro",
  "pos-login",
  "admin",
  "api",
  "app",
  "www",
  "assets",
  "static",
  "public",
  "convite",
  "recuperar-senha",
  "verificar-email",
  "sitemap",
  "robots",
  "favicon.ico",
  "manifest",
  "_next",
  "webhooks",
  "internal",
  // Páginas públicas por tipo de negócio (melhoria 5): a rota estática vence o `[tenantSlug]`.
  "salao",
  "barbearia",
  "clinica-estetica",
  "consultorio",
  "pet-shop",
] as const;

const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MIN_LENGTH = 3;
const MAX_LENGTH = 60;

export type SlugValidationError = "TOO_SHORT" | "TOO_LONG" | "INVALID_FORMAT" | "RESERVED";

/** Deriva um slug candidato a partir do nome da empresa — só normalização, sem checar unicidade/reserva. */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove acentos
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_LENGTH);
}

/** `null` = válido. Não checa unicidade no banco — isso é responsabilidade do service (I/O). */
export function validateSlug(slug: string): SlugValidationError | null {
  if (slug.length < MIN_LENGTH) return "TOO_SHORT";
  if (slug.length > MAX_LENGTH) return "TOO_LONG";
  if (!SLUG_RE.test(slug)) return "INVALID_FORMAT";
  if ((RESERVED_SLUGS as readonly string[]).includes(slug)) return "RESERVED";
  return null;
}
