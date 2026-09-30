import { formatInTimeZone } from "date-fns-tz";

/** Mensagem como o painel a recebe de `getConversationAction` (contrato da Vega 2). */
export type ConversationMessage = {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  body: string;
  createdAt: string;
  instanceLabel: string | null;
};

export type ConversationDay<T extends ConversationMessage = ConversationMessage> = { key: string; label: string; items: T[] };

/** Junta sem duplicar (por `id`) e mantém a ordem cronológica (mais antigas primeiro). */
export function mergeConversation<T extends ConversationMessage>(current: T[], incoming: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of current) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
}

/**
 * Agrupa por dia civil NO FUSO DA EMPRESA (a mesma mensagem cai em dias diferentes conforme o
 * fuso). Rótulo: "Hoje", "Ontem" ou "dd/MM/yyyy". Espera a lista já em ordem cronológica.
 */
export function groupConversationByDay<T extends ConversationMessage>(items: T[], timezone: string, now: Date = new Date()): ConversationDay<T>[] {
  const dayKey = (d: Date) => formatInTimeZone(d, timezone, "yyyy-MM-dd");
  const today = dayKey(now);
  const yesterday = dayKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const days: ConversationDay<T>[] = [];
  for (const item of items) {
    const key = dayKey(new Date(item.createdAt));
    let day = days[days.length - 1];
    if (!day || day.key !== key) {
      const label = key === today ? "Hoje" : key === yesterday ? "Ontem" : formatInTimeZone(new Date(item.createdAt), timezone, "dd/MM/yyyy");
      day = { key, label, items: [] };
      days.push(day);
    }
    day.items.push(item);
  }
  return days;
}

/** Rótulo acessível do balão: "Cliente, 14:32" / "Bot, 14:32". */
export function bubbleAriaLabel(direction: ConversationMessage["direction"], time: string): string {
  return `${direction === "INBOUND" ? "Cliente" : "Bot"}, ${time}`;
}
