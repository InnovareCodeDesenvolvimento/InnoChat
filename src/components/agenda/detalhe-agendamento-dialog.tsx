"use client";

import { useEffect, useState, useTransition } from "react";
import { ArrowLeft, CalendarClock, CalendarX, CircleCheck, RotateCcw, UserX } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { navIconFor } from "@/components/shell/nav-items";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { AppointmentSourceBadge, AppointmentStatusBadge, type AppointmentSource, type AppointmentStatus } from "./appointment-status";
import { AppointmentTimeline } from "./appointment-timeline";
import { useClientNotificationToast } from "./client-notification";
import { Alert } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  cancelAppointmentAction,
  completeAppointmentAction,
  markNoShowAppointmentAction,
  reopenAppointmentAction,
  rescheduleAppointmentAction,
} from "@/modules/agenda/appointment-actions";
import { formatDateTimeLabel, formatTimeLabel } from "@/components/lib/format-date";

export type AppointmentDetail = {
  id: string;
  startsAt: string;
  endsAt: string;
  status: "SCHEDULED" | "CANCELED" | "COMPLETED" | "NO_SHOW";
  /** Origem do agendamento; ausente em telas que ainda não a carregam. */
  source?: AppointmentSource;
  contact: { name: string | null; phoneE164: string | null };
  service: { name: string };
  professional: { name: string };
};

type Props = {
  tenantSlug: string;
  appointment: AppointmentDetail | null;
  /** Fuso do tenant — sem isso as horas exibidas seriam as do navegador de quem está vendo, não as da empresa. */
  timezone: string;
  onOpenChange: (open: boolean) => void;
  onUpdated: (appointment: unknown) => void;
  /** Assinatura suspensa/cancelada (refinamento de UX — o servidor já bloqueia). */
  disabled?: boolean;
};

function toDateTimeLocal(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function DetalheAgendamentoDialog({
  tenantSlug,
  appointment,
  timezone,
  onOpenChange,
  onUpdated,
  disabled = false,
}: Props) {
  const [mode, setMode] = useState<"view" | "reschedule" | "cancel">("view");
  const [newStartsAt, setNewStartsAt] = useState("");
  const [cancelNote, setCancelNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  // Status vindo da ação (concluir/faltou) — o pai só recarrega a lista, então o diálogo aberto
  // precisa refletir o novo estado sozinho. Amarrado ao id: outro agendamento nunca herda o override.
  const [override, setOverride] = useState<{ id: string; status: AppointmentStatus } | null>(null);
  const [timelineKey, setTimelineKey] = useState(0);
  const [pendingAction, setPendingAction] = useState<"complete" | "noshow" | "reopen" | null>(null);
  // "Agora" em estado (não Date.now() no render): reavalia a cada 30 s enquanto o diálogo está aberto,
  // para "Concluir/Faltou" habilitarem sozinhos quando o horário de início chega.
  const [now, setNow] = useState(0);
  const { notify } = useToast();
  const announceClientNotification = useClientNotificationToast();

  const appointmentId = appointment?.id;
  useEffect(() => {
    if (!appointmentId) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const interval = setInterval(tick, 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [appointmentId]);

  if (!appointment) return null;

  const status: AppointmentStatus = override?.id === appointment.id ? override.status : appointment.status;
  const hasStarted = now > 0 && new Date(appointment.startsAt).getTime() <= now;

  function close() {
    setOverride(null);
    setMode("view");
    setError(null);
    onOpenChange(false);
  }

  function handleCancel() {
    if (!appointment) return;
    setError(null);
    startTransition(async () => {
      const result = await cancelAppointmentAction(tenantSlug, appointment.id, { note: cancelNote.trim() || undefined });
      if (!result.ok) {
        setError(result.error.code === "TOO_LATE" ? "Prazo mínimo para cancelar já passou." : result.error.message);
        return;
      }
      onUpdated(result.data);
      announceClientNotification(result.data);
      close();
    });
  }

  function handleFinish(kind: "complete" | "noshow" | "reopen") {
    if (!appointment) return;
    setError(null);
    setPendingAction(kind);
    startTransition(async () => {
      const input = { tenantSlug, appointmentId: appointment.id };
      const result =
        kind === "complete"
          ? await completeAppointmentAction(input)
          : kind === "noshow"
            ? await markNoShowAppointmentAction(input)
            : await reopenAppointmentAction(input);
      setPendingAction(null);
      if (!result.ok) {
        setError(
          result.error.code === "APPOINTMENT_NOT_STARTED"
            ? "O atendimento ainda não começou. Tente de novo a partir do horário de início."
            : result.error.message,
        );
        return;
      }
      setOverride({
        id: appointment.id,
        status: kind === "complete" ? "COMPLETED" : kind === "noshow" ? "NO_SHOW" : "SCHEDULED",
      });
      setTimelineKey((k) => k + 1);
      notify({
        variant: "success",
        title:
          kind === "complete" ? "Atendimento concluído." : kind === "noshow" ? "Falta registrada." : "Agendamento reaberto.",
      });
      onUpdated(result.data);
    });
  }

  function handleReschedule(e: React.FormEvent) {
    e.preventDefault();
    if (!appointment) return;
    setError(null);
    if (!newStartsAt) {
      setError("Escolha o novo horário.");
      return;
    }
    startTransition(async () => {
      const result = await rescheduleAppointmentAction(tenantSlug, appointment.id, {
        startsAt: new Date(newStartsAt).toISOString(),
      });
      if (!result.ok) {
        if (result.error.code === "SLOT_TAKEN") {
          setError("Esse horário acabou de ser ocupado. Escolha outro.");
          return;
        }
        setError(result.error.code === "TOO_LATE" ? "Prazo mínimo para remarcar já passou." : result.error.message);
        return;
      }
      onUpdated(result.data);
      announceClientNotification(result.data);
      close();
    });
  }

  return (
    <Dialog open={!!appointment} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader icon={navIconFor("agenda")}>
          <DialogTitle>Agendamento</DialogTitle>
          <DialogDescription>
            {appointment.service.name} com {appointment.professional.name}
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 flex flex-col gap-3">
          {error ? <Alert variant="danger">{error}</Alert> : null}

          <div className="flex items-center justify-between">
            <p className="text-sm text-text-secondary">Status</p>
            <AppointmentStatusBadge status={status} />
          </div>
          {appointment.source ? (
            <div className="flex items-center justify-between">
              <p className="text-sm text-text-secondary">Origem</p>
              <AppointmentSourceBadge source={appointment.source} className="text-sm text-text" />
            </div>
          ) : null}
          <div className="flex items-center justify-between">
            <p className="text-sm text-text-secondary">Cliente</p>
            <p className="text-sm text-text">{appointment.contact.name ?? "Sem nome"}</p>
          </div>
          {appointment.contact.phoneE164 ? (
            <div className="flex items-center justify-between">
              <p className="text-sm text-text-secondary">Telefone</p>
              <p className="text-sm text-text">{appointment.contact.phoneE164}</p>
            </div>
          ) : null}
          <div className="flex items-center justify-between">
            <p className="text-sm text-text-secondary">Horário</p>
            <p className="text-sm tabular-nums text-text">
              {formatDateTimeLabel(appointment.startsAt, timezone)} – {formatTimeLabel(appointment.endsAt, timezone)}
            </p>
          </div>

          {mode === "reschedule" ? (
            <form onSubmit={handleReschedule} className="flex flex-col gap-3 border-t border-border pt-3">
              <Label htmlFor="reschedule-input">Novo horário</Label>
              <Input
                id="reschedule-input"
                type="datetime-local"
                value={newStartsAt}
                onChange={(e) => setNewStartsAt(e.target.value)}
                required
              />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" icon={ArrowLeft} onClick={() => setMode("view")}>
                  Voltar
                </Button>
                <Button type="submit" icon={CalendarClock} isLoading={isPending} loadingText="Remarcando…">
                  Confirmar remarcação
                </Button>
              </div>
            </form>
          ) : null}

          {mode === "cancel" ? (
            <div className="flex flex-col gap-3 border-t border-border pt-3">
              <Label htmlFor="cancel-note">Motivo do cancelamento (opcional)</Label>
              <Input id="cancel-note" value={cancelNote} onChange={(e) => setCancelNote(e.target.value)} />
              <p className="text-sm text-text-secondary">Tem certeza que quer cancelar este agendamento?</p>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" icon={ArrowLeft} onClick={() => setMode("view")}>
                  Voltar
                </Button>
                <Button type="button" variant="danger" icon={CalendarX} onClick={handleCancel} isLoading={isPending} loadingText="Cancelando…">
                  Confirmar cancelamento
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        <div className="mt-4">
          <AppointmentTimeline tenantSlug={tenantSlug} appointmentId={appointment.id} timezone={timezone} refreshKey={timelineKey} />
        </div>

        {mode === "view" && status === "SCHEDULED" ? (
          <div className="mt-6 flex flex-col gap-2">
            {disabled ? (
              <p className="text-sm text-danger">
                Assinatura suspensa — remarcação e cancelamento bloqueados até o pagamento.
              </p>
            ) : (
              <>
                {/* Grade de 2 colunas em qualquer largura: as ações do dia (concluir/faltou) primeiro,
                    as de mudança de horário depois; rótulos longos ocupam a linha inteira. */}
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant="success"
                    icon={CircleCheck}
                    className="col-span-2"
                    disabled={!hasStarted || isPending}
                    isLoading={pendingAction === "complete"}
                    loadingText="Concluindo…"
                    aria-describedby={hasStarted ? undefined : "finish-hint"}
                    onClick={() => handleFinish("complete")}
                  >
                    Concluir atendimento
                  </Button>
                  <Button
                    type="button"
                    variant="warning"
                    icon={UserX}
                    disabled={!hasStarted || isPending}
                    isLoading={pendingAction === "noshow"}
                    loadingText="Registrando…"
                    aria-describedby={hasStarted ? undefined : "finish-hint"}
                    onClick={() => handleFinish("noshow")}
                  >
                    Cliente faltou
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    icon={CalendarClock}
                    disabled={isPending}
                    onClick={() => {
                      setNewStartsAt(toDateTimeLocal(appointment.startsAt));
                      setMode("reschedule");
                    }}
                  >
                    Remarcar
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    icon={CalendarX}
                    className="col-span-2 border-danger/40 text-danger hover:bg-danger-bg"
                    disabled={isPending}
                    onClick={() => setMode("cancel")}
                  >
                    Cancelar agendamento
                  </Button>
                </div>
                {hasStarted ? null : (
                  <p id="finish-hint" className="text-xs text-text-secondary">
                    Concluir e registrar falta ficam disponíveis a partir das {formatTimeLabel(appointment.startsAt, timezone)}.
                  </p>
                )}
              </>
            )}
          </div>
        ) : null}
        {mode === "view" && !disabled && (status === "COMPLETED" || status === "NO_SHOW") ? (
          <div className="mt-4 flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon={RotateCcw}
              className="text-text-secondary"
              disabled={isPending}
              isLoading={pendingAction === "reopen"}
              loadingText="Reabrindo…"
              onClick={() => handleFinish("reopen")}
            >
              Reabrir agendamento
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
