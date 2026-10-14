"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowLeft, Bot, CalendarPlus, CheckCheck, Clock, RefreshCw, RotateCcw, Trash2, UserRound } from "lucide-react";
import { cn } from "@/components/lib/cn";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { InnoAnimated } from "@/components/onboarding/inno-animated";
import { formatTimeLabel } from "@/components/lib/format-date";
import { ChatDoodle, WA_TOKENS } from "@/components/whatsapp/phone-mockup";
import { groupConversationByDay, mergeConversation } from "@/components/contacts/conversation-utils";
import { getAttendanceConversationAction, sendAgentMessageAction } from "@/modules/attendance/actions";
import { AttendanceComposer, type ComposerHandle } from "./attendance-composer";
import { HelpButton } from "@/components/help/help-button";
import {
  attendanceBubbleLabel,
  canClose,
  isNearBottom,
  restoresTextOnError,
  makeLocalMessage,
  sendErrorMessage,
  statusLine,
  type AttendanceItem,
  type AttendanceMessage,
} from "./attendance-utils";

type LoadStatus = "loading" | "ready" | "error";

export type ConversationContact = { id: string; name: string; item: AttendanceItem | null };

/**
 * Coluna da direita do Atendimento: cabeçalho (nome, status, ações), a conversa no visual do
 * WhatsApp e o compositor. Montado com `key={contactId}` pelo pai — trocar de cliente reinicia o
 * estado sem efeitos de reset. `refreshTick` sobe a cada poll do pai: a conversa recarrega em
 * silêncio e só rola sozinha se a pessoa já estava lendo o fim (senão aparece "Nova mensagem").
 *
 * Acessibilidade: `role="log"` focável com o nome do cliente; cada balão é `article` rotulado com
 * quem falou; envio/erro anunciados por `aria-live`/`role=alert`; foco vai para o compositor ao abrir.
 */
export function AttendanceConversation({
  tenantSlug,
  contact,
  timezone,
  refreshTick,
  writeBlocked,
  onBack,
  onSchedule,
  onClose,
  onMessageSent,
  isSupportImpersonation = false,
  supportAdminName = null,
}: {
  tenantSlug: string;
  contact: ConversationContact;
  timezone: string;
  refreshTick: number;
  writeBlocked: boolean;
  onBack: () => void;
  onSchedule: () => void;
  onClose: () => void;
  onMessageSent: () => void;
  isSupportImpersonation?: boolean;
  supportAdminName?: string | null;
}) {
  const contactId = contact.id;
  const [items, setItems] = useState<AttendanceMessage[]>([]);
  const [locals, setLocals] = useState<AttendanceMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const [hasNew, setHasNew] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [blockedCode, setBlockedCode] = useState<string | null>(null);
  const [restore, setRestore] = useState<{ value: string; nonce: number } | null>(null);
  const [liveMessage, setLiveMessage] = useState("");

  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const restoreScrollFromRef = useRef<number | null>(null);
  const scrollToBottomRef = useRef(false);
  const wasNearBottomRef = useRef(true);
  const knownIdsRef = useRef<Set<string>>(new Set());
  const lastTickRef = useRef(refreshTick);

  const loadFirst = useCallback(async () => {
    setStatus("loading");
    setErrorMessage(null);
    try {
      const result = await getAttendanceConversationAction({ tenantSlug, contactId });
      if (!result.ok) {
        setErrorMessage(result.error.message);
        setStatus("error");
        return;
      }
      scrollToBottomRef.current = true;
      const list = result.data.items as AttendanceMessage[];
      knownIdsRef.current = new Set(list.map((m) => m.id));
      setItems(mergeConversation([], list));
      setNextCursor(result.data.nextCursor);
      setStatus("ready");
    } catch {
      setErrorMessage("Não deu para carregar a conversa agora.");
      setStatus("error");
    }
  }, [tenantSlug, contactId]);

  useEffect(() => {
    const timer = setTimeout(() => void loadFirst(), 0);
    return () => clearTimeout(timer);
  }, [loadFirst]);

  // Foco no compositor ao abrir (no celular o teclado não abre sozinho por cima da conversa).
  useEffect(() => {
    if (typeof window === "undefined" || window.matchMedia("(pointer: coarse)").matches) return;
    const timer = setTimeout(() => composerRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [contactId]);

  /** Recarga silenciosa (poll): junta o que chegou, sem piscar skeleton. */
  const refreshSilently = useCallback(async () => {
    try {
      const result = await getAttendanceConversationAction({ tenantSlug, contactId });
      if (!result.ok) return;
      const incoming = result.data.items as AttendanceMessage[];
      const fresh = incoming.filter((m) => !knownIdsRef.current.has(m.id));
      if (fresh.length === 0) return;
      for (const m of fresh) knownIdsRef.current.add(m.id);
      if (wasNearBottomRef.current) scrollToBottomRef.current = true;
      else setHasNew(true);
      setItems((current) => mergeConversation(current, incoming));
    } catch {
      // Poll é oportunista: a próxima volta tenta de novo.
    }
  }, [tenantSlug, contactId]);

  useEffect(() => {
    if (refreshTick === lastTickRef.current) return;
    lastTickRef.current = refreshTick;
    const timer = setTimeout(() => void refreshSilently(), 0);
    return () => clearTimeout(timer);
  }, [refreshTick, refreshSilently]);

  async function loadMore() {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const result = await getAttendanceConversationAction({ tenantSlug, contactId, cursor: nextCursor });
      if (!result.ok) {
        setMoreError(result.error.message);
        return;
      }
      restoreScrollFromRef.current = scrollRef.current?.scrollHeight ?? null;
      const older = result.data.items as AttendanceMessage[];
      for (const m of older) knownIdsRef.current.add(m.id);
      setItems((current) => mergeConversation(current, older));
      setNextCursor(result.data.nextCursor);
    } catch {
      setMoreError("Não deu para carregar as mensagens anteriores.");
    } finally {
      setLoadingMore(false);
    }
  }

  const all = useMemo(() => [...items, ...locals], [items, locals]);

  // Depois de pintar: 1ª carga/envio/mensagem nova com o fim à vista descem; página antiga mantém a posição.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (scrollToBottomRef.current) {
      scrollToBottomRef.current = false;
      el.scrollTop = el.scrollHeight;
      wasNearBottomRef.current = true;
    } else if (restoreScrollFromRef.current !== null) {
      el.scrollTop += el.scrollHeight - restoreScrollFromRef.current;
      restoreScrollFromRef.current = null;
    }
  }, [all]);

  // O compositor cresce (várias linhas, banner de erro) e encolhe a conversa: se a pessoa estava no
  // fim, continua no fim — senão a última bolha (a que acabou de enviar) some atrás do compositor.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (wasNearBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const near = isNearBottom(el);
    wasNearBottomRef.current = near;
    if (near && hasNew) setHasNew(false);
  }

  function jumpToBottom() {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setHasNew(false);
  }

  // ---- envio ----
  async function deliver(local: AttendanceMessage) {
    setSending(true);
    setLiveMessage("Enviando mensagem…");
    try {
      const result = await sendAgentMessageAction({ tenantSlug, contactId, text: local.body, clientMessageId: local.clientMessageId });
      if (!result.ok) {
        fail(local, result.error.code, result.error.details);
        return;
      }
      const sent = result.data.message as AttendanceMessage;
      knownIdsRef.current.add(sent.id);
      scrollToBottomRef.current = true;
      setLocals((current) => current.filter((m) => m.id !== local.id));
      setItems((current) => mergeConversation(current, [sent]));
      setLiveMessage("Mensagem enviada.");
      onMessageSent();
    } catch {
      fail(local, "NETWORK");
    } finally {
      setSending(false);
    }
  }

  function fail(local: AttendanceMessage, code: string, details?: unknown) {
    setSendError(sendErrorMessage(code, details));
    setLiveMessage("");
    if (code === "CONTACT_HAS_NO_PHONE" || code === "TENANT_SUSPENDED") setBlockedCode(code);
    if (restoresTextOnError(code)) {
      // Nada foi enviado e repetir às cegas não adianta: tira a bolha e devolve o texto ao campo.
      setLocals((current) => current.filter((m) => m.id !== local.id));
      setRestore({ value: local.body, nonce: Date.now() });
      return;
    }
    setLocals((current) => current.map((m) => (m.id === local.id ? { ...m, local: "failed", errorCode: code } : m)));
  }

  function send(text: string) {
    const local = makeLocalMessage(text, null);
    scrollToBottomRef.current = true;
    setLocals((current) => [...current, local]);
    void deliver(local);
  }

  function retry(local: AttendanceMessage) {
    if (sending) return;
    setSendError(null);
    setLocals((current) => current.map((m) => (m.id === local.id ? { ...m, local: "sending", errorCode: undefined } : m)));
    void deliver({ ...local, local: "sending" });
  }

  function discard(local: AttendanceMessage) {
    setLocals((current) => current.filter((m) => m.id !== local.id));
    setSendError(null);
    composerRef.current?.focus();
  }

  const days = useMemo(() => groupConversationByDay(all, timezone), [all, timezone]);
  const line = contact.item ? statusLine(contact.item, timezone) : { kind: "bot" as const, text: "Bot ativo" };
  const closable = contact.item ? canClose(contact.item) : false;
  const blockedReason = writeBlocked ? sendErrorMessage("TENANT_SUSPENDED") : blockedCode ? sendErrorMessage(blockedCode) : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="attendance-conversation">
      {/* Cabeçalho */}
      <header className="flex shrink-0 flex-col gap-2 border-b border-border bg-surface px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <Button type="button" variant="ghost" size="icon" icon={ArrowLeft} aria-label="Voltar para a fila" onClick={onBack} className="-ml-1 shrink-0 md:hidden" />
          <Avatar id={contact.id} name={contact.name} className="h-10 w-10 text-sm" />
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-display text-base font-bold leading-tight text-text">{contact.name}</h2>
            <p
              className={cn(
                "flex items-center gap-1.5 text-xs",
                line.kind === "waiting" ? "font-semibold text-warning" : "text-text-secondary",
              )}
              data-testid="attendance-status"
            >
              {line.kind === "waiting" ? <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : line.kind === "paused" ? <UserRound className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <Bot className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
              <span className="min-w-0 truncate">{line.text}</span>
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 md:gap-2">
          <Button type="button" variant="secondary" icon={CalendarPlus} onClick={onSchedule} disabled={writeBlocked} aria-label="Agendar para este cliente" className="max-md:gap-1.5 max-md:px-2.5">
            <span className="md:hidden">Agendar</span>
            <span className="hidden md:inline">Agendar para este cliente</span>
          </Button>
          {closable ? (
            <div className="flex items-center gap-1">
              <Button type="button" variant="secondary" icon={Bot} onClick={onClose} disabled={writeBlocked} aria-label="Encerrar e devolver ao bot" className="max-md:gap-1.5 max-md:px-2.5">
                <span className="md:hidden">Encerrar</span>
                <span className="hidden md:inline">Encerrar e devolver ao bot</span>
              </Button>
              <HelpButton helpKey="atendimento.devolver" placement="inline" />
            </div>
          ) : null}
          <Button asChild variant="ghost" className="max-md:gap-1.5 max-md:px-2.5 md:ml-auto">
            <Link href={`/${tenantSlug}/clientes?contato=${contact.id}`}>
              <UserRound className="h-4 w-4" aria-hidden="true" />
              Ver ficha
            </Link>
          </Button>
        </div>
      </header>

      {/* Conversa */}
      <div style={WA_TOKENS} className="relative min-h-0 flex-1 overflow-hidden bg-[var(--wa-bg)]">
        <ChatDoodle />
        <div
          ref={scrollRef}
          role="log"
          aria-label={`Conversa com ${contact.name}`}
          aria-busy={status === "loading"}
          tabIndex={0}
          onScroll={onScroll}
          className="relative h-full overflow-y-auto overscroll-contain px-3 py-3 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary sm:px-4"
        >
          {status === "loading" ? (
            <div className="flex flex-col gap-3" aria-hidden="true">
              <Skeleton className="h-10 w-3/5 rounded-lg" />
              <Skeleton className="ml-auto h-14 w-2/3 rounded-lg" />
              <Skeleton className="h-8 w-2/5 rounded-lg" />
              <Skeleton className="ml-auto h-10 w-1/2 rounded-lg" />
            </div>
          ) : status === "error" ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
              <p className="rounded-card bg-white/90 px-3 py-2 text-sm text-[#111B21]">{errorMessage ?? "Não deu para carregar a conversa."}</p>
              <Button type="button" variant="secondary" icon={RefreshCw} onClick={() => void loadFirst()}>
                Tentar de novo
              </Button>
            </div>
          ) : all.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
              <InnoAnimated variant="avatar" size={56} />
              <p className="rounded-card bg-white/90 px-3 py-1.5 text-sm font-medium text-[#111B21]">Nenhuma mensagem nos últimos 90 dias</p>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {nextCursor ? (
                <div className="flex flex-col items-center gap-1 pb-1">
                  <Button type="button" variant="secondary" size="sm" icon={loadingMore ? undefined : RefreshCw} onClick={() => void loadMore()} isLoading={loadingMore} loadingText="Carregando…">
                    Carregar mensagens anteriores
                  </Button>
                  {moreError ? (
                    <p role="alert" className="rounded-md bg-white/90 px-2 py-1 text-xs text-danger">
                      {moreError}
                    </p>
                  ) : null}
                </div>
              ) : null}
              {days.map((day) => (
                <section key={day.key} aria-label={day.label} className="flex flex-col gap-1.5">
                  <h3 className="mx-auto my-1 rounded-md bg-white/90 px-2.5 py-0.5 text-[11px] font-medium uppercase tracking-wide text-[#54656F] shadow-[0_1px_0.5px_rgb(11_20_26/0.1)]">
                    {day.label}
                  </h3>
                  {day.items.map((message) => (
                    <Bubble key={message.id} message={message} timezone={timezone} onRetry={retry} onDiscard={discard} retryDisabled={sending} />
                  ))}
                </section>
              ))}
            </div>
          )}
        </div>
        {hasNew ? (
          <button
            type="button"
            onClick={jumpToBottom}
            className="absolute bottom-3 left-1/2 z-10 inline-flex min-h-11 -translate-x-1/2 items-center gap-1.5 rounded-full bg-primary px-4 text-sm font-medium text-white shadow-card-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <ArrowDown className="h-4 w-4" aria-hidden="true" />
            Nova mensagem
          </button>
        ) : null}
      </div>

      <AttendanceComposer
        ref={composerRef}
        contactName={contact.name}
        onSend={send}
        blockedReason={blockedReason}
        sending={sending}
        error={sendError}
        onDismissError={() => setSendError(null)}
        restoreText={restore}
        liveMessage={liveMessage}
        isSupportImpersonation={isSupportImpersonation}
        supportAdminName={supportAdminName}
      />
    </div>
  );
}

function Bubble({
  message,
  timezone,
  onRetry,
  onDiscard,
  retryDisabled,
}: {
  message: AttendanceMessage;
  timezone: string;
  onRetry: (m: AttendanceMessage) => void;
  onDiscard: (m: AttendanceMessage) => void;
  retryDisabled: boolean;
}) {
  const inbound = message.author === "CLIENT";
  const time = formatTimeLabel(message.createdAt, timezone);
  const failed = message.local === "failed";
  return (
    <div className={cn("flex", inbound ? "justify-start" : "justify-end")}>
      <div
        role="article"
        aria-label={attendanceBubbleLabel(message, time)}
        className={cn(
          "max-w-[85%] rounded-lg px-2.5 py-1.5 text-sm leading-snug text-[var(--wa-ink)] shadow-[0_1px_0.5px_rgb(11_20_26/0.13)] md:max-w-[75%]",
          inbound ? "rounded-tl-none bg-[var(--wa-in)]" : "rounded-tr-none bg-[var(--wa-out)]",
          message.local === "sending" && "opacity-70",
          failed && "ring-2 ring-danger",
        )}
      >
        {message.author === "BOT" ? (
          <p className="mb-0.5 flex items-center gap-1 text-[11px] font-semibold text-[#54656F]">
            <span className="inline-flex items-center gap-1 rounded bg-black/[0.06] px-1.5 py-px">
              <Bot className="h-3 w-3" aria-hidden="true" />
              Bot
            </span>
          </p>
        ) : message.author === "AGENT" ? (
          <p className="mb-0.5 truncate text-[11px] font-semibold text-[#0A6B5A]">{message.authorName ?? (message.local ? "Você" : "Atendente")}</p>
        ) : null}
        <div className="flex flex-wrap items-end justify-end gap-x-2">
          {message.body.trim() ? (
            <p className="min-w-0 whitespace-pre-wrap break-words">{message.body}</p>
          ) : (
            <p className="italic text-[#54656F]">Mensagem sem texto</p>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1 pt-0.5 text-[11px] text-[#54656F]">
            <span className="tabular-nums" aria-hidden="true">
              {message.local === "sending" ? "Enviando…" : time}
            </span>
            {!inbound && !message.local ? <CheckCheck className="h-3.5 w-3.5 text-[var(--wa-tick)]" strokeWidth={2.4} aria-hidden="true" /> : null}
          </span>
        </div>
        {failed ? (
          <div className="mt-1 flex flex-wrap items-center gap-x-3 border-t border-black/10 pt-1">
            <span className="text-xs font-semibold text-[#B3261E]">Não enviada</span>
            <button
              type="button"
              onClick={() => onRetry(message)}
              disabled={retryDisabled}
              className="inline-flex min-h-11 items-center gap-1 rounded px-1 text-xs font-semibold text-[#0A6B5A] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Tentar de novo
            </button>
            <button
              type="button"
              onClick={() => onDiscard(message)}
              className="inline-flex min-h-11 items-center gap-1 rounded px-1 text-xs font-semibold text-[#54656F] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Descartar
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
