"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { CalendarOff, Check, Plus, Trash2, X } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { EmptyState } from "@/components/ui/empty-state";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { formatDateTimeLabel } from "@/components/lib/format-date";
import { createScheduleExceptionAction, deleteScheduleExceptionAction } from "@/modules/agenda/catalog-actions";

export type CompanyExceptionRow = {
  id: string;
  type: "BLOCK" | "HOLIDAY";
  startsAt: string;
  endsAt: string;
  reason: string | null;
};

const TYPE_LABEL: Record<CompanyExceptionRow["type"], string> = {
  BLOCK: "Bloqueio",
  HOLIDAY: "Feriado/folga",
};

const WRITE_BLOCKED_HINT = "Assinatura suspensa: só dá para alterar depois do pagamento.";

type FormState = { type: "BLOCK" | "HOLIDAY"; startsAt: string; endsAt: string; reason: string };
const EMPTY_FORM: FormState = { type: "HOLIDAY", startsAt: "", endsAt: "", reason: "" };

export function BloqueiosClient({
  tenantSlug,
  timezone,
  initialExceptions,
  writeBlocked = false,
}: {
  tenantSlug: string;
  timezone: string;
  initialExceptions: CompanyExceptionRow[];
  writeBlocked?: boolean;
}) {
  const { notify } = useToast();
  const [exceptions, setExceptions] = useState<CompanyExceptionRow[]>(initialExceptions);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<CompanyExceptionRow | null>(null);
  const [isPending, startTransition] = useTransition();

  function openCreate() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setDialogOpen(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    if (!form.startsAt || !form.endsAt) {
      setFormError("Informe início e fim do período.");
      return;
    }
    if (new Date(form.endsAt).getTime() <= new Date(form.startsAt).getTime()) {
      setFormError("O fim precisa ser depois do início.");
      return;
    }

    startTransition(async () => {
      const result = await createScheduleExceptionAction(tenantSlug, {
        professionalId: null,
        type: form.type,
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: new Date(form.endsAt).toISOString(),
        reason: form.reason.trim() || null,
      });

      if (!result.ok) {
        setFormError(result.error.message);
        return;
      }

      const saved = result.data as CompanyExceptionRow;
      setExceptions((prev) => [...prev, saved].sort((a, b) => a.startsAt.localeCompare(b.startsAt)));
      setDialogOpen(false);
      notify({
        variant: "success",
        title: form.type === "HOLIDAY" ? "Feriado cadastrado." : "Bloqueio criado.",
        description: "Vale para todos os profissionais neste período.",
      });
    });
  }

  function handleDelete() {
    if (!confirmDelete) return;
    const target = confirmDelete;
    startTransition(async () => {
      const result = await deleteScheduleExceptionAction(tenantSlug, target.id);
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível excluir", description: result.error.message });
        setConfirmDelete(null);
        return;
      }
      setExceptions((prev) => prev.filter((e) => e.id !== target.id));
      notify({ variant: "success", title: "Excluído." });
      setConfirmDelete(null);
    });
  }

  return (
    <div>
      <PageHeader help="pagina.bloqueios" icon={navIconFor("configuracoes")}
        title="Bloqueios e feriados"
        description="Períodos em que a empresa inteira não atende. Vale para todos os profissionais, diferente do bloqueio individual em Profissionais."
        action={
          <Button onClick={openCreate} disabled={writeBlocked} title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Novo bloqueio/feriado
          </Button>
        }
      />

      {writeBlocked ? (
        <Alert variant="danger" className="mb-4">
          {WRITE_BLOCKED_HINT}{" "}
          <Link href={`/${tenantSlug}/assinatura`} className="font-medium underline">
            Ver assinatura
          </Link>
        </Alert>
      ) : null}

      {exceptions.length === 0 ? (
        <EmptyState
          icon={CalendarOff}
          variant="highlight"
          title="Nenhum bloqueio ou feriado cadastrado"
          description="Cadastre feriados e fechamentos que afetam todos os profissionais de uma vez, como um recesso de fim de ano."
          action={
            <Button icon={Plus} onClick={openCreate} disabled={writeBlocked} title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}>
              Novo bloqueio/feriado
            </Button>
          }
        />
      ) : (
        <Card className="rounded-hero">
          <CardHeader>
            <CardTitle>Períodos cadastrados</CardTitle>
            <CardDescription>Ordenados do mais próximo para o mais distante.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {exceptions.map((exc) => (
              <div
                key={exc.id}
                className="flex items-center justify-between gap-3 rounded-card border border-border p-3 transition-colors duration-150 hover:border-primary/20 hover:bg-primary/[0.03]"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <Badge variant={exc.type === "HOLIDAY" ? "warning" : "neutral"}>{TYPE_LABEL[exc.type]}</Badge>
                    <p className="text-sm text-text">
                      {formatDateTimeLabel(exc.startsAt, timezone)} até {formatDateTimeLabel(exc.endsAt, timezone)}
                    </p>
                  </div>
                  {exc.reason ? <p className="mt-1 text-xs text-text-secondary">{exc.reason}</p> : null}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Excluir"
                  onClick={() => setConfirmDelete(exc)}
                  disabled={writeBlocked}
                  title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader icon={CalendarOff}>
            <DialogTitle>Novo bloqueio/feriado da empresa</DialogTitle>
            <DialogDescription>
              Ninguém consegue agendar com nenhum profissional nesse período. Para bloquear só um
              profissional, use a tela de Profissionais.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4">
            {formError ? (
              <p role="alert" className="text-sm text-danger">
                {formError}
              </p>
            ) : null}
            <div>
              <Label htmlFor="company-block-type">Tipo</Label>
              <Select
                id="company-block-type"
                value={form.type}
                onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as "BLOCK" | "HOLIDAY" }))}
              >
                <option value="HOLIDAY">Feriado/folga</option>
                <option value="BLOCK">Bloqueio</option>
              </Select>
            </div>
            <Field label="Início" required>
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  type="datetime-local"
                  value={form.startsAt}
                  onChange={(e) => setForm((f) => ({ ...f, startsAt: e.target.value }))}
                  required
                />
              )}
            </Field>
            <Field label="Fim" required>
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  type="datetime-local"
                  value={form.endsAt}
                  onChange={(e) => setForm((f) => ({ ...f, endsAt: e.target.value }))}
                  required
                />
              )}
            </Field>
            <Field label="Motivo (opcional)">
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  value={form.reason}
                  onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))}
                  maxLength={255}
                  placeholder="Ex.: Recesso de fim de ano"
                />
              )}
            </Field>
            <DialogFooter>
              <Button icon={X} type="button" variant="secondary" onClick={() => setDialogOpen(false)}>
                Cancelar
              </Button>
              <Button icon={Check} type="submit" isLoading={isPending} loadingText="Criando…">
                Criar
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirmDelete} onOpenChange={(open) => !open && setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader icon={Trash2} tone="danger">
            <DialogTitle>Excluir</DialogTitle>
            <DialogDescription>Tem certeza? Essa ação não pode ser desfeita.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button icon={X} type="button" variant="secondary" onClick={() => setConfirmDelete(null)}>
              Cancelar
            </Button>
            <Button icon={Trash2} type="button" variant="danger" onClick={handleDelete} isLoading={isPending} loadingText="Excluindo…">
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
