"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { BarChart3, Download } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from "@/components/ui/table";
import { cn } from "@/components/lib/cn";
import { DEFAULT_PAGE_SIZE } from "@/components/lib/pagination";
import { formatCentsBRL } from "@/modules/billing/format";
import type { ReportLine, ReportSummary } from "@/core/reports/aggregate";
import type { ReportPreset } from "@/core/reports/range";

type Props = {
  tenantSlug: string;
  range: { preset: ReportPreset; from: string; to: string; days: number };
  summary: ReportSummary;
  byService: ReportLine[];
  byProfessional: ReportLine[];
};

const PRESETS: { value: Exclude<ReportPreset, "custom">; label: string }[] = [
  { value: "this_month", label: "Este mês" },
  { value: "last_month", label: "Mês passado" },
  { value: "last_30_days", label: "Últimos 30 dias" },
];

/** "2026-10-02" -> "02/10/2026" sem passar por Date (o fuso do navegador não pode mexer no dia). */
function brDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function pct(value: number): string {
  return `${value.toFixed(1).replace(".", ",")}%`;
}

export function RelatoriosClient({ tenantSlug, range, summary, byService, byProfessional }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [customOpen, setCustomOpen] = useState(range.preset === "custom");
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);

  function go(query: Record<string, string>) {
    const qs = new URLSearchParams(query).toString();
    startTransition(() => router.push(`${pathname}?${qs}`));
  }

  const csvQuery = new URLSearchParams({ tenant: tenantSlug, periodo: range.preset, de: range.from, ate: range.to }).toString();
  const hasData = summary.completed + summary.noShow > 0;
  const customInvalid = !from || !to;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        help="pagina.relatorios"
        icon={navIconFor("relatorios")}
        title="Relatórios"
        description={`Atendimentos concluídos de ${brDate(range.from)} a ${brDate(range.to)}.`}
        action={
          <Button variant="secondary" asChild>
            <a href={`/api/reports/csv?${csvQuery}`} download>
              <Download className="h-4 w-4" aria-hidden="true" />
              Baixar CSV
            </a>
          </Button>
        }
      />

      <Card className="rounded-hero">
        <CardContent className="flex flex-col gap-4 pt-5">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Período do relatório">
            {PRESETS.map((p) => (
              <Button
                key={p.value}
                type="button"
                size="sm"
                variant={range.preset === p.value && !customOpen ? "primary" : "secondary"}
                aria-pressed={range.preset === p.value && !customOpen}
                disabled={isPending}
                onClick={() => {
                  setCustomOpen(false);
                  go({ periodo: p.value });
                }}
              >
                {p.label}
              </Button>
            ))}
            <Button
              type="button"
              size="sm"
              variant={customOpen ? "primary" : "secondary"}
              aria-pressed={customOpen}
              disabled={isPending}
              onClick={() => setCustomOpen(true)}
            >
              Personalizado
            </Button>
          </div>
          {customOpen ? (
            <form
              className="flex flex-col gap-3 sm:flex-row sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                if (!customInvalid) go({ periodo: "custom", de: from, ate: to });
              }}
            >
              <Field label="De">
                {(fieldProps) => <Input {...fieldProps} type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />}
              </Field>
              <Field label="Até">
                {(fieldProps) => <Input {...fieldProps} type="date" value={to} onChange={(e) => setTo(e.target.value)} required />}
              </Field>
              <Button type="submit" disabled={customInvalid || isPending} isLoading={isPending} loadingText="Carregando…">
                Ver período
              </Button>
            </form>
          ) : null}
        </CardContent>
      </Card>

      {summary.estimatedCount > 0 ? (
        <Alert variant="warning" title="Valores estimados">
          {summary.estimatedCount === 1 ? "1 atendimento deste período foi concluído" : `${summary.estimatedCount} atendimentos deste período foram concluídos`}{" "}
          antes dos relatórios existirem. Para esses, o sistema usa o preço e a comissão de hoje.
        </Alert>
      ) : null}
      {summary.withoutPriceCount > 0 ? (
        <Alert variant="info">
          {summary.withoutPriceCount === 1 ? "1 atendimento concluído é de um serviço" : `${summary.withoutPriceCount} atendimentos concluídos são de serviços`} sem preço e conta
          R$ 0,00. Cadastre o preço na tela Serviços para os próximos entrarem no faturamento.
        </Alert>
      ) : null}

      {!hasData ? (
        <EmptyState
          icon={BarChart3}
          title="Nenhum atendimento neste período"
          description="Só entram atendimentos marcados como Concluído ou Faltou. Conclua os atendimentos na agenda e os números aparecem aqui."
        />
      ) : (
        <>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5" data-testid="relatorios-resumo">
            <Metric label="Faturamento" value={formatCentsBRL(summary.revenueCents)} strong />
            <Metric label="Atendimentos concluídos" value={String(summary.completed)} />
            <Metric label="Ticket médio" value={formatCentsBRL(summary.ticketCents)} />
            <Metric label="Comissão a pagar" value={formatCentsBRL(summary.commissionCents)} />
            <Metric label="Taxa de faltas" value={pct(summary.noShowRatePercent)} hint={`${summary.noShow} ${summary.noShow === 1 ? "falta" : "faltas"}`} />
          </dl>

          <ReportTable
            title="Por profissional"
            description="Comissão a pagar e faltas de cada um."
            nameHeader="Profissional"
            lines={byProfessional}
            showCommission
            label="Paginação dos profissionais"
          />
          <ReportTable
            title="Por serviço"
            description="O que mais fatura no período."
            nameHeader="Serviço"
            lines={byService}
            label="Paginação dos serviços"
          />
        </>
      )}
    </div>
  );
}

function Metric({ label, value, hint, strong }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <div className={cn("rounded-hero border border-border bg-surface p-5 shadow-card", strong && "border-primary/30")}>
      <dt className="text-sm font-medium text-text-secondary">{label}</dt>
      <dd className="mt-1 break-words font-display text-2xl font-black tabular-nums text-text">{value}</dd>
      {hint ? <dd className="mt-1 text-xs text-text-secondary">{hint}</dd> : null}
    </div>
  );
}

function ReportTable({
  title,
  description,
  nameHeader,
  lines,
  showCommission,
  label,
}: {
  title: string;
  description: string;
  nameHeader: string;
  lines: ReportLine[];
  showCommission?: boolean;
  label: string;
}) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(lines.length / pageSize));
  const current = Math.min(page, totalPages);
  const visible = lines.slice((current - 1) * pageSize, current * pageSize);

  return (
    <Card className="rounded-hero">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="hidden md:block">
          <Table>
            <TableHead>
              <TableRow>
                <TableHeadCell>{nameHeader}</TableHeadCell>
                <TableHeadCell className="text-right">Concluídos</TableHeadCell>
                <TableHeadCell className="text-right">Faturamento</TableHeadCell>
                <TableHeadCell className="text-right">Ticket médio</TableHeadCell>
                {showCommission ? <TableHeadCell className="text-right">Comissão a pagar</TableHeadCell> : null}
                {showCommission ? <TableHeadCell className="text-right">Faltas</TableHeadCell> : null}
              </TableRow>
            </TableHead>
            <TableBody>
              {visible.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="font-medium">{l.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{l.completed}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCentsBRL(l.revenueCents)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatCentsBRL(l.ticketCents)}</TableCell>
                  {showCommission ? <TableCell className="text-right tabular-nums">{formatCentsBRL(l.commissionCents)}</TableCell> : null}
                  {showCommission ? (
                    <TableCell className="text-right tabular-nums">
                      {pct(l.noShowRatePercent)} <span className="text-xs text-text-secondary">({l.noShow})</span>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <ul className="flex flex-col gap-3 md:hidden">
          {visible.map((l) => (
            <li key={l.id} className="rounded-card border border-border p-4">
              <p className="break-words font-medium text-text">{l.name}</p>
              <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                <div>
                  <dt className="text-xs text-text-secondary">Concluídos</dt>
                  <dd className="tabular-nums">{l.completed}</dd>
                </div>
                <div>
                  <dt className="text-xs text-text-secondary">Faturamento</dt>
                  <dd className="tabular-nums">{formatCentsBRL(l.revenueCents)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-text-secondary">Ticket médio</dt>
                  <dd className="tabular-nums">{formatCentsBRL(l.ticketCents)}</dd>
                </div>
                {showCommission ? (
                  <div>
                    <dt className="text-xs text-text-secondary">Comissão a pagar</dt>
                    <dd className="tabular-nums">{formatCentsBRL(l.commissionCents)}</dd>
                  </div>
                ) : null}
                {showCommission ? (
                  <div>
                    <dt className="text-xs text-text-secondary">Faltas</dt>
                    <dd className="tabular-nums">
                      {pct(l.noShowRatePercent)} ({l.noShow})
                    </dd>
                  </div>
                ) : null}
              </dl>
            </li>
          ))}
        </ul>

        {lines.length > 10 ? (
          <Pagination
            label={label}
            page={current}
            pageSize={pageSize}
            totalItems={lines.length}
            totalPages={totalPages}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
