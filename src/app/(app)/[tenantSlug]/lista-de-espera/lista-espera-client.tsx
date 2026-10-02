"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { CalendarClock, Hourglass, Plus, Send, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { EmptyState } from "@/components/ui/empty-state";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Pagination } from "@/components/ui/pagination";
import { useToast } from "@/components/ui/toast";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from "@/components/ui/table";
import { formatLongDateLabel, formatTimeLabel } from "@/components/lib/format-date";
import { formatPhoneDisplay } from "@/components/lib/format-phone";
import { PAGE_SIZE_OPTIONS, DEFAULT_PAGE_SIZE } from "@/components/lib/pagination";
import { describePreference } from "@/core/waitlist/match";
import type { WaitlistListData } from "@/modules/waitlist/service";
import { listWaitlistAction, offerWaitlistEntryAction, removeWaitlistEntryAction } from "@/modules/waitlist/actions";
import type { ProfessionalRow } from "../profissionais/profissionais-client";
import type { ServiceRow } from "../servicos/servicos-client";
import { AddWaitlistDialog } from "./add-waitlist-dialog";

type ListData = WaitlistListData;
export type WaitlistItem = ListData["items"][number];
type StatusFilter = "active" | "all" | "WAITING" | "OFFERED" | "FULFILLED" | "EXPIRED" | "CANCELED";

const STATUS_LABEL: Record<string, string> = {
  WAITING: "Na fila",
  OFFERED: "Oferta enviada",
  ACCEPTED: "Aceitou",
  FULFILLED: "Encaixado",
  EXPIRED: "Venceu",
  CANCELED: "Saiu da lista",
};
const STATUS_VARIANT: Record<string, "primary" | "success" | "danger" | "warning" | "neutral"> = {
  WAITING: "primary",
  OFFERED: "warning",
  ACCEPTED: "success",
  FULFILLED: "success",
  EXPIRED: "neutral",
  CANCELED: "neutral",
};

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function ListaEsperaClient({
  tenantSlug,
  timezone,
  professionals,
  services,
}: {
  tenantSlug: string;
  timezone: string;
  professionals: ProfessionalRow[];
  services: ServiceRow[];
}) {
  const { notify } = useToast();
  const [date, setDate] = useState("");
  const [professionalId, setProfessionalId] = useState("");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [data, setData] = useState<ListData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [toRemove, setToRemove] = useState<WaitlistItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const load = useCallback(
    (silent?: boolean) => {
      if (silent !== true) setLoading(true);
      setError(null);
      listWaitlistAction(tenantSlug, { date: date || null, professionalId: professionalId || null, status, page, pageSize }).then((result) => {
        if (!result.ok) setError(result.error.message);
        else setData(result.data);
        setLoading(false);
      });
    },
    [tenantSlug, date, professionalId, status, page, pageSize],
  );

  useEffect(() => {
    const timeoutId = setTimeout(load, 0);
    return () => clearTimeout(timeoutId);
  }, [load]);

  function changeFilter<T>(setter: (v: T) => void, value: T) {
    setter(value);
    setPage(1);
  }

  function offerNow(item: WaitlistItem) {
    setBusyId(item.id);
    startTransition(async () => {
      const result = await offerWaitlistEntryAction(tenantSlug, item.id);
      setBusyId(null);
      if (!result.ok) {
        notify({ variant: "error", title: "Não deu para oferecer o encaixe", description: result.error.message });
        return;
      }
      notify({ variant: "success", title: "Oferta enviada", description: `O horário das ${formatTimeLabel(result.data.slotStart, timezone)} foi oferecido pelo WhatsApp.` });
      load(true);
    });
  }

  function confirmRemove() {
    const item = toRemove;
    if (!item) return;
    setBusyId(item.id);
    startTransition(async () => {
      const result = await removeWaitlistEntryAction(tenantSlug, item.id);
      setBusyId(null);
      setToRemove(null);
      if (!result.ok) {
        notify({ variant: "error", title: "Não deu para remover", description: result.error.message });
        return;
      }
      notify({ variant: "success", title: "Pessoa removida da lista" });
      load(true);
    });
  }

  const items = data?.items ?? [];
  const groups = groupByDay(items);

  return (
    <div>
      <PageHeader
        help="pagina.listaEspera"
        icon={navIconFor("lista-de-espera")}
        title="Lista de espera"
        description="Quem está esperando um horário, por dia e profissional."
        action={
          <Button onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Adicionar à lista
          </Button>
        }
      />

      {!loading && !error && data ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-xs text-text-secondary ring-1 ring-primary/15">
            <CalendarClock className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            <span className="font-semibold tabular-nums text-text">{data.total}</span>
            {data.total === 1 ? "pedido na lista" : "pedidos na lista"}
          </span>
        </div>
      ) : null}

      <Card className="mb-4 rounded-hero p-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <Label htmlFor="espera-dia">Dia</Label>
            <div className="flex gap-2">
              <Input id="espera-dia" type="date" min={todayISO()} value={date} onChange={(e) => changeFilter(setDate, e.target.value)} />
              {date ? (
                <Button type="button" variant="secondary" onClick={() => changeFilter(setDate, "")}>
                  Todos
                </Button>
              ) : null}
            </div>
          </div>
          <div>
            <Label htmlFor="espera-prof">Profissional</Label>
            <Select id="espera-prof" value={professionalId} onChange={(e) => changeFilter(setProfessionalId, e.target.value)}>
              <option value="">Todos</option>
              {professionals.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="espera-status">Situação</Label>
            <Select id="espera-status" value={status} onChange={(e) => changeFilter(setStatus, e.target.value as StatusFilter)}>
              <option value="active">Esperando ou com oferta</option>
              <option value="WAITING">Na fila</option>
              <option value="OFFERED">Oferta enviada</option>
              <option value="FULFILLED">Encaixados</option>
              <option value="EXPIRED">Venceram</option>
              <option value="CANCELED">Saíram da lista</option>
              <option value="all">Todas</option>
            </Select>
          </div>
        </div>
      </Card>

      {loading && !data ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-14 rounded-hero" />
          ))}
        </div>
      ) : error ? (
        <EmptyState icon={Hourglass} title="Não deu para carregar" description={error} />
      ) : items.length === 0 ? (
        <EmptyState
          icon={Hourglass}
          title="Ninguém na lista de espera"
          description="Quando um cliente pedir um dia sem horário, ele entra aqui. Você também pode adicionar alguém à mão."
          action={
            <Button icon={Plus} onClick={() => setAddOpen(true)}>
              Adicionar à lista
            </Button>
          }
        />
      ) : (
        <>
          <Card className="hidden rounded-hero md:block">
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeadCell>Cliente</TableHeadCell>
                  <TableHeadCell>Serviço</TableHeadCell>
                  <TableHeadCell>Profissional</TableHeadCell>
                  <TableHeadCell>Horário pedido</TableHeadCell>
                  <TableHeadCell>Situação</TableHeadCell>
                  <TableHeadCell>Origem</TableHeadCell>
                  <TableHeadCell>
                    <span className="sr-only">Ações</span>
                  </TableHeadCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {groups.map((group) => (
                  <GroupRows key={group.date} group={group} timezone={timezone} busyId={busyId} isPending={isPending} onOffer={offerNow} onRemove={setToRemove} />
                ))}
              </TableBody>
            </Table>
          </Card>

          <div className="flex flex-col gap-3 md:hidden">
            {groups.map((group) => (
              <section key={group.date} aria-label={dayHeading(group.date)}>
                <h2 className="mb-2 text-sm font-semibold text-text">{dayHeading(group.date)}</h2>
                <div className="flex flex-col gap-3">
                  {group.items.map((item) => (
                    <Card key={item.id} className="rounded-hero p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="font-medium text-text">{item.contactName ?? "Sem nome"}</p>
                        <StatusBadge item={item} timezone={timezone} />
                      </div>
                      <p className="mt-1 text-sm text-text-secondary">
                        {item.serviceName} · {item.professionalName ?? "Qualquer profissional"}
                      </p>
                      <p className="mt-1 text-xs text-text-secondary">
                        {describePreference(item)} · {item.source === "BOT" ? "Pelo WhatsApp" : "Pelo painel"}
                        {item.contactPhone ? ` · ${formatPhoneDisplay(item.contactPhone)}` : ""}
                      </p>
                      <RowActions item={item} busyId={busyId} isPending={isPending} onOffer={offerNow} onRemove={setToRemove} className="mt-3" />
                    </Card>
                  ))}
                </div>
              </section>
            ))}
          </div>

          {data ? (
            <Pagination
              className="mt-4"
              label="Paginação da lista de espera"
              page={data.page}
              pageSize={data.pageSize}
              totalItems={data.total}
              totalPages={data.pageCount}
              isPending={loading}
              pageSizeOptions={PAGE_SIZE_OPTIONS}
              onPageChange={setPage}
              onPageSizeChange={(n) => {
                setPageSize(n);
                setPage(1);
              }}
            />
          ) : null}
        </>
      )}

      <AddWaitlistDialog
        tenantSlug={tenantSlug}
        open={addOpen}
        onOpenChange={setAddOpen}
        services={services}
        professionals={professionals}
        onAdded={(alreadyExisted) => {
          notify(alreadyExisted ? { variant: "info", title: "Essa pessoa já estava nessa lista" } : { variant: "success", title: "Pessoa adicionada à lista" });
          load(true);
        }}
      />

      <Dialog open={toRemove !== null} onOpenChange={(open) => !open && setToRemove(null)}>
        <DialogContent>
          <DialogHeader icon={Trash2}>
            <DialogTitle>Remover da lista de espera?</DialogTitle>
            <DialogDescription>
              {toRemove ? `${toRemove.contactName ?? "Essa pessoa"} deixa de esperar ${toRemove.serviceName} em ${formatLongDateLabel(toRemove.date)}.` : ""}
              {toRemove?.status === "OFFERED" ? " A oferta que ela recebeu perde a validade e o horário passa para a próxima da fila." : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setToRemove(null)}>
              Manter na lista
            </Button>
            <Button type="button" variant="danger" icon={Trash2} onClick={confirmRemove} isLoading={isPending} loadingText="Removendo…">
              Remover
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {error && data ? <Alert variant="danger">{error}</Alert> : null}
    </div>
  );
}

type Group = { date: string; items: WaitlistItem[] };

function groupByDay(items: WaitlistItem[]): Group[] {
  const groups: Group[] = [];
  for (const item of items) {
    const last = groups[groups.length - 1];
    if (last && last.date === item.date) last.items.push(item);
    else groups.push({ date: item.date, items: [item] });
  }
  return groups;
}

function dayHeading(dateISO: string): string {
  return formatLongDateLabel(dateISO, { capitalize: true });
}

function StatusBadge({ item, timezone }: { item: WaitlistItem; timezone: string }) {
  const expired = item.status === "OFFERED" && item.offerExpired;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge variant={expired ? "neutral" : (STATUS_VARIANT[item.status] ?? "neutral")}>{expired ? "Oferta vencida" : (STATUS_LABEL[item.status] ?? item.status)}</Badge>
      {item.status === "OFFERED" && item.offeredSlotStart && !expired ? (
        <span className="text-xs tabular-nums text-text-secondary">
          {formatTimeLabel(item.offeredSlotStart, timezone)} até {item.offerExpiresAt ? formatTimeLabel(item.offerExpiresAt, timezone) : ""}
        </span>
      ) : null}
    </span>
  );
}

function RowActions({
  item,
  busyId,
  isPending,
  onOffer,
  onRemove,
  className,
}: {
  item: WaitlistItem;
  busyId: string | null;
  isPending: boolean;
  onOffer: (item: WaitlistItem) => void;
  onRemove: (item: WaitlistItem) => void;
  className?: string;
}) {
  const active = item.status === "WAITING" || item.status === "OFFERED";
  if (!active) return null;
  const busy = busyId === item.id && isPending;
  return (
    <div className={className ?? "flex justify-end gap-2"}>
      {item.status === "WAITING" ? (
        <Button type="button" size="sm" variant="secondary" icon={Send} isLoading={busy} loadingText="Enviando…" onClick={() => onOffer(item)}>
          Oferecer encaixe
        </Button>
      ) : null}
      <Button type="button" size="sm" variant="ghost" icon={Trash2} disabled={busy} onClick={() => onRemove(item)} aria-label={`Remover ${item.contactName ?? "pessoa"} da lista`}>
        Remover
      </Button>
    </div>
  );
}

function GroupRows({
  group,
  timezone,
  busyId,
  isPending,
  onOffer,
  onRemove,
}: {
  group: Group;
  timezone: string;
  busyId: string | null;
  isPending: boolean;
  onOffer: (item: WaitlistItem) => void;
  onRemove: (item: WaitlistItem) => void;
}) {
  return (
    <>
      <TableRow className="bg-bg">
        <TableCell colSpan={7} className="py-2 text-sm font-semibold text-text">
          {dayHeading(group.date)}
        </TableCell>
      </TableRow>
      {group.items.map((item) => (
        <TableRow key={item.id}>
          <TableCell>
            <p className="font-medium text-text">{item.contactName ?? "Sem nome"}</p>
            {item.contactPhone ? <p className="text-xs text-text-secondary">{formatPhoneDisplay(item.contactPhone)}</p> : null}
          </TableCell>
          <TableCell>{item.serviceName}</TableCell>
          <TableCell>{item.professionalName ?? "Qualquer"}</TableCell>
          <TableCell className="tabular-nums">{describePreference(item)}</TableCell>
          <TableCell>
            <StatusBadge item={item} timezone={timezone} />
          </TableCell>
          <TableCell className="text-sm text-text-secondary">{item.source === "BOT" ? "WhatsApp" : "Painel"}</TableCell>
          <TableCell>
            <RowActions item={item} busyId={busyId} isPending={isPending} onOffer={onOffer} onRemove={onRemove} />
          </TableCell>
        </TableRow>
      ))}
    </>
  );
}
