export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

/** Lê um inteiro positivo da URL; qualquer outra coisa vira o padrão (nunca confia no que veio na barra de endereço). */
export function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value || !/^\d{1,6}$/.test(value)) return fallback;
  const n = Number(value);
  return n >= 1 ? n : fallback;
}

export function parsePageSize(value: string | undefined): number {
  const n = parsePositiveInt(value, DEFAULT_PAGE_SIZE);
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(n) ? n : DEFAULT_PAGE_SIZE;
}

/**
 * Números de página com reticências: sempre a primeira, a última e a vizinhança da atual.
 * `pageItems(5, 12)` → [1, "…", 4, 5, 6, "…", 12]. Poucas páginas aparecem todas.
 */
export function pageItems(page: number, totalPages: number): Array<number | "…"> {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
  const keep = new Set<number>([1, totalPages, page - 1, page, page + 1]);
  if (page <= 3) [2, 3, 4].forEach((n) => keep.add(n));
  if (page >= totalPages - 2) [totalPages - 3, totalPages - 2, totalPages - 1].forEach((n) => keep.add(n));
  const sorted = [...keep].filter((n) => n >= 1 && n <= totalPages).sort((a, b) => a - b);
  const out: Array<number | "…"> = [];
  sorted.forEach((n, i) => {
    const prev = sorted[i - 1];
    if (prev !== undefined && n - prev === 2) out.push(prev + 1);
    else if (prev !== undefined && n - prev > 2) out.push("…");
    out.push(n);
  });
  return out;
}

/** "26–50 de 137" para o "Mostrando …". */
export function rangeOf(page: number, pageSize: number, totalItems: number): { from: number; to: number } {
  if (totalItems === 0) return { from: 0, to: 0 };
  const from = (page - 1) * pageSize + 1;
  return { from, to: Math.min(page * pageSize, totalItems) };
}
