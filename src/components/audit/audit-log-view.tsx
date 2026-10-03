"use client";

import { useRouter, usePathname } from "next/navigation";
import { useState, useTransition } from "react";
import { Eye, Filter, History, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState } from "@/components/ui/empty-state";
import { DEFAULT_PAGE_SIZE } from "@/components/lib/pagination";
import { formatTimeLabel } from "@/components/lib/format-date";
import { formatDateBR } from "@/modules/billing/format";
import { AUDIT_AREAS } from "@/modules/audit/labels";
import type { AuditFilters, AuditItem, AuditPage } from "@/modules/audit/queries";

type Variant = "admin" | "tenant";

const TZ = "America/Sao_Paulo";

function buildQuery(f: AuditFilters, page: number, pageSize: number): string {
  const q = new URLSearchParams();
  if (f.tenantQuery) q.set("empresa", f.tenantQuery);
  if (f.area) q.set("area", f.area);
  if (f.actor) q.set("pessoa", f.actor);
  if (f.from) q.set("de", f.from);
  if (f.to) q.set("ate", f.to);
  if (page > 1) q.set("pagina", String(page));
  if (pageSize !== DEFAULT_PAGE_SIZE) q.set("porPagina", String(pageSize));
  const text = q.toString();
  return text ? `?${text}` : "";
}

function roleVariant(role: string): "primary" | "neutral" | "warning" {
  if (role === "PLATFORM_ADMIN") return "warning";
  if (role === "OWNER") return "primary";
  return "neutral";
}

function When({ at, timezone }: { at: string; timezone: string }) {
  const d = new Date(at);
  return (
    <>
      <span className="block font-medium tabular-nums text-text">{formatDateBR(d, timezone)}</span>
      <span className="block text-xs tabular-nums text-text-secondary">{formatTimeLabel(d, timezone)}</span>
    </>
  );
}

function Who({ item }: { item: AuditItem }) {
  return (
    <div className="min-w-0">
      <p className="break-words font-medium text-text [overflow-wrap:anywhere]">{item.actorName}</p>
      <Badge variant={roleVariant(item.actorRole)} className="mt-1">
        {item.actorRoleLabel}
      </Badge>
    </div>
  );
}

function What({ item, showTenant }: { item: AuditItem; showTenant: boolean }) {
  return (
    <div className="min-w-0">
      <p className="font-medium text-text">{item.actionLabel}</p>
      <p className="mt-0.5 break-words text-sm text-text-secondary [overflow-wrap:anywhere]">{item.summary}</p>
      {item.clientName ? (
        <p className="mt-0.5 break-words text-sm text-text-secondary [overflow-wrap:anywhere]" data-testid="audit-client">
          Cliente: {item.clientName}
        </p>
      ) : null}
      {showTenant ? (
        <p className="mt-1 text-xs text-text-secondary">{item.tenant ? `Empresa: ${item.tenant.name}` : "Plataforma (sem empresa)"}</p>
      ) : null}
    </div>
  );
}

export function AuditLogView({
  data,
  filters: applied,
  variant,
  timezone = TZ,
}: {
  data: AuditPage;
  filters: AuditFilters;
  variant: Variant;
  timezone?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [form, setForm] = useState<AuditFilters>(applied);
  const [detail, setDetail] = useState<AuditItem | null>(null);
  const { items, page, pageSize } = data;
  const isAdmin = variant === "admin";
  const areas = AUDIT_AREAS.filter((a) => isAdmin || !a.platformOnly);

  function go(filters: AuditFilters, nextPage: number, nextSize: number) {
    startTransition(() => router.push(`${pathname}${buildQuery(filters, nextPage, nextSize)}`));
  }

  function clean(f: AuditFilters): AuditFilters {
    return {
      tenantQuery: f.tenantQuery?.trim() || undefined,
      area: f.area || undefined,
      actor: f.actor?.trim() || undefined,
      from: f.from || undefined,
      to: f.to || undefined,
    };
  }

  function applyFilters(e?: React.FormEvent) {
    e?.preventDefault();
    go(clean(form), 1, pageSize);
  }

  function clearFilters() {
    setForm({});
    go({}, 1, pageSize);
  }

  const hasFilter = Object.values(applied).some((v) => !!v);

  const detailButton = (item: AuditItem) => (
    <Button type="button" variant="secondary" size="sm" icon={Eye} onClick={() => setDetail(item)} aria-label={`Ver detalhes: ${item.actionLabel}`}>
      Ver detalhes
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      <Card className="rounded-hero">
        <CardHeader help={isAdmin ? "admin.auditoriaFiltros" : undefined} className="py-3.5">
          <CardTitle className="text-base">Filtros</CardTitle>
        </CardHeader>
        <CardContent className="p-4">
          <form onSubmit={applyFilters} className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {isAdmin ? (
                <Field label="Empresa">
                  {(p) => (
                    <Input {...p} className="w-full" placeholder="Nome da empresa" maxLength={120} value={form.tenantQuery ?? ""} onChange={(e) => setForm({ ...form, tenantQuery: e.target.value })} />
                  )}
                </Field>
              ) : null}
              <Field label="O que mudou">
                {(p) => (
                  <Select {...p} value={form.area ?? ""} onChange={(e) => setForm({ ...form, area: e.target.value })}>
                    <option value="">Tudo</option>
                    {areas.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Quem fez">
                {(p) => (
                  <Input {...p} className="w-full" placeholder="Nome ou e-mail" maxLength={120} value={form.actor ?? ""} onChange={(e) => setForm({ ...form, actor: e.target.value })} />
                )}
              </Field>
              <Field label="De">
                {(p) => <Input {...p} type="date" className="w-full" value={form.from ?? ""} onChange={(e) => setForm({ ...form, from: e.target.value })} />}
              </Field>
              <Field label="Até">
                {(p) => <Input {...p} type="date" className="w-full" value={form.to ?? ""} onChange={(e) => setForm({ ...form, to: e.target.value })} />}
              </Field>
              <div className="flex items-end gap-2">
                <Button type="submit" icon={Filter} variant="secondary" isLoading={isPending} loadingText="Filtrando…" className="flex-1 xl:flex-none">
                  Filtrar
                </Button>
                <Button type="button" variant="ghost" icon={X} onClick={clearFilters} disabled={isPending}>
                  Limpar
                </Button>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>

      {items.length === 0 ? (
        <EmptyState
          icon={History}
          title={hasFilter ? "Nenhuma alteração com esses filtros" : "Nada registrado ainda"}
          description={hasFilter ? "Ajuste ou limpe os filtros para ver outras alterações." : "Quando alguém mudar algo importante, a alteração aparece aqui."}
        />
      ) : (
        <>
          <div className={isPending ? "opacity-60 transition-opacity" : "transition-opacity"} aria-busy={isPending || undefined}>
            <Card className="hidden rounded-hero lg:block" data-testid="audit-table">
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeadCell>Quando</TableHeadCell>
                    <TableHeadCell>Quem</TableHeadCell>
                    <TableHeadCell>O que mudou</TableHeadCell>
                    <TableHeadCell className="text-right">Detalhes</TableHeadCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.id} className="align-top">
                      <TableCell className="whitespace-nowrap">
                        <When at={item.createdAt} timezone={timezone} />
                      </TableCell>
                      <TableCell className="min-w-[12rem] max-w-[15rem]">
                        <Who item={item} />
                      </TableCell>
                      <TableCell className="min-w-[18rem]">
                        <What item={item} showTenant={isAdmin} />
                      </TableCell>
                      <TableCell className="text-right">{detailButton(item)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>

            <ul className="flex flex-col gap-3 lg:hidden" data-testid="audit-cards">
              {items.map((item) => (
                <li key={item.id}>
                  <Card className="rounded-hero p-4">
                    <div className="flex items-start justify-between gap-3">
                      <Who item={item} />
                      <div className="shrink-0 text-right text-sm">
                        <When at={item.createdAt} timezone={timezone} />
                      </div>
                    </div>
                    <div className="mt-3 flex flex-col gap-3 border-t border-border pt-3">
                      <What item={item} showTenant={isAdmin} />
                      <div className="flex justify-end">{detailButton(item)}</div>
                    </div>
                  </Card>
                </li>
              ))}
            </ul>
          </div>

          <Pagination
            label="Paginação do histórico"
            page={page}
            pageSize={pageSize}
            totalItems={data.totalItems}
            totalPages={data.totalPages}
            isPending={isPending}
            onPageChange={(p) => go(applied, p, pageSize)}
            onPageSizeChange={(size) => go(applied, 1, size)}
          />
        </>
      )}

      <Dialog open={!!detail} onOpenChange={(open) => !open && setDetail(null)}>
        <DialogContent className="w-[min(40rem,calc(100vw-2rem))]">
          <DialogHeader icon={History}>
            <DialogTitle>{detail?.actionLabel ?? "Detalhes"}</DialogTitle>
            <DialogDescription>
              {detail ? `${detail.actorName} (${detail.actorRoleLabel}), ${formatDateBR(new Date(detail.createdAt), timezone)} às ${formatTimeLabel(detail.createdAt, timezone)}.` : ""}
            </DialogDescription>
          </DialogHeader>
          {detail ? (
            <div className="mt-4 flex max-h-[60vh] flex-col gap-4 overflow-y-auto" data-testid="audit-detail">
              <p className="break-words text-sm text-text [overflow-wrap:anywhere]">{detail.summary}</p>
              {detail.clientName ? <p className="break-words text-sm text-text-secondary [overflow-wrap:anywhere]">Cliente: {detail.clientName}</p> : null}
              {isAdmin ? (
                <p className="text-xs text-text-secondary">
                  {detail.tenant ? `Empresa: ${detail.tenant.name} (/${detail.tenant.slug})` : "Plataforma (sem empresa)"}
                  {detail.ipTruncated ? `. Origem aproximada: ${detail.ipTruncated}` : ""}
                </p>
              ) : null}
              {detail.changes.length > 0 ? (
                <ul className="flex flex-col gap-2" data-testid="audit-changes">
                  {detail.changes.map((c) => (
                    <li key={c.field} className="rounded-card border border-border bg-bg p-3">
                      <p className="text-sm font-medium text-text">{c.label}</p>
                      <dl className="mt-1.5 grid gap-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-3">
                        <dt className="text-text-secondary">Antes</dt>
                        <dd className="break-words text-text [overflow-wrap:anywhere]">{c.from}</dd>
                        <dt className="text-text-secondary">Depois</dt>
                        <dd className="break-words font-medium text-text [overflow-wrap:anywhere]">{c.to}</dd>
                      </dl>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-text-secondary">Esta ação não guardou o antes e o depois dos campos.</p>
              )}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" icon={X} onClick={() => setDetail(null)}>
              Fechar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
