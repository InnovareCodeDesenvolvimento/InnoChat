"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter, usePathname } from "next/navigation";
import { AlertTriangle, Bug, CheckCircle2, Eye, EyeOff, RotateCcw, TriangleAlert } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState } from "@/components/ui/empty-state";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { HelpButton } from "@/components/help/help-button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/components/lib/cn";
import { DEFAULT_PAGE_SIZE } from "@/components/lib/pagination";
import { formatDateTimeLabel } from "@/components/lib/format-date";
import { getErrorGroupAction, setErrorGroupStatusAction } from "@/modules/error-monitor/actions";
import type { ErrorGroupDetail, ErrorGroupItem, ErrorListResult, ErrorSourceFilter, ErrorStatus } from "@/modules/error-monitor/service";

const TZ = "America/Sao_Paulo";

export type ErrosFilters = { status?: ErrorStatus; source?: ErrorSourceFilter };

const STATUS_LABEL: Record<ErrorStatus, string> = { OPEN: "Aberto", RESOLVED: "Resolvido", IGNORED: "Ignorado" };
const STATUS_VARIANT: Record<ErrorStatus, "danger" | "success" | "neutral"> = { OPEN: "danger", RESOLVED: "success", IGNORED: "neutral" };
const SOURCE_LABEL: Record<ErrorSourceFilter, string> = { SERVER: "Servidor", CLIENT: "Navegador" };

function buildQuery(f: ErrosFilters, page: number, pageSize: number): string {
  const q = new URLSearchParams();
  if (f.status) q.set("status", f.status);
  if (f.source) q.set("origem", f.source);
  if (page > 1) q.set("pagina", String(page));
  if (pageSize !== DEFAULT_PAGE_SIZE) q.set("porPagina", String(pageSize));
  const text = q.toString();
  return text ? `?${text}` : "";
}

function TotalCard({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone: "success" | "danger" | "neutral" }) {
  const toneClass = { success: "bg-success-bg text-success", danger: "bg-danger-bg text-danger", neutral: "bg-bg text-text-secondary" }[tone];
  return (
    <Card className="flex items-center gap-3 rounded-hero p-4">
      <span className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-full [&>svg]:h-5 [&>svg]:w-5", toneClass)}>{icon}</span>
      <div className="min-w-0">
        <p className="text-sm text-text-secondary">{label}</p>
        <p className="font-display text-2xl font-black tabular-nums text-text">{value.toLocaleString("pt-BR")}</p>
      </div>
    </Card>
  );
}

function StatusActions({ item, busy, onChange }: { item: Pick<ErrorGroupItem, "status" | "id" | "message">; busy: boolean; onChange: (status: ErrorStatus) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {item.status === "OPEN" ? (
        <>
          <Button type="button" size="sm" variant="secondary" icon={CheckCircle2} disabled={busy} onClick={() => onChange("RESOLVED")} aria-label={`Resolver: ${item.message}`}>
            Resolver
          </Button>
          <Button type="button" size="sm" variant="ghost" icon={EyeOff} disabled={busy} onClick={() => onChange("IGNORED")} aria-label={`Ignorar: ${item.message}`}>
            Ignorar
          </Button>
        </>
      ) : (
        <Button type="button" size="sm" variant="secondary" icon={RotateCcw} disabled={busy} onClick={() => onChange("OPEN")} aria-label={`Reabrir: ${item.message}`}>
          Reabrir
        </Button>
      )}
    </div>
  );
}

export function ErrosClient({ data, filters: applied }: { data: ErrorListResult; filters: ErrosFilters }) {
  const { notify } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const { items, totals, page, pageSize } = data;

  function go(filters: ErrosFilters, nextPage: number, nextSize: number) {
    startTransition(() => router.push(`${pathname}${buildQuery(filters, nextPage, nextSize)}`));
  }

  const [target, setTarget] = useState<ErrorGroupItem | null>(null);
  const [detail, setDetail] = useState<ErrorGroupDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const request = useRef(0);

  async function openDetail(item: ErrorGroupItem) {
    const mine = ++request.current;
    setTarget(item);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    const result = await getErrorGroupAction(item.id);
    if (mine !== request.current) return;
    setDetailLoading(false);
    if (!result.ok) setDetailError(result.error.message);
    else setDetail(result.data);
  }

  function closeDetail() {
    request.current += 1;
    setTarget(null);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
  }

  async function changeStatus(item: Pick<ErrorGroupItem, "id">, status: ErrorStatus) {
    setBusyId(item.id);
    const result = await setErrorGroupStatusAction(item.id, status);
    setBusyId(null);
    if (!result.ok) {
      notify({ variant: "error", title: "Não deu para mudar a situação.", description: result.error.message });
      return;
    }
    notify({
      variant: "success",
      title: status === "RESOLVED" ? "Erro marcado como resolvido." : status === "IGNORED" ? "Erro ignorado." : "Erro reaberto.",
    });
    if (detail && detail.group.id === item.id) setDetail({ ...detail, group: result.data });
    router.refresh();
  }

  const hasFilter = !!applied.status || !!applied.source;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        icon={navIconFor("admin/erros")}
        title="Erros"
        description="Os erros que o sistema registrou sozinho, juntando os que se repetem."
        help="pagina.adminErros"
        className="mb-2"
      />

      <div className="grid grid-cols-3 gap-3" aria-live="polite" aria-busy={isPending || undefined}>
        <TotalCard icon={<AlertTriangle aria-hidden="true" />} label="Abertos" value={totals.open} tone="danger" />
        <TotalCard icon={<CheckCircle2 aria-hidden="true" />} label="Resolvidos" value={totals.resolved} tone="success" />
        <TotalCard icon={<EyeOff aria-hidden="true" />} label="Ignorados" value={totals.ignored} tone="neutral" />
      </div>

      <Card className="rounded-hero">
        <CardHeader help="admin.errosFiltros" className="py-3.5">
          <CardTitle className="text-base">Filtros</CardTitle>
        </CardHeader>
        <CardContent className="p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Situação">
              {(p) => (
                <Select {...p} value={applied.status ?? ""} disabled={isPending} onChange={(e) => go({ ...applied, status: (e.target.value || undefined) as ErrorStatus | undefined }, 1, pageSize)}>
                  <option value="">Todas</option>
                  <option value="OPEN">Abertos</option>
                  <option value="RESOLVED">Resolvidos</option>
                  <option value="IGNORED">Ignorados</option>
                </Select>
              )}
            </Field>
            <Field label="Origem">
              {(p) => (
                <Select {...p} value={applied.source ?? ""} disabled={isPending} onChange={(e) => go({ ...applied, source: (e.target.value || undefined) as ErrorSourceFilter | undefined }, 1, pageSize)}>
                  <option value="">Todas</option>
                  <option value="SERVER">Servidor</option>
                  <option value="CLIENT">Navegador</option>
                </Select>
              )}
            </Field>
          </div>
        </CardContent>
      </Card>

      {items.length === 0 ? (
        <EmptyState
          icon={Bug}
          title={hasFilter ? "Nenhum erro com esses filtros" : "Nenhum erro registrado"}
          description={hasFilter ? "Mude ou limpe os filtros para ver outros erros." : "Quando algo quebrar, o erro aparece aqui e você recebe um aviso."}
        />
      ) : (
        <>
          <Card className="rounded-hero">
            <CardHeader help="admin.errosLista" className="py-3.5">
              <CardTitle className="text-base">Erros registrados</CardTitle>
            </CardHeader>
            <ul className={cn("divide-y divide-border transition-opacity", isPending && "opacity-60")} aria-busy={isPending || undefined} data-testid="errors-list">
              {items.map((item) => (
                <li key={item.id} className="flex flex-col gap-3 p-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={STATUS_VARIANT[item.status]}>{STATUS_LABEL[item.status]}</Badge>
                      <Badge variant="neutral">{SOURCE_LABEL[item.source]}</Badge>
                      <span className="text-sm font-medium tabular-nums text-text">
                        {item.count.toLocaleString("pt-BR")} {item.count === 1 ? "vez" : "vezes"}
                      </span>
                    </div>
                    <p className="mt-2 break-words font-medium text-text [overflow-wrap:anywhere]">
                      <span className="text-text-secondary">{item.type}: </span>
                      {item.message}
                    </p>
                    <p className="mt-1 text-xs text-text-secondary">
                      Última vez em {formatDateTimeLabel(item.lastSeenAt, TZ)}. Primeira em {formatDateTimeLabel(item.firstSeenAt, TZ)}.
                      {item.route ? ` Rota: ${item.route}.` : ""}
                      {item.lastVersion ? ` Versão ${item.lastVersion}.` : ""}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                    <Button type="button" size="sm" variant="ghost" icon={Eye} onClick={() => openDetail(item)} aria-label={`Ver detalhes: ${item.message}`}>
                      Ver detalhes
                    </Button>
                    <StatusActions item={item} busy={busyId === item.id} onChange={(s) => changeStatus(item, s)} />
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Pagination
            label="Paginação dos erros"
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

      <Dialog open={!!target} onOpenChange={(open) => !open && closeDetail()}>
        <DialogContent className="w-[min(44rem,calc(100vw-2rem))]">
          <DialogHeader icon={TriangleAlert}>
            <DialogTitle>
              Detalhe do erro <HelpButton helpKey="admin.errosDetalhe" placement="inline" />
            </DialogTitle>
            <DialogDescription>{target ? `${target.type}: ${target.message}` : ""}</DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex max-h-[60vh] flex-col gap-3 overflow-y-auto" aria-busy={detailLoading || undefined}>
            {detailLoading ? (
              <div aria-hidden="true" className="flex flex-col gap-2">
                <Skeleton className="h-5 w-2/3" />
                <Skeleton className="h-32" />
              </div>
            ) : detailError ? (
              <Alert variant="danger">{detailError}</Alert>
            ) : detail ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge variant={STATUS_VARIANT[detail.group.status]}>{STATUS_LABEL[detail.group.status]}</Badge>
                  <StatusActions item={detail.group} busy={busyId === detail.group.id} onChange={(s) => changeStatus(detail.group, s)} />
                </div>
                <p className="text-sm text-text-secondary">
                  {detail.group.count.toLocaleString("pt-BR")} {detail.group.count === 1 ? "ocorrência" : "ocorrências"} no total. Abaixo, as últimas {detail.events.length}.
                  {detail.group.status === "IGNORED" ? " Erro ignorado: novas ocorrências só somam no contador." : ""}
                </p>
                {detail.events.length === 0 ? (
                  <p className="text-sm text-text-secondary">Não há ocorrências guardadas. As com mais de 30 dias são apagadas, e o total continua contando.</p>
                ) : (
                  <ol className="flex flex-col gap-3">
                    {detail.events.map((e) => (
                      <li key={e.id} className="rounded-card border border-border p-3">
                        <p className="text-sm font-medium tabular-nums text-text">{formatDateTimeLabel(e.occurredAt, TZ)}</p>
                        <p className="text-xs text-text-secondary">
                          {e.route ? `Rota ${e.route}. ` : ""}
                          {e.version ? `Versão ${e.version}. ` : ""}
                          {e.hasUser ? "Com usuário logado. " : ""}
                          {e.hasTenant ? "Dentro de uma empresa." : ""}
                        </p>
                        {e.stack ? <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-card bg-bg p-2 text-xs text-text">{e.stack}</pre> : null}
                      </li>
                    ))}
                  </ol>
                )}
              </>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
