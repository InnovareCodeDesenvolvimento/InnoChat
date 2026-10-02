import { aggregateReport, type ReportGroupRow, type ReportResult } from "@/core/reports/aggregate";
import { resolveReportRange, type ReportRange } from "@/core/reports/range";
import { queryReportGroups } from "@/lib/db/reports-sql";

/**
 * Camada de leitura da tela Relatórios. O guard (só OWNER) fica em quem chama (página e rota do CSV), que já
 * resolve o `tenantId` pela sessão: este módulo nunca recebe `tenantId` do cliente.
 */

export type ReportView = ReportResult & { range: ReportRange; groups: ReportGroupRow[] };

export async function getReport(
  tenantId: string,
  timezone: string,
  input: { preset?: string; from?: string; to?: string },
  now: Date = new Date(),
): Promise<ReportView> {
  const range = resolveReportRange(input, now, timezone);
  const groups = await queryReportGroups({ tenantId, from: range.fromInstant, toExclusive: range.toExclusiveInstant });
  return { range, groups, ...aggregateReport(groups) };
}
