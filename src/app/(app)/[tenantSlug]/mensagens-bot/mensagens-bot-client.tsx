"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { History, Pencil, RotateCcw, X } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { Card } from "@/components/ui/card";
import { HelpButton } from "@/components/help/help-button";
import { BOT_TAB_HELP } from "@/components/help/help-content";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/components/lib/cn";
import { catalogV1, catalogV2, legacyTitle, TABS, type CatalogEntry, type FlowVersion, type TabId } from "@/components/bot-texts/catalog";
import { EditTextDialog, type SaveOutcome } from "@/components/bot-texts/edit-text-dialog";
import { resetBotTextAction, upsertBotTextAction } from "@/modules/bot-texts/bot-text-actions";

export type BotTextRow = { key: string; text: string; isDefault: boolean; legacy: boolean };

function detailsList(details: unknown, field: "disallowedVariables" | "unknownVariables"): string[] | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = (details as Record<string, unknown>)[field];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : undefined;
}

export function MensagensBotClient({
  tenantSlug,
  flowVersion,
  initialTexts,
}: {
  tenantSlug: string;
  flowVersion: FlowVersion;
  initialTexts: BotTextRow[];
}) {
  const { notify } = useToast();
  const entries = useMemo<CatalogEntry[]>(() => (flowVersion === 2 ? catalogV2() : catalogV1()), [flowVersion]);
  const entryByKey = useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries]);

  const [rows, setRows] = useState<Map<string, BotTextRow>>(() => new Map(initialTexts.map((row) => [row.key, row])));
  const [tab, setTab] = useState<TabId>("conversa");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Link direto vindo de Configurações (#lembretes): abre a aba certa e leva até a mensagem.
  useEffect(() => {
    const timer = setTimeout(() => {
      const hash = window.location.hash.slice(1);
      if (hash !== "lembretes") return;
      setTab("meus");
      requestAnimationFrame(() => document.getElementById("lembretes")?.scrollIntoView({ block: "center" }));
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  /** Textos vigentes por chave (padrão do código quando não há linha) — base da prévia. */
  const currentTexts = useMemo(() => {
    const map: Record<string, string> = {};
    for (const entry of entries) map[entry.key] = rows.get(entry.key)?.text ?? entry.defaultText;
    return map;
  }, [entries, rows]);

  const legacyRows = useMemo(() => [...rows.values()].filter((r) => r.legacy), [rows]);
  const tabEntries = useMemo(() => {
    const map = new Map<TabId, CatalogEntry[]>();
    for (const tabDef of TABS) map.set(tabDef.id, entries.filter((e) => e.group === tabDef.id));
    return map;
  }, [entries]);

  const editingEntry = editingKey ? entryByKey.get(editingKey) ?? null : null;
  const editingRow = editingKey ? rows.get(editingKey) ?? null : null;

  async function handleSave(entry: CatalogEntry, text: string): Promise<SaveOutcome> {
    const result = await upsertBotTextAction(tenantSlug, { key: entry.key, text });
    if (!result.ok) {
      const disallowed = detailsList(result.error.details, "disallowedVariables") ?? detailsList(result.error.details, "unknownVariables");
      return { ok: false, message: result.error.message, disallowed };
    }
    const saved = text.trim();
    setRows((prev) => new Map(prev).set(entry.key, { key: entry.key, text: saved, isDefault: false, legacy: false }));
    notify({ variant: "success", title: "Mensagem atualizada." });
    setEditingKey(null);
    return { ok: true };
  }

  function handleReset() {
    if (!confirmReset) return;
    const key = confirmReset;
    const entry = entryByKey.get(key);
    startTransition(async () => {
      const result = await resetBotTextAction(tenantSlug, key);
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível restaurar", description: result.error.message });
        setConfirmReset(null);
        return;
      }
      setRows((prev) => new Map(prev).set(key, { key, text: entry?.defaultText ?? "", isDefault: true, legacy: false }));
      notify({ variant: "success", title: "Mensagem restaurada ao padrão." });
      setConfirmReset(null);
    });
  }

  function onTabKeyDown(event: React.KeyboardEvent) {
    const index = TABS.findIndex((t) => t.id === tab);
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    else return;
    event.preventDefault();
    setTab(TABS[next].id);
    tabRefs.current[TABS[next].id]?.focus();
  }

  const active = TABS.find((t) => t.id === tab) ?? TABS[0];
  const activeEntries = tabEntries.get(active.id) ?? [];
  const confirmEntry = confirmReset ? entryByKey.get(confirmReset) : undefined;

  return (
    <div>
      <PageHeader help="pagina.mensagensBot"
        icon={navIconFor("mensagens-bot")}
        title="Mensagens do bot"
        description="Edite os textos que o bot envia no WhatsApp, por etapa da conversa."
      />

      <div className="mb-5 flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="flow-version">
        <div className="flex items-center gap-1.5">
          <Badge variant={flowVersion === 2 ? "primary" : "neutral"}>{flowVersion === 2 ? "Fluxo publicado: v2" : "Fluxo publicado: v1"}</Badge>
          <HelpButton helpKey="whatsapp.fluxoVersao" placement="inline" />
        </div>
        <p className="min-w-0 text-sm text-text-secondary">
          {flowVersion === 2
            ? "Os textos abaixo valem para o atendimento atual."
            : "O bot ainda usa o fluxo anterior. Os textos novos aparecem aqui quando o fluxo v2 for publicado."}
        </p>
      </div>

      <div
        role="tablist"
        aria-label="Grupos de mensagens"
        onKeyDown={onTabKeyDown}
        className="-mx-1 mb-4 flex gap-1 overflow-x-auto border-b border-border px-1"
      >
        {TABS.map((t) => {
          const list = tabEntries.get(t.id) ?? [];
          const custom = list.filter((e) => rows.get(e.key) && !rows.get(e.key)!.isDefault).length;
          const selected = t.id === tab;
          return (
            <button
              key={t.id}
              ref={(el) => {
                tabRefs.current[t.id] = el;
              }}
              type="button"
              role="tab"
              id={`bot-tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`bot-panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(t.id)}
              className={cn(
                "-mb-px inline-flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-3.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary",
                selected ? "border-primary text-primary" : "border-transparent text-text-secondary hover:text-text",
              )}
            >
              {t.label}
              {custom > 0 ? (
                <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-xs font-semibold text-primary">
                  {custom}
                  <span className="sr-only"> {custom === 1 ? "personalizada" : "personalizadas"}</span>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id={`bot-panel-${active.id}`} aria-labelledby={`bot-tab-${active.id}`} tabIndex={-1}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <p className="min-w-0 pt-0.5 text-sm text-text-secondary">{active.hint}</p>
          <HelpButton key={active.id} helpKey={BOT_TAB_HELP[active.id]} />
        </div>
        <Card className="rounded-hero">
          {activeEntries.length === 0 ? (
            <p className="p-5 text-sm text-text-secondary">Nenhuma mensagem neste grupo.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              {activeEntries.map((entry) => {
                const row = rows.get(entry.key);
                if (!row) return null;
                return (
                  <li
                    key={entry.key}
                    id={entry.key === "REMINDER" ? "lembretes" : undefined}
                    className="flex scroll-mt-24 flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:p-5"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-sm font-semibold text-text">{entry.title}</h3>
                        <Badge variant={row.isDefault ? "neutral" : "primary"}>{row.isDefault ? "Padrão" : "Personalizado"}</Badge>
                      </div>
                      {entry.description ? <p className="mt-0.5 text-sm text-text-secondary">{entry.description}</p> : null}
                      <p className="mt-1.5 line-clamp-2 whitespace-pre-line break-words text-sm text-text">{row.text}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1 self-end sm:self-center">
                      {!row.isDefault ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Restaurar padrão de ${entry.title}`}
                          onClick={() => setConfirmReset(entry.key)}
                        >
                          <RotateCcw className="h-4 w-4" aria-hidden="true" />
                        </Button>
                      ) : null}
                      <Button icon={Pencil} variant="secondary" size="sm" aria-label={`Editar ${entry.title}`} onClick={() => setEditingKey(entry.key)}>
                        Editar
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {legacyRows.length > 0 ? (
        <details className="group mt-8 rounded-hero border border-border bg-surface" data-testid="legacy-texts">
          <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-hero px-5 py-3 text-sm font-semibold text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
            <History className="h-4 w-4 text-text-secondary" aria-hidden="true" />
            Textos da versão anterior
            <Badge variant="neutral">{legacyRows.length}</Badge>
          </summary>
          <div className="border-t border-border px-5 pb-5 pt-4">
            <p className="mb-4 text-sm text-text-secondary">
              Você tinha editado estas mensagens no fluxo anterior. O fluxo novo não as usa, mas o texto fica guardado aqui para consulta. Só leitura.
            </p>
            <ul className="flex flex-col gap-3">
              {legacyRows.map((row) => (
                <li key={row.key} className="rounded-card border border-border bg-bg p-4">
                  <p className="text-sm font-medium text-text">{legacyTitle(row.key)}</p>
                  <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-text-secondary">{row.text}</p>
                </li>
              ))}
            </ul>
          </div>
        </details>
      ) : null}

      {editingEntry && editingRow ? (
        <EditTextDialog
          key={editingEntry.key}
          entry={editingEntry}
          initialText={editingRow.text}
          isDefault={editingRow.isDefault}
          texts={currentTexts}
          flowVersion={flowVersion}
          onClose={() => setEditingKey(null)}
          onSave={(text) => handleSave(editingEntry, text)}
          onReset={() => {
            setEditingKey(null);
            setConfirmReset(editingEntry.key);
          }}
        />
      ) : null}

      <Dialog open={!!confirmReset} onOpenChange={(open) => !open && setConfirmReset(null)}>
        <DialogContent>
          <DialogHeader icon={RotateCcw} tone="danger">
            <DialogTitle>Restaurar padrão</DialogTitle>
            <DialogDescription>
              {confirmEntry ? `“${confirmEntry.title}” volta ao texto padrão do InnoChat. ` : ""}O texto personalizado é apagado e não dá para desfazer.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button icon={X} type="button" variant="secondary" onClick={() => setConfirmReset(null)}>
              Cancelar
            </Button>
            <Button icon={RotateCcw} type="button" variant="danger" onClick={handleReset} isLoading={isPending} loadingText="Restaurando…">
              Restaurar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
