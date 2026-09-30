import { formatTimeLabel } from "@/components/lib/format-date";
import type { ConversationMessage } from "@/components/contacts/conversation-utils";

/**
 * Lógica pura da tela Atendimento (fila + conversa + compositor). Sem React: testável no vitest
 * node. O formato dos itens espelha o contrato de `@/modules/attendance/actions`.
 */

export type AttendanceStatus = "WAITING" | "IN_PROGRESS" | "RECENT";
export type MessageAuthor = "CLIENT" | "BOT" | "AGENT";

export type AttendanceItem = {
  contactId: string;
  contactName: string;
  handoffId: string | null;
  status: AttendanceStatus;
  requestedAt: string | null;
  offHours: boolean;
  lastMessage: { body: string; direction: "INBOUND" | "OUTBOUND"; author: MessageAuthor; createdAt: string } | null;
  botPausedUntil: string | null;
};

export type AttendanceMessage = ConversationMessage & {
  author: MessageAuthor;
  authorName: string | null;
  /** Só no cliente: envio otimista em andamento / que falhou. */
  local?: "sending" | "failed";
  /** Só no cliente, junto de `local: "failed"`: código do erro do contrato. */
  errorCode?: string;
};

export type AttendanceTab = "waiting" | "active" | "recent";

export const ATTENDANCE_TABS: { id: AttendanceTab; label: string; status: AttendanceStatus }[] = [
  { id: "waiting", label: "Aguardando", status: "WAITING" },
  { id: "active", label: "Em atendimento", status: "IN_PROGRESS" },
  { id: "recent", label: "Encerrados (24h)", status: "RECENT" },
];

const time = (iso: string | null | undefined): number => (iso ? new Date(iso).getTime() : 0);

/** Itens da aba, na ordem certa: quem espera há mais tempo primeiro; as demais, mais recentes primeiro. */
export function itemsForTab(items: AttendanceItem[], tab: AttendanceTab): AttendanceItem[] {
  const status = ATTENDANCE_TABS.find((t) => t.id === tab)?.status;
  const list = items.filter((i) => i.status === status);
  if (tab === "waiting") {
    return list.sort((a, b) => time(waitingSince(a)) - time(waitingSince(b)));
  }
  return list.sort((a, b) => time(b.lastMessage?.createdAt ?? b.requestedAt) - time(a.lastMessage?.createdAt ?? a.requestedAt));
}

/** Aba inicial: a do contato selecionado; senão a fila de espera se houver alguém; senão quem está em atendimento. */
export function initialTab(items: AttendanceItem[], selectedContactId: string | null): AttendanceTab {
  const selected = selectedContactId ? items.find((i) => i.contactId === selectedContactId) : null;
  if (selected) return selected.status === "WAITING" ? "waiting" : selected.status === "IN_PROGRESS" ? "active" : "recent";
  if (items.some((i) => i.status === "WAITING")) return "waiting";
  if (items.some((i) => i.status === "IN_PROGRESS")) return "active";
  return "waiting";
}

/** Desde quando o item espera (pedido do atendente; senão a última mensagem). */
export function waitingSince(item: AttendanceItem): string | null {
  return item.requestedAt ?? item.lastMessage?.createdAt ?? null;
}

/** O cliente que espera há mais tempo (destaque na fila). `null` se ninguém espera. */
export function longestWaitingId(items: AttendanceItem[]): string | null {
  return itemsForTab(items, "waiting")[0]?.contactId ?? null;
}

/** Espera acima deste limite ganha o tom de alerta no tempo relativo. */
export const LONG_WAIT_MINUTES = 10;

export function isLongWait(item: AttendanceItem, now: Date = new Date()): boolean {
  if (item.status !== "WAITING") return false;
  const since = waitingSince(item);
  return since !== null && now.getTime() - new Date(since).getTime() >= LONG_WAIT_MINUTES * 60_000;
}

/** Prévia da última mensagem com quem falou ("Você: ...", "Bot: ..."), numa linha só. */
export function messagePreview(item: AttendanceItem): string {
  const last = item.lastMessage;
  if (!last) return "Sem mensagens recentes";
  const body = last.body.replace(/\s+/g, " ").trim() || "Mensagem sem texto";
  if (last.author === "AGENT") return `Você: ${body}`;
  if (last.author === "BOT") return `Bot: ${body}`;
  return body;
}

export type StatusLine = { kind: "waiting" | "paused" | "bot"; text: string };

/** Linha de status do topo da conversa. */
export function statusLine(
  item: Pick<AttendanceItem, "status" | "botPausedUntil">,
  timezone: string,
  now: Date = new Date(),
): StatusLine {
  if (item.status === "WAITING") return { kind: "waiting", text: "Aguardando atendente" };
  if (item.botPausedUntil && new Date(item.botPausedUntil).getTime() > now.getTime()) {
    return { kind: "paused", text: `Em atendimento: bot pausado até ${formatTimeLabel(item.botPausedUntil, timezone)}` };
  }
  return { kind: "bot", text: "Bot ativo" };
}

/** "Encerrar e devolver ao bot" só faz sentido com alguém esperando, em atendimento ou com o bot pausado. */
export function canClose(item: Pick<AttendanceItem, "status" | "botPausedUntil">, now: Date = new Date()): boolean {
  if (item.status !== "RECENT") return true;
  return !!item.botPausedUntil && new Date(item.botPausedUntil).getTime() > now.getTime();
}

// ---------------------------------------------------------------------------------------------
// Compositor
// ---------------------------------------------------------------------------------------------

export const MAX_MESSAGE_LENGTH = 4096;
/** O contador só aparece a partir de 90% do limite (não polui a digitação normal). */
export const COUNTER_FROM = Math.floor(MAX_MESSAGE_LENGTH * 0.9);

export type CounterState = { visible: boolean; over: boolean; text: string };

export function counterState(length: number): CounterState {
  const fmt = (n: number) => n.toLocaleString("pt-BR");
  return {
    visible: length >= COUNTER_FROM,
    over: length > MAX_MESSAGE_LENGTH,
    text: `${fmt(length)} / ${fmt(MAX_MESSAGE_LENGTH)}`,
  };
}

/** Pode enviar: tem texto de verdade e cabe no limite. */
export function canSend(text: string): boolean {
  return text.trim().length > 0 && text.length <= MAX_MESSAGE_LENGTH;
}

const SEND_ERRORS: Record<string, string> = {
  WHATSAPP_NOT_CONNECTED: "O WhatsApp da empresa está desconectado. Reconecte o número em WhatsApp para poder responder.",
  CONTACT_HAS_NO_PHONE: "Este cliente não tem telefone cadastrado, então não dá para enviar mensagem.",
  TEXT_EMPTY: "Escreva uma mensagem antes de enviar.",
  TEXT_TOO_LONG: `A mensagem passou de ${MAX_MESSAGE_LENGTH.toLocaleString("pt-BR")} caracteres. Encurte o texto ou divida em duas mensagens.`,
  RATE_LIMITED: "Você está enviando rápido demais. Espere alguns segundos e tente de novo.",
  CONVERSATION_BUSY: "O bot está respondendo este cliente agora. Espere um instante e envie de novo: sua mensagem continua no campo.",
  SEND_FAILED: "O WhatsApp recusou o envio e nada foi enviado. Sua mensagem continua no campo: tente de novo em instantes.",
  TENANT_SUSPENDED: "Assinatura suspensa: o envio de mensagens está bloqueado até o pagamento.",
};

/** `details.retryAfterMs` do RATE_LIMITED, em segundos inteiros (mín. 1); `null` se o servidor não mandou. */
export function retryAfterSeconds(details: unknown): number | null {
  const ms = (details as { retryAfterMs?: unknown } | null | undefined)?.retryAfterMs;
  return typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? Math.max(1, Math.ceil(ms / 1000)) : null;
}

/** Mensagem humana para cada erro do contrato de envio; o resto cai no texto genérico. */
export function sendErrorMessage(code: string | undefined, details?: unknown): string {
  if (code === "RATE_LIMITED") {
    const seconds = retryAfterSeconds(details);
    if (seconds !== null) {
      return `Você está enviando rápido demais. Tente de novo em ${seconds} ${seconds === 1 ? "segundo" : "segundos"}.`;
    }
  }
  return (code && SEND_ERRORS[code]) || "Não foi possível enviar a mensagem agora. Tente de novo.";
}

/**
 * Erros em que o texto VOLTA para o campo e nenhuma bolha "não enviada" fica na conversa: ou repetir
 * não adianta até a pessoa resolver a causa (sem telefone, assinatura suspensa, texto vazio/longo),
 * ou o servidor garante que nada foi gravado e o melhor é reeditar/reenviar (bot ocupado, recusa da
 * Evolution). Nos demais (WhatsApp desconectado, limite de envio, falha de rede) a bolha fica com
 * "Tentar de novo".
 */
export function restoresTextOnError(code: string | undefined): boolean {
  return (
    code === "CONTACT_HAS_NO_PHONE" ||
    code === "TENANT_SUSPENDED" ||
    code === "TEXT_TOO_LONG" ||
    code === "TEXT_EMPTY" ||
    code === "CONVERSATION_BUSY" ||
    code === "SEND_FAILED"
  );
}

export function makeLocalMessage(text: string, authorName: string | null, now: Date = new Date()): AttendanceMessage {
  return {
    id: `local-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    direction: "OUTBOUND",
    body: text,
    createdAt: now.toISOString(),
    instanceLabel: null,
    author: "AGENT",
    authorName,
    local: "sending",
  };
}

/** Rótulo acessível do balão: "Cliente, 14:32" / "Bot, 14:32" / "Atendente Maria, 14:32". */
export function attendanceBubbleLabel(
  message: Pick<AttendanceMessage, "author" | "authorName" | "local">,
  timeLabel: string,
): string {
  const name = message.authorName?.trim();
  const who =
    message.author === "CLIENT"
      ? "Cliente"
      : message.author === "BOT"
        ? "Bot"
        : name && name.toLowerCase() !== "atendente"
          ? `Atendente ${name}`
          : "Atendente";
  const state = message.local === "sending" ? ", enviando" : message.local === "failed" ? ", não enviada" : "";
  return `${who}, ${timeLabel}${state}`;
}

/** Rolagem perto do fim? (tolerância de 80 px) */
export function isNearBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }, tolerance = 80): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= tolerance;
}
