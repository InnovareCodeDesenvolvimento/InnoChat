import { BellRing, Check, ListChecks } from "lucide-react";
import { cn } from "@/components/lib/cn";
import { AgendaCard, InkCheck, Notif } from "./day-story-pieces";
import type { JourneyStepId } from "./journey-data";

/**
 * Cartão que acompanha cada passo da jornada, ao lado do celular. Tudo ilustrativo (decorativo para
 * leitor de tela: o texto do passo já conta a mesma coisa) e com dados fictícios. Nenhum número de
 * resultado; só situações que o produto de fato tem: notificação, passos do bot, agenda,
 * lembrete e a situação "Atendido" da agenda.
 */
const FLOW = ["Serviço", "Dia", "Horário", "Confirmação"];

function Row({
  time,
  name,
  service,
  badge,
  highlight,
  muted,
}: {
  time: string;
  name: string;
  service: string;
  badge: string;
  highlight?: boolean;
  muted?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-xl px-3 py-2 transition-colors",
        highlight ? "bg-success-bg ring-1 ring-success/40" : "bg-bg",
        muted && "opacity-70",
      )}
    >
      <span className="w-12 shrink-0 font-display text-base font-bold tabular-nums text-text">{time}</span>
      <div className="min-w-0 flex-1 leading-tight">
        <p className="truncate text-sm font-semibold text-text">{name}</p>
        <p className="truncate text-xs text-text-secondary">{service}</p>
      </div>
      <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-xs font-semibold text-success ring-1 ring-success/30">
        <InkCheck className="h-3.5 w-3.5" />
        {badge}
      </span>
    </div>
  );
}

export function JourneyCard({ id }: { id: JourneyStepId }) {
  switch (id) {
    case "mensagem":
      return (
        <div className="space-y-2">
          <p className="px-1 text-xs font-bold uppercase tracking-wider text-sidebar-text">Notificação na empresa</p>
          <Notif name="Camila" text="oi" time="09:41" buzz={false} />
        </div>
      );
    case "resposta":
      return (
        <div className="rounded-2xl border border-border bg-surface p-4 shadow-card">
          <p className="pb-3 text-xs font-bold uppercase tracking-wider text-text-secondary">O bot conduz o cliente</p>
          <ol className="space-y-2">
            {FLOW.map((label, index) => (
              <li key={label} className="flex items-center gap-3 rounded-xl bg-bg px-3 py-2">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-white">
                  {index + 1}
                </span>
                <span className="text-sm font-semibold text-text">{label}</span>
              </li>
            ))}
          </ol>
          <p className="mt-3 flex items-center gap-1.5 text-xs text-text-secondary">
            <ListChecks className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Tudo por menu numerado, sem ninguém digitar
          </p>
        </div>
      );
    case "agenda":
      return (
        <AgendaCard title="Agenda · Studio Bella">
          <Row time="09:00" name="Bianca" service="Escova modelada" badge="Agendado" muted />
          <Row time="10:30" name="Marina" service="Coloração" badge="Agendado" muted />
          <Row time="14:00" name="Camila" service="Corte feminino" badge="Agendado" highlight />
        </AgendaCard>
      );
    case "lembrete":
      return (
        <div className="rounded-2xl border border-border bg-surface p-4 shadow-card">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card bg-warning-bg text-warning">
              <BellRing className="h-5 w-5" aria-hidden="true" />
            </span>
            <div className="min-w-0 leading-tight">
              <p className="text-sm font-bold text-text">Lembrete enviado</p>
              <p className="mt-1 text-xs text-text-secondary">No dia anterior, às 09:00</p>
            </div>
          </div>
          <p className="mt-3 rounded-xl bg-bg px-3 py-2 text-sm text-text">
            <span className="font-semibold">Camila</span>
            <span className="text-text-secondary"> · Corte feminino · 14:00</span>
          </p>
        </div>
      );
    case "cliente":
      return (
        <AgendaCard title="Agenda · Studio Bella">
          <Row time="09:00" name="Bianca" service="Escova modelada" badge="Atendido" muted />
          <Row time="10:30" name="Marina" service="Coloração" badge="Atendido" muted />
          <Row time="14:00" name="Camila" service="Corte feminino" badge="Atendido" highlight />
          <p className="flex items-center gap-1.5 px-1 pt-1 text-xs font-semibold text-success">
            <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden="true" />
            Camila foi atendida às 14:00
          </p>
        </AgendaCard>
      );
  }
}
