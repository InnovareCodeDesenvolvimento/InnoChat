"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { AlertTriangle, Banknote, Check, Filter, FlaskConical, QrCode, ReceiptText, RefreshCw, Send, TrendingUp, Wallet, X } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cycleTitle } from "@/core/billing";
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Alert } from "@/components/ui/alert";
import { Pagination } from "@/components/ui/pagination";
import { EmptyState } from "@/components/ui/empty-state";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/components/lib/cn";
import { formatDateBR, formatCentsBRL } from "@/modules/billing/format";
import {
  listInvoicesAdminAction,
  markInvoicePaidManuallyAction,
  reconcileInvoiceAdminAction,
  regeneratePixForInvoiceAdminAction,
} from "@/modules/billing/admin-actions";
import type { AdminInvoiceListItem, BillingMonthlyTotals, DelinquentCompany } from "@/modules/billing/admin-service";

type InvoiceRow = Omit<AdminInvoiceListItem, "periodStart" | "periodEnd" | "dueAt" | "paidAt" | "createdAt"> & {
  periodStart: string;
  periodEnd: string;
  dueAt: string;
  paidAt: string | null;
  createdAt: string;
};

const STATUS_LABEL: Record<InvoiceRow["status"], string> = {
  OPEN: "Aberta",
  PAID: "Paga",
  EXPIRED: "Expirada",
  VOID: "Anulada",
};

const STATUS_BADGE: Record<InvoiceRow["status"], BadgeProps["variant"]> = {
  OPEN: "warning",
  PAID: "success",
  EXPIRED: "danger",
  VOID: "neutral",
};

type Paging = { page: number; pageSize: number; totalItems: number; totalPages: number };

function StatBlock({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: "primary" | "success" | "warning" | "danger";
}) {
  const TONE_CLASSES: Record<typeof tone, string> = {
    primary: "bg-primary/10 text-primary",
    success: "bg-success-bg text-success",
    warning: "bg-warning-bg text-warning",
    danger: "bg-danger-bg text-danger",
  };
  return (
    <Card className="rounded-hero p-5">
      <div className={cn("mb-4 flex h-11 w-11 items-center justify-center rounded-full [&>svg]:h-5 [&>svg]:w-5", TONE_CLASSES[tone])}>
        {icon}
      </div>
      <p className="text-sm font-medium text-text-secondary">{label}</p>
      <p className="mt-1 font-display text-3xl font-black tabular-nums text-text">{value}</p>
    </Card>
  );
}

type MarkPaidTarget = { invoice: InvoiceRow };

export function AdminCobrancaClient({
  totals,
  initialItems,
  initialPaging,
  delinquents,
}: {
  totals: BillingMonthlyTotals;
  initialItems: InvoiceRow[];
  initialPaging: Paging;
  delinquents: DelinquentCompany[];
}) {
  const { notify } = useToast();
  const [items, setItems] = useState<InvoiceRow[]>(initialItems);
  const [paging, setPaging] = useState<Paging>(initialPaging);
  // Filtros JÁ aplicados (o que a lista mostra); o formulário pode estar adiante, até o clique em "Filtrar".
  const [appliedFilters, setAppliedFilters] = useState<{ status: InvoiceRow["status"] | ""; from: string; to: string }>({ status: "", from: "", to: "" });
  const [isPending, startTransition] = useTransition();
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<InvoiceRow["status"] | "">("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [companyFilter, setCompanyFilter] = useState("");

  const [markPaidTarget, setMarkPaidTarget] = useState<MarkPaidTarget | null>(null);
  const [reason, setReason] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);

  const filteredItems = useMemo(() => {
    if (!companyFilter.trim()) return items;
    const needle = companyFilter.trim().toLowerCase();
    return items.filter((i) => i.tenantName.toLowerCase().includes(needle) || i.tenantSlug.toLowerCase().includes(needle));
  }, [items, companyFilter]);

  function loadInvoices(filters: { status: InvoiceRow["status"] | ""; from: string; to: string }, page: number, pageSize: number) {
    startTransition(async () => {
      const result = await listInvoicesAdminAction({
        status: filters.status || undefined,
        fromDate: filters.from || undefined,
        toDate: filters.to || undefined,
        page,
        pageSize,
      });
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível carregar as faturas", description: result.error.message });
        return;
      }
      setItems(
        result.data.items.map((item) => ({
          ...item,
          periodStart: new Date(item.periodStart).toISOString(),
          periodEnd: new Date(item.periodEnd).toISOString(),
          dueAt: new Date(item.dueAt).toISOString(),
          paidAt: item.paidAt ? new Date(item.paidAt).toISOString() : null,
          createdAt: new Date(item.createdAt).toISOString(),
        })),
      );
      setAppliedFilters(filters);
      setPaging({ page: result.data.page, pageSize: result.data.pageSize, totalItems: result.data.totalItems, totalPages: result.data.totalPages });
    });
  }

  function applyFilters() {
    loadInvoices({ status: statusFilter, from: fromDate, to: toDate }, 1, paging.pageSize);
  }

  function handleRegeneratePix(invoice: InvoiceRow) {
    setRegeneratingId(invoice.id);
    startTransition(async () => {
      const result = await regeneratePixForInvoiceAdminAction(invoice.id);
      setRegeneratingId(null);
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível regerar o Pix", description: result.error.message });
        return;
      }
      setItems((prev) => prev.map((i) => (i.id === invoice.id ? { ...i, hasPix: result.data.hasPix } : i)));
      notify({
        variant: result.data.hasPix ? "success" : "error",
        title: result.data.hasPix ? "Pix regerado." : "Pix não pôde ser gerado.",
      });
    });
  }

  function handleReconcile(invoice: InvoiceRow) {
    setCheckingId(invoice.id);
    startTransition(async () => {
      const result = await reconcileInvoiceAdminAction(invoice.id);
      setCheckingId(null);
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível conferir no Mercado Pago", description: result.error.message });
        return;
      }
      const outcome = result.data;
      if (outcome.status === "paid" || outcome.status === "already_paid") {
        setItems((prev) => prev.map((i) => (i.id === invoice.id ? { ...i, status: "PAID", paidAt: new Date().toISOString() } : i)));
        notify({ variant: "success", title: outcome.status === "paid" ? "Pagamento confirmado no Mercado Pago." : "Esta fatura já estava paga." });
      } else if (outcome.status === "pending") {
        notify({ variant: "info", title: "Ainda não foi pago.", description: `Status no Mercado Pago: ${outcome.mpStatus}.` });
      } else if (outcome.status === "payment_failed") {
        notify({ variant: "error", title: "O pagamento não foi concluído.", description: `Status no Mercado Pago: ${outcome.mpStatus}. A fatura continua em aberto.` });
      } else if (outcome.status === "error") {
        notify({
          variant: "error",
          title: "Não foi possível consultar o Mercado Pago.",
          description:
            outcome.code === "NOT_CONFIGURED"
              ? "Access token do ambiente desta fatura não está salvo."
              : outcome.code === "PAYMENT_MISMATCH"
                ? "O pagamento consultado pertence a outra fatura."
                : outcome.code === "AMOUNT_MISMATCH"
                  ? "O valor pago não confere com o da fatura. Não foi baixada."
                : "Serviço indisponível ou credencial recusada. Veja Admin → Saúde.",
        });
      } else if (outcome.status === "voided_invoice_paid") {
        notify({ variant: "error", title: "Pagamento aprovado para fatura anulada.", description: "Reative a empresa e/ou estorne no Mercado Pago." });
      } else {
        notify({ variant: "info", title: "Nada a conferir nesta fatura." });
      }
    });
  }

  function openMarkPaid(invoice: InvoiceRow) {
    setMarkPaidTarget({ invoice });
    setReason("");
    setDialogError(null);
  }

  function handleMarkPaid(e: React.FormEvent) {
    e.preventDefault();
    if (!markPaidTarget) return;
    setDialogError(null);
    if (reason.trim().length < 3) {
      setDialogError("Informe um motivo com pelo menos 3 caracteres.");
      return;
    }
    startTransition(async () => {
      const result = await markInvoicePaidManuallyAction(markPaidTarget.invoice.id, { reason });
      if (!result.ok) {
        setDialogError(result.error.message);
        return;
      }
      setItems((prev) =>
        prev.map((i) => (i.id === markPaidTarget.invoice.id ? { ...i, status: "PAID", paidAt: new Date().toISOString() } : i)),
      );
      notify({
        variant: "success",
        title: result.data.alreadyProcessed ? "Esta fatura já estava paga." : "Fatura marcada como paga.",
      });
      setMarkPaidTarget(null);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        icon={navIconFor("admin/cobranca")}
        title="Cobranças"
        description="Faturas de todas as empresas, totais do mês e inadimplência."
        action={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="secondary">
              <Link href="/admin/financeiro">
                <Wallet className="h-4 w-4 shrink-0" aria-hidden="true" />
                Financeiro
              </Link>
            </Button>
            <Button asChild variant="secondary">
              <Link href="/admin/envios">
                <Send className="h-4 w-4 shrink-0" aria-hidden="true" />
                Envios de cobrança
              </Link>
            </Button>
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatBlock icon={<Banknote aria-hidden="true" />} label="Recebido no mês" value={formatCentsBRL(totals.receivedCents)} tone="success" />
        <StatBlock icon={<ReceiptText aria-hidden="true" />} label="Em aberto" value={formatCentsBRL(totals.openCents)} tone="warning" />
        <StatBlock icon={<AlertTriangle aria-hidden="true" />} label="Vencido" value={formatCentsBRL(totals.overdueCents)} tone="danger" />
        <StatBlock icon={<FlaskConical aria-hidden="true" />} label="Em teste" value={formatCentsBRL(totals.trialCents)} tone="primary" />
        <StatBlock icon={<TrendingUp aria-hidden="true" />} label="MRR estimado" value={formatCentsBRL(totals.mrrCents)} tone="primary" />
      </div>

      {delinquents.length > 0 ? (
        <Card className="rounded-hero">
          <CardHeader>
            <CardTitle>Inadimplentes</CardTitle>
            <CardDescription>Empresas com assinatura atrasada ou suspensa por falta de pagamento.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {delinquents.map((company) => (
              <div key={company.tenantId} className="flex items-center justify-between gap-3 rounded-card border border-border p-3">
                <div className="flex items-center gap-2.5">
                  <Avatar id={company.tenantId} name={company.name} size="sm" />
                  <div>
                    <p className="text-sm font-medium text-text">{company.name}</p>
                    <p className="text-xs text-text-secondary">/{company.slug}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={company.status === "SUSPENDED" ? "danger" : "warning"}>
                    {company.status === "SUSPENDED" ? "Suspensa" : "Fatura atrasada"}
                  </Badge>
                  <span className="text-xs text-text-secondary">
                    {company.daysOverdue} dia{company.daysOverdue === 1 ? "" : "s"} de atraso
                  </span>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card className="rounded-hero">
        <CardContent className="p-4">
          <div className="grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[10rem_10rem_10rem_minmax(0,1fr)_auto]">
          <Field label="Status">
            {(fieldProps) => (
              <Select
                {...fieldProps}
                className="w-full"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as InvoiceRow["status"] | "")}
              >
                <option value="">Todos</option>
                <option value="OPEN">Aberta</option>
                <option value="PAID">Paga</option>
                <option value="EXPIRED">Expirada</option>
                <option value="VOID">Anulada</option>
              </Select>
            )}
          </Field>
          <Field label="Vencimento de">
            {(fieldProps) => <Input {...fieldProps} type="date" className="w-full" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />}
          </Field>
          <Field label="Vencimento até">
            {(fieldProps) => <Input {...fieldProps} type="date" className="w-full" value={toDate} onChange={(e) => setToDate(e.target.value)} />}
          </Field>
          <Field label="Empresa">
            {(fieldProps) => (
              <Input
                {...fieldProps}
                className="w-full"
                value={companyFilter}
                onChange={(e) => setCompanyFilter(e.target.value)}
                placeholder="Nome da empresa"
              />
            )}
          </Field>
          <Button icon={Filter} type="button" variant="secondary" onClick={applyFilters} isLoading={isPending} className="w-full sm:col-span-2 lg:col-span-1 lg:w-auto" loadingText="Filtrando…">
              Filtrar
            </Button>
          </div>
          <p className="mt-3 text-xs text-text-secondary">
            Datas filtram pelo vencimento. O campo Empresa filtra só a página já carregada, por nome ou identificador.
          </p>
        </CardContent>
      </Card>

      {filteredItems.length === 0 ? (
        <EmptyState icon={ReceiptText} title="Nenhuma fatura encontrada" description="Ajuste os filtros para ver outras faturas." />
      ) : (
        <Card className="rounded-hero">
          <Table>
            <TableHead>
              <TableRow>
                <TableHeadCell>Empresa</TableHeadCell>
                <TableHeadCell>Valor</TableHeadCell>
                <TableHeadCell>Status</TableHeadCell>
                <TableHeadCell>Vencimento</TableHeadCell>
                <TableHeadCell>Pago em</TableHeadCell>
                <TableHeadCell className="text-right">Ações</TableHeadCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredItems.map((invoice) => (
                <TableRow key={invoice.id}>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <Avatar id={invoice.tenantId} name={invoice.tenantName} size="sm" />
                      <div>
                        <p className="font-medium text-text">{invoice.tenantName}</p>
                        <p className="text-xs text-text-secondary">/{invoice.tenantSlug}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="tabular-nums">
                    {formatCentsBRL(invoice.amountCents)}
                    {invoice.cycle !== "MONTHLY" ? <Badge variant="neutral" className="ml-1.5">{cycleTitle(invoice.cycle)}</Badge> : null}
                    {invoice.discountCents > 0 ? (
                      <span className="block text-xs text-text-secondary">cupom {invoice.couponCode ?? ""}: -{formatCentsBRL(invoice.discountCents)}</span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      <Badge variant={STATUS_BADGE[invoice.status]}>{STATUS_LABEL[invoice.status]}</Badge>
                      {invoice.kind === "TRIAL" && invoice.status !== "PAID" ? <Badge variant="neutral">Teste</Badge> : null}
                      {invoice.status === "OPEN" && !invoice.hasPix ? (
                        <span title="Sem Pix gerado" className="text-text-secondary">
                          <QrCode className="h-3.5 w-3.5" aria-hidden="true" />
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>{formatDateBR(new Date(invoice.dueAt))}</TableCell>
                  <TableCell>{invoice.paidAt ? formatDateBR(new Date(invoice.paidAt)) : "—"}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {invoice.status === "OPEN" ? (
                        <>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Regerar Pix da fatura de ${invoice.tenantName}`}
                            title="Regerar Pix"
                            onClick={() => handleRegeneratePix(invoice)}
                            disabled={isPending}
                          >
                            {regeneratingId === invoice.id ? (
                              <Spinner />
                            ) : (
                              <QrCode className="h-4 w-4" aria-hidden="true" />
                            )}
                          </Button>
                          {invoice.hasMpPayment ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`Conferir no Mercado Pago a fatura de ${invoice.tenantName}`}
                              title="Conferir no Mercado Pago"
                              onClick={() => handleReconcile(invoice)}
                              disabled={isPending}
                            >
                              {checkingId === invoice.id ? <Spinner /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
                            </Button>
                          ) : null}
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Marcar como paga a fatura de ${invoice.tenantName}`}
                            title="Marcar como paga manualmente"
                            onClick={() => openMarkPaid(invoice)}
                            disabled={isPending}
                          >
                            <Check className="h-4 w-4" aria-hidden="true" />
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <Pagination
        label="Paginação das faturas"
        page={paging.page}
        pageSize={paging.pageSize}
        totalItems={paging.totalItems}
        totalPages={paging.totalPages}
        isPending={isPending}
        onPageChange={(p) => loadInvoices(appliedFilters, p, paging.pageSize)}
        onPageSizeChange={(size) => loadInvoices(appliedFilters, 1, size)}
      />

      <Dialog open={!!markPaidTarget} onOpenChange={(open) => !open && setMarkPaidTarget(null)}>
        <DialogContent>
          <DialogHeader icon={navIconFor("admin/cobranca")} tone="warning">
            <DialogTitle>Marcar fatura como paga manualmente</DialogTitle>
            <DialogDescription>
              Isso marca a fatura de &ldquo;{markPaidTarget?.invoice.tenantName}&rdquo; ({markPaidTarget ? formatCentsBRL(markPaidTarget.invoice.amountCents) : ""})
              como paga, avança o ciclo de cobrança e reativa a assinatura se estiver suspensa. Esta ação fica registrada com seu usuário e o
              motivo abaixo. Use só para pagamentos confirmados fora do Pix.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleMarkPaid} className="mt-4 flex flex-col gap-4">
            {dialogError ? <Alert variant="danger">{dialogError}</Alert> : null}
            <Field label="Motivo da baixa manual" required hint="Explique como o pagamento foi confirmado (ex.: transferência, depósito).">
              {(fieldProps) => (
                <Textarea
                  {...fieldProps}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  maxLength={500}
                  required
                  placeholder="Ex.: cliente pagou por transferência bancária, comprovante recebido por e-mail em 28/09."
                />
              )}
            </Field>
            <DialogFooter>
              <Button icon={X} type="button" variant="secondary" onClick={() => setMarkPaidTarget(null)}>
                Cancelar
              </Button>
              <Button icon={Check} type="submit" variant="danger" isLoading={isPending} loadingText="Confirmando…">
                Confirmar baixa manual
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
