"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter, usePathname } from "next/navigation";
import { formatInTimeZone } from "date-fns-tz";
import { Check, Filter, Pencil, Plus, Power, TicketPercent, Users, X } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { Card } from "@/components/ui/card";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/ui/pagination";
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { HelpButton } from "@/components/help/help-button";
import { useToast } from "@/components/ui/toast";
import { couponCycleRuleLabel, couponDiscountLabel, couponDurationLabel } from "@/core/billing";
import { formatCentsBRL } from "@/modules/billing/format";
import {
  createCouponAction,
  listCouponRedemptionsAction,
  setCouponActiveAction,
  updateCouponAction,
} from "@/modules/billing/coupon-actions";
import type { CouponListItem, CouponRedemptionItem, CouponState } from "@/modules/billing/coupons";

export type CouponRow = Omit<CouponListItem, "validFrom" | "validUntil" | "createdAt"> & {
  validFrom: string | null;
  validUntil: string | null;
  createdAt: string;
};

export type CouponFilters = { search: string; status: "all" | "active" | "inactive" };
type Paging = { page: number; pageSize: number; totalItems: number; totalPages: number };
type PlanOption = { id: string; name: string };

const BR_TZ = "America/Sao_Paulo";

const STATE_LABEL: Record<CouponState, string> = {
  ACTIVE: "Ativo",
  INACTIVE: "Desativado",
  SCHEDULED: "Ainda não começou",
  EXPIRED: "Vencido",
  EXHAUSTED: "Esgotado",
};
const STATE_BADGE: Record<CouponState, BadgeProps["variant"]> = {
  ACTIVE: "success",
  INACTIVE: "neutral",
  SCHEDULED: "primary",
  EXPIRED: "warning",
  EXHAUSTED: "warning",
};

function dateLabel(iso: string | null): string {
  return iso ? formatInTimeZone(new Date(iso), BR_TZ, "dd/MM/yyyy") : "";
}
function dateInput(iso: string | null): string {
  return iso ? formatInTimeZone(new Date(iso), BR_TZ, "yyyy-MM-dd") : "";
}
function validityLabel(c: CouponRow): string {
  if (c.validFrom && c.validUntil) return `${dateLabel(c.validFrom)} a ${dateLabel(c.validUntil)}`;
  if (c.validUntil) return `Até ${dateLabel(c.validUntil)}`;
  if (c.validFrom) return `A partir de ${dateLabel(c.validFrom)}`;
  return "Sem prazo";
}
function plansLabel(c: CouponRow, plans: PlanOption[]): string {
  if (c.planIds.length === 0) return "Todos os planos";
  return c.planIds.map((id) => plans.find((p) => p.id === id)?.name ?? "Plano removido").join(", ");
}
function usageLabel(c: CouponRow): string {
  return c.maxRedemptions === null ? `${c.redemptionsCount} usos` : `${c.redemptionsCount} de ${c.maxRedemptions}`;
}

type FormState = {
  code: string;
  description: string;
  kind: "PERCENT" | "AMOUNT";
  value: string;
  duration: "ONCE" | "N_CYCLES" | "FOREVER";
  durationCycles: string;
  appliesToCycle: "ANY" | "MONTHLY" | "ANNUAL";
  validFrom: string;
  validUntil: string;
  maxRedemptions: string;
  planIds: string[];
  active: boolean;
};

const EMPTY_FORM: FormState = {
  code: "",
  description: "",
  kind: "PERCENT",
  value: "10",
  duration: "ONCE",
  durationCycles: "3",
  appliesToCycle: "ANY",
  validFrom: "",
  validUntil: "",
  maxRedemptions: "",
  planIds: [],
  active: true,
};

function toForm(c: CouponRow): FormState {
  return {
    code: c.code,
    description: c.description ?? "",
    kind: c.kind,
    value: c.kind === "PERCENT" ? String(c.value) : (c.value / 100).toFixed(2),
    duration: c.duration,
    durationCycles: c.durationCycles !== null ? String(c.durationCycles) : "3",
    appliesToCycle: c.appliesToCycle,
    validFrom: dateInput(c.validFrom),
    validUntil: dateInput(c.validUntil),
    maxRedemptions: c.maxRedemptions !== null ? String(c.maxRedemptions) : "",
    planIds: c.planIds,
    active: c.active,
  };
}

function buildQuery(filters: CouponFilters, page: number, pageSize: number): string {
  const q = new URLSearchParams();
  if (filters.search) q.set("busca", filters.search);
  if (filters.status === "active") q.set("situacao", "ativos");
  if (filters.status === "inactive") q.set("situacao", "desativados");
  if (page > 1) q.set("pagina", String(page));
  if (pageSize !== 25) q.set("porPagina", String(pageSize));
  const s = q.toString();
  return s ? `?${s}` : "";
}

export function CuponsClient({ items, paging, filters, plans }: { items: CouponRow[]; paging: Paging; filters: CouponFilters; plans: PlanOption[] }) {
  const { notify } = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const [search, setSearch] = useState(filters.search);
  const [status, setStatus] = useState<CouponFilters["status"]>(filters.status);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CouponRow | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);

  const [redemptionsOf, setRedemptionsOf] = useState<CouponRow | null>(null);

  function go(nextFilters: CouponFilters, page: number, pageSize: number) {
    startTransition(() => router.push(`${pathname}${buildQuery(nextFilters, page, pageSize)}`));
  }

  function applyFilters(e: React.FormEvent) {
    e.preventDefault();
    go({ search: search.trim(), status }, 1, paging.pageSize);
  }

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(c: CouponRow) {
    setEditing(c);
    setForm(toForm(c));
    setFormError(null);
    setFormOpen(true);
  }

  const locked = editing !== null && editing.redemptionsCount > 0;

  function buildPayload(): Record<string, unknown> | string {
    const code = form.code.trim().toUpperCase();
    if (!editing && !/^[A-Z0-9_-]{3,32}$/.test(code)) return "O código usa só letras, números, hífen e sublinhado, de 3 a 32 caracteres.";

    let value: number;
    if (form.kind === "PERCENT") {
      value = Number(form.value);
      if (!Number.isInteger(value) || value < 1 || value > 100) return "A porcentagem vai de 1 a 100.";
    } else {
      value = Math.round(Number(form.value.replace(",", ".")) * 100);
      if (Number.isNaN(value) || value < 1) return "Informe o desconto em reais, por exemplo 50,00.";
    }

    let durationCycles: number | null = null;
    if (form.duration === "N_CYCLES") {
      durationCycles = Number(form.durationCycles);
      if (!Number.isInteger(durationCycles) || durationCycles < 1 || durationCycles > 60) return "Informe por quantas cobranças o desconto vale (de 1 a 60).";
    }

    let maxRedemptions: number | null = null;
    if (form.maxRedemptions.trim() !== "") {
      maxRedemptions = Number(form.maxRedemptions);
      if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1) return "O limite de usos precisa ser pelo menos 1, ou deixe em branco.";
    }
    if (form.validFrom && form.validUntil && form.validFrom > form.validUntil) return "A data final precisa ser depois da inicial.";

    return {
      ...(editing ? {} : { code }),
      description: form.description.trim() || null,
      kind: form.kind,
      value,
      duration: form.duration,
      durationCycles,
      appliesToCycle: form.appliesToCycle,
      validFrom: form.validFrom || null,
      validUntil: form.validUntil || null,
      maxRedemptions,
      planIds: form.planIds,
      active: form.active,
    };
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const payload = buildPayload();
    if (typeof payload === "string") {
      setFormError(payload);
      return;
    }
    startTransition(async () => {
      const result = editing ? await updateCouponAction(editing.id, payload) : await createCouponAction(payload);
      if (!result.ok) {
        setFormError(result.error.message);
        return;
      }
      setFormOpen(false);
      notify({ variant: "success", title: editing ? "Cupom atualizado." : "Cupom criado." });
      router.refresh();
    });
  }

  function toggleActive(c: CouponRow) {
    startTransition(async () => {
      const result = await setCouponActiveAction(c.id, { active: !c.active });
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível mudar o cupom", description: result.error.message });
        return;
      }
      notify({ variant: "success", title: c.active ? "Cupom desativado." : "Cupom ativado." });
      router.refresh();
    });
  }

  function togglePlan(id: string, checked: boolean) {
    setForm((f) => ({ ...f, planIds: checked ? [...f.planIds, id] : f.planIds.filter((p) => p !== id) }));
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        icon={navIconFor("admin/cupons")}
        title="Cupons"
        description="Códigos de desconto para o cadastro e a tela Assinatura."
        help="admin.cupons"
        action={
          <Button icon={Plus} type="button" onClick={openCreate}>
            Novo cupom
          </Button>
        }
      />

      <Card className="rounded-hero p-4">
        <form onSubmit={applyFilters} className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_14rem_auto]">
          <Field label="Buscar">
            {(fieldProps) => <Input {...fieldProps} className="w-full" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Código ou descrição" maxLength={60} />}
          </Field>
          <Field label="Situação">
            {(fieldProps) => (
              <Select {...fieldProps} className="w-full" value={status} onChange={(e) => setStatus(e.target.value as CouponFilters["status"])}>
                <option value="all">Todos</option>
                <option value="active">Ativos</option>
                <option value="inactive">Desativados</option>
              </Select>
            )}
          </Field>
          <Button icon={Filter} type="submit" variant="secondary" isLoading={isPending} loadingText="Filtrando…" className="w-full sm:col-span-2 lg:col-span-1 lg:w-auto">
            Filtrar
          </Button>
        </form>
      </Card>

      {items.length === 0 ? (
        <EmptyState
          icon={TicketPercent}
          title={filters.search || filters.status !== "all" ? "Nenhum cupom encontrado" : "Nenhum cupom ainda"}
          description={filters.search || filters.status !== "all" ? "Ajuste os filtros para ver outros cupons." : "Crie o primeiro cupom para oferecer desconto no cadastro e na tela Assinatura."}
        />
      ) : (
        <>
          <Card className="hidden rounded-hero md:block" data-testid="cupons-tabela">
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeadCell>Código</TableHeadCell>
                  <TableHeadCell>Desconto</TableHeadCell>
                  <TableHeadCell>Vale para</TableHeadCell>
                  <TableHeadCell>Validade</TableHeadCell>
                  <TableHeadCell>Usos</TableHeadCell>
                  <TableHeadCell>Situação</TableHeadCell>
                  <TableHeadCell className="text-right">Ações</TableHeadCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {items.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <p className="font-mono text-sm font-semibold text-text">{c.code}</p>
                      {c.description ? <p className="max-w-[16rem] truncate text-xs text-text-secondary">{c.description}</p> : null}
                    </TableCell>
                    <TableCell>
                      <p className="font-medium">{couponDiscountLabel(c.kind, c.value)}</p>
                      <p className="text-xs text-text-secondary">{couponDurationLabel(c.duration, c.durationCycles)}</p>
                    </TableCell>
                    <TableCell>
                      <p>{plansLabel(c, plans)}</p>
                      <p className="text-xs text-text-secondary">{couponCycleRuleLabel(c.appliesToCycle)}</p>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{validityLabel(c)}</TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">{usageLabel(c)}</TableCell>
                    <TableCell>
                      <Badge variant={STATE_BADGE[c.state]}>{STATE_LABEL[c.state]}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button type="button" variant="ghost" size="icon" aria-label={`Ver resgates do cupom ${c.code}`} title="Resgates" onClick={() => setRedemptionsOf(c)}>
                          <Users className="h-4 w-4" aria-hidden="true" />
                        </Button>
                        <Button type="button" variant="ghost" size="icon" aria-label={`Editar o cupom ${c.code}`} title="Editar" onClick={() => openEdit(c)}>
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={c.active ? `Desativar o cupom ${c.code}` : `Ativar o cupom ${c.code}`}
                          title={c.active ? "Desativar" : "Ativar"}
                          onClick={() => toggleActive(c)}
                          disabled={isPending}
                        >
                          <Power className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          <ul className="flex flex-col gap-3 md:hidden" data-testid="cupons-cartoes">
            {items.map((c) => (
              <li key={c.id} className="rounded-hero border border-border bg-surface p-4 shadow-card">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="break-all font-mono text-sm font-semibold text-text">{c.code}</p>
                    {c.description ? <p className="mt-0.5 text-xs text-text-secondary">{c.description}</p> : null}
                  </div>
                  <Badge variant={STATE_BADGE[c.state]}>{STATE_LABEL[c.state]}</Badge>
                </div>
                <p className="mt-3 font-display text-xl font-black text-text">{couponDiscountLabel(c.kind, c.value)}</p>
                <p className="text-xs text-text-secondary">{couponDurationLabel(c.duration, c.durationCycles)}</p>
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
                  <div>
                    <dt className="text-xs text-text-secondary">Vale para</dt>
                    <dd>{plansLabel(c, plans)}</dd>
                    <dd className="text-xs text-text-secondary">{couponCycleRuleLabel(c.appliesToCycle)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-text-secondary">Validade</dt>
                    <dd>{validityLabel(c)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-text-secondary">Usos</dt>
                    <dd className="tabular-nums">{usageLabel(c)}</dd>
                  </div>
                </dl>
                <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
                  <Button type="button" variant="secondary" size="sm" icon={Users} onClick={() => setRedemptionsOf(c)}>
                    Resgates
                  </Button>
                  <Button type="button" variant="secondary" size="sm" icon={Pencil} onClick={() => openEdit(c)}>
                    Editar
                  </Button>
                  <Button type="button" variant="secondary" size="sm" icon={Power} onClick={() => toggleActive(c)} disabled={isPending}>
                    {c.active ? "Desativar" : "Ativar"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      <Pagination
        label="Paginação dos cupons"
        page={paging.page}
        pageSize={paging.pageSize}
        totalItems={paging.totalItems}
        totalPages={paging.totalPages}
        isPending={isPending}
        onPageChange={(p) => go(filters, p, paging.pageSize)}
        onPageSizeChange={(size) => go(filters, 1, size)}
      />

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto">
          <DialogHeader icon={navIconFor("admin/cupons")}>
            <DialogTitle>{editing ? `Editar ${editing.code}` : "Novo cupom"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "O código não muda. Mudanças valem para quem usar o cupom daqui para frente."
                : "O código é o que a empresa digita. Ele fica em maiúsculas."}
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4" noValidate>
            {formError ? <Alert variant="danger">{formError}</Alert> : null}
            {locked ? (
              <Alert variant="info">
                Esse cupom já foi usado {editing?.redemptionsCount} {editing?.redemptionsCount === 1 ? "vez" : "vezes"}. Desconto, duração e ciclo ficam travados. Prazo, limite, planos e situação ainda podem mudar.
              </Alert>
            ) : null}

            <Field label="Código" required hint={editing ? undefined : "De 3 a 32 letras, números, hífen ou sublinhado. Exemplo: BEMVINDO20."}>
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  value={form.code}
                  onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))}
                  disabled={editing !== null}
                  maxLength={32}
                  autoCapitalize="characters"
                  autoComplete="off"
                />
              )}
            </Field>

            <Field label="Descrição (só você vê)">
              {(fieldProps) => (
                <Input {...fieldProps} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} maxLength={200} placeholder="Campanha de lançamento" />
              )}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Tipo de desconto" required>
                {(fieldProps) => (
                  <Select
                    {...fieldProps}
                    value={form.kind}
                    disabled={locked}
                    onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as FormState["kind"], value: e.target.value === "PERCENT" ? "10" : "20,00" }))}
                  >
                    <option value="PERCENT">Porcentagem</option>
                    <option value="AMOUNT">Valor em reais</option>
                  </Select>
                )}
              </Field>
              <Field label={form.kind === "PERCENT" ? "Desconto (%)" : "Desconto (R$)"} required hint={form.kind === "AMOUNT" ? "Por fatura. Nunca deixa a fatura abaixo de R$ 1,00." : undefined}>
                {(fieldProps) => (
                  <Input {...fieldProps} inputMode="decimal" value={form.value} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))} />
                )}
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Por quanto tempo vale" required>
                {(fieldProps) => (
                  <Select {...fieldProps} value={form.duration} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, duration: e.target.value as FormState["duration"] }))}>
                    <option value="ONCE">Só na primeira cobrança</option>
                    <option value="N_CYCLES">Em um número de cobranças</option>
                    <option value="FOREVER">Em todas as cobranças</option>
                  </Select>
                )}
              </Field>
              {form.duration === "N_CYCLES" ? (
                <Field label="Quantas cobranças" required>
                  {(fieldProps) => (
                    <Input {...fieldProps} type="number" min={1} max={60} value={form.durationCycles} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, durationCycles: e.target.value }))} />
                  )}
                </Field>
              ) : null}
            </div>

            <Field label="Em qual cobrança vale" required>
              {(fieldProps) => (
                <Select {...fieldProps} value={form.appliesToCycle} disabled={locked} onChange={(e) => setForm((f) => ({ ...f, appliesToCycle: e.target.value as FormState["appliesToCycle"] }))}>
                  <option value="ANY">Mensal ou anual</option>
                  <option value="MONTHLY">Só no plano mensal</option>
                  <option value="ANNUAL">Só no plano anual</option>
                </Select>
              )}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Vale a partir de">
                {(fieldProps) => <Input {...fieldProps} type="date" value={form.validFrom} onChange={(e) => setForm((f) => ({ ...f, validFrom: e.target.value }))} />}
              </Field>
              <Field label="Vale até">
                {(fieldProps) => <Input {...fieldProps} type="date" value={form.validUntil} onChange={(e) => setForm((f) => ({ ...f, validUntil: e.target.value }))} />}
              </Field>
            </div>

            <Field label="Limite de empresas" hint="Em branco: sem limite. Cada empresa só usa o cupom uma vez.">
              {(fieldProps) => (
                <Input {...fieldProps} type="number" min={editing?.redemptionsCount || 1} value={form.maxRedemptions} onChange={(e) => setForm((f) => ({ ...f, maxRedemptions: e.target.value }))} />
              )}
            </Field>

            <fieldset>
              <legend className="mb-2 text-sm font-medium text-text">Planos em que vale</legend>
              <p className="mb-2 text-xs text-text-secondary">Sem nenhum marcado, vale para todos os planos.</p>
              <div className="flex flex-wrap gap-x-5 gap-y-1">
                {plans.map((p) => (
                  <label key={p.id} className="flex min-h-11 items-center gap-2 text-sm text-text">
                    <input type="checkbox" checked={form.planIds.includes(p.id)} onChange={(e) => togglePlan(p.id, e.target.checked)} className="h-4 w-4 rounded border-border accent-primary" />
                    {p.name}
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="flex min-h-11 items-center gap-2 text-sm text-text">
              <input type="checkbox" checked={form.active} onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))} className="h-4 w-4 rounded border-border accent-primary" />
              Ativo (as empresas já podem usar)
            </label>

            <DialogFooter>
              <Button icon={X} type="button" variant="secondary" onClick={() => setFormOpen(false)}>
                Cancelar
              </Button>
              <Button icon={Check} type="submit" isLoading={isPending} loadingText="Salvando…">
                Salvar
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <RedemptionsDialog coupon={redemptionsOf} onClose={() => setRedemptionsOf(null)} />
    </div>
  );
}

function RedemptionsDialog({ coupon, onClose }: { coupon: CouponRow | null; onClose: () => void }) {
  return (
    <Dialog open={coupon !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[min(36rem,calc(100vw-2rem))] overflow-y-auto">
        {/* Montado só com o diálogo aberto e com `key`: cada cupom começa do zero, sem resetar estado em efeito. */}
        {coupon ? <RedemptionsBody key={coupon.id} coupon={coupon} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function RedemptionsBody({ coupon }: { coupon: CouponRow }) {
  const [rows, setRows] = useState<CouponRedemptionItem[]>([]);
  const [paging, setPaging] = useState<Paging>({ page: 1, pageSize: 10, totalItems: 0, totalPages: 1 });
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [isPending, startTransition] = useTransition();
  const couponId = coupon.id;

  function load(page: number, pageSize: number) {
    if (!couponId) return;
    startTransition(async () => {
      const result = await listCouponRedemptionsAction(couponId, { page, pageSize });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setError(null);
      setRows(result.data.items);
      setPaging({ page: result.data.page, pageSize: result.data.pageSize, totalItems: result.data.totalItems, totalPages: result.data.totalPages });
      setLoaded(true);
    });
  }

  useEffect(() => {
    load(1, 10);
    // Só na montagem: o corpo é remontado (key) para cada cupom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
        <DialogHeader icon={navIconFor("admin/cupons")}>
          <DialogTitle className="flex items-center gap-1">
            Resgates de {coupon.code}
            <HelpButton helpKey="admin.cupomResgates" />
          </DialogTitle>
          <DialogDescription>Empresas que adotaram este cupom e quanto ele valeu na primeira fatura.</DialogDescription>
        </DialogHeader>
        <div className="mt-4 flex flex-col gap-3">
          {error ? <Alert variant="danger">{error}</Alert> : null}
          {loaded && rows.length === 0 && !error ? (
            <p className="rounded-card border border-border p-4 text-sm text-text-secondary">Nenhuma empresa usou este cupom ainda.</p>
          ) : null}
          {rows.length > 0 ? (
            <ul className="divide-y divide-border rounded-card border border-border" data-testid="resgates-lista">
              {rows.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 text-sm">
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-text">{r.tenantName}</span>
                    <span className="block text-xs text-text-secondary">/{r.tenantSlug} · {formatInTimeZone(new Date(r.createdAt), BR_TZ, "dd/MM/yyyy")}</span>
                  </span>
                  <span className="tabular-nums text-text">{r.invoiceId ? formatCentsBRL(r.discountCents) : "ainda sem fatura"}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <Pagination
            label="Paginação dos resgates"
            page={paging.page}
            pageSize={paging.pageSize}
            totalItems={paging.totalItems}
            totalPages={paging.totalPages}
            isPending={isPending}
            pageSizeOptions={[10, 25, 50]}
            onPageChange={(p) => load(p, paging.pageSize)}
            onPageSizeChange={(size) => load(1, size)}
          />
        </div>
    </>
  );
}
