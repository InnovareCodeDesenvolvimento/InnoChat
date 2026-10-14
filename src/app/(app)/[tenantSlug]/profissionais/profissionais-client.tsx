"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Check, Plus, Trash2, UserRound, X } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { EmptyState } from "@/components/ui/empty-state";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Avatar } from "@/components/ui/avatar";
import { Table, TableBody, TableCell, TableHead, TableHeadCell, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import { SupportModeBadge } from "@/components/support/SupportModeBadge";
import { useToast } from "@/components/ui/toast";
import {
  createProfessionalAction,
  deleteProfessionalAction,
  updateProfessionalAction,
} from "@/modules/agenda/catalog-actions";

export type ProfessionalRow = {
  id: string;
  name: string;
  active: boolean;
  sortOrder: number;
  professionalServices: { serviceId: string }[];
  workingHours: { id: string; weekday: number; startTime: string; endTime: string }[];
};

const WRITE_BLOCKED_HINT = "Assinatura suspensa: só dá para alterar depois do pagamento.";

export function ProfissionaisClient({
  tenantSlug,
  initialProfessionals,
  writeBlocked = false,
  isSupportImpersonation = false,
  defaultDialogOpen = false,
}: {
  tenantSlug: string;
  initialProfessionals: ProfessionalRow[];
  writeBlocked?: boolean;
  isSupportImpersonation?: boolean;
  /** Estado aberto inicial do diálogo de criação (útil em testes SSR) */
  defaultDialogOpen?: boolean;
}) {
  const [professionals, setProfessionals] = useState<ProfessionalRow[]>(initialProfessionals);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [dialogOpen, setDialogOpen] = useState(defaultDialogOpen);
  const [name, setName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ProfessionalRow | null>(null);
  const [isPending, startTransition] = useTransition();
  const { notify } = useToast();

  function openCreate() {
    setName("");
    setFormError(null);
    setDialogOpen(true);
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    startTransition(async () => {
      const result = await createProfessionalAction(tenantSlug, { name: name.trim() });
      if (!result.ok) {
        setFormError(result.error.message);
        return;
      }
      const created = result.data as Omit<ProfessionalRow, "professionalServices" | "workingHours">;
      setProfessionals((prev) =>
        [...prev, { ...created, professionalServices: [], workingHours: [] }].sort(
          (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
        ),
      );
      setDialogOpen(false);
      notify({ variant: "success", title: "Profissional criado.", description: "Agora defina o expediente e os serviços dele." });
    });
  }

  const totalItems = professionals.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const effectivePage = Math.min(page, totalPages);
  const pagedProfessionals = professionals.slice((effectivePage - 1) * pageSize, effectivePage * pageSize);

  function toggleActive(professional: ProfessionalRow) {
    startTransition(async () => {
      const result = await updateProfessionalAction(tenantSlug, professional.id, { active: !professional.active });
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível atualizar", description: result.error.message });
        return;
      }
      setProfessionals((prev) =>
        prev.map((p) => (p.id === professional.id ? { ...p, active: !professional.active } : p)),
      );
      notify({ variant: "success", title: !professional.active ? "Profissional ativado." : "Profissional desativado." });
    });
  }

  function handleDelete() {
    if (!confirmDelete) return;
    const target = confirmDelete;
    startTransition(async () => {
      const result = await deleteProfessionalAction(tenantSlug, target.id);
      if (!result.ok) {
        if (result.error.code === "HAS_APPOINTMENTS") {
          notify({
            variant: "error",
            title: "Não é possível excluir",
            description: "Este profissional tem agendamentos. Desative-o em vez de excluir.",
          });
        } else {
          notify({ variant: "error", title: "Não foi possível excluir", description: result.error.message });
        }
        setConfirmDelete(null);
        return;
      }
      setProfessionals((prev) => prev.filter((p) => p.id !== target.id));
      notify({ variant: "success", title: "Profissional excluído." });
      setConfirmDelete(null);
    });
  }

  return (
    <div>
      <PageHeader
        help="pagina.profissionais"
        icon={navIconFor("profissionais")}
        title="Profissionais"
        description="Expediente semanal e serviços de cada um."
        badge={<SupportModeBadge isSupportImpersonation={isSupportImpersonation} />}
        action={
          <Button onClick={openCreate} disabled={writeBlocked} title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Novo profissional
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

      {professionals.length === 0 ? (
        <EmptyState
          icon={UserRound}
          title="Nenhum profissional cadastrado ainda"
          description="Crie o primeiro profissional para definir expediente e serviços."
          action={
            <Button icon={Plus} onClick={openCreate} disabled={writeBlocked} title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}>
              Novo profissional
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
                  <TableHeadCell>Serviços</TableHeadCell>
                  <TableHeadCell>Expediente</TableHeadCell>
                  <TableHeadCell>Status</TableHeadCell>
                  <TableHeadCell className="text-right">Ações</TableHeadCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {pagedProfessionals.map((professional) => (
                  <TableRow key={professional.id}>
                    <TableCell className="font-medium">
                      <Link
                        href={`/${tenantSlug}/profissionais/${professional.id}`}
                        className="flex items-center gap-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      >
                        <Avatar id={professional.id} name={professional.name} size="sm" />
                        {professional.name}
                      </Link>
                    </TableCell>
                    <TableCell>{professional.professionalServices.length}</TableCell>
                    <TableCell>
                      {professional.workingHours.length > 0
                        ? `${new Set(professional.workingHours.map((h) => h.weekday)).size} dia(s)`
                        : "Não definido"}
                    </TableCell>
                    <TableCell>
                      <button
                        type="button"
                        onClick={() => toggleActive(professional)}
                        disabled={isPending || writeBlocked}
                        className="cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
                        title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}
                        aria-label={professional.active ? `Desativar ${professional.name}` : `Ativar ${professional.name}`}
                      >
                        <Badge variant={professional.active ? "success" : "neutral"}>
                          {professional.active ? "Ativo" : "Inativo"}
                        </Badge>
                      </button>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" asChild>
                          <Link href={`/${tenantSlug}/profissionais/${professional.id}`}>Editar</Link>
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Excluir ${professional.name}`}
                          onClick={() => setConfirmDelete(professional)}
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
            {pagedProfessionals.map((professional) => (
              <Card key={professional.id} className="rounded-hero p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link
                    href={`/${tenantSlug}/profissionais/${professional.id}`}
                    className="flex items-center gap-2 font-medium text-text hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                  >
                    <Avatar id={professional.id} name={professional.name} size="sm" />
                    {professional.name}
                  </Link>
                  <button
                    type="button"
                    onClick={() => toggleActive(professional)}
                    disabled={isPending || writeBlocked}
                    className="cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
                    title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}
                    aria-label={professional.active ? `Desativar ${professional.name}` : `Ativar ${professional.name}`}
                  >
                    <Badge variant={professional.active ? "success" : "neutral"}>
                      {professional.active ? "Ativo" : "Inativo"}
                    </Badge>
                  </button>
                </div>
                <p className="mt-1 text-sm text-text-secondary">
                  {professional.professionalServices.length} serviço(s) ·{" "}
                  {professional.workingHours.length > 0
                    ? `${new Set(professional.workingHours.map((h) => h.weekday)).size} dia(s) de expediente`
                    : "expediente não definido"}
                </p>
                <div className="mt-3 flex justify-end gap-1 border-t border-border pt-3">
                  <Button variant="ghost" size="sm" asChild>
                    <Link href={`/${tenantSlug}/profissionais/${professional.id}`}>Editar</Link>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConfirmDelete(professional)}
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

          <Pagination
            page={effectivePage}
            pageSize={pageSize}
            totalItems={totalItems}
            totalPages={totalPages}
            onPageChange={setPage}
            onPageSizeChange={(newSize) => {
              setPageSize(newSize);
              setPage(1);
            }}
            label="Paginação dos profissionais"
            className="mt-4"
          />
        </>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent container={null}>
          <DialogHeader icon={navIconFor("profissionais")}>
            <DialogTitle>Novo profissional</DialogTitle>
            <DialogDescription>Depois de criar, defina os serviços e o expediente dele.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreate} className="mt-4 flex flex-col gap-4">
            {formError ? (
              <p role="alert" className="text-sm text-danger">
                {formError}
              </p>
            ) : null}
            <Field label="Nome" required helpKey="catalogo.profissionalNome">
              {(fieldProps) => (
                <Input {...fieldProps} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} />
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
            <DialogTitle>Excluir profissional</DialogTitle>
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
