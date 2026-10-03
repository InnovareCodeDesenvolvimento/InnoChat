"use client";

import { useState, useTransition } from "react";
import { Check, CheckCircle2, Copy, XCircle, Zap } from "lucide-react";
import { cn } from "@/components/lib/cn";
import { Button } from "@/components/ui/button";

export type TestResult = { ok: boolean; detalhe: string } | null;

/** Botão "Testar conexão" com resultado inline — usa os valores AINDA NÃO SALVOS do formulário
 * (decisão do dono: testar antes de gravar), nunca lê o que já está no banco. */
export function TestConnectionButton({ onTest }: { onTest: () => Promise<TestResult> }) {
  const [result, setResult] = useState<TestResult>(null);
  const [isPending, startTransition] = useTransition();

  function run() {
    setResult(null);
    startTransition(async () => {
      const r = await onTest();
      setResult(r);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Button icon={Zap} type="button" variant="secondary" size="sm" onClick={run} isLoading={isPending} loadingText="Testando…" className="self-start">
        Testar conexão
      </Button>
      {result ? (
        <p role="status" className={`flex items-center gap-1.5 text-sm ${result.ok ? "text-success" : "text-danger"}`}>
          {result.ok ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          ) : (
            <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          {result.detalhe}
        </p>
      ) : null}
    </div>
  );
}

export function CopyField({ label, value, hint }: { label: string; value: string | null; hint?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  return (
    <div>
      <p className="text-sm font-medium text-text">{label}</p>
      <div className="mt-1 flex items-center gap-2 rounded-card border border-border bg-bg p-2.5">
        <code className="flex-1 overflow-x-auto whitespace-nowrap text-xs text-text">
          {value ?? "Ainda não detectada"}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Copiar ${label}`}
          onClick={copy}
          disabled={!value}
        >
          {copied ? <Check className="h-4 w-4 text-success" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
        </Button>
      </div>
      {hint ? <p className="mt-1 text-xs text-text-secondary">{hint}</p> : null}
    </div>
  );
}

/** Card de status do checklist (docs/design/screens/premium/onda2) — em vez do rótulo com
 * ícone solto de antes, cada item vira um cartão pequeno com selo tingido de sucesso/pendência,
 * escaneável num único olhar. */
export function StatusCard({ label, ready }: { label: string; ready: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-hero border p-4 transition-colors duration-150",
        ready ? "border-success/25 bg-success-bg/60" : "border-border bg-bg",
      )}
    >
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
          ready ? "bg-success/15 text-success" : "bg-text-secondary/10 text-text-secondary",
        )}
      >
        {ready ? <CheckCircle2 className="h-4.5 w-4.5" aria-hidden="true" /> : <XCircle className="h-4.5 w-4.5" aria-hidden="true" />}
      </div>
      <div>
        <p className={cn("text-sm font-semibold", ready ? "text-text" : "text-text-secondary")}>{label}</p>
        <p className="text-xs text-text-secondary">{ready ? "Configurado" : "Pendente"}</p>
      </div>
    </div>
  );
}
