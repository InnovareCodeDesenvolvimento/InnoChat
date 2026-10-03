import { getPrisma } from "@/lib/db/prisma";
import { DomainError } from "@/lib/errors";
import { CSV_BOM, csvLine } from "@/lib/csv";
import { asBillingCycle, cycleTitle, DEFAULT_BILLING_TIMEZONE, localDateOf } from "@/core/billing";
import type { InvoiceStatus } from "@/lib/db/types";
import { formatDateBR } from "./format";
import { resolveCsvRange } from "./finance-service";

/**
 * CSV de faturas para o contador (GET /api/admin/finance/invoices.csv). Período pelo VENCIMENTO, no fuso de São
 * Paulo, com teto de 12 meses por arquivo. Toda célula passa por `csvCell` (injeção de fórmula: nome de empresa
 * como `=HYPERLINK(...)` vira texto). Lê em páginas de `PAGE` linhas; passou de `MAX_ROWS` recusa em vez de truncar.
 */

export const INVOICES_CSV_HEADER = [
  "Empresa",
  "Documento",
  "Plano",
  "Ciclo",
  "Competência",
  "Vencimento",
  "Valor",
  "Status",
  "Pago em",
  "Forma",
  "Id da fatura",
  "Id do pagamento MP",
] as const;

const PAGE = 1000;
const MAX_ROWS = 20_000;

export type InvoicesCsvParams = { from?: string; to?: string; status?: InvoiceStatus };

/** "4990" -> "49,90" (decimal com vírgula, como o Excel em português espera). */
function reais(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

export async function buildInvoicesCsv(params: InvoicesCsvParams, now: Date = new Date()): Promise<{ filename: string; csv: string; rows: number }> {
  const range = resolveCsvRange({ from: params.from, to: params.to }, now);
  const prisma = getPrisma();
  const where = { dueAt: { gte: range.from, lt: range.toExclusive }, ...(params.status ? { status: params.status } : {}) };

  const lines: string[] = [csvLine([...INVOICES_CSV_HEADER])];
  let rows = 0;
  let cursorId: string | undefined;
  for (;;) {
    const page = await prisma.invoice.findMany({
      where,
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      select: {
        id: true,
        amountCents: true,
        periodStart: true,
        dueAt: true,
        status: true,
        paidAt: true,
        paidByPaymentId: true,
        mpPaymentId: true,
        cycle: true,
        subscription: { select: { plan: { select: { name: true } }, tenant: { select: { name: true, document: true, timezone: true } } } },
      },
    });
    if (page.length === 0) break;
    for (const invoice of page) {
      rows += 1;
      if (rows > MAX_ROWS) throw new DomainError("EXPORT_TOO_LARGE", "Muitas faturas no período. Reduza o intervalo de datas.");
      const tz = invoice.subscription.tenant.timezone || DEFAULT_BILLING_TIMEZONE;
      const paid = invoice.status === "PAID";
      lines.push(
        csvLine([
          invoice.subscription.tenant.name,
          invoice.subscription.tenant.document,
          invoice.subscription.plan.name,
          cycleTitle(asBillingCycle(invoice.cycle)),
          localDateOf(invoice.periodStart, tz).slice(0, 7),
          formatDateBR(invoice.dueAt, tz),
          reais(invoice.amountCents),
          invoice.status,
          paid && invoice.paidAt ? formatDateBR(invoice.paidAt, tz) : "",
          paid ? (invoice.paidByPaymentId === "manual" || (invoice.paidByPaymentId === null && invoice.mpPaymentId === null) ? "MANUAL" : "PIX") : "",
          invoice.id,
          invoice.mpPaymentId,
        ]),
      );
    }
    cursorId = page[page.length - 1]!.id;
    if (page.length < PAGE) break;
  }

  return { filename: `faturas-${range.fromDate}_a_${range.toDate}.csv`, csv: `${CSV_BOM}${lines.join("\r\n")}\r\n`, rows };
}
