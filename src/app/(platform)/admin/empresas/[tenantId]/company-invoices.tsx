"use client";

import { useState } from "react";
import { Receipt } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from "@/components/ui/table";
import { INVOICE_STATUS_LABEL, INVOICE_STATUS_VARIANT } from "@/components/admin/billing-labels";
import { cycleTitle, type BillingCycle } from "@/core/billing";
import { formatCentsBRL, formatDateBR } from "@/modules/billing/format";

export type InvoiceRow = {
  id: string;
  amountCents: number;
  status: string;
  periodStart: string;
  periodEnd: string;
  dueAt: string;
  paidAt: string | null;
  kind: "TRIAL" | "REGULAR";
  cycle: BillingCycle;
};

/** As faturas já vêm todas do servidor (no máximo 100), então a página mora aqui e não na URL. */
export function CompanyInvoices({ invoices }: { invoices: InvoiceRow[] }) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const totalPages = Math.max(1, Math.ceil(invoices.length / pageSize));
  const current = Math.min(page, totalPages);
  const rows = invoices.slice((current - 1) * pageSize, current * pageSize);

  return (
    <Card className="rounded-hero">
      <CardHeader>
        <CardTitle>Faturas</CardTitle>
        <CardDescription>Da mais nova para a mais antiga.</CardDescription>
      </CardHeader>
      {invoices.length === 0 ? (
        <div className="p-5">
          <EmptyState icon={Receipt} title="Nenhuma fatura ainda" description="Quando a primeira fatura for gerada, ela aparece aqui." />
        </div>
      ) : (
        <>
          <div className="hidden p-4 md:block">
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeadCell>Período</TableHeadCell>
                  <TableHeadCell>Vencimento</TableHeadCell>
                  <TableHeadCell>Valor</TableHeadCell>
                  <TableHeadCell>Ciclo</TableHeadCell>
                  <TableHeadCell>Situação</TableHeadCell>
                  <TableHeadCell>Pago em</TableHeadCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((inv) => (
                  <TableRow key={inv.id}>
                    <TableCell className="tabular-nums">
                      {formatDateBR(new Date(inv.periodStart))} a {formatDateBR(new Date(inv.periodEnd))}
                    </TableCell>
                    <TableCell className="tabular-nums">{formatDateBR(new Date(inv.dueAt))}</TableCell>
                    <TableCell className="tabular-nums">{formatCentsBRL(inv.amountCents)}</TableCell>
                    <TableCell>{cycleTitle(inv.cycle)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Badge variant={INVOICE_STATUS_VARIANT[inv.status] ?? "neutral"}>{INVOICE_STATUS_LABEL[inv.status] ?? inv.status}</Badge>
                        {inv.kind === "TRIAL" && inv.status !== "PAID" ? <Badge variant="neutral">Teste</Badge> : null}
                      </div>
                    </TableCell>
                    <TableCell className="tabular-nums">{inv.paidAt ? formatDateBR(new Date(inv.paidAt)) : "Ainda não"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="flex flex-col gap-3 p-4 md:hidden">
            {rows.map((inv) => (
              <li key={inv.id} className="rounded-card border border-border p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-display text-lg font-bold tabular-nums text-text">
                    {formatCentsBRL(inv.amountCents)} <span className="text-xs font-medium text-text-secondary">({cycleTitle(inv.cycle).toLowerCase()})</span>
                  </p>
                  <Badge variant={INVOICE_STATUS_VARIANT[inv.status] ?? "neutral"}>{INVOICE_STATUS_LABEL[inv.status] ?? inv.status}</Badge>
                </div>
                <p className="mt-1 text-xs text-text-secondary">
                  Período de {formatDateBR(new Date(inv.periodStart))} a {formatDateBR(new Date(inv.periodEnd))}
                </p>
                <p className="mt-1 text-xs text-text-secondary">
                  Vence em {formatDateBR(new Date(inv.dueAt))}. {inv.paidAt ? `Paga em ${formatDateBR(new Date(inv.paidAt))}.` : "Ainda não foi paga."}
                </p>
              </li>
            ))}
          </ul>
          <div className="border-t border-border p-4">
            <Pagination
              label="Paginação das faturas"
              page={current}
              pageSize={pageSize}
              totalItems={invoices.length}
              totalPages={totalPages}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
            />
          </div>
        </>
      )}
    </Card>
  );
}
