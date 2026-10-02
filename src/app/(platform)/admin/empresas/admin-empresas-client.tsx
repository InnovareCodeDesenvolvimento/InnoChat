"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Ban, CalendarPlus, ReceiptText, RotateCcw, Timer, X } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { Card } from "@/components/ui/card";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { Pagination } from "@/components/ui/pagination";
import { useToast } from "@/components/ui/toast";
import { formatDateTimeLabel } from "@/components/lib/format-date";
import {
  extendTrialAction,
  listCompaniesAction,
  reactivateCompanyAction,
  suspendCompanyAction,
} from "@/modules/billing/admin-actions";

export type CompanyRow = {
  tenantId: string;
  slug: string;
  name: string;
  planCode: string;
  persistedStatus: string;
  effectiveStatus: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string;
};

const STATUS_BADGE: Record<string, "primary" | "success" | "warning" | "danger" | "neutral"> = {
  TRIALING: "primary",
  ACTIVE: "success",
  PAST_DUE: "warning",
  SUSPENDED: "danger",
  CANCELED: "neutral",
};

const STATUS_LABEL: Record<string, string> = {
  TRIALING: "Em teste",
  ACTIVE: "Ativa",
  PAST_DUE: "Fatura atrasada",
  SUSPENDED: "Suspensa",
  CANCELED: "Cancelada",
};

type ConfirmAction = { type: "suspend" | "reactivate"; company: CompanyRow };

type Paging = { page: number; pageSize: number; totalItems: number; totalPages: number };

export function AdminEmpresasClient({
  initialItems,
  initialPaging,
}: {
  initialItems: CompanyRow[];
  initialPaging: Paging;
}) {
  const { notify } = useToast();
  const [items, setItems] = useState<CompanyRow[]>(initialItems);
  const [paging, setPaging] = useState<Paging>(initialPaging);
  const [isPending, startTransition] = useTransition();
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [extendTarget, setExtendTarget] = useState<CompanyRow | null>(null);
  const [extraDays, setExtraDays] = useState("1");
  const [dialogError, setDialogError] = useState<string | null>(null);

  function goToPage(page: number, pageSize: number) {
    startTransition(async () => {
      const result = await listCompaniesAction({ page, pageSize });
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível carregar as empresas", description: result.error.message });
        return;
      }
      const mapped = result.data.items.map((item) => ({
        ...item,
        trialEndsAt: item.trialEndsAt ? new Date(item.trialEndsAt).toISOString() : null,
        currentPeriodEnd: new Date(item.currentPeriodEnd).toISOString(),
      }));
      setItems(mapped);
      setPaging({ page: result.data.page, pageSize: result.data.pageSize, totalItems: result.data.totalItems, totalPages: result.data.totalPages });
    });
  }

  function handleConfirm() {
    if (!confirmAction) return;
    const { type, company } = confirmAction;
    startTransition(async () => {
      const result =
        type === "suspend" ? await suspendCompanyAction(company.tenantId) : await reactivateCompanyAction(company.tenantId);
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível concluir", description: result.error.message });
        setConfirmAction(null);
        return;
      }
      setItems((prev) =>
        prev.map((c) =>
          c.tenantId === company.tenantId
            ? { ...c, persistedStatus: type === "suspend" ? "SUSPENDED" : "ACTIVE", effectiveStatus: type === "suspend" ? "SUSPENDED" : "ACTIVE" }
            : c,
        ),
      );
      notify({ variant: "success", title: type === "suspend" ? "Empresa suspensa." : "Empresa reativada." });
      setConfirmAction(null);
    });
  }

  function openExtend(company: CompanyRow) {
    setExtendTarget(company);
    setExtraDays("1");
    setDialogError(null);
  }

  function handleExtend(e: React.FormEvent) {
    e.preventDefault();
    if (!extendTarget) return;
    setDialogError(null);
    const days = Number(extraDays);
    if (!Number.isInteger(days) || days < 1 || days > 30) {
      setDialogError("Informe um número de dias entre 1 e 30.");
      return;
    }
    startTransition(async () => {
      const result = await extendTrialAction(extendTarget.tenantId, { extraDays: days });
      if (!result.ok) {
        setDialogError(result.error.message);
        return;
      }
      notify({ variant: "success", title: `Trial estendido em ${days} dia(s).` });
      setExtendTarget(null);
    });
  }

  return (
    <div>
      <PageHeader icon={navIconFor("admin/empresas")} title="Empresas" description="Status da assinatura, limites e trial de cada empresa." />

      <Card className="rounded-hero">
        <Table>
          <TableHead>
            <TableRow>
              <TableHeadCell>Empresa</TableHeadCell>
              <TableHeadCell>Plano</TableHeadCell>
              <TableHeadCell>Status</TableHeadCell>
              <TableHeadCell>Vencimento</TableHeadCell>
              <TableHeadCell className="text-right">Ações</TableHeadCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {items.map((company) => (
              <TableRow key={company.tenantId}>
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <Avatar id={company.tenantId} name={company.name} size="sm" />
                    <div>
                      <Link
                        href={`/admin/empresas/${company.tenantId}`}
                        className="font-medium text-text hover:text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      >
                        {company.name}
                      </Link>
                      <p className="text-xs text-text-secondary">/{company.slug}</p>
                    </div>
                  </div>
                </TableCell>
                <TableCell>{company.planCode}</TableCell>
                <TableCell>
                  <Badge variant={STATUS_BADGE[company.effectiveStatus] ?? "neutral"}>
                    {STATUS_LABEL[company.effectiveStatus] ?? company.effectiveStatus}
                  </Badge>
                  {company.persistedStatus !== company.effectiveStatus ? (
                    <p className="mt-1 text-xs text-text-secondary">
                      Banco ainda mostra &ldquo;{STATUS_LABEL[company.persistedStatus] ?? company.persistedStatus}&rdquo; até o
                      próximo ciclo de verificação.
                    </p>
                  ) : null}
                </TableCell>
                <TableCell>
                  {company.effectiveStatus === "TRIALING" && company.trialEndsAt
                    ? formatDateTimeLabel(company.trialEndsAt, "America/Sao_Paulo")
                    : formatDateTimeLabel(company.currentPeriodEnd, "America/Sao_Paulo")}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button asChild variant="ghost" size="icon">
                      <Link href={`/admin/empresas/${company.tenantId}`} aria-label={`Ver cobrança de ${company.name}`} title="Ver cobrança">
                        <ReceiptText className="h-4 w-4" aria-hidden="true" />
                      </Link>
                    </Button>
                    {company.effectiveStatus === "TRIALING" ? (
                      <Button variant="ghost" size="icon" aria-label={`Estender trial de ${company.name}`} onClick={() => openExtend(company)}>
                        <Timer className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    ) : null}
                    {company.effectiveStatus === "SUSPENDED" || company.effectiveStatus === "PAST_DUE" ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Reativar ${company.name}`}
                        onClick={() => setConfirmAction({ type: "reactivate", company })}
                      >
                        <RotateCcw className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    ) : null}
                    {company.effectiveStatus !== "SUSPENDED" && company.effectiveStatus !== "CANCELED" ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Suspender ${company.name}`}
                        onClick={() => setConfirmAction({ type: "suspend", company })}
                      >
                        <Ban className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Pagination
        label="Paginação das empresas"
        page={paging.page}
        pageSize={paging.pageSize}
        totalItems={paging.totalItems}
        totalPages={paging.totalPages}
        isPending={isPending}
        onPageChange={(p) => goToPage(p, paging.pageSize)}
        onPageSizeChange={(size) => goToPage(1, size)}
        className="mt-4"
      />

      <Dialog open={!!confirmAction} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <DialogContent>
          <DialogHeader icon={confirmAction?.type === "suspend" ? Ban : RotateCcw} tone={confirmAction?.type === "suspend" ? "danger" : "primary"}>
            <DialogTitle>{confirmAction?.type === "suspend" ? "Suspender empresa" : "Reativar empresa"}</DialogTitle>
            <DialogDescription>
              {confirmAction?.type === "suspend"
                ? `Isso deixa o painel de "${confirmAction.company.name}" somente leitura e desliga o bot no WhatsApp imediatamente. Tem certeza?`
                : `Isso reativa "${confirmAction?.company.name}" com um novo ciclo de 1 mês a partir de hoje. Tem certeza?`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button icon={X} type="button" variant="secondary" onClick={() => setConfirmAction(null)}>
              Cancelar
            </Button>
            <Button
              icon={confirmAction?.type === "suspend" ? Ban : RotateCcw}
              type="button"
              variant={confirmAction?.type === "suspend" ? "danger" : "primary"}
              onClick={handleConfirm}
              isLoading={isPending}
             loadingText="Confirmando…">
              Confirmar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!extendTarget} onOpenChange={(open) => !open && setExtendTarget(null)}>
        <DialogContent>
          <DialogHeader icon={CalendarPlus}>
            <DialogTitle>Estender trial</DialogTitle>
            <DialogDescription>
              Adiciona dias ao teste de &ldquo;{extendTarget?.name}&rdquo;. Só é possível enquanto a empresa ainda está em teste.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleExtend} className="mt-4 flex flex-col gap-4">
            {dialogError ? <Alert variant="danger">{dialogError}</Alert> : null}
            <Field label="Dias extras" required hint="Entre 1 e 30 dias.">
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  type="number"
                  min={1}
                  max={30}
                  value={extraDays}
                  onChange={(e) => setExtraDays(e.target.value)}
                  required
                />
              )}
            </Field>
            <DialogFooter>
              <Button icon={X} type="button" variant="secondary" onClick={() => setExtendTarget(null)}>
                Cancelar
              </Button>
              <Button icon={CalendarPlus} type="submit" isLoading={isPending} loadingText="Estendendo…">
                Estender
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
