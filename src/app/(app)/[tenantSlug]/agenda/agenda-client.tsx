"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { formatInTimeZone, fromZonedTime } from "date-fns-tz";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CalendarClock, CalendarPlus, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useLiveAppointments, useOnAppointmentsChanged } from "@/components/notifications/notification-center-provider";
import { AppointmentSourceBadge, AppointmentStatusBadge } from "@/components/agenda/appointment-status";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, colorForId } from "@/components/ui/avatar";
import { useToast } from "@/components/ui/toast";
import { useClientNotificationToast } from "@/components/agenda/client-notification";
import { cn } from "@/components/lib/cn";
import {
  capitalizeFirst,
  formatDateTimeLabel,
  formatDayNumber,
  formatLongDateLabel,
  formatShortWeekdayLabel,
  formatTimeLabel,
  formatWeekRangeLabel,
  friendlyTimezoneLabel,
} from "@/components/lib/format-date";
import { listAppointmentsAction, rescheduleAppointmentAction } from "@/modules/agenda/appointment-actions";
import { listScheduleExceptionsAction } from "@/modules/agenda/catalog-actions";
import {
  NovoAgendamentoDialog,
  type AgendaProfessional,
  type AgendaService,
  type NovoAgendamentoPrefill,
} from "@/components/agenda/novo-agendamento-dialog";
import { DetalheAgendamentoDialog, type AppointmentDetail } from "@/components/agenda/detalhe-agendamento-dialog";
import type { ProfessionalRow } from "../profissionais/profissionais-client";
import type { ServiceRow } from "../servicos/servicos-client";

const SLOT_MIN = 30;
const DEFAULT_WINDOW_START_MIN = 7 * 60;
const DEFAULT_WINDOW_END_MIN = 20 * 60;
const ROW_HEIGHT_PX = 48;
const WEEK_ROW_HEIGHT_PX = 28;

type ApptStatus = AppointmentDetail["status"];

type ApptRaw = {
  id: string;
  startsAt: string | Date;
  endsAt: string | Date;
  status: ApptStatus;
  source?: "WHATSAPP" | "PANEL";
  professionalId: string;
  contact: { name: string | null; phoneE164: string | null };
  service: { name: string };
  professional: { name: string };
};

type ScheduleExceptionRow = {
  id: string;
  /** `null` = bloqueio/feriado da empresa inteira (afeta todos os profissionais). */
  professionalId: string | null;
  type: "BLOCK" | "HOLIDAY";
  startsAt: string | Date;
  endsAt: string | Date;
  reason: string | null;
};

const EXCEPTION_TYPE_LABEL: Record<ScheduleExceptionRow["type"], string> = {
  BLOCK: "Bloqueio",
  HOLIDAY: "Feriado",
};

/** Cor por status — mesma leitura visual em bloco de agenda e em badge. */
const STATUS_BLOCK_CLASSES: Record<ApptStatus, string> = {
  SCHEDULED: "bg-primary/90 hover:bg-primary text-white",
  COMPLETED: "bg-success/90 hover:bg-success text-white",
  NO_SHOW: "bg-warning/90 hover:bg-warning text-white",
  CANCELED: "bg-text-secondary/50 text-white line-through",
};
const STATUS_BADGE_VARIANT: Record<ApptStatus, "primary" | "success" | "warning" | "danger"> = {
  SCHEDULED: "primary",
  COMPLETED: "success",
  NO_SHOW: "warning",
  CANCELED: "danger",
};

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function minutesToHHMM(min: number): string {
  const h = String(Math.floor(min / 60)).padStart(2, "0");
  const m = String(min % 60).padStart(2, "0");
  return `${h}:${m}`;
}

function addDaysISO(dateISO: string, days: number): string {
  const [y, m, d] = dateISO.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function weekdayOf(dateISO: string): number {
  const [y, m, d] = dateISO.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function startOfWeekISO(dateISO: string): string {
  const wd = weekdayOf(dateISO); // 0=domingo
  const diff = (wd + 6) % 7; // dias desde segunda
  return addDaysISO(dateISO, -diff);
}

/** Intervalos de expediente de um profissional num dia da semana (0=domingo), já ordenados. */
function workingHoursForWeekday(prof: ProfessionalRow, weekday: number): { startTime: string; endTime: string }[] {
  return prof.workingHours
    .filter((h) => h.weekday === weekday)
    .slice()
    .sort((a, b) => toMinutes(a.startTime) - toMinutes(b.startTime));
}

function workingHoursSummary(hours: { startTime: string; endTime: string }[]): string {
  if (hours.length === 0) return "Folga";
  return hours.map((h) => `${h.startTime}–${h.endTime}`).join(", ");
}

const DATE_PARAM_RE = /^\d{4}-\d{2}-\d{2}$/;

export function AgendaClient({
  tenantSlug,
  timezone,
  professionals,
  services,
  writeBlocked = false,
}: {
  tenantSlug: string;
  timezone: string;
  professionals: ProfessionalRow[];
  services: ServiceRow[];
  writeBlocked?: boolean;
}) {
  const [view, setView] = useState<"day" | "week">("day");
  const searchParams = useSearchParams();
  // `?data=YYYY-MM-DD` (link das notificações): abre a agenda direto naquele dia.
  const [dateISO, setDateISO] = useState(() => {
    const requested = searchParams.get("data");
    return requested && DATE_PARAM_RE.test(requested) ? requested : formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");
  });
  const [appointments, setAppointments] = useState<ApptRaw[]>([]);
  const [exceptions, setExceptions] = useState<ScheduleExceptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [novoOpen, setNovoOpen] = useState(false);
  const [novoPrefill, setNovoPrefill] = useState<NovoAgendamentoPrefill | undefined>(undefined);
  const [detail, setDetail] = useState<AppointmentDetail | null>(null);
  const [nowTick, setNowTick] = useState(() => new Date());
  const [weekProfessionalId, setWeekProfessionalId] = useState<string>("");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState(false);
  const router = useRouter();
  const { notify } = useToast();
  const announceClientNotification = useClientNotificationToast();

  // Paleta de comando (Ctrl+K) e o atalho "Novo agendamento" do Início linkam para
  // `/agenda?novo=1` — abre o diálogo direto, sem precisar clicar de novo no botão da tela.
  // `setTimeout(fn, 0)`: setState direto no corpo do efeito dispara o lint
  // `react-hooks/set-state-in-effect` (armadilha já registrada na memória).
  useEffect(() => {
    if (searchParams.get("novo") !== "1") return;
    const id = setTimeout(() => {
      setNovoOpen(true);
      router.replace(`/${tenantSlug}/agenda`, { scroll: false });
    }, 0);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Já na Agenda e clicou numa notificação de outro dia: o parâmetro muda, o dia acompanha.
  useEffect(() => {
    const requested = searchParams.get("data");
    if (!requested || !DATE_PARAM_RE.test(requested)) return;
    const id = setTimeout(() => {
      setView("day");
      setDateISO(requested);
    }, 0);
    return () => clearTimeout(id);
  }, [searchParams]);

  const activeProfessionals = useMemo(() => professionals.filter((p) => p.active), [professionals]);
  const agendaServices: AgendaService[] = services;
  const agendaProfessionals: AgendaProfessional[] = professionals;

  const rangeFrom = view === "day" ? dateISO : startOfWeekISO(dateISO);
  const rangeDays = view === "day" ? 1 : 7;

  // `silent`: recarga por notificação nova — não pisca o skeleton, só troca os dados.
  const load = useCallback((silent?: boolean) => {
    if (silent !== true) setLoading(true);
    const from = fromZonedTime(`${rangeFrom}T00:00:00`, timezone);
    const to = fromZonedTime(`${addDaysISO(rangeFrom, rangeDays)}T00:00:00`, timezone);
    Promise.all([
      listAppointmentsAction(tenantSlug, { from: from.toISOString(), to: to.toISOString(), limit: 500 }),
      listScheduleExceptionsAction(tenantSlug, { from: from.toISOString(), to: to.toISOString() }),
    ])
      .then(([apptResult, exceptionResult]) => {
        if (apptResult.ok) {
          setAppointments(
            (apptResult.data as ApptRaw[]).filter((a) => a.status !== "CANCELED"),
          );
        }
        if (exceptionResult.ok) {
          setExceptions(exceptionResult.data as ScheduleExceptionRow[]);
        }
      })
      .finally(() => setLoading(false));
  }, [tenantSlug, timezone, rangeFrom, rangeDays]);

  useEffect(() => {
    const timeoutId = setTimeout(load, 0);
    return () => clearTimeout(timeoutId);
  }, [load]);

  // Entrou/mudou agendamento (ex.: cliente marcou pelo WhatsApp): recarrega sem F5.
  useOnAppointmentsChanged(() => load(true));

  // Sinaliza ao provider que há arraste em andamento (ele adia o refresh ao vivo).
  useEffect(() => {
    if (!draggingId) return;
    document.body.dataset.apptDrag = "1";
    return () => {
      delete document.body.dataset.apptDrag;
    };
  }, [draggingId]);

  useEffect(() => {
    const interval = setInterval(() => setNowTick(new Date()), 60_000);
    return () => clearInterval(interval);
  }, []);

  function goToday() {
    setDateISO(formatInTimeZone(new Date(), timezone, "yyyy-MM-dd"));
  }
  function goPrev() {
    setDateISO((d) => addDaysISO(d, view === "day" ? -1 : -7));
  }
  function goNext() {
    setDateISO((d) => addDaysISO(d, view === "day" ? 1 : 7));
  }

  function openNovoAt(professionalId: string | null, startsAt: string) {
    setNovoPrefill({ professionalId, startsAt });
    setNovoOpen(true);
  }
  function openNovoBlank(forDate?: string) {
    setNovoPrefill(forDate ? { date: forDate } : undefined);
    setNovoOpen(true);
  }
  /**
   * Arrastar para remarcar (docs premium, pacote "agenda interativa") — reaproveita a MESMA
   * `rescheduleAppointmentAction` do diálogo de detalhe ("Remarcar" por texto continua existindo,
   * o arraste é um atalho, não o único caminho). Limitação de contrato conhecida e reportada no
   * handoff: `rescheduleAppointment` (backend, Vega) só muda `startsAt` — mantém o MESMO
   * profissional do agendamento original. Por isso só existe drop dentro da coluna do próprio
   * profissional; soltar em outra coluna é bloqueado antes de chamar o servidor (ver `DayView`).
   */
  async function handleReschedule(appointmentId: string, newStartsAtISO: string) {
    setRescheduling(true);
    const result = await rescheduleAppointmentAction(tenantSlug, appointmentId, { startsAt: newStartsAtISO });
    setRescheduling(false);
    if (result.ok) {
      notify({ variant: "success", title: "Agendamento remarcado", description: formatDateTimeLabel(newStartsAtISO, timezone) });
      announceClientNotification(result.data);
      load();
    } else if (result.error.code === "SLOT_TAKEN") {
      notify({ variant: "error", title: "Horário ocupado", description: "Esse horário acabou de ser ocupado por outro agendamento." });
    } else {
      notify({ variant: "error", title: "Não foi possível remarcar", description: result.error.message });
    }
  }

  function openDetail(a: ApptRaw) {
    setDetail({
      id: a.id,
      startsAt: new Date(a.startsAt).toISOString(),
      endsAt: new Date(a.endsAt).toISOString(),
      status: a.status,
      contact: a.contact,
      service: a.service,
      professional: a.professional,
    });
  }

  const todayISO = formatInTimeZone(nowTick, timezone, "yyyy-MM-dd");

  // Contadores do dia — só fazem sentido olhando o dia de hoje, então usamos
  // o carregamento atual quando ele já cobre hoje (dia == hoje, ou a semana
  // corrente inclui hoje); senão os contadores refletem o dia selecionado.
  const countsDateISO = view === "day" ? dateISO : todayISO;
  const isCountingToday = countsDateISO === todayISO;
  const countsSource =
    view === "day"
      ? appointments
      : appointments.filter((a) => formatInTimeZone(new Date(a.startsAt), timezone, "yyyy-MM-dd") === countsDateISO);
  const totalCount = view === "day" ? countsSource.length : countsSource.length;
  const upcomingCount = countsSource.filter(
    (a) => a.status === "SCHEDULED" && new Date(a.startsAt).getTime() > nowTick.getTime(),
  ).length;

  return (
    <div>
      <PageHeader icon={navIconFor("agenda")}
        title="Agenda"
        description={friendlyTimezoneLabel(timezone)}
        action={
          <Button
            onClick={() => openNovoBlank()}
            disabled={writeBlocked}
            title={writeBlocked ? "Assinatura suspensa — ação bloqueada até o pagamento." : undefined}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Novo agendamento
          </Button>
        }
      />

      {!loading ? (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-xs text-text-secondary ring-1 ring-primary/15">
            <CalendarClock className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            <span className="font-semibold tabular-nums text-text">{totalCount}</span>
            {isCountingToday ? "agendamentos hoje" : "agendamentos no dia selecionado"}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-xs text-text-secondary ring-1 ring-primary/15">
            <CalendarPlus className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            <span className="font-semibold tabular-nums text-text">{upcomingCount}</span>
            próximos
          </span>
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" aria-label="Período anterior" onClick={goPrev}>
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button variant="outline" size="sm" onClick={goToday}>
            Hoje
          </Button>
          <Button variant="outline" size="icon" aria-label="Próximo período" onClick={goNext}>
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
          <p className="ml-2 text-sm font-medium text-text">
            {view === "day"
              ? formatLongDateLabel(dateISO)
              : formatWeekRangeLabel(startOfWeekISO(dateISO), addDaysISO(startOfWeekISO(dateISO), 6))}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {view === "week" ? (
            <Select
              aria-label="Filtrar semana por profissional"
              value={weekProfessionalId}
              onChange={(e) => setWeekProfessionalId(e.target.value)}
              className="w-auto min-w-[10rem]"
            >
              <option value="">Todos os profissionais</option>
              {activeProfessionals.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          ) : null}
          <div className="flex gap-1 rounded-card border border-border p-1">
            <button
              type="button"
              onClick={() => setView("day")}
              className={cn(
                "flex min-h-11 items-center rounded-card px-3 text-sm transition-colors duration-150 motion-reduce:transition-none",
                view === "day" ? "bg-primary text-white" : "text-text-secondary hover:bg-bg",
              )}
            >
              Dia
            </button>
            <button
              type="button"
              onClick={() => setView("week")}
              className={cn(
                "flex min-h-11 items-center rounded-card px-3 text-sm transition-colors duration-150 motion-reduce:transition-none",
                view === "week" ? "bg-primary text-white" : "text-text-secondary hover:bg-bg",
              )}
            >
              Semana
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <AgendaSkeleton />
      ) : view === "day" ? (
        <DayView
          dateISO={dateISO}
          timezone={timezone}
          professionals={activeProfessionals}
          appointments={appointments}
          exceptions={exceptions}
          now={nowTick}
          onSlotClick={openNovoAt}
          onApptClick={openDetail}
          onReschedule={handleReschedule}
          draggingId={draggingId}
          onDragStateChange={setDraggingId}
          dragDisabled={writeBlocked || rescheduling}
        />
      ) : (
        <WeekView
          weekStartISO={rangeFrom}
          timezone={timezone}
          professionals={activeProfessionals}
          appointments={appointments}
          exceptions={exceptions}
          professionalId={weekProfessionalId}
          now={nowTick}
          onDayClick={(d) => {
            setDateISO(d);
            setView("day");
          }}
          onApptClick={openDetail}
        />
      )}

      <NovoAgendamentoDialog
        tenantSlug={tenantSlug}
        services={agendaServices}
        professionals={agendaProfessionals}
        timezone={timezone}
        open={novoOpen}
        onOpenChange={setNovoOpen}
        prefill={novoPrefill}
        onCreated={() => load()}
        disabled={writeBlocked}
      />
      <DetalheAgendamentoDialog
        tenantSlug={tenantSlug}
        appointment={detail}
        timezone={timezone}
        onOpenChange={(open) => !open && setDetail(null)}
        onUpdated={() => load()}
        disabled={writeBlocked}
      />
    </div>
  );
}

/** Skeleton com shimmer no lugar de "Carregando agenda…" (docs premium, pacote "movimento"). */
function AgendaSkeleton() {
  return (
    <>
      <Card className="hidden overflow-hidden rounded-hero p-4 md:block">
        <div className="flex gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[420px] flex-1" />
          ))}
        </div>
      </Card>
      <div className="flex flex-col gap-4 md:hidden">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-[140px] rounded-hero" />
        ))}
      </div>
    </>
  );
}

function computeWindow(
  dateISO: string,
  professionals: ProfessionalRow[],
  appointments: ApptRaw[],
  timezone: string,
): { startMin: number; endMin: number } {
  const weekday = weekdayOf(dateISO);
  let startMin = DEFAULT_WINDOW_START_MIN;
  let endMin = DEFAULT_WINDOW_END_MIN;

  for (const p of professionals) {
    for (const h of p.workingHours) {
      if (h.weekday !== weekday) continue;
      startMin = Math.min(startMin, toMinutes(h.startTime));
      endMin = Math.max(endMin, toMinutes(h.endTime));
    }
  }
  for (const a of appointments) {
    const startLocal = formatInTimeZone(new Date(a.startsAt), timezone, "HH:mm");
    const endLocal = formatInTimeZone(new Date(a.endsAt), timezone, "HH:mm");
    startMin = Math.min(startMin, toMinutes(startLocal));
    endMin = Math.max(endMin, toMinutes(endLocal));
  }
  return { startMin, endMin };
}

/** Fundo hachurado sutil — sinaliza "fora do expediente" sem parecer um bloqueio visual pesado. */
const OUT_OF_HOURS_STYLE: React.CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(135deg, var(--color-border) 0, var(--color-border) 1px, transparent 1px, transparent 7px)",
  backgroundColor: "var(--color-bg)",
};

/**
 * Fundo hachurado tingido de "alerta" — sinaliza bloqueio/feriado, diferente
 * do hachurado neutro de "fora do expediente" (`OUT_OF_HOURS_STYLE`). Fica
 * por cima do slot livre (bloqueia o clique) mas abaixo de um agendamento
 * real (z-10) — se por acaso já existir um agendamento marcado ali, ele
 * continua visível e clicável em vez de ficar escondido atrás do bloqueio.
 */
const EXCEPTION_BAND_STYLE: React.CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(135deg, var(--color-warning) 0, var(--color-warning) 1.5px, transparent 1.5px, transparent 8px)",
  backgroundColor: "var(--color-warning-bg)",
};

/** Retorna as exceções (bloqueio/feriado) que tocam `dateISO`, dentro do fuso do tenant. */
function exceptionsOverlappingDay(
  exceptions: ScheduleExceptionRow[],
  dateISO: string,
  timezone: string,
): ScheduleExceptionRow[] {
  const dayStart = fromZonedTime(`${dateISO}T00:00:00`, timezone).getTime();
  const dayEnd = fromZonedTime(`${addDaysISO(dateISO, 1)}T00:00:00`, timezone).getTime();
  return exceptions.filter((e) => new Date(e.startsAt).getTime() < dayEnd && new Date(e.endsAt).getTime() > dayStart);
}

/** Posição/altura (px) da parte da exceção que cai dentro da janela visível do dia, ou `null` se não sobra nada. */
function exceptionBandPosition(
  exception: ScheduleExceptionRow,
  dateISO: string,
  timezone: string,
  startMin: number,
  endMin: number,
  rowHeightPx: number,
): { top: number; height: number } | null {
  const dayStartMs = fromZonedTime(`${dateISO}T00:00:00`, timezone).getTime();
  const dayEndMs = fromZonedTime(`${addDaysISO(dateISO, 1)}T00:00:00`, timezone).getTime();
  const clippedStartMs = Math.max(new Date(exception.startsAt).getTime(), dayStartMs);
  const clippedEndMs = Math.min(new Date(exception.endsAt).getTime(), dayEndMs);
  if (clippedEndMs <= clippedStartMs) return null;

  let startLocalMin = toMinutes(formatInTimeZone(new Date(clippedStartMs), timezone, "HH:mm"));
  // "00:00" do dia seguinte (fim exatamente na virada) deve valer como fim do dia (24:00), não início.
  let endLocalMin =
    clippedEndMs === dayEndMs ? 24 * 60 : toMinutes(formatInTimeZone(new Date(clippedEndMs), timezone, "HH:mm"));

  startLocalMin = Math.max(startLocalMin, startMin);
  endLocalMin = Math.min(endLocalMin, endMin);
  if (endLocalMin <= startLocalMin) return null;

  const top = ((startLocalMin - startMin) / SLOT_MIN) * rowHeightPx;
  const height = Math.max(((endLocalMin - startLocalMin) / SLOT_MIN) * rowHeightPx, rowHeightPx / 2);
  return { top, height };
}

function exceptionLabel(exception: ScheduleExceptionRow): string {
  return exception.reason?.trim() || EXCEPTION_TYPE_LABEL[exception.type];
}

/** Mini-resumo flutuante no hover do bloco (docs premium, pacote "agenda interativa"). */
function HoverSummary({ appt, timezone }: { appt: ApptRaw; timezone: string }) {
  return (
    <div
      className="pointer-events-none absolute left-1/2 top-full z-30 mt-1.5 w-48 -translate-x-1/2 rounded-card border border-border bg-surface p-3 text-left text-xs shadow-card-hover"
      role="tooltip"
    >
      <p className="font-semibold text-text">{appt.contact.name ?? "Sem nome"}</p>
      <p className="mt-0.5 text-text-secondary">{appt.service.name}</p>
      <p className="mt-0.5 tabular-nums text-text-secondary">
        {formatTimeLabel(appt.startsAt, timezone)}–{formatTimeLabel(appt.endsAt, timezone)}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
        <AppointmentStatusBadge status={appt.status} />
        <AppointmentSourceBadge source={appt.source} />
      </div>
    </div>
  );
}

/**
 * Bloco de agendamento arrastável (docs premium, "arrastar para remarcar") — só é de fato
 * arrastável quando `status === "SCHEDULED"` (mesma regra do backend, `rescheduleAppointment`
 * só aceita remarcar um agendamento em aberto) e a tela não está bloqueada por escrita/já
 * remarcando. Barra lateral na cor do PROFISSIONAL (`colorForId`) somada ao preenchimento por
 * STATUS — as duas informações cabem juntas sem se atrapalhar.
 */
function DraggableAppointmentBlock({
  appt,
  top,
  height,
  timezone,
  disabled,
  onClick,
}: {
  appt: ApptRaw;
  top: number;
  height: number;
  timezone: string;
  disabled: boolean;
  onClick: () => void;
}) {
  const draggable = appt.status === "SCHEDULED" && !disabled;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: appt.id,
    data: { professionalId: appt.professionalId },
    disabled: !draggable,
  });
  const [hover, setHover] = useState(false);
  const highlighted = useLiveAppointments().highlightedIds.has(appt.id);

  return (
    <div
      className="absolute z-10"
      style={{ top, height, left: 4, right: 4 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        ref={setNodeRef}
        type="button"
        onClick={onClick}
        style={{ borderLeftColor: colorForId(appt.professionalId) }}
        className={cn(
          "h-full w-full overflow-hidden rounded-card border-l-[3px] p-1.5 text-left text-xs shadow-card",
          "transition-[transform,opacity] duration-150 hover:-translate-y-px motion-reduce:transition-none motion-reduce:hover:translate-y-0",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white",
          draggable ? "cursor-grab touch-none active:cursor-grabbing" : "cursor-pointer",
          isDragging && "opacity-0",
          highlighted && "appt-highlight",
          STATUS_BLOCK_CLASSES[appt.status],
        )}
        {...listeners}
        {...attributes}
      >
        <p className="truncate font-semibold tabular-nums">{formatTimeLabel(appt.startsAt, timezone)}</p>
        <p className="truncate font-medium">{appt.service.name}</p>
        <p className="truncate opacity-90">{appt.contact.name ?? "Sem nome"}</p>
      </button>
      {hover && !isDragging ? <HoverSummary appt={appt} timezone={timezone} /> : null}
    </div>
  );
}

/** Célula de horário — droppable durante o arraste; nunca aceita solta em folga/bloqueio. */
function DroppableSlotCell({
  id,
  disabled,
  top,
  height,
  onClick,
  ariaLabel,
}: {
  id: string;
  disabled: boolean;
  top: number;
  height: number;
  onClick: () => void;
  ariaLabel: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id, disabled });
  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={onClick}
      style={{ top, height }}
      className={cn(
        "absolute left-0 right-0 border-b border-border transition-colors duration-150 hover:bg-bg motion-reduce:transition-none",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        isOver && !disabled && "bg-primary/15",
      )}
      aria-label={ariaLabel}
    />
  );
}

function DayView({
  dateISO,
  timezone,
  professionals,
  appointments,
  exceptions,
  now,
  onSlotClick,
  onApptClick,
  onReschedule,
  draggingId,
  onDragStateChange,
  dragDisabled = false,
}: {
  dateISO: string;
  timezone: string;
  professionals: ProfessionalRow[];
  appointments: ApptRaw[];
  exceptions: ScheduleExceptionRow[];
  now: Date;
  onSlotClick: (professionalId: string, startsAtISO: string) => void;
  onApptClick: (a: ApptRaw) => void;
  /** Arrastar para remarcar é opcional — só o `DayView` do painel do tenant usa; `WeekView`
   * continua só com clique (ver PENDÊNCIAS no handoff: cobrir a semana fica para outra rodada). */
  onReschedule?: (appointmentId: string, newStartsAtISO: string) => void;
  draggingId?: string | null;
  onDragStateChange?: (id: string | null) => void;
  dragDisabled?: boolean;
}) {
  const highlightedIds = useLiveAppointments().highlightedIds;
  const { notify } = useToast();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );
  const { startMin, endMin } = useMemo(
    () => computeWindow(dateISO, professionals, appointments, timezone),
    [dateISO, professionals, appointments, timezone],
  );
  const totalSlots = Math.max(1, Math.ceil((endMin - startMin) / SLOT_MIN));
  const columnHeight = totalSlots * ROW_HEIGHT_PX;

  const isToday = formatInTimeZone(now, timezone, "yyyy-MM-dd") === dateISO;
  const nowMin = isToday ? toMinutes(formatInTimeZone(now, timezone, "HH:mm")) : null;
  const nowTopPx = nowMin !== null && nowMin >= startMin && nowMin <= endMin ? ((nowMin - startMin) / SLOT_MIN) * ROW_HEIGHT_PX : null;

  function slotToISO(minuteOffset: number): string {
    const totalMin = startMin + minuteOffset;
    const hh = String(Math.floor(totalMin / 60)).padStart(2, "0");
    const mm = String(totalMin % 60).padStart(2, "0");
    return fromZonedTime(`${dateISO}T${hh}:${mm}:00`, timezone).toISOString();
  }

  const byProfessional = (professionalId: string) => appointments.filter((a) => a.professionalId === professionalId);

  const weekday = weekdayOf(dateISO);
  function isWithinWorkingHours(prof: ProfessionalRow, minuteOffset: number): boolean {
    const min = startMin + minuteOffset;
    return prof.workingHours.some((h) => h.weekday === weekday && min >= toMinutes(h.startTime) && min < toMinutes(h.endTime));
  }

  const dayExceptions = useMemo(() => exceptionsOverlappingDay(exceptions, dateISO, timezone), [exceptions, dateISO, timezone]);
  /** Bloqueio/feriado da empresa inteira (`professionalId: null`) vale para todo profissional. */
  function bandsForProfessional(professionalId: string): ScheduleExceptionRow[] {
    return dayExceptions.filter((e) => e.professionalId === null || e.professionalId === professionalId);
  }

  /** Nunca dá para soltar (arrastar) num slot com bloqueio/feriado — mesma regra do dono. */
  function slotBlockedByException(professionalId: string, minuteOffset: number): boolean {
    const min = startMin + minuteOffset;
    return bandsForProfessional(professionalId).some((e) => {
      const position = exceptionBandPosition(e, dateISO, timezone, startMin, endMin, ROW_HEIGHT_PX);
      if (!position) return false;
      const bandStartMin = startMin + position.top / ROW_HEIGHT_PX * SLOT_MIN;
      const bandEndMin = bandStartMin + (position.height / ROW_HEIGHT_PX) * SLOT_MIN;
      return min >= bandStartMin && min < bandEndMin;
    });
  }

  const draggingAppt = draggingId ? appointments.find((a) => a.id === draggingId) : undefined;

  function handleDragStart(event: DragStartEvent) {
    onDragStateChange?.(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    onDragStateChange?.(null);
    const { active, over } = event;
    if (!over) return;
    const draggedProfessionalId = active.data.current?.professionalId as string | undefined;
    const [overProfessionalId, slotIndexStr] = String(over.id).split(":");
    if (!draggedProfessionalId || overProfessionalId !== draggedProfessionalId) {
      notify({
        variant: "info",
        title: "Não é possível mudar de profissional arrastando",
        description: "Abra o agendamento e use \"Remarcar\" para trocar de profissional.",
      });
      return;
    }
    const slotIndex = Number(slotIndexStr);
    onReschedule?.(String(active.id), slotToISO(slotIndex * SLOT_MIN));
  }

  return (
    <>
      {/* Desktop/tablet: colunas por profissional */}
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      {/* Responsivo (docs premium, requisito reforçado 2026-09-29): a GRADE rola por dentro
          (`max-h-*` + `overflow-auto` neste wrapper, não a página inteira) com cabeçalho de
          horas (coluna) e de profissionais (linha) fixos via `sticky` — testado sem rolagem
          horizontal da página em 360/390/768/1024/1440px (ver handoff, matriz de breakpoints). */}
      <Card className="hidden overflow-auto rounded-hero md:block" style={{ maxHeight: "calc(100vh - 280px)" }}>
        <div className="flex min-w-full">
          <div className="sticky left-0 z-20 w-16 shrink-0 border-r border-border bg-surface">
            <div className="sticky top-0 z-30 h-14 border-b border-border bg-surface" />
            {Array.from({ length: totalSlots }).map((_, i) => {
              const min = startMin + i * SLOT_MIN;
              const label = min % 60 === 0 ? `${String(Math.floor(min / 60)).padStart(2, "0")}:00` : "";
              return (
                <div
                  key={i}
                  style={{ height: ROW_HEIGHT_PX }}
                  className="border-b border-border px-2 text-right text-xs tabular-nums text-text-secondary"
                >
                  {label}
                </div>
              );
            })}
          </div>

          {professionals.map((prof) => {
            const todaysHours = workingHoursForWeekday(prof, weekday);
            const isOffToday = todaysHours.length === 0;
            return (
              <div key={prof.id} className="min-w-[13rem] flex-1 border-r border-border last:border-r-0">
                <div className="sticky top-0 z-20 flex h-14 flex-col items-center justify-center border-b border-border bg-surface px-2 text-center">
                  <div className="flex items-center gap-1.5">
                    <Avatar id={prof.id} name={prof.name} size="sm" />
                    <p className="truncate text-sm font-medium text-text">{prof.name}</p>
                  </div>
                  <p className={cn("truncate text-[11px] tabular-nums", isOffToday ? "font-medium text-text-secondary" : "text-text-secondary")}>
                    {workingHoursSummary(todaysHours)}
                  </p>
                </div>
                <div className="relative" style={{ height: columnHeight }}>
                  {isOffToday ? (
                    <div
                      className="absolute inset-0 flex items-center justify-center text-xs text-text-secondary"
                      style={OUT_OF_HOURS_STYLE}
                      aria-label={`${prof.name} não atende neste dia`}
                    >
                      <span className="rounded-full border border-border bg-surface px-3 py-1">Folga</span>
                    </div>
                  ) : (
                    Array.from({ length: totalSlots }).map((_, i) => {
                      const withinHours = isWithinWorkingHours(prof, i * SLOT_MIN);
                      if (!withinHours) {
                        return (
                          <div
                            key={i}
                            style={{ top: i * ROW_HEIGHT_PX, height: ROW_HEIGHT_PX, ...OUT_OF_HOURS_STYLE }}
                            className="absolute left-0 right-0 border-b border-border"
                            aria-hidden="true"
                          />
                        );
                      }
                      return (
                        <DroppableSlotCell
                          key={i}
                          id={`${prof.id}:${i}`}
                          disabled={!draggingId || dragDisabled || slotBlockedByException(prof.id, i * SLOT_MIN)}
                          top={i * ROW_HEIGHT_PX}
                          height={ROW_HEIGHT_PX}
                          onClick={() => onSlotClick(prof.id, slotToISO(i * SLOT_MIN))}
                          ariaLabel={`Novo agendamento com ${prof.name} às ${minutesToHHMM(startMin + i * SLOT_MIN)}`}
                        />
                      );
                    })
                  )}

                  {!isOffToday &&
                    bandsForProfessional(prof.id).map((exception) => {
                      const position = exceptionBandPosition(exception, dateISO, timezone, startMin, endMin, ROW_HEIGHT_PX);
                      if (!position) return null;
                      return (
                        <div
                          key={exception.id}
                          style={{ top: position.top, height: position.height, ...EXCEPTION_BAND_STYLE }}
                          className="absolute left-0 right-0 z-[8] flex items-center overflow-hidden px-1.5 text-[11px] font-medium text-warning"
                          title={`${EXCEPTION_TYPE_LABEL[exception.type]}${exception.reason ? ` — ${exception.reason}` : ""}`}
                        >
                          <span className="truncate">{exceptionLabel(exception)}</span>
                        </div>
                      );
                    })}

                  {byProfessional(prof.id).map((a) => {
                    const startLocalMin = toMinutes(formatInTimeZone(new Date(a.startsAt), timezone, "HH:mm"));
                    const endLocalMin = toMinutes(formatInTimeZone(new Date(a.endsAt), timezone, "HH:mm"));
                    const top = ((startLocalMin - startMin) / SLOT_MIN) * ROW_HEIGHT_PX;
                    const height = Math.max(((endLocalMin - startLocalMin) / SLOT_MIN) * ROW_HEIGHT_PX, ROW_HEIGHT_PX / 2);
                    return (
                      <DraggableAppointmentBlock
                        key={a.id}
                        appt={a}
                        top={top}
                        height={height}
                        timezone={timezone}
                        disabled={dragDisabled}
                        onClick={() => onApptClick(a)}
                      />
                    );
                  })}

                  {nowTopPx !== null ? (
                    <div className="pointer-events-none absolute left-0 right-0 z-20 border-t-2 border-danger" style={{ top: nowTopPx }}>
                      <span className="absolute -left-1 -top-1.5 flex h-3 w-3">
                        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-danger opacity-60" aria-hidden="true" />
                        <span className="relative inline-flex h-3 w-3 rounded-full bg-danger" aria-hidden="true" />
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
      <DragOverlay>
        {draggingAppt ? (
          <div
            className={cn("w-44 rounded-card border-l-[3px] p-1.5 text-left text-xs shadow-card-hover", STATUS_BLOCK_CLASSES[draggingAppt.status])}
            style={{ borderLeftColor: colorForId(draggingAppt.professionalId) }}
          >
            <p className="truncate font-semibold tabular-nums">{formatTimeLabel(draggingAppt.startsAt, timezone)}</p>
            <p className="truncate font-medium">{draggingAppt.service.name}</p>
          </div>
        ) : null}
      </DragOverlay>
      </DndContext>

      {/* Celular: lista por profissional */}
      <div className="flex flex-col gap-4 md:hidden">
        {professionals.map((prof) => {
          const items = byProfessional(prof.id).sort((a, b) => a.startsAt.toString().localeCompare(b.startsAt.toString()));
          const todaysHours = workingHoursForWeekday(prof, weekday);
          const isOffToday = todaysHours.length === 0;
          const bands = bandsForProfessional(prof.id);
          return (
            <Card key={prof.id}>
              <div className="flex items-center justify-between gap-3 border-b border-border p-4">
                <div className="min-w-0">
                  <p className="font-display text-sm font-bold text-text [overflow-wrap:anywhere]">{prof.name}</p>
                  <p className="text-xs tabular-nums text-text-secondary">{workingHoursSummary(todaysHours)}</p>
                  {!isOffToday && bands.length > 0 ? (
                    <p className="mt-0.5 text-xs font-medium text-warning">
                      {bands.map((e) => exceptionLabel(e)).join(", ")}
                    </p>
                  ) : null}
                </div>
                {!isOffToday ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    onClick={() => onSlotClick(prof.id, slotToISO(Math.max(0, (nowMin ?? startMin) - startMin)))}
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    Agendar
                  </Button>
                ) : null}
              </div>
              <div className="flex flex-col divide-y divide-border">
                {isOffToday && items.length === 0 ? (
                  <p className="p-4 text-sm text-text-secondary">Folga — não atende neste dia.</p>
                ) : items.length === 0 ? (
                  <p className="p-4 text-sm text-text-secondary">Nenhum agendamento neste dia.</p>
                ) : (
                  items.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => onApptClick(a)}
                      className={cn("flex items-center justify-between gap-3 p-4 text-left transition-colors duration-150 hover:bg-bg motion-reduce:transition-none", highlightedIds.has(a.id) && "appt-highlight")}
                    >
                      <div>
                        <p className="text-sm font-medium text-text">{a.service.name}</p>
                        <p className="text-xs text-text-secondary">{a.contact.name ?? "Sem nome"}</p>
                      </div>
                      <Badge variant={STATUS_BADGE_VARIANT[a.status]} className="tabular-nums">
                        {formatTimeLabel(a.startsAt, timezone)}
                      </Badge>
                    </button>
                  ))
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}

function computeWeekWindow(
  days: string[],
  professionals: ProfessionalRow[],
  appointments: ApptRaw[],
  timezone: string,
): { startMin: number; endMin: number } {
  let startMin = DEFAULT_WINDOW_START_MIN;
  let endMin = DEFAULT_WINDOW_END_MIN;
  for (const dateISO of days) {
    const window = computeWindow(dateISO, professionals, appointments, timezone);
    startMin = Math.min(startMin, window.startMin);
    endMin = Math.max(endMin, window.endMin);
  }
  return { startMin, endMin };
}

function WeekView({
  weekStartISO,
  timezone,
  professionals,
  appointments,
  exceptions,
  professionalId,
  now,
  onDayClick,
  onApptClick,
}: {
  weekStartISO: string;
  timezone: string;
  professionals: ProfessionalRow[];
  appointments: ApptRaw[];
  exceptions: ScheduleExceptionRow[];
  professionalId: string;
  now: Date;
  onDayClick: (dateISO: string) => void;
  onApptClick: (a: ApptRaw) => void;
}) {
  const highlightedIds = useLiveAppointments().highlightedIds;
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDaysISO(weekStartISO, i)), [weekStartISO]);

  const filteredProfessionals = professionalId ? professionals.filter((p) => p.id === professionalId) : professionals;
  const filteredAppointments = professionalId
    ? appointments.filter((a) => a.professionalId === professionalId)
    : appointments;
  // "Todos": mostra bloqueio da empresa OU de qualquer profissional ativo filtrado; com um
  // profissional selecionado, só o dele + o da empresa inteira.
  const relevantProfessionalIds = new Set(filteredProfessionals.map((p) => p.id));
  function bandsForDay(dateISO: string): ScheduleExceptionRow[] {
    return exceptionsOverlappingDay(exceptions, dateISO, timezone).filter(
      (e) => e.professionalId === null || relevantProfessionalIds.has(e.professionalId),
    );
  }

  const { startMin, endMin } = useMemo(
    () => computeWeekWindow(days, filteredProfessionals, filteredAppointments, timezone),
    [days, filteredProfessionals, filteredAppointments, timezone],
  );
  const totalSlots = Math.max(1, Math.ceil((endMin - startMin) / SLOT_MIN));
  const columnHeight = totalSlots * WEEK_ROW_HEIGHT_PX;
  const todayISO = formatInTimeZone(now, timezone, "yyyy-MM-dd");

  function isWithinAnyWorkingHours(dateISO: string, minuteOffset: number): boolean {
    const weekday = weekdayOf(dateISO);
    const min = startMin + minuteOffset;
    return filteredProfessionals.some((p) =>
      p.workingHours.some((h) => h.weekday === weekday && min >= toMinutes(h.startTime) && min < toMinutes(h.endTime)),
    );
  }

  function apptsForDay(dateISO: string) {
    return filteredAppointments
      .filter((a) => formatInTimeZone(new Date(a.startsAt), timezone, "yyyy-MM-dd") === dateISO)
      .sort((a, b) => a.startsAt.toString().localeCompare(b.startsAt.toString()));
  }

  return (
    <>
      {/* Desktop/tablet: grade por horário, 7 colunas (dias) */}
      <Card className="hidden overflow-x-auto rounded-hero md:block">
        <div className="flex min-w-full">
          <div className="w-14 shrink-0 border-r border-border">
            <div className="h-14 border-b border-border" />
            {Array.from({ length: totalSlots }).map((_, i) => {
              const min = startMin + i * SLOT_MIN;
              const label = min % 60 === 0 ? `${String(Math.floor(min / 60)).padStart(2, "0")}:00` : "";
              return (
                <div
                  key={i}
                  style={{ height: WEEK_ROW_HEIGHT_PX }}
                  className="border-b border-border px-2 text-right text-[11px] tabular-nums text-text-secondary"
                >
                  {label}
                </div>
              );
            })}
          </div>

          {days.map((dateISO) => {
            const isToday = dateISO === todayISO;
            const dayAppts = apptsForDay(dateISO);
            return (
              <div
                key={dateISO}
                className={cn("min-w-[8.5rem] flex-1 border-r border-border last:border-r-0", isToday && "bg-primary/5")}
              >
                <button
                  type="button"
                  onClick={() => onDayClick(dateISO)}
                  className={cn(
                    "flex h-14 w-full flex-col items-center justify-center border-b border-border text-center transition-colors duration-150 hover:bg-bg motion-reduce:transition-none",
                    isToday && "border-b-primary",
                  )}
                >
                  <p className="text-[11px] text-text-secondary">{formatShortWeekdayLabel(dateISO, { capitalize: true })}</p>
                  <p
                    className={cn(
                      "flex h-6 w-6 items-center justify-center rounded-full text-sm font-bold tabular-nums",
                      isToday ? "bg-primary text-white" : "text-text",
                    )}
                  >
                    {formatDayNumber(dateISO)}
                  </p>
                </button>
                <div className="relative" style={{ height: columnHeight }}>
                  {Array.from({ length: totalSlots }).map((_, i) => {
                    const withinHours = isWithinAnyWorkingHours(dateISO, i * SLOT_MIN);
                    return (
                      <div
                        key={i}
                        style={{
                          top: i * WEEK_ROW_HEIGHT_PX,
                          height: WEEK_ROW_HEIGHT_PX,
                          ...(withinHours ? {} : OUT_OF_HOURS_STYLE),
                        }}
                        className="absolute left-0 right-0 border-b border-border"
                        aria-hidden="true"
                      />
                    );
                  })}

                  {bandsForDay(dateISO).map((exception) => {
                    const position = exceptionBandPosition(exception, dateISO, timezone, startMin, endMin, WEEK_ROW_HEIGHT_PX);
                    if (!position) return null;
                    return (
                      <div
                        key={exception.id}
                        style={{ top: position.top, height: position.height, ...EXCEPTION_BAND_STYLE }}
                        className="absolute left-0 right-0 z-[8] flex items-center overflow-hidden px-1 text-[10px] font-medium text-warning"
                        title={`${EXCEPTION_TYPE_LABEL[exception.type]}${exception.reason ? ` — ${exception.reason}` : ""}`}
                      >
                        <span className="truncate">{exceptionLabel(exception)}</span>
                      </div>
                    );
                  })}

                  {dayAppts.map((a) => {
                    const startLocalMin = toMinutes(formatInTimeZone(new Date(a.startsAt), timezone, "HH:mm"));
                    const endLocalMin = toMinutes(formatInTimeZone(new Date(a.endsAt), timezone, "HH:mm"));
                    const top = ((startLocalMin - startMin) / SLOT_MIN) * WEEK_ROW_HEIGHT_PX;
                    const height = Math.max(((endLocalMin - startLocalMin) / SLOT_MIN) * WEEK_ROW_HEIGHT_PX, WEEK_ROW_HEIGHT_PX);
                    return (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => onApptClick(a)}
                        style={{ top, height, left: 3, right: 3 }}
                        className={cn(
                          "absolute z-10 overflow-hidden rounded-[4px] px-1.5 py-0.5 text-left text-[11px] leading-tight shadow-card transition-transform duration-150 hover:-translate-y-px motion-reduce:transition-none motion-reduce:hover:translate-y-0",
                          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white",
                          highlightedIds.has(a.id) && "appt-highlight",
                          STATUS_BLOCK_CLASSES[a.status],
                        )}
                        title={`${formatTimeLabel(a.startsAt, timezone)} · ${a.service.name} · ${a.professional.name}`}
                      >
                        <span className="tabular-nums font-semibold">{formatTimeLabel(a.startsAt, timezone)}</span>{" "}
                        <span className="truncate">{a.service.name}</span>
                        {!professionalId ? <span className="block truncate opacity-90">{a.professional.name}</span> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Celular: lista agrupada por dia */}
      <div className="flex flex-col gap-3 md:hidden">
        {days.map((dateISO) => {
          const isToday = dateISO === todayISO;
          const dayAppts = apptsForDay(dateISO);
          const bands = bandsForDay(dateISO);
          return (
            <Card key={dateISO} className={cn(isToday && "ring-1 ring-primary")}>
              <button
                type="button"
                onClick={() => onDayClick(dateISO)}
                className="flex w-full items-center justify-between gap-3 border-b border-border p-3 text-left transition-colors duration-150 hover:bg-bg motion-reduce:transition-none"
              >
                <div>
                  <p className="text-sm font-medium text-text">
                    {capitalizeFirst(formatShortWeekdayLabel(dateISO))}, {formatDayNumber(dateISO)}
                  </p>
                  {bands.length > 0 ? (
                    <p className="mt-0.5 text-xs font-medium text-warning">{bands.map((e) => exceptionLabel(e)).join(", ")}</p>
                  ) : null}
                </div>
                {isToday ? <Badge variant="primary">Hoje</Badge> : null}
              </button>
              <div className="flex flex-col divide-y divide-border">
                {dayAppts.length === 0 ? (
                  <p className="p-3 text-sm text-text-secondary">Sem agendamentos</p>
                ) : (
                  dayAppts.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => onApptClick(a)}
                      className={cn("flex items-center justify-between gap-3 p-3 text-left transition-colors duration-150 hover:bg-bg motion-reduce:transition-none", highlightedIds.has(a.id) && "appt-highlight")}
                    >
                      <div>
                        <p className="text-sm font-medium text-text">{a.service.name}</p>
                        <p className="text-xs text-text-secondary">{a.professional.name}</p>
                      </div>
                      <Badge variant={STATUS_BADGE_VARIANT[a.status]} className="tabular-nums">
                        {formatTimeLabel(a.startsAt, timezone)}
                      </Badge>
                    </button>
                  ))
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </>
  );
}
