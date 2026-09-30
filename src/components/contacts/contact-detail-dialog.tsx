"use client";

import { HelpButton } from "@/components/help/help-button";
import { navIconFor } from "@/components/shell/nav-items";
import { useEffect, useState, useTransition } from "react";
import { CalendarPlus, ClipboardList, MessageCircle, Pause, Pencil, Play, Trash2, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar } from "@/components/ui/avatar";
import { useToast } from "@/components/ui/toast";
import { formatPhoneDisplay } from "@/components/lib/format-phone";
import { formatDateTimeLabel, formatDateTimeShortLabel } from "@/components/lib/format-date";
import {
  getContactAction,
  setContactBotPausedAction,
  deleteContactAction,
} from "@/modules/contacts/actions";
import { ContactFormDialog, type ContactFormTarget } from "./contact-form-dialog";
import { ContactConversation } from "./contact-conversation";
import { cn } from "@/components/lib/cn";
import { NovoAgendamentoDialog, type AgendaProfessional, type AgendaService } from "@/components/agenda/novo-agendamento-dialog";
type DetailTab = "resumo" | "conversa";

const TABS: { id: DetailTab; label: string; icon: typeof MessageCircle }[] = [
  { id: "resumo", label: "Resumo", icon: ClipboardList },
  { id: "conversa", label: "Conversa", icon: MessageCircle },
];

export type ContactSource = "WHATSAPP" | "PANEL";

export type ContactAppointmentRow = {
  id: string;
  startsAt: string;
  serviceName: string;
  professionalName: string;
  status: "SCHEDULED" | "CANCELED" | "COMPLETED" | "NO_SHOW";
  source: "WHATSAPP" | "PANEL";
};

export type ContactDetail = {
  id: string;
  displayName: string;
  name: string | null;
  pushName: string | null;
  phoneE164: string | null;
  source: ContactSource;
  appointmentsCount: number;
  noShowCount: number;
  lastAppointmentAt: string | null;
  nextAppointmentAt: string | null;
  botPaused: boolean;
  createdAt: string;
  notes: string | null;
  botPausedUntil: string | null;
  appointments: ContactAppointmentRow[];
};

const STATUS_LABEL: Record<ContactAppointmentRow["status"], string> = {
  SCHEDULED: "Agendado",
  CANCELED: "Cancelado",
  COMPLETED: "Concluído",
  NO_SHOW: "Faltou",
};

const STATUS_VARIANT: Record<ContactAppointmentRow["status"], "success" | "danger" | "neutral" | "warning"> = {
  SCHEDULED: "success",
  CANCELED: "danger",
  COMPLETED: "neutral",
  NO_SHOW: "warning",
};

const WRITE_BLOCKED_HINT = "Assinatura suspensa — ação bloqueada até o pagamento.";

type Props = {
  tenantSlug: string;
  timezone: string;
  isOwner: boolean;
  writeBlocked: boolean;
  contactId: string | null;
  professionals: AgendaProfessional[];
  services: AgendaService[];
  onOpenChange: (open: boolean) => void;
  /** Algo mudou (agendamento criado, bot pausado, editado, excluído…) — recarrega a lista pai. */
  onChanged: () => void;
  /** `Tenant.notifyClientOnStaffChanges` — repassado ao diálogo "Agendar para este cliente". */
  notifyClient?: boolean;
};

/**
 * Painel de detalhe em dialog (mesma escolha da Agenda — `DetalheAgendamentoDialog`), em vez de
 * uma rota `/clientes/[id]`: mantém a navegação da lista intacta e reaproveita o padrão já usado
 * no resto do painel para "ver mais sobre um item".
 */
export function ContactDetailDialog({
  tenantSlug,
  timezone,
  notifyClient = false,
  isOwner,
  writeBlocked,
  contactId,
  professionals,
  services,
  onOpenChange,
  onChanged,
}: Props) {
  const { notify } = useToast();
  const [detail, setDetail] = useState<ContactDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [tab, setTab] = useState<DetailTab>("resumo");
  const [isPausePending, startPauseTransition] = useTransition();
  const [isDeletePending, startDeleteTransition] = useTransition();

  const open = !!contactId;

  function load() {
    if (!contactId) return;
    setLoading(true);
    setError(null);
    getContactAction(tenantSlug, contactId)
      .then((result) => {
        if (!result.ok) {
          setError(result.error.message);
          setDetail(null);
          return;
        }
        setDetail(result.data as ContactDetail);
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    if (!contactId) {
      const timeoutId = setTimeout(() => {
        setDetail(null);
        setError(null);
        setTab("resumo");
      }, 0);
      return () => clearTimeout(timeoutId);
    }
    const timeoutId = setTimeout(load, 0);
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  function onTabKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const index = TABS.findIndex((t) => t.id === tab);
    const next =
      event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
    setTab(TABS[next]!.id);
    document.getElementById(`contact-tab-${TABS[next]!.id}`)?.focus();
  }

  function close() {
    setConfirmDelete(false);
    onOpenChange(false);
  }

  function pauseBot(paused: boolean, hours?: number) {
    if (!contactId) return;
    startPauseTransition(async () => {
      const result = await setContactBotPausedAction(tenantSlug, contactId, { paused, hours });
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível atualizar o bot", description: result.error.message });
        return;
      }
      setDetail((prev) => (prev ? { ...prev, botPaused: paused, botPausedUntil: result.data.botPausedUntil } : prev));
      notify({ variant: "success", title: paused ? "Bot pausado para este cliente." : "Bot retomado." });
      onChanged();
    });
  }

  function handleDelete() {
    if (!contactId) return;
    startDeleteTransition(async () => {
      const result = await deleteContactAction(tenantSlug, contactId);
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível excluir", description: result.error.message });
        setConfirmDelete(false);
        return;
      }
      notify({
        variant: "success",
        title: result.data.mode === "deleted" ? "Cliente excluído." : "Cliente anonimizado.",
        description:
          result.data.mode === "anonymized"
            ? "Como este cliente tem histórico de agendamentos, os dados pessoais foram removidos e o histórico foi mantido."
            : undefined,
      });
      onChanged();
      close();
    });
  }

  const editTarget: ContactFormTarget | null = detail
    ? { id: detail.id, name: detail.name, phoneE164: detail.phoneE164, source: detail.source, notes: detail.notes }
    : null;

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && close()}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] w-[min(38rem,calc(100vw-2rem))] overflow-y-auto">
          <DialogHeader icon={navIconFor("clientes")}>
            <DialogTitle>Cliente</DialogTitle>
            <DialogDescription>Dados, histórico de agendamentos e controle do bot.</DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="mt-4 flex flex-col gap-3">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-16" />
              <Skeleton className="h-24" />
            </div>
          ) : error ? (
            <Alert variant="danger" className="mt-4">
              {error}
            </Alert>
          ) : detail ? (
            <div className="mt-4 flex flex-col gap-5">
              <div role="tablist" aria-label="Seções da ficha do cliente" className="flex gap-1 border-b border-border" onKeyDown={onTabKeyDown}>
                {TABS.map(({ id, label, icon: TabIcon }) => (
                  <button
                    key={id}
                    id={`contact-tab-${id}`}
                    type="button"
                    role="tab"
                    aria-selected={tab === id}
                    aria-controls={`contact-panel-${id}`}
                    tabIndex={tab === id ? 0 : -1}
                    onClick={() => setTab(id)}
                    className={cn(
                      "-mb-px inline-flex min-h-11 items-center gap-2 border-b-2 px-4 text-sm font-medium transition-colors duration-150 motion-reduce:transition-none",
                      "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary",
                      tab === id ? "border-primary text-primary" : "border-transparent text-text-secondary hover:text-text",
                    )}
                  >
                    <TabIcon className="h-4 w-4" aria-hidden="true" />
                    {label}
                  </button>
                ))}
              </div>

              {tab === "conversa" ? (
                <div role="tabpanel" id="contact-panel-conversa" aria-labelledby="contact-tab-conversa">
                  <ContactConversation
                    tenantSlug={tenantSlug}
                    contactId={detail.id}
                    contactName={detail.displayName}
                    timezone={timezone}
                  />
                </div>
              ) : (
              <div role="tabpanel" id="contact-panel-resumo" aria-labelledby="contact-tab-resumo" className="flex flex-col gap-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <Avatar id={detail.id} name={detail.displayName} />
                  <div>
                  <div className="flex items-center gap-2">
                    <p className="font-display text-lg font-bold text-text">{detail.displayName}</p>
                    <Badge variant={detail.source === "WHATSAPP" ? "success" : "neutral"}>
                      {detail.source === "WHATSAPP" ? "WhatsApp" : "Painel"}
                    </Badge>
                    {detail.botPaused ? <Badge variant="warning">Bot pausado</Badge> : null}
                  </div>
                  <p className="mt-1 text-sm text-text-secondary">
                    {detail.phoneE164 ? formatPhoneDisplay(detail.phoneE164) : "Sem telefone"}
                  </p>
                  {detail.pushName && detail.pushName !== detail.name ? (
                    <p className="text-xs text-text-secondary">Nome no WhatsApp: {detail.pushName}</p>
                  ) : null}
                  </div>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setEditOpen(true)}
                  disabled={writeBlocked}
                  title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  Editar
                </Button>
              </div>

              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div>
                  <p className="text-text-secondary">Agendamentos</p>
                  <p className="font-medium text-text">{detail.appointmentsCount}</p>
                </div>
                <div>
                  <p className="text-text-secondary">Faltas</p>
                  <p className="font-medium text-text">{detail.noShowCount}</p>
                </div>
                <div>
                  <p className="text-text-secondary">Último</p>
                  <p className="font-medium text-text">
                    {detail.lastAppointmentAt ? formatDateTimeShortLabel(detail.lastAppointmentAt, timezone) : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-text-secondary">Próximo</p>
                  <p className="font-medium text-text">
                    {detail.nextAppointmentAt ? formatDateTimeShortLabel(detail.nextAppointmentAt, timezone) : "—"}
                  </p>
                </div>
              </div>

              {detail.notes ? (
                <div className="rounded-card border border-border bg-bg p-3 text-sm text-text">
                  <p className="mb-1 text-xs font-medium text-text-secondary">Notas</p>
                  {detail.notes}
                </div>
              ) : null}

              <div className="rounded-card border border-border p-3">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-medium text-text">Bot do WhatsApp</p>
                  <HelpButton helpKey="config.pausaCliente" />
                </div>
                <p className="mt-0.5 text-xs text-text-secondary">
                  Pausar faz o bot parar de responder esse cliente — você atende pelo celular. Retome quando quiser
                  que o bot volte a responder.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {detail.botPaused ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => pauseBot(false)}
                      isLoading={isPausePending}
                      disabled={writeBlocked}
                      title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}
                    >
                      <Play className="h-3.5 w-3.5" aria-hidden="true" />
                      Retomar bot
                    </Button>
                  ) : (
                    <>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => pauseBot(true, 1)}
                        isLoading={isPausePending}
                        disabled={writeBlocked}
                        title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}
                      >
                        <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                        Pausar por 1h
                      </Button>
                      <Button
                        icon={Pause}
                        variant="secondary"
                        size="sm"
                        onClick={() => pauseBot(true, 24)}
                        isLoading={isPausePending}
                        disabled={writeBlocked}
                        title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}
                      >
                        Pausar por 24h
                      </Button>
                      <Button
                        icon={Pause}
                        variant="secondary"
                        size="sm"
                        onClick={() => pauseBot(true)}
                        isLoading={isPausePending}
                        disabled={writeBlocked}
                        title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}
                      >
                        Pausar indefinidamente
                      </Button>
                    </>
                  )}
                </div>
                {detail.botPaused && detail.botPausedUntil ? (
                  <p className="mt-2 text-xs text-text-secondary">
                    Pausado até {formatDateTimeLabel(detail.botPausedUntil, timezone)}.
                  </p>
                ) : detail.botPaused ? (
                  <p className="mt-2 text-xs text-text-secondary">Pausado sem prazo — retome manualmente quando quiser.</p>
                ) : null}
              </div>

              <div>
                <p className="mb-2 text-sm font-medium text-text">Histórico de agendamentos</p>
                {detail.appointments.length === 0 ? (
                  <p className="text-sm text-text-secondary">Nenhum agendamento ainda.</p>
                ) : (
                  <div className="flex flex-col divide-y divide-border rounded-card border border-border">
                    {detail.appointments.map((appt) => (
                      <div key={appt.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                        <div>
                          <p className="font-medium text-text">{appt.serviceName}</p>
                          <p className="text-xs text-text-secondary">
                            {appt.professionalName} · {formatDateTimeShortLabel(appt.startsAt, timezone)}
                          </p>
                        </div>
                        <Badge variant={STATUS_VARIANT[appt.status]}>{STATUS_LABEL[appt.status]}</Badge>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              </div>
              )}
            </div>
          ) : null}

          {detail ? (
            <DialogFooter className="justify-between">
              {isOwner ? (
                <Button
                  variant="ghost"
                  className="text-danger hover:bg-danger-bg"
                  onClick={() => setConfirmDelete(true)}
                  disabled={writeBlocked}
                  title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  Excluir cliente
                </Button>
              ) : (
                <span />
              )}
              <Button
                icon={CalendarPlus}
                onClick={() => setScheduleOpen(true)}
                disabled={writeBlocked}
                title={writeBlocked ? WRITE_BLOCKED_HINT : undefined}
              >
                Agendar para este cliente
              </Button>
            </DialogFooter>
          ) : null}
        </DialogContent>
      </Dialog>

      <ContactFormDialog
        tenantSlug={tenantSlug}
        open={editOpen}
        onOpenChange={setEditOpen}
        contact={editTarget}
        onSaved={() => {
          load();
          onChanged();
        }}
      />

      {detail ? (
        <NovoAgendamentoDialog
          tenantSlug={tenantSlug}
          services={services}
          professionals={professionals}
          timezone={timezone}
          open={scheduleOpen}
          onOpenChange={setScheduleOpen}
          disabled={writeBlocked}
          presetContact={{ id: detail.id, name: detail.displayName, phone: detail.phoneE164 }}
          notifyClient={notifyClient}
          onCreated={() => {
            load();
            onChanged();
          }}
        />
      ) : null}

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader icon={Trash2} tone="danger">
            <DialogTitle>Excluir cliente</DialogTitle>
            <DialogDescription>
              Tem certeza que quer excluir &ldquo;{detail?.displayName}&rdquo;? Clientes sem histórico são excluídos de
              verdade; clientes com agendamentos são anonimizados — os dados pessoais somem, mas o histórico do
              atendimento fica preservado nos relatórios. Essa ação não pode ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button icon={X} type="button" variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancelar
            </Button>
            <Button icon={Trash2} type="button" variant="danger" onClick={handleDelete} isLoading={isDeletePending} loadingText="Excluindo…">
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
