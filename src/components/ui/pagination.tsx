"use client";

import { useId } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/components/lib/cn";
import { PAGE_SIZE_OPTIONS, pageItems, rangeOf } from "@/components/lib/pagination";
import { Select } from "./select";

export type PaginationProps = {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  /** Nome da lista para leitor de tela ("Paginação dos envios"). */
  label: string;
  /** Troca de página em andamento: desabilita os controles e avisa o leitor de tela. */
  isPending?: boolean;
  pageSizeOptions?: readonly number[];
  className?: string;
};

const NAV_BTN =
  "inline-flex h-11 items-center justify-center gap-1.5 rounded-card border border-border bg-surface px-3 text-sm font-medium text-text " +
  "hover:bg-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary " +
  "disabled:pointer-events-none disabled:opacity-50";

/**
 * Paginação numerada: "Mostrando 26–50 de 137", escolha de quantos por página, Anterior/Próxima e números com
 * reticências (1 … 4 5 6 … 12). No celular, só "Página 2 de 6" com Anterior/Próxima. Alvos de 44px, `nav` com nome,
 * `aria-current="page"` na atual. Não guarda estado: quem usa decide onde a página mora (URL, de preferência).
 */
export function Pagination({
  page,
  pageSize,
  totalItems,
  totalPages,
  onPageChange,
  onPageSizeChange,
  label,
  isPending,
  pageSizeOptions = PAGE_SIZE_OPTIONS,
  className,
}: PaginationProps) {
  const selectId = useId();
  if (totalItems === 0) return null;
  const { from, to } = rangeOf(page, pageSize, totalItems);
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  const prev = (
    <button type="button" className={NAV_BTN} disabled={!hasPrev || isPending} onClick={() => onPageChange(page - 1)}>
      <ChevronLeft className="h-4 w-4" aria-hidden="true" />
      Anterior
    </button>
  );
  const next = (
    <button type="button" className={NAV_BTN} disabled={!hasNext || isPending} onClick={() => onPageChange(page + 1)}>
      Próxima
      <ChevronRight className="h-4 w-4" aria-hidden="true" />
    </button>
  );

  return (
    <nav aria-label={label} aria-busy={isPending || undefined} className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p role="status" className="text-sm text-text-secondary">
          Mostrando <span className="font-semibold tabular-nums text-text">{from.toLocaleString("pt-BR")}</span>
          {"–"}
          <span className="font-semibold tabular-nums text-text">{to.toLocaleString("pt-BR")}</span> de{" "}
          <span className="font-semibold tabular-nums text-text">{totalItems.toLocaleString("pt-BR")}</span>
        </p>
        <div className="flex items-center gap-2">
          <label htmlFor={selectId} className="text-sm text-text-secondary">
            Por página
          </label>
          <Select
            id={selectId}
            className="w-24"
            value={pageSize}
            disabled={isPending}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
          >
            {pageSizeOptions.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {totalPages > 1 ? (
        <>
          <div className="flex items-center justify-between gap-2 sm:hidden">
            {prev}
            <span className="text-sm font-medium tabular-nums text-text">
              Página {page} de {totalPages}
            </span>
            {next}
          </div>
          <ol className="hidden items-center justify-center gap-1.5 sm:flex">
            <li>{prev}</li>
            {pageItems(page, totalPages).map((item, i) =>
              item === "…" ? (
                <li key={`gap-${i}`} aria-hidden="true" className="px-1 text-text-secondary">
                  …
                </li>
              ) : (
                <li key={item}>
                  <button
                    type="button"
                    aria-label={`Página ${item}`}
                    aria-current={item === page ? "page" : undefined}
                    disabled={isPending}
                    onClick={() => item !== page && onPageChange(item)}
                    className={cn(
                      "inline-flex h-11 min-w-11 items-center justify-center rounded-card border px-3 text-sm font-medium tabular-nums",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:pointer-events-none",
                      item === page ? "border-primary bg-primary text-white" : "border-border bg-surface text-text hover:bg-bg",
                    )}
                  >
                    {item}
                  </button>
                </li>
              ),
            )}
            <li>{next}</li>
          </ol>
        </>
      ) : null}
    </nav>
  );
}
