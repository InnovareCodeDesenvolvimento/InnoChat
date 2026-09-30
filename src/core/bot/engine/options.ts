import type { OptionV2 } from "./types";

const MAX_OPTIONS = 9;

/** "1️⃣".."9️⃣". Fora de 1..9 lança (o WhatsApp não tem keycap para 10). */
export function keycap(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > MAX_OPTIONS) {
    throw new RangeError(`keycap fora de 1..9: ${n}`);
  }
  return `${n}️⃣`;
}

/** Fatia uma página. Sem volta cíclica: página além do fim devolve lista vazia. */
export function pageSlice<T>(
  all: T[],
  page: number,
  size = 8,
): { items: T[]; hasMore: boolean; hasPrev: boolean } {
  const p = Number.isInteger(page) && page > 0 ? page : 0;
  const start = p * size;
  return {
    items: all.slice(start, start + size),
    hasMore: start + size < all.length,
    hasPrev: p > 0,
  };
}

/**
 * Numera de 1 em diante, sem pular: leading + itens + "Ver mais" + "Ver anteriores" + trailing.
 * Lança se passar de 9 (limite dos keycaps). Cada opção sai com `label` = `title`.
 */
export function buildOptions(input: {
  leading?: Omit<OptionV2, "n">[];
  items: Omit<OptionV2, "n">[];
  trailing?: Omit<OptionV2, "n">[];
  hasMore?: boolean;
  hasPrev?: boolean;
  labels: { more: string; prev: string };
}): OptionV2[] {
  const list: Omit<OptionV2, "n">[] = [...(input.leading ?? []), ...input.items];
  if (input.hasMore) list.push({ id: "MORE", title: input.labels.more });
  if (input.hasPrev) list.push({ id: "PREV", title: input.labels.prev });
  list.push(...(input.trailing ?? []));
  if (list.length > MAX_OPTIONS) {
    throw new RangeError(`máximo de ${MAX_OPTIONS} opções por mensagem, recebi ${list.length}`);
  }
  return list.map((o, i) => ({ ...o, n: i + 1, label: o.title }));
}
