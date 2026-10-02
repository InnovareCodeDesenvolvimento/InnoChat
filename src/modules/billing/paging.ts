import { z } from "zod";

/**
 * Paginação por página (numerada) das listas do Admin: registro de envios, linha do tempo, empresas e faturas.
 * `page` é 1-based; fora do intervalo devolve a última página válida. `pageSize` só aceita 10, 25, 50 ou 100.
 */

export const PAGE_SIZES = [10, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 25;

export type PageInfo = { page: number; pageSize: PageSize; totalItems: number; totalPages: number };

/** Entrada comum das actions paginadas (valida `pageSize` só nos 4 valores; `page` menor que 1 vira 1). */
export const pagingInputShape = {
  page: z.coerce.number().int().max(100_000).optional(),
  pageSize: z.union([z.literal(10), z.literal(25), z.literal(50), z.literal(100)]).optional(),
};

/** Página pedida (1-based) ajustada ao intervalo válido: fora dele devolve a última (ou a 1ª se não há nada). */
export function resolvePage(requested: number | undefined, pageSize: PageSize, totalItems: number): PageInfo & { skip: number } {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.min(Math.max(requested ?? 1, 1), totalPages);
  return { page, pageSize, totalItems, totalPages, skip: (page - 1) * pageSize };
}

/** Só o que vai na resposta (sem o `skip` interno). */
export function pageInfoOf(info: PageInfo & { skip: number }): PageInfo {
  return { page: info.page, pageSize: info.pageSize, totalItems: info.totalItems, totalPages: info.totalPages };
}
