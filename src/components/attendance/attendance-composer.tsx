"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { AlertCircle, Send } from "lucide-react";
import { cn } from "@/components/lib/cn";
import { Button } from "@/components/ui/button";
import { HelpButton } from "@/components/help/help-button";
import { SupportChatBadge } from "@/components/support/SupportChatBadge";
import { canSend, counterState, MAX_MESSAGE_LENGTH } from "./attendance-utils";

export type ComposerHandle = { focus: () => void };

const MAX_HEIGHT_PX = 160;

/**
 * Compositor: textarea que cresce até ~6 linhas, Enter envia, Shift+Enter quebra a linha (e Enter
 * durante composição de IME não envia). Contador só perto do limite. `onSend` devolve `true` quando
 * o envio foi ACEITO para processar (o texto é limpo na hora — o envio é otimista; se falhar, a
 * conversa mostra a bolha com "Tentar de novo" e o erro fica em `error`).
 */
export const AttendanceComposer = forwardRef<
  ComposerHandle,
  {
    contactName: string;
    onSend: (text: string) => void;
    /** Bloqueia o envio (assinatura suspensa, contato sem telefone…) com a razão visível. */
    blockedReason: string | null;
    /** Enviando: mantém o campo, segura o botão. */
    sending: boolean;
    /** Último erro de envio (mensagem já traduzida) — anunciado como alerta. */
    error: string | null;
    onDismissError: () => void;
    /** Texto para devolver ao campo quando o envio não pode ser repetido (ex.: recusa de validação). */
    restoreText: { value: string; nonce: number } | null;
    /** Texto para leitores de tela (aria-live): "Enviando…", "Mensagem enviada.". */
    liveMessage: string;
    /** Se a sessão é uma impersonação de suporte */
    isSupportImpersonation?: boolean;
    /** Nome do admin em suporte */
    supportAdminName?: string | null;
  }
>(function AttendanceComposer(
  {
    contactName,
    onSend,
    blockedReason,
    sending,
    error,
    onDismissError,
    restoreText,
    liveMessage,
    isSupportImpersonation = false,
    supportAdminName = null,
  },
  ref,
) {
  const [text, setText] = useState("");
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const lastRestore = useRef(0);

  useImperativeHandle(ref, () => ({ focus: () => areaRef.current?.focus({ preventScroll: true }) }), []);

  const resize = useCallback(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
    el.style.overflowY = el.scrollHeight > MAX_HEIGHT_PX ? "auto" : "hidden";
  }, []);

  useLayoutEffect(resize, [text, resize]);

  // Devolve o texto ao campo quando o pai pede (envio recusado: a pessoa não perde o que escreveu).
  useEffect(() => {
    if (!restoreText || restoreText.nonce === lastRestore.current) return;
    lastRestore.current = restoreText.nonce;
    const id = setTimeout(() => {
      setText((current) => (current.trim() ? current : restoreText.value));
      areaRef.current?.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(id);
  }, [restoreText]);

  const counter = counterState(text.length);
  const sendable = canSend(text) && !sending && !blockedReason;

  function submit() {
    if (!sendable) return;
    const value = text.trim();
    setText("");
    onDismissError();
    onSend(value);
    areaRef.current?.focus({ preventScroll: true });
  }

  return (
    <form
      className="shrink-0 border-t border-border bg-surface p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {error ? (
        <div role="alert" className="mb-2 flex items-start gap-2 rounded-card border border-danger/30 bg-danger-bg px-3 py-2 text-sm text-danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <p className="min-w-0 flex-1">{error}</p>
        </div>
      ) : null}
      {blockedReason ? (
        <p className="mb-2 rounded-card border border-border bg-bg px-3 py-2 text-sm text-text-secondary">{blockedReason}</p>
      ) : null}

      {isSupportImpersonation ? (
        <div className="mb-2">
          <SupportChatBadge isSupportImpersonation={isSupportImpersonation} adminName={supportAdminName} />
        </div>
      ) : null}

      <div className="flex items-end gap-2">
        <div
          className={cn(
            "min-w-0 flex-1 rounded-card border bg-surface transition-colors duration-150 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/25 motion-reduce:transition-none",
            counter.over ? "border-danger" : "border-border",
            blockedReason && "opacity-60",
          )}
        >
          <textarea
            ref={areaRef}
            value={text}
            rows={1}
            disabled={!!blockedReason}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            aria-label={`Mensagem para ${contactName}`}
            aria-describedby="att-composer-hint"
            aria-invalid={counter.over || undefined}
            placeholder="Escreva uma mensagem"
            enterKeyHint="send"
            autoComplete="off"
            className="block max-h-40 min-h-11 w-full resize-none bg-transparent px-3 py-2.5 text-sm leading-snug text-text placeholder:text-text-secondary focus:outline-none disabled:cursor-not-allowed"
            data-testid="attendance-composer-input"
          />
        </div>
        <Button
          type="submit"
          size="icon"
          icon={Send}
          aria-label="Enviar mensagem"
          disabled={!sendable}
          isLoading={sending}
          className="h-11 w-11 shrink-0"
          data-testid="attendance-send"
        />
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-3 text-xs text-text-secondary">
        <div className="flex items-center gap-1.5">
          <p id="att-composer-hint" className="max-md:hidden">
            Enter envia · Shift+Enter quebra a linha
          </p>
          <HelpButton helpKey="atendimento.responder" placement="inline" />
        </div>
        {counter.visible ? (
          <p className={cn("ml-auto tabular-nums", counter.over ? "font-semibold text-danger" : "")} aria-label={`${text.length} de ${MAX_MESSAGE_LENGTH} caracteres`}>
            {counter.text}
          </p>
        ) : null}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {liveMessage}
      </p>
    </form>
  );
});
