/**
 * Utilitários de CSV com proteção contra injeção de fórmula (planilha que abre `=HYPERLINK(...)` como fórmula).
 * Separador `;` e BOM: é o que o Excel em português do Brasil abre direito.
 */

/** Neutraliza fórmula: célula que começa com `= + - @` (ou tab/CR, ou espaços antes disso) ganha apóstrofo. */
export function neutralizeFormula(raw: string): string {
  return /^\s*[=+\-@\t\r]/.test(raw) || /^[\t\r]/.test(raw) ? `'${raw}` : raw;
}

export function csvCell(raw: string | number | null | undefined): string {
  const text = raw === null || raw === undefined ? "" : String(raw);
  const value = neutralizeFormula(text);
  return /[";\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function csvLine(cells: Array<string | number | null | undefined>): string {
  return cells.map(csvCell).join(";");
}

export const CSV_BOM = "﻿";
