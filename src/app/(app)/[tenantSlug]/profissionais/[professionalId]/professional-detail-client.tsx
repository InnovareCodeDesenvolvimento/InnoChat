"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { ArrowLeft, CalendarOff, Check, Plus, Trash2, X } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Field } from "@/components/ui/field";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Avatar } from "@/components/ui/avatar";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import {
  createScheduleExceptionAction,
  deleteScheduleExceptionAction,
  setProfessionalServicesAction,
  setProfessionalWorkingHoursAction,
  updateProfessionalAction,
} from "@/modules/agenda/catalog-actions";
import type { ProfessionalRow } from "../profissionais-client";
import type { ServiceRow } from "../../servicos/servicos-client";

const WEEKDAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

type WorkingHourRow = { id: string; weekday: number; startTime: string; endTime: string };
type ExceptionRow = {
  id: string;
  professionalId: string | null;
  type: "BLOCK" | "HOLIDAY";
  startsAt: string;
  endsAt: string;
  reason: string | null;
};

const WRITE_BLOCKED_HINT = "Assinatura suspensa: só dá para alterar depois do pagamento.";

export function ProfessionalDetailClient({
  tenantSlug,
  professional,
  allServices,
  initialExceptions,
  writeBlocked = false,
}: {
  tenantSlug: string;
  professional: ProfessionalRow;
  allServices: ServiceRow[];
  initialExceptions: ExceptionRow[];
  writeBlocked?: boolean;
}) {
  const { notify } = useToast();
  const [isPending, startTransition] = useTransition();

  // Dados básicos
  const [name, setName] = useState(professional.name);
  const [active, setActive] = useState(professional.active);

  // Serviços
  const [serviceIds, setServiceIds] = useState<Set<string>>(
    new Set(professional.professionalServices.map((s) => s.serviceId)),
  );

  // Expediente
  const [hours, setHours] = useState<WorkingHourRow[]>(
    professional.workingHours.map((h) => ({ ...h })),
  );

  // Bloqueios
  const [exceptions, setExceptions] = useState<ExceptionRow[]>(initialExceptions);
  const [blockDialogOpen, setBlockDialogOpen] = useState(false);
  const [blockForm, setBlockForm] = useState({
    type: "BLOCK" as "BLOCK" | "HOLIDAY",
    startsAt: "",
    endsAt: "",
    reason: "",
  });
  const [blockError, setBlockError] = useState<string | null>(null);

  function saveBasics(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const result = await updateProfessionalAction(tenantSlug, professional.id, { name: name.trim(), active });
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível salvar", description: result.error.message });
        return;
      }
      notify({ variant: "success", title: "Dados atualizados." });
    });
  }

  function toggleService(serviceId: string) {
    setServiceIds((prev) => {
      const next = new Set(prev);
      if (next.has(serviceId)) next.delete(serviceId);
      else next.add(serviceId);
      return next;
    });
  }

  function saveServices() {
    startTransition(async () => {
      const result = await setProfessionalServicesAction(tenantSlug, professional.id, {
        serviceIds: Array.from(serviceIds),
      });
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível salvar", description: result.error.message });
        return;
      }
      notify({ variant: "success", title: "Serviços atualizados." });
    });
  }

  function addHourRange(weekday: number) {
    setHours((prev) => [
      ...prev,
      { id: `new-${Date.now()}-${Math.random()}`, weekday, startTime: "09:00", endTime: "18:00" },
    ]);
  }

  function updateHour(id: string, field: "startTime" | "endTime", value: string) {
    setHours((prev) => prev.map((h) => (h.id === id ? { ...h, [field]: value } : h)));
  }

  function removeHour(id: string) {
    setHours((prev) => prev.filter((h) => h.id !== id));
  }

  function saveHours() {
    startTransition(async () => {
      const result = await setProfessionalWorkingHoursAction(tenantSlug, professional.id, {
        hours: hours.map(({ weekday, startTime, endTime }) => ({ weekday, startTime, endTime })),
      });
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível salvar o expediente", description: result.error.message });
        return;
      }
      setHours((result.data as WorkingHourRow[]).map((h) => ({ ...h })));
      notify({ variant: "success", title: "Expediente atualizado." });
    });
  }

  function openBlockDialog() {
    setBlockError(null);
    setBlockForm({ type: "BLOCK", startsAt: "", endsAt: "", reason: "" });
    setBlockDialogOpen(true);
  }

  function handleCreateBlock(e: React.FormEvent) {
    e.preventDefault();
    setBlockError(null);
    startTransition(async () => {
      const result = await createScheduleExceptionAction(tenantSlug, {
        professionalId: professional.id,
        type: blockForm.type,
        startsAt: new Date(blockForm.startsAt).toISOString(),
        endsAt: new Date(blockForm.endsAt).toISOString(),
        reason: blockForm.reason.trim() || null,
      });
      if (!result.ok) {
        setBlockError(result.error.message);
        return;
      }
      setExceptions((prev) => [...prev, result.data as ExceptionRow].sort((a, b) => a.startsAt.localeCompare(b.startsAt)));
      setBlockDialogOpen(false);
      notify({ variant: "success", title: "Bloqueio criado." });
    });
  }

  function handleDeleteBlock(id: string) {
    startTransition(async () => {
      const result = await deleteScheduleExceptionAction(tenantSlug, id);
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível excluir", description: result.error.message });
        return;
      }
      setExceptions((prev) => prev.filter((e) => e.id !== id));
      notify({ variant: "success", title: "Bloqueio excluído." });
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader help="pagina.profissionalDetalhe" icon={navIconFor("profissionais")}
        title={
          <span className="flex items-center gap-3">
            <Avatar id={professional.id} name={professional.name} />
            {professional.name}
          </span>
        }
        description="Dados, serviços, expediente semanal e bloqueios."
        action={
          <Button variant="ghost" asChild>
            <Link href={`/${tenantSlug}/profissionais`}>
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              Voltar
            </Link>
          </Button>
        }
      />

      {writeBlocked ? (
        <Alert variant="danger">
          {WRITE_BLOCKED_HINT}{" "}
          <Link href={`/${tenantSlug}/assinatura`} className="font-medium underline">
            Ver assinatura
          </Link>
        </Alert>
      ) : null}

      <Card className="rounded-hero">
        <CardHeader help="profissional.dados">
          <CardTitle>Dados</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveBasics} className="flex flex-col gap-4 sm:flex-row sm:items-end sm:gap-4">
            <div className="flex-1">
              <Field label="Nome" required>
                {(fieldProps) => (
                  <Input {...fieldProps} value={name} onChange={(e) => setName(e.target.value)} required disabled={writeBlocked} />
                )}
              </Field>
            </div>
            <label className="flex items-center gap-2 pb-2.5 text-sm text-text">
              <input
                type="checkbox"
                checked={active}
                onChange={(e) => setActive(e.target.checked)}
                disabled={writeBlocked}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              Ativo
            </label>
            <Button icon={Check} type="submit" isLoading={isPending} disabled={writeBlocked} title={writeBlocked ? WRITE_BLOCKED_HINT : undefined} loadingText="Salvando…">
              Salvar
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card className="rounded-hero">
        <CardHeader help="profissional.servicos">
          <CardTitle>Serviços que realiza</CardTitle>
          <CardDescription>Marque os serviços que este profissional atende.</CardDescription>
        </CardHeader>
        <CardContent>
          {allServices.length === 0 ? (
            <p className="text-sm text-text-secondary">Cadastre serviços primeiro na tela de Serviços.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {allServices.map((service) => (
                <label key={service.id} className="flex items-center gap-2 text-sm text-text">
                  <input
                    type="checkbox"
                    checked={serviceIds.has(service.id)}
                    onChange={() => toggleService(service.id)}
                    disabled={writeBlocked}
                    className="h-4 w-4 rounded border-border accent-primary"
                  />
                  {service.name}
                </label>
              ))}
            </div>
          )}
        </CardContent>
        <CardFooter>
          <Button
            icon={Check}
            onClick={saveServices}
            isLoading={isPending}
            disabled={allServices.length === 0 || writeBlocked}
            title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}
           loadingText="Salvando…">
            Salvar serviços
          </Button>
        </CardFooter>
      </Card>

      <Card className="rounded-hero">
        <CardHeader help="profissional.expediente">
          <CardTitle>Expediente semanal</CardTitle>
          <CardDescription>Pode ter mais de um intervalo por dia, como manhã e tarde com o almoço no meio.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {WEEKDAYS.map((label, weekday) => {
            const dayHours = hours.filter((h) => h.weekday === weekday);
            return (
              <div key={weekday} className="flex flex-col gap-2 border-b border-border pb-4 last:border-0 last:pb-0">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-text">{label}</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => addHourRange(weekday)}
                    disabled={writeBlocked}
                    title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    Adicionar intervalo
                  </Button>
                </div>
                {dayHours.length === 0 ? (
                  <p className="text-xs text-text-secondary">Sem expediente neste dia.</p>
                ) : (
                  dayHours.map((h) => (
                    <div key={h.id} className="flex items-center gap-2">
                      <Input
                        type="time"
                        value={h.startTime}
                        onChange={(e) => updateHour(h.id, "startTime", e.target.value)}
                        className="w-32"
                        aria-label={`Início, ${label}`}
                        disabled={writeBlocked}
                      />
                      <span className="text-sm text-text-secondary">até</span>
                      <Input
                        type="time"
                        value={h.endTime}
                        onChange={(e) => updateHour(h.id, "endTime", e.target.value)}
                        className="w-32"
                        aria-label={`Fim, ${label}`}
                        disabled={writeBlocked}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Remover intervalo"
                        onClick={() => removeHour(h.id)}
                        disabled={writeBlocked}
                        title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  ))
                )}
              </div>
            );
          })}
        </CardContent>
        <CardFooter>
          <Button icon={Check} onClick={saveHours} isLoading={isPending} disabled={writeBlocked} title={writeBlocked ? WRITE_BLOCKED_HINT : undefined} loadingText="Salvando…">
            Salvar expediente
          </Button>
        </CardFooter>
      </Card>

      <Card className="rounded-hero">
        <CardHeader help="profissional.folgas">
          <CardTitle>Bloqueios e folgas</CardTitle>
          <CardDescription>Períodos em que este profissional não atende.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {exceptions.length === 0 ? (
            <p className="text-sm text-text-secondary">Nenhum bloqueio cadastrado.</p>
          ) : (
            exceptions.map((exc) => (
              <div key={exc.id} className="flex items-center justify-between gap-3 rounded-card border border-border p-3">
                <div>
                  <div className="flex items-center gap-2">
                    <Badge variant={exc.type === "HOLIDAY" ? "warning" : "neutral"}>
                      {exc.type === "HOLIDAY" ? "Feriado/folga" : "Bloqueio"}
                    </Badge>
                    <p className="text-sm text-text">
                      {new Date(exc.startsAt).toLocaleString("pt-BR")} até {new Date(exc.endsAt).toLocaleString("pt-BR")}
                    </p>
                  </div>
                  {exc.reason ? <p className="mt-1 text-xs text-text-secondary">{exc.reason}</p> : null}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Excluir bloqueio"
                  onClick={() => handleDeleteBlock(exc.id)}
                  disabled={writeBlocked}
                  title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </div>
            ))
          )}
        </CardContent>
        <CardFooter>
          <Button variant="secondary" onClick={openBlockDialog} disabled={writeBlocked} title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            Novo bloqueio
          </Button>
        </CardFooter>
      </Card>

      <Dialog open={blockDialogOpen} onOpenChange={setBlockDialogOpen}>
        <DialogContent>
          <DialogHeader icon={CalendarOff}>
            <DialogTitle>Novo bloqueio</DialogTitle>
            <DialogDescription>Bloqueia agendamentos deste profissional no período informado.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateBlock} className="mt-4 flex flex-col gap-4">
            {blockError ? (
              <p role="alert" className="text-sm text-danger">
                {blockError}
              </p>
            ) : null}
            <div>
              <Label htmlFor="block-type">Tipo</Label>
              <Select
                id="block-type"
                value={blockForm.type}
                onChange={(e) => setBlockForm((f) => ({ ...f, type: e.target.value as "BLOCK" | "HOLIDAY" }))}
              >
                <option value="BLOCK">Bloqueio</option>
                <option value="HOLIDAY">Feriado/folga</option>
              </Select>
            </div>
            <Field label="Início" required>
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  type="datetime-local"
                  value={blockForm.startsAt}
                  onChange={(e) => setBlockForm((f) => ({ ...f, startsAt: e.target.value }))}
                  required
                />
              )}
            </Field>
            <Field label="Fim" required>
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  type="datetime-local"
                  value={blockForm.endsAt}
                  onChange={(e) => setBlockForm((f) => ({ ...f, endsAt: e.target.value }))}
                  required
                />
              )}
            </Field>
            <Field label="Motivo (opcional)">
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  value={blockForm.reason}
                  onChange={(e) => setBlockForm((f) => ({ ...f, reason: e.target.value }))}
                  maxLength={255}
                />
              )}
            </Field>
            <DialogFooter>
              <Button icon={X} type="button" variant="secondary" onClick={() => setBlockDialogOpen(false)}>
                Cancelar
              </Button>
              <Button icon={Check} type="submit" isLoading={isPending} loadingText="Criando…">
                Criar
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
