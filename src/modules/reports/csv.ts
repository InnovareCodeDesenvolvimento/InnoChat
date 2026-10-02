import { CSV_BOM, csvLine } from "@/lib/csv";
import type { ReportGroupRow } from "@/core/reports/aggregate";
import { noShowRate, ticketOf } from "@/core/reports/aggregate";
import type { ReportRange } from "@/core/reports/range";

/**
 * CSV do relatório: uma linha por profissional e serviço. Toda célula passa por `csvCell` (nome de serviço
 * como `=HYPERLINK(...)` vira texto). Valores em reais com vírgula, como o Excel em português espera.
 */

export const REPORT_CSV_HEADER = [
  "Profissional",
  "Serviço",
  "Atendimentos concluídos",
  "Faltas",
  "Taxa de faltas (%)",
  "Faturamento (R$)",
  "Ticket médio (R$)",
  "Comissão a pagar (R$)",
  "Valores estimados (atendimentos)",
] as const;

function reais(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

export function buildReportCsv(groups: ReportGroupRow[], range: ReportRange): { filename: string; csv: string; rows: number } {
  const sorted = [...groups].sort(
    (a, b) => a.professionalName.localeCompare(b.professionalName, "pt-BR") || a.serviceName.localeCompare(b.serviceName, "pt-BR"),
  );
  const lines = [csvLine([...REPORT_CSV_HEADER])];
  for (const g of sorted) {
    lines.push(
      csvLine([
        g.professionalName,
        g.serviceName,
        g.completed,
        g.noShow,
        String(noShowRate(g.completed, g.noShow)).replace(".", ","),
        reais(g.revenueCents),
        reais(ticketOf(g.revenueCents, g.completed)),
        reais(g.commissionCents),
        g.estimatedCount,
      ]),
    );
  }
  return { filename: `relatorio-${range.from}-a-${range.to}.csv`, csv: CSV_BOM + lines.join("\r\n") + "\r\n", rows: sorted.length };
}
