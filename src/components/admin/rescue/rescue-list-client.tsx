"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Filter,
  Search,
  UserCheck,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Field } from "@/components/ui/field";
import { HelpButton } from "@/components/help/help-button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { formatPhoneDisplay } from "@/components/lib/format-phone";
import { pageItems, rangeOf, PAGE_SIZE_OPTIONS } from "@/components/lib/pagination";
import { RESCUE_FILTER_STATUSES, RESCUE_STATUS_CONFIG } from "@/modules/rescue/labels";
import type { RescueLeadListResult } from "@/modules/rescue/admin-actions";

export type RescueListClientProps = {
  data: RescueLeadListResult;
  filters: {
    search?: string;
    status?: string;
    from?: string;
    to?: string;
    orderBy?: string;
    page: number;
    pageSize: number;
  };
};

export function RescueListClient({ data, filters }: RescueListClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const [searchDraft, setSearchDraft] = useState(filters.search ?? "");
  const [statusDraft, setStatusDraft] = useState(filters.status ?? "");
  const [fromDraft, setFromDraft] = useState(filters.from ?? "");
  const [toDraft, setToDraft] = useState(filters.to ?? "");

  function updateParams(changes: Record<string, string | undefined>) {
    const sp = new URLSearchParams(searchParams.toString());
    Object.entries(changes).forEach(([key, value]) => {
      if (value === undefined || value === "") {
        sp.delete(key);
      } else {
        sp.set(key, value);
      }
    });
    // Volta à página 1 se alterou filtros (exceto se a própria página foi passada)
    if (!("pagina" in changes)) {
      sp.delete("pagina");
    }
    startTransition(() => {
      router.push(`/admin/resgate?${sp.toString()}`);
    });
  }

  function handleApplyFilters(e: React.FormEvent) {
    e.preventDefault();
    updateParams({
      busca: searchDraft.trim() || undefined,
      status: statusDraft || undefined,
      de: fromDraft || undefined,
      ate: toDraft || undefined,
    });
  }

  function handleClearFilters() {
    setSearchDraft("");
    setStatusDraft("");
    setFromDraft("");
    setToDraft("");
    startTransition(() => {
      router.push("/admin/resgate");
    });
  }

  function handleSort(column: "createdAt" | "nextRunAt") {
    let nextOrder = "createdAt_desc";
    if (column === "createdAt") {
      nextOrder = filters.orderBy === "createdAt_desc" ? "createdAt_asc" : "createdAt_desc";
    } else if (column === "nextRunAt") {
      nextOrder = filters.orderBy === "nextRunAt_asc" ? "nextRunAt_desc" : "nextRunAt_asc";
    }
    updateParams({ ordem: nextOrder });
  }

  const hasActiveFilters = Boolean(filters.search || filters.status || filters.from || filters.to);
  const range = rangeOf(data.page, data.pageSize, data.total);
  const paginationElements = pageItems(data.page, data.totalPages);

  const csvUrl = (() => {
    const sp = new URLSearchParams();
    if (filters.status) sp.set("status", filters.status);
    if (filters.from) sp.set("from", filters.from);
    if (filters.to) sp.set("to", filters.to);
    if (filters.search) sp.set("search", filters.search);
    const q = sp.toString();
    return `/api/admin/rescue/leads.csv${q ? `?${q}` : ""}`;
  })();

  return (
    <div className="space-y-6">
      <PageHeader
        icon={UserCheck}
        title="Resgate de leads"
        description="Cadastros que ainda não acessaram o painel da empresa, acolhidos por mensagens em 24h e 96h."
        help="pagina.adminResgate"
        action={
          <div className="flex flex-wrap items-center gap-3">
            <a href={csvUrl} download>
              <Button variant="outline" size="sm" icon={Download}>
                Exportar leads (CSV)
              </Button>
            </a>
            <Link href="/admin/configuracoes/marketing#resgate">
              <Button variant="outline" size="sm">
                Configurações da régua
              </Button>
            </Link>
          </div>
        }
      />

      {!data.isRescueEnabled && (
        <div className="flex items-start justify-between gap-4 rounded-card border border-warning/40 bg-warning-bg p-4 text-warning">
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            <div>
              <span className="font-bold">A régua de resgate está pausada globalmente (Kill switch acionado).</span>
              <p className="text-xs text-text-secondary">
                Nenhuma mensagem de resgate automática está sendo disparada no momento. Os cadastros continuam sendo registrados normalmente.
              </p>
            </div>
          </div>
          <Link href="/admin/configuracoes/marketing#resgate">
            <Button variant="outline" size="sm" className="border-warning/50 text-warning hover:bg-warning/10">
              Reativar régua
            </Button>
          </Link>
        </div>
      )}

      {/* Filtros */}
      <Card className="border-border bg-surface p-4">
        <form onSubmit={handleApplyFilters} className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
            <div className="flex items-center gap-2 text-sm font-semibold text-text">
              <Filter className="h-4 w-4 text-text-muted" />
              <span>Filtros de busca</span>
            </div>
            <div className="flex items-center gap-2">
              {hasActiveFilters && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  icon={X}
                  onClick={handleClearFilters}
                  disabled={isPending}
                >
                  Limpar filtros
                </Button>
              )}
              <HelpButton helpKey="admin.resgateFiltros" />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Buscar por lead, empresa ou telefone">
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  type="search"
                  placeholder="Nome, e-mail, telefone..."
                  value={searchDraft}
                  onChange={(e) => setSearchDraft(e.target.value)}
                />
              )}
            </Field>

            <Field label="Situação no resgate">
              {(fieldProps) => (
                <select
                  {...fieldProps}
                  className="w-full rounded-card border border-border bg-bg px-3 py-2 text-sm text-text focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  value={statusDraft}
                  onChange={(e) => setStatusDraft(e.target.value)}
                >
                  <option value="">Todas as situações</option>
                  {RESCUE_FILTER_STATUSES.map((st) => (
                    <option key={st} value={st}>
                      {RESCUE_STATUS_CONFIG[st]?.label ?? st}
                    </option>
                  ))}
                </select>
              )}
            </Field>

            <Field label="Cadastrado a partir de">
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  type="date"
                  value={fromDraft}
                  onChange={(e) => setFromDraft(e.target.value)}
                />
              )}
            </Field>

            <Field label="Cadastrado até">
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  type="date"
                  value={toDraft}
                  onChange={(e) => setToDraft(e.target.value)}
                />
              )}
            </Field>
          </div>

          <div className="flex justify-end pt-1">
            <Button type="submit" size="sm" icon={Search} isLoading={isPending}>
              Filtrar leads
            </Button>
          </div>
        </form>
      </Card>

      {/* Lista de leads */}
      {data.items.length === 0 ? (
        <EmptyState
          icon={UserCheck}
          title={hasActiveFilters ? "Nenhum lead encontrado" : "Nenhum lead em resgate no momento"}
          description={
            hasActiveFilters
              ? "Nenhum cadastro corresponde aos filtros aplicados. Tente ajustar os termos ou o período selecionado."
              : "Quem se cadastrar pelo Meta Ads aparece aqui em 24h caso ainda não tenha acessado o painel da empresa."
          }
        />
      ) : (
        <Card className="overflow-hidden border-border bg-surface">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border bg-bg/50 text-xs font-semibold uppercase text-text-muted">
                <tr>
                  <th className="px-4 py-3">Lead / Responsável</th>
                  <th className="px-4 py-3">Telefone</th>
                  <th className="px-4 py-3">Situação</th>
                  <th className="px-4 py-3">
                    <button
                      type="button"
                      className="flex items-center gap-1 hover:text-text"
                      onClick={() => handleSort("nextRunAt")}
                    >
                      <span>Próximo disparo</span>
                      <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </th>
                  <th className="px-4 py-3">
                    <button
                      type="button"
                      className="flex items-center gap-1 hover:text-text"
                      onClick={() => handleSort("createdAt")}
                    >
                      <span>Cadastrado em</span>
                      <ArrowUpDown className="h-3 w-3" />
                    </button>
                  </th>
                  <th className="px-4 py-3 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.items.map((lead) => {
                  const config = RESCUE_STATUS_CONFIG[lead.status] ?? {
                    label: lead.status,
                    variant: "neutral",
                  };

                  const nextRunFormatted = lead.nextRunAt
                    ? new Intl.DateTimeFormat("pt-BR", {
                        dateStyle: "short",
                        timeStyle: "short",
                        timeZone: "America/Sao_Paulo",
                      }).format(new Date(lead.nextRunAt))
                    : "—";

                  const createdAtFormatted = new Intl.DateTimeFormat("pt-BR", {
                    dateStyle: "short",
                    timeStyle: "short",
                    timeZone: "America/Sao_Paulo",
                  }).format(new Date(lead.createdAt));

                  return (
                    <tr key={lead.id} className="hover:bg-bg/40">
                      <td className="px-4 py-3.5">
                        <div className="font-medium text-text">
                          {lead.userName || "Sem nome informado"}
                        </div>
                        <div className="text-xs text-text-muted">
                          {lead.userEmail} · <span className="font-semibold">{lead.tenantName}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3.5 text-text-secondary">
                        {formatPhoneDisplay(lead.phoneE164)}
                      </td>
                      <td className="px-4 py-3.5">
                        <Badge variant={config.variant}>
                          {config.label}
                        </Badge>
                      </td>
                      <td className="px-4 py-3.5 text-xs text-text-secondary">
                        {nextRunFormatted}
                      </td>
                      <td className="px-4 py-3.5 text-xs text-text-muted">
                        {createdAtFormatted}
                      </td>
                      <td className="px-4 py-3.5 text-right">
                        <Link href={`/admin/resgate/${lead.id}`}>
                          <Button variant="ghost" size="sm">
                            Ver detalhes
                          </Button>
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Rodapé da paginação (regra listas-com-paginacao) */}
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border p-4 text-xs text-text-muted">
            <div className="flex items-center gap-3">
              <span>
                Mostrando {range.from}–{range.to} de {data.total} {data.total === 1 ? "lead" : "leads"}
              </span>
              <div className="flex items-center gap-1.5">
                <span>Por página:</span>
                <select
                  value={data.pageSize}
                  onChange={(e) => updateParams({ porPagina: e.target.value })}
                  className="rounded border border-border bg-bg px-2 py-1 text-xs text-text focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {data.totalPages > 1 && (
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  icon={ChevronLeft}
                  disabled={data.page <= 1 || isPending}
                  onClick={() => updateParams({ pagina: String(data.page - 1) })}
                  aria-label="Página anterior"
                />
                {paginationElements.map((item, idx) =>
                  item === "…" ? (
                    <span key={`dots-${idx}`} className="px-2 text-text-muted">
                      …
                    </span>
                  ) : (
                    <Button
                      key={item}
                      variant={item === data.page ? "primary" : "outline"}
                      size="sm"
                      onClick={() => updateParams({ pagina: String(item) })}
                      disabled={isPending}
                    >
                      {item}
                    </Button>
                  )
                )}
                <Button
                  variant="outline"
                  size="sm"
                  icon={ChevronRight}
                  disabled={data.page >= data.totalPages || isPending}
                  onClick={() => updateParams({ pagina: String(data.page + 1) })}
                  aria-label="Próxima página"
                />
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
