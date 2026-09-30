"use client";

import { useId, useMemo, useRef, useState } from "react";
import { Check, RotateCcw, X } from "lucide-react";
import { navIconFor } from "@/components/shell/nav-items";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { disallowedVars, type CatalogEntry, type FlowVersion } from "./catalog";
import { renderPreviewV1, renderPreviewV2 } from "./preview";
import { WhatsAppBubble } from "./whatsapp-bubble";

export type SaveOutcome = { ok: true } | { ok: false; message: string; disallowed?: string[] };

const MAX_LENGTH = 1000;

/**
 * Editor de uma mensagem: texto + chips das variáveis permitidas (inserem no cursor) + aviso
 * inline de variável fora do contexto + prévia no formato do WhatsApp. Em telas largas o editor
 * e a prévia ficam lado a lado; no celular, um embaixo do outro.
 */
export function EditTextDialog({
  entry,
  initialText,
  isDefault,
  texts,
  flowVersion,
  onClose,
  onSave,
  onReset,
}: {
  entry: CatalogEntry;
  initialText: string;
  isDefault: boolean;
  /** Textos vigentes da empresa (v2): a prévia usa os rótulos e rodapés reais junto com a edição. */
  texts: Record<string, string>;
  flowVersion: FlowVersion;
  onClose: () => void;
  onSave: (text: string) => Promise<SaveOutcome>;
  onReset: () => void;
}) {
  const uid = useId();
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(initialText);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [withPrice, setWithPrice] = useState(true);

  const disallowed = useMemo(() => disallowedVars(entry, text, flowVersion), [entry, text, flowVersion]);
  const preview = useMemo(
    () => (flowVersion === 2 ? renderPreviewV2(entry.key, { ...texts, [entry.key]: text }, { withPrice }) : renderPreviewV1(text)),
    [entry.key, flowVersion, text, texts, withPrice],
  );
  const empty = text.trim().length === 0;
  const unchanged = text === initialText;
  const canSave = !empty && !unchanged && disallowed.length === 0 && !saving;
  const showsPriceSwitch = flowVersion === 2 && entry.allowedVars.includes("preco");
  const isLabel = entry.key.startsWith("LABEL_");
  const noVariables = entry.allowedVars.length === 0;

  function insertVariable(name: string) {
    const el = areaRef.current;
    const token = `{${name}}`;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? start;
    const next = text.slice(0, start) + token + text.slice(end);
    if (next.length > MAX_LENGTH) return;
    setText(next);
    setServerError(null);
    // Depois do render, devolve o foco e põe o cursor logo após a variável inserida.
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  }

  async function handleSave() {
    setSaving(true);
    setServerError(null);
    const outcome = await onSave(text);
    setSaving(false);
    if (!outcome.ok) {
      setServerError(
        outcome.disallowed && outcome.disallowed.length > 0
          ? `O servidor recusou: ${outcome.disallowed.map((v) => `{${v}}`).join(", ")} não vale nesta mensagem.`
          : outcome.message,
      );
    }
  }

  const areaId = `${uid}-texto`;
  const warnId = `${uid}-aviso`;

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] w-[min(60rem,calc(100vw-2rem))] overflow-y-auto">
        <DialogHeader icon={navIconFor("mensagens-bot")}>
          <DialogTitle>{entry.title}</DialogTitle>
          <DialogDescription>{entry.description || "Edite o texto e confira a prévia antes de salvar."}</DialogDescription>
        </DialogHeader>

        <div className="mt-5 grid gap-6 lg:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-4">
            <div>
              <Label htmlFor={areaId}>Texto da mensagem</Label>
              <Textarea
                id={areaId}
                ref={areaRef}
                value={text}
                onChange={(e) => {
                  setText(e.target.value);
                  setServerError(null);
                }}
                rows={isLabel ? 2 : 8}
                maxLength={MAX_LENGTH}
                invalid={disallowed.length > 0}
                aria-describedby={disallowed.length > 0 ? warnId : undefined}
                className="font-mono text-[13px] leading-relaxed"
              />
              <p className="mt-1 flex justify-between gap-3 text-xs text-text-secondary">
                <span>Use *negrito*, _itálico_ e ~tachado~ como no WhatsApp.</span>
                <span>
                  {text.length}/{MAX_LENGTH}
                </span>
              </p>
            </div>

            {disallowed.length > 0 ? (
              <Alert variant="warning" id={warnId} title="Variável que não vale nesta mensagem">
                {disallowed.map((v) => `{${v}}`).join(", ")} {disallowed.length > 1 ? "não podem ser usadas" : "não pode ser usada"} aqui: o bot não tem esse dado nesta etapa.
                Remova para salvar.
              </Alert>
            ) : null}
            {serverError ? (
              <Alert variant="danger" title="Não foi possível salvar">
                {serverError}
              </Alert>
            ) : null}

            <div>
              <p id={`${uid}-vars`} className="mb-1.5 text-sm font-medium text-text">
                Variáveis desta mensagem
              </p>
              {noVariables ? (
                <p className="text-sm text-text-secondary">Rótulos não usam variáveis: escreva só o nome da opção.</p>
              ) : (
                <>
                  <div role="group" aria-labelledby={`${uid}-vars`} className="flex flex-wrap gap-2">
                    {entry.allowedVars.map((name) => (
                      <button
                        key={name}
                        type="button"
                        onClick={() => insertVariable(name)}
                        className="inline-flex min-h-11 items-center rounded-full border border-border bg-bg px-3.5 text-sm font-medium text-text transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                      >
                        {`{${name}}`}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-xs text-text-secondary">Toque para inserir onde está o cursor.</p>
                </>
              )}
            </div>
          </div>

          <section aria-label="Prévia da mensagem no WhatsApp" className="flex min-w-0 flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-text">Prévia</p>
              <span className="text-xs text-text-secondary">Com dados de exemplo</span>
            </div>
            <WhatsAppBubble text={preview} name="Studio Bela" />
            {showsPriceSwitch ? (
              <div className="flex items-center justify-between gap-3">
                <span id={`${uid}-preco`} className="text-sm text-text">
                  Simular serviço sem preço
                </span>
                <Switch checked={!withPrice} onCheckedChange={(v) => setWithPrice(!v)} aria-labelledby={`${uid}-preco`} />
              </div>
            ) : null}
          </section>
        </div>

        <DialogFooter className="items-center sm:justify-between">
          {isDefault ? (
            <span className="text-sm text-text-secondary">Usando o texto padrão.</span>
          ) : (
            <Button icon={RotateCcw} type="button" variant="ghost" onClick={onReset} disabled={saving}>
              Restaurar padrão
            </Button>
          )}
          <div className="flex flex-wrap justify-end gap-3">
            <Button icon={X} type="button" variant="secondary" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button icon={Check} type="button" onClick={handleSave} disabled={!canSave} isLoading={saving} loadingText="Salvando…">
              Salvar
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
