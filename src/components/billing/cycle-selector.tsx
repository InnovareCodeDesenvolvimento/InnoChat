"use client";

import { Check } from "lucide-react";
import { cn } from "@/components/lib/cn";
import type { BillingCycle, CycleOptionData } from "@/core/billing";

function brl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/** Texto do valor do ciclo escolhido: "R$ 590,00 a cada 12 meses, o que dá R$ 49,17 por mês." */
export function cycleDetailText(option: CycleOptionData): string {
  if (option.cycle === "MONTHLY") return `${brl(option.periodCents)} por mês, uma fatura por mês.`;
  return `${brl(option.periodCents)} a cada ${option.every}, o que dá ${brl(option.perMonthCents)} por mês.`;
}

/** "Você economiza R$ 118,00 (2 meses grátis)." ou `null` no mensal e sem economia. */
export function cycleSavingsText(option: CycleOptionData): string | null {
  if (option.savingsCents <= 0) return null;
  const free = option.savingsLabel?.includes("grátis") ? option.savingsLabel : null;
  const extra = free ? ` (${free})` : option.percent >= 1 ? ` (${option.percent}%)` : "";
  return `Você economiza ${brl(option.savingsCents)}${extra}.`;
}

/**
 * Seletor de ciclo: "Pagar a cada 1, 3, 6 ou 12 meses". Controle segmentado feito de radios nativos (teclado com
 * setas, leitor de tela anuncia "1 de 4"), 2x2 no celular e 4 numa linha de 640px para cima. Só recebe os ciclos que o
 * plano oferece. O detalhe do escolhido (valor do período, equivalente por mês, economia) fica logo abaixo.
 */
export function CycleSelector({
  options,
  value,
  onChange,
  name = "billingCycle",
  legend = "Pagar a cada",
  disabled,
  primary = "months",
  testId = "ciclo-seletor",
  showDetail = true,
}: {
  options: CycleOptionData[];
  value: BillingCycle;
  onChange: (cycle: BillingCycle) => void;
  name?: string;
  legend?: string;
  disabled?: boolean;
  /** `months` mostra "3 meses" com o nome pequeno embaixo; `name` mostra "Trimestral" com os meses embaixo. */
  primary?: "months" | "name";
  testId?: string;
  showDetail?: boolean;
}) {
  const selected = options.find((o) => o.cycle === value) ?? options[0];
  if (!selected) return null;
  const savings = cycleSavingsText(selected);

  return (
    <fieldset disabled={disabled} className="min-w-0" data-testid={testId}>
      <legend className="mb-2 text-sm font-medium text-text">{legend}</legend>
      <div className={cn("grid gap-2", options.length === 1 ? "grid-cols-1" : "grid-cols-2", options.length >= 3 && "sm:grid-cols-4", options.length === 2 && "sm:grid-cols-2")}>
        {options.map((option) => {
          const checked = option.cycle === selected.cycle;
          return (
            <label
              key={option.cycle}
              data-testid={`ciclo-${option.cycle}`}
              className={cn(
                "relative flex min-h-14 min-w-0 cursor-pointer flex-col items-center justify-center rounded-card border px-2 py-2 text-center transition-colors motion-reduce:transition-none",
                "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary",
                "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-70",
                checked ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "border-border bg-surface hover:border-primary/40",
              )}
            >
              <input type="radio" name={name} value={option.cycle} checked={checked} onChange={() => onChange(option.cycle)} className="sr-only" />
              <span className="flex items-center gap-1 font-display text-sm font-bold text-text">
                {checked ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" /> : null}
                {primary === "months" ? option.every : option.label}
              </span>
              <span className="text-xs text-text-secondary">{primary === "months" ? option.label : option.every}</span>
              {option.percent > 0 && option.savingsCents > 0 ? (
                <span className="mt-1 rounded-full bg-success-bg px-1.5 py-0.5 text-[11px] font-semibold leading-none text-success">
                  <span aria-hidden="true">−{option.percent}%</span>
                  <span className="sr-only">economia de {option.percent}%</span>
                </span>
              ) : null}
            </label>
          );
        })}
      </div>
      {showDetail ? (
        <p aria-live="polite" className="mt-3 text-sm text-text" data-testid="ciclo-detalhe">
          <span className="tabular-nums">{cycleDetailText(selected)}</span>
          {savings ? <span className="font-medium text-success"> {savings}</span> : null}
        </p>
      ) : null}
    </fieldset>
  );
}
