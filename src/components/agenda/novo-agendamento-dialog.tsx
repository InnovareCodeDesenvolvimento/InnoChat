"use client";

import { navIconFor } from "@/components/shell/nav-items";
import { CalendarPlus, X } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { cn } from "@/components/lib/cn";
import { createAppointmentAction } from "@/modules/agenda/appointment-actions";
import { useClientNotificationToast } from "./client-notification";
import { listAvailableSlotsAction } from "@/modules/agenda/availability-actions";
import { formatDateTimeLabel, formatTimeLabel } from "@/components/lib/format-date";
import { formatPhoneDisplay } from "@/components/lib/format-phone";

export type AgendaService = { id: string; name: string; durationMin: number; active: boolean };
export type AgendaProfessional = { id: string; name: string; active: boolean };

export type NovoAgendamentoPrefill = {
  serviceId?: string;
  professionalId?: string | null;
  /** Data local no formato YYYY-MM-DD. */
  date?: string;
  /** Instante ISO já escolhido (ex.: clique num horário livre na grade da agenda). */
  startsAt?: string;
};

type Props = {
  tenantSlug: string;
  services: AgendaService[];
  professionals: AgendaProfessional[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefill?: NovoAgendamentoPrefill;
  onCreated: (appointment: unknown) => void;
  /** Fuso do tenant — os horários livres vêm do servidor em UTC, precisam exibir na hora local da empresa. */
  timezone: string;
  /** Assinatura suspensa/cancelada (refinamento de UX — o servidor já bloqueia). */
  disabled?: boolean;
  /**
   * Cliente já escolhido (tela de Clientes, "Agendar para este cliente") — some com os campos
   * de nome/telefone e manda `contactId` em vez de `contactName`/`contactPhoneE164`.
   */
  presetContact?: { id: string; name: string; phone: string | null } | null;
  /** `Tenant.notifyClientOnStaffChanges`: com ele ligado e o cliente com telefone, mostra o aviso de que haverá mensagem no WhatsApp. */
  notifyClient?: boolean;
};

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Dialog reutilizado pela Agenda (clique num horário livre já preenche tudo) e pelos
 * Agendamentos (botão "Novo agendamento" abre em branco). `SLOT_TAKEN` recarrega a lista de
 * horários em vez de só mostrar erro — o horário escolhido pode ter sido ocupado por outra
 * pessoa entre a abertura do dialog e o clique em confirmar.
 */
export function NovoAgendamentoDialog({
  tenantSlug,
  services,
  professionals,
  open,
  onOpenChange,
  prefill,
  onCreated,
  timezone,
  disabled = false,
  presetContact = null,
  notifyClient = false,
}: Props) {
  const announceClientNotification = useClientNotificationToast();
  const activeServices = services.filter((s) => s.active);
  const activeProfessionals = professionals.filter((p) => p.active);

  const [serviceId, setServiceId] = useState(prefill?.serviceId ?? activeServices[0]?.id ?? "");
  const [professionalId, setProfessionalId] = useState(prefill?.professionalId ?? "");
  const [date, setDate] = useState(prefill?.date ?? todayISO());
  const [lockedStartsAt, setLockedStartsAt] = useState<string | null>(prefill?.startsAt ?? null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(prefill?.startsAt ?? null);
  const [slots, setSlots] = useState<string[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    const timeoutId = setTimeout(() => {
      setServiceId(prefill?.serviceId ?? activeServices[0]?.id ?? "");
      setProfessionalId(prefill?.professionalId ?? "");
      setDate(prefill?.date ?? todayISO());
      setLockedStartsAt(prefill?.startsAt ?? null);
      setSelectedSlot(prefill?.startsAt ?? null);
      setContactName("");
      setContactPhone("");
      setError(null);
    }, 0);
    return () => clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefill]);

  useEffect(() => {
    if (!open || lockedStartsAt || !serviceId) {
      const timeoutId = setTimeout(() => setSlots([]), 0);
      return () => clearTimeout(timeoutId);
    }
    let cancelled = false;
    const timeoutId = setTimeout(() => {
      setLoadingSlots(true);
      listAvailableSlotsAction(tenantSlug, { serviceId, professionalId: professionalId || null, date })
        .then((result) => {
          if (cancelled) return;
          if (result.ok) {
            setSlots(result.data.slots);
          } else {
            setSlots([]);
          }
        })
        .finally(() => {
          if (!cancelled) setLoadingSlots(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [open, lockedStartsAt, serviceId, professionalId, date, tenantSlug]);

  function reloadSlots() {
    setLockedStartsAt(null);
    setSelectedSlot(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const startsAt = lockedStartsAt ?? selectedSlot;
    if (!startsAt) {
      setError("Escolha um horário.");
      return;
    }
    if (!presetContact && !contactName.trim()) {
      setError("Informe o nome do cliente.");
      return;
    }

    startTransition(async () => {
      const result = await createAppointmentAction(tenantSlug, {
        serviceId,
        professionalId: professionalId || null,
        startsAt,
        ...(presetContact
          ? { contactId: presetContact.id }
          : { contactName: contactName.trim(), contactPhoneE164: contactPhone.trim() || undefined }),
      });

      if (!result.ok) {
        if (result.error.code === "SLOT_TAKEN") {
          setError("Esse horário acabou de ser ocupado. Escolha outro.");
          reloadSlots();
          return;
        }
        setError(result.error.message);
        return;
      }

      onCreated(result.data);
      announceClientNotification(result.data);
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader icon={navIconFor("agenda")}>
          <DialogTitle>Novo agendamento</DialogTitle>
          <DialogDescription>Escolha o serviço, o profissional e um horário livre.</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4">
          {error ? <Alert variant="danger">{error}</Alert> : null}
          {disabled ? (
            <Alert variant="danger">Assinatura suspensa: não dá para criar agendamentos até o pagamento.</Alert>
          ) : null}

          <fieldset disabled={disabled} className="flex flex-col gap-4">
          <div>
            <Label htmlFor="na-service">Serviço</Label>
            <Select id="na-service" value={serviceId} onChange={(e) => setServiceId(e.target.value)} required>
              {activeServices.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.durationMin} min)
                </option>
              ))}
            </Select>
          </div>

          <div>
            <Label htmlFor="na-professional">Profissional</Label>
            <Select id="na-professional" value={professionalId} onChange={(e) => setProfessionalId(e.target.value)}>
              <option value="">Qualquer profissional disponível</option>
              {activeProfessionals.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>

          {lockedStartsAt ? (
            <div className="rounded-card border border-border bg-bg p-3 text-sm">
              <p className="text-text">
                Horário escolhido:{" "}
                <strong className="tabular-nums">{formatDateTimeLabel(lockedStartsAt, timezone)}</strong>
              </p>
              <button type="button" onClick={reloadSlots} className="mt-1 text-xs text-primary underline-offset-4 hover:underline">
                Escolher outro horário
              </button>
            </div>
          ) : (
            <>
              <Field label="Data" required>
                {(fieldProps) => (
                  <Input {...fieldProps} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
                )}
              </Field>

              <div>
                <Label>Horário</Label>
                {loadingSlots ? (
                  <p className="text-sm text-text-secondary">Carregando horários…</p>
                ) : slots.length === 0 ? (
                  <p className="text-sm text-text-secondary">Nenhum horário livre neste dia.</p>
                ) : (
                  <div className="grid grid-cols-4 gap-2">
                    {slots.map((slot) => (
                      <button
                        key={slot}
                        type="button"
                        onClick={() => setSelectedSlot(slot)}
                        className={cn(
                          "rounded-card border px-2 py-1.5 text-sm",
                          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                          selectedSlot === slot
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border text-text hover:bg-bg",
                        )}
                        aria-pressed={selectedSlot === slot}
                      >
                        <span className="tabular-nums">{formatTimeLabel(slot, timezone)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}

          {presetContact ? (
            <div className="rounded-card border border-border bg-bg p-3 text-sm">
              <p className="text-text-secondary">Cliente</p>
              <p className="font-medium text-text">{presetContact.name}</p>
              {presetContact.phone ? (
                <p className="text-text-secondary">{formatPhoneDisplay(presetContact.phone)}</p>
              ) : null}
            </div>
          ) : (
            <>
              <Field label="Nome do cliente" required>
                {(fieldProps) => (
                  <Input {...fieldProps} value={contactName} onChange={(e) => setContactName(e.target.value)} required maxLength={120} />
                )}
              </Field>

              <Field label="Telefone (opcional)">
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    value={contactPhone}
                    onChange={(e) => setContactPhone(e.target.value)}
                    placeholder="+55 11 99999-9999"
                  />
                )}
              </Field>
            </>
          )}
          </fieldset>

          {notifyClient && (presetContact ? !!presetContact.phone : contactPhone.trim() !== "") ? (
            <p className="text-xs text-text-secondary" data-testid="notify-client-hint">
              O cliente receberá a confirmação no WhatsApp
            </p>
          ) : null}

          <DialogFooter>
            <Button icon={X} type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button icon={CalendarPlus} type="submit" isLoading={isPending} disabled={disabled} loadingText="Agendando…">
              Agendar
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
