/**
 * Comissão em centavos, pura. Regras (decisão do dono, Melhoria 8):
 * - o % do serviço DAQUELE profissional manda; se for nulo, vale o % do profissional; se este for nulo, 0;
 * - 0 é um valor válido ("este serviço não comissiona") e NÃO cai no padrão do profissional;
 * - o resultado é arredondado para o centavo mais próximo (meio centavo sobe).
 * O Prisma devolve `Decimal` para o %; converta com `pctToNumber` antes de chamar estas funções.
 */

export type PctInput = number | null | undefined;

function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

export function resolveCommissionPct(serviceOverridePct: PctInput, professionalPct: PctInput): number {
  if (serviceOverridePct !== null && serviceOverridePct !== undefined) return clampPct(serviceOverridePct);
  if (professionalPct !== null && professionalPct !== undefined) return clampPct(professionalPct);
  return 0;
}

/** `priceCents * pct / 100`, em inteiros: o % (2 casas) vira "centésimos de ponto" para não somar erro de float. */
export function commissionCentsFor(priceCents: number, pct: number): number {
  if (!Number.isFinite(priceCents) || priceCents <= 0) return 0;
  const hundredths = Math.round(clampPct(pct) * 100);
  return Math.round((priceCents * hundredths) / 10_000);
}

/** Converte o `Decimal` do Prisma (ou número, ou nulo) em número; nulo continua nulo. */
export function pctToNumber(value: { toString(): string } | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "number" ? value : Number(value.toString());
  return Number.isFinite(n) ? n : null;
}

/** Texto digitado ("40", "12,5", "") para número ou nulo (vazio = usa o padrão). `ok: false` = texto inválido. */
export function parsePctText(text: string): { ok: true; value: number | null } | { ok: false } {
  const t = text.trim().replace("%", "").trim().replace(",", ".");
  if (t === "") return { ok: true, value: null };
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return { ok: false };
  const n = Number(t);
  return n >= 0 && n <= 100 ? { ok: true, value: n } : { ok: false };
}

/** 40 -> "40", 12.5 -> "12,5" (vírgula, como o dono digita). */
export function formatPctText(pct: number | null): string {
  return pct === null ? "" : String(pct).replace(".", ",");
}
