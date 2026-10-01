"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, ChevronRight, Sparkles } from "lucide-react";
import { cn } from "@/components/lib/cn";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { dismissOnboardingChecklistAction } from "@/modules/onboarding/actions";
import type { OnboardingState } from "@/modules/onboarding/service";
import { InnoAnimated } from "./inno-animated";
import { expressionForPhase } from "./inno-face";
import { CHECKLIST_OPTIONAL_TIP, CHECKLIST_STEPS, CHECKLIST_UI } from "./inno-script";
import { InnoSpeechText } from "./inno-speech-text";
import { useInnoSpeech } from "./use-inno-speech";

/** Parabéns: componente próprio para a fala (e o "uma vez por sessão") só existir quando ele aparece. */
function ChecklistDone({ error, pending, onClose }: { error: string | null; pending: boolean; onClose: () => void }) {
  const speech = useInnoSpeech(CHECKLIST_UI.doneBody, { onceKey: "checklist-done" });
  return (
    <Card className="mb-6 rounded-hero-lg border-success/30 bg-success-bg/40" data-tour="checklist">
      <div className="flex flex-col items-center gap-4 p-5 text-center sm:flex-row sm:p-6 sm:text-left">
        <InnoAnimated variant="full" className="w-20 shrink-0 sm:w-24" expression="happy" talking={speech.phase === "typing"} />
        <div className="min-w-0 flex-1" role="status">
          <h2 className="font-display text-xl font-bold text-text">{CHECKLIST_UI.doneTitle}</h2>
          <InnoSpeechText text={CHECKLIST_UI.doneBody} speech={speech} className="mt-1.5" />
          {error ? <p className="mt-2 text-sm text-danger">{error}</p> : null}
        </div>
        <Button type="button" variant="primary" onClick={onClose} isLoading={pending} className="w-full shrink-0 sm:w-auto">
          {CHECKLIST_UI.close}
        </Button>
      </div>
    </Card>
  );
}

/**
 * Card "Primeiros passos" do Início. O estado (`steps`, `allDone`) vem calculado pelo servidor —
 * aqui só se desenha e se esconde. "Esconder" e "Fechar" chamam a mesma action; o card some na
 * hora (otimista) e volta, com aviso, se o servidor recusar.
 */
export function OnboardingChecklistCard({ tenantSlug, state }: { tenantSlug: string; state: OnboardingState }) {
  const [hidden, setHidden] = useState(false);
  // Falas do Inno (fixas por estado): 1ª vez na sessão anima; depois o texto já aparece inteiro.
  const introSpeech = useInnoSpeech(CHECKLIST_UI.intro, { onceKey: "checklist-intro" });

  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (hidden) return null;

  function dismiss() {
    setError(null);
    setHidden(true);
    startTransition(async () => {
      try {
        const result = await dismissOnboardingChecklistAction(tenantSlug);
        if (!result.ok) {
          setHidden(false);
          setError(CHECKLIST_UI.error);
        }
      } catch {
        setHidden(false);
        setError(CHECKLIST_UI.error);
      }
    });
  }

  const doneByKey = new Map(state.steps.map((s) => [s.key, s.done]));
  const items = CHECKLIST_STEPS.map((s) => ({ ...s, done: doneByKey.get(s.key) ?? false }));
  const doneCount = items.filter((i) => i.done).length;
  const percent = Math.round((doneCount / items.length) * 100);
  const nextKey = items.find((i) => !i.done)?.key;
  const introFace = expressionForPhase(introSpeech.phase);

  if (state.allDone) {
    return <ChecklistDone error={error} pending={pending} onClose={dismiss} />;
  }

  return (
    <Card className="mb-6 rounded-hero-lg" data-tour="checklist">
      <div className="grid gap-x-6 gap-y-4 p-5 sm:p-6 md:grid-cols-[1fr_auto]">
        <div className="min-w-0">
          <div className="flex items-start gap-3">
            <InnoAnimated variant="avatar" size={44} className="md:hidden" {...introFace} />
            <div className="min-w-0 flex-1">
              <h2 className="font-display text-xl font-bold text-text">{CHECKLIST_UI.title}</h2>
              <InnoSpeechText text={CHECKLIST_UI.intro} speech={introSpeech} className="mt-1" />
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <div
              role="progressbar"
              aria-label={CHECKLIST_UI.title}
              aria-valuemin={0}
              aria-valuemax={items.length}
              aria-valuenow={doneCount}
              aria-valuetext={CHECKLIST_UI.progress(doneCount, items.length)}
              className="h-2 flex-1 overflow-hidden rounded-full bg-border"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out motion-reduce:transition-none"
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="shrink-0 text-xs font-semibold tabular-nums text-text-secondary">
              {CHECKLIST_UI.progress(doneCount, items.length)}
            </span>
          </div>

          <ol className="mt-4 divide-y divide-border rounded-card border border-border">
            {items.map((item, i) => (
              <li key={item.key} className="flex items-center gap-3 p-3">
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                    item.done ? "bg-success text-white" : "border border-border bg-bg text-text-secondary",
                  )}
                >
                  {item.done ? <Check className="h-4 w-4" strokeWidth={3} /> : i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={cn("text-sm font-medium", item.done ? "text-text-secondary line-through" : "text-text")}>
                    {item.title}
                    {item.done ? <span className="sr-only">, {CHECKLIST_UI.done}</span> : null}
                  </p>
                  {item.done ? null : <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">{item.description}</p>}
                </div>
                {item.done ? null : (
                  <Button
                    asChild
                    size="sm"
                    variant={item.key === nextKey ? "primary" : "outline"}
                    className="shrink-0"
                  >
                    <Link href={`/${tenantSlug}/${item.path}`} aria-label={`${item.cta}: ${item.title}`}>
                      {item.cta}
                      <ChevronRight className="h-4 w-4" aria-hidden="true" />
                    </Link>
                  </Button>
                )}
              </li>
            ))}
          </ol>

          {/* Dica opcional: fora do contrato (`state.steps`), nunca conta para o progresso. */}
          <div className="mt-2 flex items-center gap-3 rounded-card border border-dashed border-border p-3" data-testid="checklist-optional">
            <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Sparkles className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-text">
                {CHECKLIST_OPTIONAL_TIP.title}
                <span className="ml-2 rounded-full bg-bg px-2 py-0.5 text-[11px] font-semibold text-text-secondary">{CHECKLIST_UI.optionalLabel}</span>
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-text-secondary">{CHECKLIST_OPTIONAL_TIP.description}</p>
            </div>
            <Button asChild size="sm" variant="outline" className="shrink-0">
              <Link href={`/${tenantSlug}/${CHECKLIST_OPTIONAL_TIP.path}`} aria-label={`${CHECKLIST_OPTIONAL_TIP.cta}: ${CHECKLIST_OPTIONAL_TIP.title}`}>
                {CHECKLIST_OPTIONAL_TIP.cta}
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </Button>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3">
            {error ? <p className="text-sm text-danger">{error}</p> : <span />}
            <button
              type="button"
              onClick={dismiss}
              aria-label={CHECKLIST_UI.hideLabel}
              className={cn(
                "inline-flex min-h-11 items-center rounded-card px-3 text-xs font-medium text-text-secondary underline-offset-4 hover:text-text hover:underline",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
              )}
            >
              {CHECKLIST_UI.hide}
            </button>
          </div>
        </div>

        <div className="hidden items-end md:flex">
          <InnoAnimated variant="full" className="w-28 lg:w-32" {...introFace} />
        </div>
      </div>
    </Card>
  );
}
