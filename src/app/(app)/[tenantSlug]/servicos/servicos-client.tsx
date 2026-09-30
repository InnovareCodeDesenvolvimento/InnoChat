"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Check, Pencil, Plus, Scissors, Trash2, X } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { EmptyState } from "@/components/ui/empty-state";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import {
  createServiceAction,
  deleteServiceAction,
  updateServiceAction,
} from "@/modules/agenda/catalog-actions";

export type ServiceRow = {
  id: string;
  name: string;
  durationMin: number;
  bufferAfterMin: number;
  priceCents: number | null;
  active: boolean;
  sortOrder: number;
};

function formatPrice(cents: number | null): string {
  if (cents === null) return "—";
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

type FormState = {
  name: string;
  durationMin: string;
  bufferAfterMin: string;
  priceReais: string;
  active: boolean;
  sortOrder: string;
};

const EMPTY_FORM: FormState = {
  name: "",
  durationMin: "30",
  bufferAfterMin: "0",
  priceReais: "",
  active: true,
  sortOrder: "0",
};

const WRITE_BLOCKED_HINT = "Assinatura suspensa — ação bloqueada até o pagamento.";

export function ServicosClient({
  tenantSlug,
  initialServices,
  writeBlocked = false,
}: {
  tenantSlug: string;
  initialServices: ServiceRow[];
  writeBlocked?: boolean;
}) {
  const [services, setServices] = useState<ServiceRow[]>(initialServices);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ServiceRow | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ServiceRow | null>(null);
  const [isPending, startTransition] = useTransition();
  const { notify } = useToast();

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setDialogOpen(true);
  }

  function openEdit(service: ServiceRow) {
    setEditing(service);
    setForm({
      name: service.name,
      durationMin: String(service.durationMin),
      bufferAfterMin: String(service.bufferAfterMin),
      priceReais: service.priceCents !== null ? (service.priceCents / 100).toFixed(2) : "",
      active: service.active,
      sortOrder: String(service.sortOrder),
    });
    setFormError(null);
    setDialogOpen(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    const durationMin = Number(form.durationMin);
    const bufferAfterMin = Number(form.bufferAfterMin) || 0;
    const sortOrder = Number(form.sortOrder) || 0;
    const priceCents = form.priceReais.trim() === "" ? null : Math.round(Number(form.priceReais.replace(",", ".")) * 100);

    const payload = {
      name: form.name.trim(),
      durationMin,
      bufferAfterMin,
      priceCents,
      active: form.active,
      sortOrder,
    };

    startTransition(async () => {
      const result = editing
        ? await updateServiceAction(tenantSlug, editing.id, payload)
        : await createServiceAction(tenantSlug, payload);

      if (!result.ok) {
        setFormError(result.error.message);
        return;
      }

      const saved = result.data as ServiceRow;
      setServices((prev) => {
        if (editing) return prev.map((s) => (s.id === saved.id ? saved : s));
        return [...prev, saved].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
      });
      setDialogOpen(false);
      notify({ variant: "success", title: editing ? "Serviço atualizado." : "Serviço criado." });
    });
  }

  function handleDelete() {
    if (!confirmDelete) return;
    const target = confirmDelete;
    startTransition(async () => {
      const result = await deleteServiceAction(tenantSlug, target.id);
      if (!result.ok) {
        if (result.error.code === "HAS_APPOINTMENTS") {
          notify({
            variant: "error",
            title: "Não é possível excluir",
            description: "Este serviço tem agendamentos. Desative-o em vez de excluir.",
          });
        } else {
          notify({ variant: "error", title: "Não foi possível excluir", description: result.error.message });
        }
        setConfirmDelete(null);
        return;
      }
      setServices((prev) => prev.filter((s) => s.id !== target.id));
      notify({ variant: "success", title: "Serviço excluído." });
      setConfirmDelete(null);
    });
  }

  function toggleActive(service: ServiceRow) {
    startTransition(async () => {
      const result = await updateServiceAction(tenantSlug, service.id, { active: !service.active });
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível atualizar", description: result.error.message });
        return;
      }
      const saved = result.data as ServiceRow;
      setServices((prev) => prev.map((s) => (s.id === saved.id ? saved : s)));
      notify({ variant: "success", title: saved.active ? "Serviço ativado." : "Serviço desativado." });
    });
  }

  return (
    <div>
      <PageHeader help="pagina.servicos" icon={navIconFor("servicos")}
        title="Serviços"
        description="Nome, duração, intervalo, preço opcional e ordem."
        action={
          <Button onClick={openCreate} disabled={writeBlocked} title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Novo serviço
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

      {services.length === 0 ? (
        <EmptyState
          icon={Scissors}
          title="Nenhum serviço cadastrado ainda"
          description="Crie o primeiro serviço para começar a montar a agenda."
          action={
            <Button icon={Plus} onClick={openCreate} disabled={writeBlocked} title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}>
              Novo serviço
            </Button>
          }
        />
      ) : (
        <>
          <Card className="hidden rounded-hero md:block">
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeadCell>Nome</TableHeadCell>
                  <TableHeadCell>Duração</TableHeadCell>
                  <TableHeadCell>Intervalo</TableHeadCell>
                  <TableHeadCell>Preço</TableHeadCell>
                  <TableHeadCell>Status</TableHeadCell>
                  <TableHeadCell className="text-right">Ações</TableHeadCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {services.map((service) => (
                  <TableRow key={service.id}>
                    <TableCell className="font-medium">{service.name}</TableCell>
                    <TableCell>{service.durationMin} min</TableCell>
                    <TableCell>{service.bufferAfterMin > 0 ? `${service.bufferAfterMin} min` : "—"}</TableCell>
                    <TableCell>{formatPrice(service.priceCents)}</TableCell>
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => toggleActive(service)}
                        disabled={isPending || writeBlocked}
                        className="cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
                        title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}
                        aria-label={service.active ? `Desativar ${service.name}` : `Ativar ${service.name}`}
                      >
                        <Badge variant={service.active ? "success" : "neutral"}>
                          {service.active ? "Ativo" : "Inativo"}
                        </Badge>
                      </button>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Editar ${service.name}`}
                          onClick={() => openEdit(service)}
                          disabled={writeBlocked}
                          title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}
                        >
                          <Pencil className="h-4 w-4" aria-hidden="true" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Excluir ${service.name}`}
                          onClick={() => setConfirmDelete(service)}
                          disabled={writeBlocked}
                          title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}
                        >
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          <div className="flex flex-col gap-3 md:hidden">
            {services.map((service) => (
              <Card key={service.id} className="rounded-hero p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium text-text">{service.name}</p>
                  <button
                    type="button"
                    onClick={() => toggleActive(service)}
                    disabled={isPending || writeBlocked}
                    className="cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
                    title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}
                    aria-label={service.active ? `Desativar ${service.name}` : `Ativar ${service.name}`}
                  >
                    <Badge variant={service.active ? "success" : "neutral"}>
                      {service.active ? "Ativo" : "Inativo"}
                    </Badge>
                  </button>
                </div>
                <p className="mt-1 text-sm text-text-secondary">
                  {service.durationMin} min
                  {service.bufferAfterMin > 0 ? ` · ${service.bufferAfterMin} min de intervalo` : ""} ·{" "}
                  {formatPrice(service.priceCents)}
                </p>
                <div className="mt-3 flex justify-end gap-1 border-t border-border pt-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openEdit(service)}
                    disabled={writeBlocked}
                    title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                    Editar
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmDelete(service)}
                    disabled={writeBlocked}
                    title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}
                    className="text-danger hover:bg-danger-bg"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    Excluir
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader icon={navIconFor("servicos")}>
            <DialogTitle>{editing ? "Editar serviço" : "Novo serviço"}</DialogTitle>
            <DialogDescription>Duração e intervalo entram no cálculo dos horários livres.</DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4">
            {formError ? (
              <p role="alert" className="text-sm text-danger">
                {formError}
              </p>
            ) : null}

            <Field label="Nome" required>
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  required
                  maxLength={120}
                />
              )}
            </Field>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Duração (min)" required>
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    type="number"
                    min={5}
                    max={1440}
                    value={form.durationMin}
                    onChange={(e) => setForm((f) => ({ ...f, durationMin: e.target.value }))}
                    required
                  />
                )}
              </Field>
              <Field label="Intervalo após (min)" hint="Tempo de folga depois do atendimento.">
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    type="number"
                    min={0}
                    max={1440}
                    value={form.bufferAfterMin}
                    onChange={(e) => setForm((f) => ({ ...f, bufferAfterMin: e.target.value }))}
                  />
                )}
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Preço (R$)" hint="Deixe em branco para não mostrar preço.">
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    inputMode="decimal"
                    placeholder="0,00"
                    value={form.priceReais}
                    onChange={(e) => setForm((f) => ({ ...f, priceReais: e.target.value }))}
                  />
                )}
              </Field>
              <Field label="Ordem de exibição">
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    type="number"
                    value={form.sortOrder}
                    onChange={(e) => setForm((f) => ({ ...f, sortOrder: e.target.value }))}
                  />
                )}
              </Field>
            </div>

            <label className="flex items-center gap-2 text-sm text-text">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              Ativo (aparece para agendamento)
            </label>

            <DialogFooter>
              <Button icon={X} type="button" variant="secondary" onClick={() => setDialogOpen(false)}>
                Cancelar
              </Button>
              <Button icon={Check} type="submit" isLoading={isPending}>
                {editing ? "Salvar" : "Criar"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirmDelete} onOpenChange={(open) => !open && setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader icon={Trash2} tone="danger">
            <DialogTitle>Excluir serviço</DialogTitle>
            <DialogDescription>
              Tem certeza que quer excluir &ldquo;{confirmDelete?.name}&rdquo;? Essa ação não pode ser desfeita.
            </DialogDescription>
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
