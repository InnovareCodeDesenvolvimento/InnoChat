"use client";

import * as RadixDialog from "@radix-ui/react-dialog";
import { Check, Info, Lightbulb, TriangleAlert } from "lucide-react";
import { cn } from "@/components/lib/cn";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { HELP, type HelpKey } from "./help-content";
import { useHelpVisible } from "./help-visibility";

export type HelpButtonProps = {
  helpKey: HelpKey;
  /**
   * `corner`: canto superior direito do card/cabeçalho (posição absoluta — o pai precisa ser
   * `relative`; `CardHeader`/`PageHeader` já cuidam disso). `inline`: acompanha o texto (ao lado de
   * um rótulo). Nos dois o alvo de toque é 44×44; o círculo visível é menor.
   */
  placement?: "corner" | "inline";
  className?: string;
};

/**
 * Ícone "i" que abre a explicação de uma tela/card/configuração: para que serve, como usar e
 * exemplos concretos (texto em `help-content.ts`). Abre num diálogo — no celular sobe como folha
 * de baixo — com foco preso, Esc para fechar e devolução do foco ao "i" (Radix). Recebe só a
 * CHAVE (string): nunca componente/função como prop vinda de Server Component.
 *
 * Some depois de `HELP_VISIBLE_MS` (opacity 0, mantém espaço e foco; ver `help-visibility.tsx`) e
 * reaparece com hover (no ícone ou no pai), foco de teclado ou diálogo aberto.
 */
export function HelpButton({ helpKey, placement = "inline", className }: HelpButtonProps) {
  const entry = HELP[helpKey];
  const visible = useHelpVisible();
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={`Como funciona: ${entry.title}`}
          data-help-key={helpKey}
          data-help-hidden={visible ? undefined : "true"}
          className={cn(
            "help-fade group/help inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full",
            "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary",
            placement === "corner" ? "absolute right-2 top-2 z-10" : "-my-2 -mr-1.5",
            className,
          )}
        >
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface text-text-secondary transition-colors duration-150 group-hover/help:border-primary/40 group-hover/help:bg-primary/10 group-hover/help:text-primary motion-reduce:transition-none"
          >
            <Info className="h-[18px] w-[18px]" />
          </span>
        </button>
      </DialogTrigger>
      <DialogContent
        aria-describedby={undefined}
        className={cn(
          "flex max-h-[min(40rem,calc(100dvh-2rem))] w-[min(32rem,calc(100vw-2rem))] flex-col overflow-hidden p-0",
          // Celular: folha que sobe da borda de baixo, largura total.
          "max-sm:bottom-0 max-sm:left-0 max-sm:top-auto max-sm:max-h-[88dvh] max-sm:w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none",
        )}
      >
        <div className="shrink-0 px-6 pb-4 pt-6">
          <DialogHeader icon={Info}>
            <p className="text-xs font-semibold uppercase tracking-wide text-primary">Como funciona</p>
            <DialogTitle>{entry.title}</DialogTitle>
          </DialogHeader>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto border-t border-border px-6 py-5" data-help-body="">
          <section>
            <h3 className="text-sm font-bold text-text">Para que serve</h3>
            <p className="mt-1 text-sm leading-relaxed text-text-secondary">{entry.purpose}</p>
          </section>

          {entry.steps?.length ? (
            <section className="mt-5">
              <h3 className="text-sm font-bold text-text">Como usar</h3>
              <ol className="mt-2 flex flex-col gap-2">
                {entry.steps.map((step, index) => (
                  <li key={step} className="flex items-start gap-3 text-sm leading-relaxed text-text-secondary">
                    <span
                      aria-hidden="true"
                      className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary"
                    >
                      {index + 1}
                    </span>
                    <span className="min-w-0">{step}</span>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          <section className="mt-5">
            <h3 className="text-sm font-bold text-text">{entry.examples.length > 1 ? "Exemplos" : "Exemplo"}</h3>
            <ul className="mt-2 flex flex-col gap-2">
              {entry.examples.map((example) => (
                <li key={example} className="rounded-card border border-border bg-bg p-3 text-sm leading-relaxed text-text">
                  {example}
                </li>
              ))}
            </ul>
          </section>

          {entry.tip ? (
            <div className="mt-5 flex items-start gap-2.5 rounded-card border border-primary/20 bg-primary/5 p-3 text-sm leading-relaxed text-text">
              <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <p>
                <strong className="font-semibold">Dica: </strong>
                {entry.tip}
              </p>
            </div>
          ) : null}
          {entry.warning ? (
            <div className="mt-3 flex items-start gap-2.5 rounded-card border border-warning/30 bg-warning-bg p-3 text-sm leading-relaxed text-text">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
              <p>
                <strong className="font-semibold">Atenção: </strong>
                {entry.warning}
              </p>
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 justify-end border-t border-border px-6 py-4">
          <RadixDialog.Close asChild>
            <Button type="button" icon={Check} variant="secondary">
              Entendi
            </Button>
          </RadixDialog.Close>
        </div>
      </DialogContent>
    </Dialog>
  );
}
