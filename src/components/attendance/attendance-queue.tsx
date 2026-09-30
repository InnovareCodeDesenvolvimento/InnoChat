"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Moon, RefreshCw } from "lucide-react";
import { cn } from "@/components/lib/cn";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { InnoAnimated } from "@/components/onboarding/inno-animated";
import { formatRelativeTime } from "@/components/notifications/notification-utils";
import {
  ATTENDANCE_TABS,
  isLongWait,
  itemsForTab,
  longestWaitingId,
  messagePreview,
  waitingSince,
  type AttendanceItem,
  type AttendanceTab,
} from "./attendance-utils";

export type QueueStatus = "loading" | "ready" | "error";

const EMPTY_COPY: Record<AttendanceTab, { title: string; hint: string }> = {
  waiting: { title: "Nenhum cliente aguardando atendimento", hint: "Quando alguém pedir um atendente, aparece aqui na hora." },
  active: { title: "Nenhuma conversa em atendimento", hint: "Responda quem está aguardando para abrir um atendimento." },
  recent: { title: "Nenhum atendimento encerrado nas últimas 24 horas", hint: "Os atendimentos encerrados ficam aqui por um dia." },
};

/** Relógio que só serve para o "há 5 min" não congelar entre um poll e outro. */
function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/**
 * Fila do Atendimento (coluna da esquerda): três abas — Aguardando (N), Em atendimento e
 * Encerrados (24h) — e a lista de clientes. Quem espera há mais tempo fica no topo da aba
 * Aguardando com destaque. Cada linha é um botão de 64px+ (alvo de toque > 44px).
 */
export function AttendanceQueue({
  items,
  waitingCount,
  status,
  errorMessage,
  tab,
  onTabChange,
  selectedContactId,
  onSelect,
  onRetry,
}: {
  items: AttendanceItem[];
  waitingCount: number;
  status: QueueStatus;
  errorMessage: string | null;
  tab: AttendanceTab;
  onTabChange: (tab: AttendanceTab) => void;
  selectedContactId: string | null;
  onSelect: (contactId: string) => void;
  onRetry: () => void;
}) {
  const now = useNow(30_000);
  const tabRefs = useRef<Partial<Record<AttendanceTab, HTMLButtonElement | null>>>({});
  const list = itemsForTab(items, tab);
  const longestId = tab === "waiting" && list.length > 1 ? longestWaitingId(items) : null;

  function onTabKeyDown(e: React.KeyboardEvent, index: number) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const last = ATTENDANCE_TABS.length - 1;
    const next = e.key === "Home" ? 0 : e.key === "End" ? last : e.key === "ArrowRight" ? (index + 1) % (last + 1) : (index + last) % (last + 1);
    const target = ATTENDANCE_TABS[next].id;
    onTabChange(target);
    tabRefs.current[target]?.focus();
  }

  return (
    <section aria-label="Fila de atendimento" className="flex min-h-0 flex-1 flex-col" data-testid="attendance-queue">
      <div role="tablist" aria-label="Filtrar a fila" className="flex shrink-0 gap-1 border-b border-border p-2">
        {ATTENDANCE_TABS.map((t, index) => {
          const selected = t.id === tab;
          return (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`att-tab-${t.id}`}
              aria-selected={selected}
              aria-controls="att-tabpanel"
              tabIndex={selected ? 0 : -1}
              onClick={() => onTabChange(t.id)}
              onKeyDown={(e) => onTabKeyDown(e, index)}
              className={cn(
                "flex min-h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-card px-2 text-center text-xs font-semibold leading-tight transition-colors duration-150 motion-reduce:transition-none",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                selected ? "bg-primary/10 text-primary" : "text-text-secondary hover:bg-bg hover:text-text",
              )}
            >
              <span className="min-w-0">
                {t.label}
                {t.id === "waiting" ? ` (${waitingCount})` : null}
              </span>
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id="att-tabpanel"
        aria-labelledby={`att-tab-${tab}`}
        aria-busy={status === "loading"}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {status === "loading" ? (
          <div className="flex flex-col" aria-hidden="true">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3 border-b border-border px-3 py-3">
                <Skeleton className="h-10 w-10 shrink-0 rounded-full" />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <Skeleton className="h-3.5 w-2/5" />
                  <Skeleton className="h-3 w-4/5" />
                </div>
              </div>
            ))}
          </div>
        ) : status === "error" && items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center" role="alert">
            <AlertCircle className="h-8 w-8 text-danger" aria-hidden="true" />
            <p className="text-sm text-text-secondary">{errorMessage ?? "Não deu para carregar a fila agora."}</p>
            <Button type="button" variant="secondary" icon={RefreshCw} onClick={onRetry}>
              Tentar de novo
            </Button>
          </div>
        ) : list.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center" data-testid="attendance-queue-empty">
            <InnoAnimated variant="avatar" size={72} />
            <p className="text-sm font-semibold text-text">{EMPTY_COPY[tab].title}</p>
            <p className="text-xs text-text-secondary">{EMPTY_COPY[tab].hint}</p>
          </div>
        ) : (
          <ul className="flex flex-col">
            {list.map((item) => (
              <QueueRow
                key={item.contactId}
                item={item}
                now={now}
                selected={item.contactId === selectedContactId}
                highlighted={item.contactId === longestId}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function QueueRow({
  item,
  now,
  selected,
  highlighted,
  onSelect,
}: {
  item: AttendanceItem;
  now: Date;
  selected: boolean;
  highlighted: boolean;
  onSelect: (contactId: string) => void;
}) {
  const since = item.status === "WAITING" ? waitingSince(item) : (item.lastMessage?.createdAt ?? item.requestedAt);
  const relative = since ? formatRelativeTime(since, now) : "";
  const longWait = isLongWait(item, now);
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(item.contactId)}
        aria-current={selected ? "true" : undefined}
        data-contact-id={item.contactId}
        data-highlighted={highlighted ? "true" : undefined}
        className={cn(
          "relative flex min-h-16 w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left transition-colors duration-150 motion-reduce:transition-none",
          "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary",
          selected ? "bg-primary/10" : highlighted ? "bg-warning-bg/60 hover:bg-warning-bg" : "hover:bg-bg",
        )}
      >
        {highlighted ? <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-warning" /> : null}
        <Avatar id={item.contactId} name={item.contactName} className="h-10 w-10 text-sm" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-sm font-semibold text-text">{item.contactName}</span>
            {relative ? (
              <span className={cn("shrink-0 text-xs tabular-nums", longWait ? "font-semibold text-warning" : "text-text-secondary")}>
                {relative}
              </span>
            ) : null}
          </span>
          <span className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-xs text-text-secondary">{messagePreview(item)}</span>
            {item.offHours ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning-bg px-2 py-0.5 text-[11px] font-medium text-warning ring-1 ring-warning/25">
                <Moon className="h-3 w-3" aria-hidden="true" />
                Fora do horário
              </span>
            ) : null}
          </span>
        </span>
      </button>
    </li>
  );
}
