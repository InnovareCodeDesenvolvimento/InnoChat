import { formatInTimeZone } from "date-fns-tz";
import type { BellNotification } from "./types";

/** Intervalo normal do polling (pedido do dono: 30 s). */
export const POLL_INTERVAL_MS = 30_000;
/** Teto do backoff em caso de erro — 5 min. */
export const POLL_MAX_DELAY_MS = 5 * 60_000;
/** Nunca empilhar mais de 3 toasts; o resto vai só para o sino. */
export const MAX_VISIBLE_TOASTS = 3;

/**
 * Atraso até o próximo poll. 0 falhas = intervalo normal; cada falha consecutiva dobra o atraso
 * (60 s, 120 s…) até o teto — nunca martela um servidor que já está com problema.
 */
export function nextPollDelay(consecutiveFailures: number, base = POLL_INTERVAL_MS, max = POLL_MAX_DELAY_MS): number {
  if (consecutiveFailures <= 0) return base;
  return Math.min(base * 2 ** consecutiveFailures, max);
}

/** "agora mesmo" / "há 5 min" / "há 3h" / "ontem" / "há 4 dias" / "12/09". */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const diffMs = now.getTime() - new Date(iso).getTime();
  if (Number.isNaN(diffMs) || diffMs < 60_000) return "agora mesmo";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours}h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "ontem";
  if (days < 7) return `há ${days} dias`;
  return formatInTimeZone(new Date(iso), "UTC", "dd/MM");
}

/**
 * Contador dentro do sino: "9+" a partir de 10 (o `aria-label` do botão carrega o número
 * exato, então nada se perde para leitor de tela).
 */
export function badgeText(count: number): string {
  return count > 9 ? "9+" : String(count);
}

export function unreadAriaLabel(count: number): string {
  if (count <= 0) return "Notificações, nenhuma não lida";
  return count === 1 ? "Notificações, 1 notificação não lida" : `Notificações, ${count} notificações não lidas`;
}

const TITLE_COUNT_RE = /^\(\d+\)\s+/;

/** Título original da aba, sem o prefixo "(3) " que nós mesmos colocamos. */
export function stripTitleCount(title: string): string {
  return title.replace(TITLE_COUNT_RE, "");
}

/** "(3) InnoChat — Painel" — sem prefixo quando não há não lidas. */
export function titleWithCount(title: string, count: number): string {
  const base = stripTitleCount(title);
  return count > 0 ? `(${count}) ${base}` : base;
}

export type NotificationGroup<T extends BellNotification = BellNotification> = {
  key: "today" | "yesterday" | "earlier";
  label: string;
  items: T[];
};

const GROUP_LABEL: Record<NotificationGroup["key"], string> = {
  today: "Hoje",
  yesterday: "Ontem",
  earlier: "Anteriores",
};

/** Agrupa (já em ordem decrescente) por dia civil no fuso da empresa; grupos vazios não saem. */
export function groupNotifications<T extends BellNotification>(items: T[], timezone: string, now: Date = new Date()): NotificationGroup<T>[] {
  const dayKey = (d: Date) => formatInTimeZone(d, timezone, "yyyy-MM-dd");
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const buckets: Record<NotificationGroup["key"], T[]> = { today: [], yesterday: [], earlier: [] };
  for (const item of items) {
    const key = dayKey(new Date(item.createdAt));
    buckets[key === today ? "today" : key === yesterday ? "yesterday" : "earlier"].push(item);
  }
  return (Object.keys(buckets) as NotificationGroup["key"][])
    .filter((key) => buckets[key].length > 0)
    .map((key) => ({ key, label: GROUP_LABEL[key], items: buckets[key] }));
}

/** Junta sem duplicar (por `id`; o mais novo vence) e mantém a ordem decrescente por data. */
export function mergeNotifications<T extends BellNotification>(current: T[], incoming: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of current) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

/** Maior `createdAt` do lote (âncora do próximo `since`); `fallback` se o lote for vazio. */
export function latestCreatedAt(items: BellNotification[], fallback: string): string {
  return items.reduce((max, item) => (item.createdAt > max ? item.createdAt : max), fallback);
}

/**
 * Quais notificações novas viram toast. Regras: só as não lidas; ações do próprio usuário
 * (`byMe`) não geram toast (quem clicou já sabe — vão só para o sino); cabem no máximo
 * `max - visibleCount` (as mais recentes primeiro). O que sobra fica no sino.
 */
export function pickToasts<T extends BellNotification>(fresh: T[], visibleCount: number, max = MAX_VISIBLE_TOASTS): T[] {
  const room = Math.max(0, max - visibleCount);
  return fresh
    .filter((n) => !n.read && !("byMe" in n && n.byMe))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, room);
}

/** Começa em até 15 min? Ganha destaque no card "Próximos atendimentos". */
export const IMMINENT_MINUTES = 15;

/** Minutos até o início, arredondando para cima (faltam 25 s = "em 1 min"); negativo = já começou. */
export function minutesUntilStart(startsAtIso: string, now: Date = new Date()): number {
  return Math.ceil((new Date(startsAtIso).getTime() - now.getTime()) / 60_000);
}

/** "agora" / "em 25 min" / "em 1h" / "em 1h 20 min". */
export function formatCountdown(minutes: number): string {
  if (minutes <= 0) return "agora";
  if (minutes < 60) return `em ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `em ${hours}h` : `em ${hours}h ${rest} min`;
}

export function isImminent(minutes: number): boolean {
  return minutes <= IMMINENT_MINUTES;
}

/** Sufixo que o servidor põe no corpo do "pediu atendente" fora do horário (B-2). */
const OFF_HOURS_SUFFIX_RE = /\s*·\s*fora do horário\s*$/i;

/**
 * `handoff.offHours` (contrato B-2, §3.5 do plano) sem depender de o tipo já ter o campo: o
 * servidor manda o dado; aqui só lemos. Notificação de outro tipo → `false`.
 */
export function isOffHoursHandoff(notification: BellNotification): boolean {
  if ((notification.kind as string) !== "HANDOFF_REQUESTED") return false;
  const handoff = (notification as { handoff?: { offHours?: boolean } }).handoff;
  return handoff?.offHours === true;
}

/** Corpo sem o "· fora do horário" quando a linha já mostra o selo próprio (não repetir). */
export function handoffBody(notification: BellNotification): string {
  const body = notification.body ?? "";
  return isOffHoursHandoff(notification) ? body.replace(OFF_HOURS_SUFFIX_RE, "") : body;
}
