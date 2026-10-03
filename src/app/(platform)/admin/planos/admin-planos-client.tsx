"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, Check, MessageCircle, Pencil, Sparkles, Users2, X } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { useToast } from "@/components/ui/toast";
import { HelpButton } from "@/components/help/help-button";
import {
  CYCLE_INFO,
  CYCLE_PRICE_FIELD,
  cycleSavings,
  cycleSavingsLabel,
  MIN_CHARGE_CENTS,
  suggestCyclePrices,
  type BillingCycle,
  type SuggestedPrice,
} from "@/core/billing";
import { updatePlanAction } from "@/modules/billing/admin-actions";

export type PlanRow = {
  id: string;
  code: string;
  name: string;
  priceCents: number;
  /** Preço do período inteiro (cobrado de uma vez), em centavos; `null` = o plano não oferece o período. */
  quarterlyPriceCents: number | null;
  semiannualPriceCents: number | null;
  annualPriceCents: number | null;
  maxWhatsappNumbers: number;
  maxProfessionals: number | null;
  active: boolean;
  sortOrder: number;
};

function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const LONG_CYCLES = ["QUARTERLY", "SEMIANNUAL", "ANNUAL"] as const;
type LongCycle = (typeof LONG_CYCLES)[number];

type FormState = {
  name: string;
  priceReais: string;
  /** Preço do período por ciclo, em reais, como o admin digita. Em branco = não oferece. */
  periodReais: Record<LongCycle, string>;
  maxWhatsappNumbers: string;
  maxProfessionalsUnlimited: boolean;
  maxProfessionals: string;
  active: boolean;
  sortOrder: string;
};

function reais(cents: number | null): string {
  return cents !== null ? (cents / 100).toFixed(2) : "";
}

function toForm(plan: PlanRow): FormState {
  return {
    name: plan.name,
    priceReais: (plan.priceCents / 100).toFixed(2),
    periodReais: {
      QUARTERLY: reais(plan.quarterlyPriceCents),
      SEMIANNUAL: reais(plan.semiannualPriceCents),
      ANNUAL: reais(plan.annualPriceCents),
    },
    maxWhatsappNumbers: String(plan.maxWhatsappNumbers),
    maxProfessionalsUnlimited: plan.maxProfessionals === null,
    maxProfessionals: plan.maxProfessionals !== null ? String(plan.maxProfessionals) : "",
    active: plan.active,
    sortOrder: String(plan.sortOrder),
  };
}

function toCents(text: string): number {
  return Math.round(Number(text.replace(",", ".")) * 100);
}

/** Preços do plano como o núcleo os lê (`null` = não oferece). */
function planPricesOf(plan: PlanRow) {
  return {
    priceCents: plan.priceCents,
    quarterlyPriceCents: plan.quarterlyPriceCents,
    semiannualPriceCents: plan.semiannualPriceCents,
    annualPriceCents: plan.annualPriceCents,
  };
}

function savingsLine(prices: ReturnType<typeof planPricesOf>, cycle: BillingCycle): string | null {
  const s = cycleSavings(prices, cycle);
  if (s.periodCents === null || s.savingsCents <= 0) return null;
  const label = cycleSavingsLabel(prices, cycle);
  return label ? `${label}, ${formatBRL(s.savingsCents)} de economia` : `${formatBRL(s.savingsCents)} de economia`;
}

/**
 * Dica ao vivo sob cada campo de período: quanto custam as mensalidades do período, a economia em reais e em % e o
 * equivalente por mês. Se há assinaturas ativas no período e o campo está em branco, avisa que não pode apagar.
 */
function cycleHint(cycle: LongCycle, form: FormState, inUse: number): string {
  const info = CYCLE_INFO[cycle];
  const text = form.periodReais[cycle].trim();
  if (text === "") {
    return inUse > 0
      ? `${inUse === 1 ? "1 assinatura ativa usa" : `${inUse} assinaturas ativas usam`} este período: o preço não pode ficar em branco.`
      : "Em branco: o plano não oferece este período.";
  }
  const monthly = toCents(form.priceReais);
  const value = toCents(text);
  if (Number.isNaN(value) || value <= 0) return "Digite o valor do período inteiro, por exemplo 168,00.";
  if (Number.isNaN(monthly) || monthly <= 0) return "Defina o preço mensal para ver a economia.";
  const full = monthly * info.months;
  if (value > full) return `Maior que ${info.months} mensalidades (${formatBRL(full)}). Confira o valor.`;
  const prices = { priceCents: monthly, quarterlyPriceCents: null, semiannualPriceCents: null, annualPriceCents: null, [CYCLE_PRICE_FIELD[cycle]]: value } as ReturnType<typeof planPricesOf>;
  const s = cycleSavings(prices, cycle);
  const perMonth = `Dá ${formatBRL(s.perMonthCents as number)} por mês.`;
  if (s.savingsCents === 0) return `Igual a ${info.months} mensalidades: sem desconto. ${perMonth}`;
  const label = cycleSavingsLabel(prices, cycle);
  return `${info.months} mensalidades custam ${formatBRL(full)}. Economia de ${formatBRL(s.savingsCents)} (${s.percent}%${label && label.includes("grátis") ? `, ${label}` : ""}). ${perMonth}`;
}

/** Conta que o botão "Sugerir" fez, por período, para o admin conferir antes de salvar. */
function suggestionLine(monthly: number, s: SuggestedPrice): string {
  const info = CYCLE_INFO[s.cycle];
  return `${info.label}: ${formatBRL(monthly)} x ${info.months} = ${formatBRL(s.fullCents)}. Com ${s.rule}: ${formatBRL(s.rawCents)}, arredondado para ${formatBRL(s.roundedCents)}.`;
}

export function AdminPlanosClient({
  initialPlans,
  cycleUsage = {},
}: {
  initialPlans: PlanRow[];
  /** Assinaturas não canceladas por plano e ciclo (para avisar antes de apagar um preço em uso). */
  cycleUsage?: Record<string, Partial<Record<BillingCycle, number>>>;
}) {
  const { notify } = useToast();
  const [plans, setPlans] = useState<PlanRow[]>([...initialPlans].sort((a, b) => a.sortOrder - b.sortOrder));
  const [editing, setEditing] = useState<PlanRow | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<SuggestedPrice[] | null>(null);
  /** Aviso de preço de período abaixo de 50% das mensalidades: o servidor recusa até o admin confirmar neste diálogo. */
  const [lowPriceWarning, setLowPriceWarning] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function openEdit(plan: PlanRow) {
    setEditing(plan);
    setForm(toForm(plan));
    setFormError(null);
    setSuggestion(null);
  }

  function closeEdit() {
    setEditing(null);
    setForm(null);
    setSuggestion(null);
  }

  /** Preenche os três períodos com 5%, 10% e 2 meses grátis, arredondados; o admin edita depois. */
  function applySuggestion() {
    if (!form) return;
    const monthly = toCents(form.priceReais);
    const suggested = suggestCyclePrices(monthly);
    if (suggested.length === 0) {
      setFormError("Defina o preço mensal (pelo menos R$ 1,00) para sugerir os outros períodos.");
      return;
    }
    setFormError(null);
    setSuggestion(suggested);
    setForm((f) => f && { ...f, periodReais: { QUARTERLY: reais(suggested[0].roundedCents), SEMIANNUAL: reais(suggested[1].roundedCents), ANNUAL: reais(suggested[2].roundedCents) } });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing || !form) return;
    setFormError(null);

    const priceCents = Math.round(Number(form.priceReais.replace(",", ".")) * 100);
    if (Number.isNaN(priceCents) || priceCents < 0) {
      setFormError("Informe um preço válido.");
      return;
    }

    // Em branco = o plano não oferece o período. Preenchido precisa ser válido e não passar das mensalidades do período.
    const periodCents: Record<LongCycle, number | null> = { QUARTERLY: null, SEMIANNUAL: null, ANNUAL: null };
    for (const cycle of LONG_CYCLES) {
      const info = CYCLE_INFO[cycle];
      const text = form.periodReais[cycle].trim();
      const inUse = cycleUsage[editing.id]?.[cycle] ?? 0;
      if (text === "") {
        if (inUse > 0) {
          setFormError(`Não dá para tirar o preço ${info.word}: ${inUse === 1 ? "1 assinatura ativa usa" : `${inUse} assinaturas ativas usam`} esse período neste plano.`);
          return;
        }
        continue;
      }
      const value = toCents(text);
      if (Number.isNaN(value) || value < MIN_CHARGE_CENTS) {
        setFormError(`O preço ${info.word} precisa ser pelo menos R$ 1,00, ou deixe em branco.`);
        return;
      }
      if (priceCents > 0 && value > priceCents * info.months) {
        setFormError(`O preço ${info.word} não pode ser maior que ${info.months} mensalidades.`);
        return;
      }
      periodCents[cycle] = value;
    }

    submitPlan(editing, form, priceCents, periodCents, false);
  }

  function submitPlan(plan: PlanRow, values: FormState, priceCents: number, periodCents: Record<LongCycle, number | null>, confirmLowPrice: boolean) {
    startTransition(async () => {
      const result = await updatePlanAction(plan.id, {
        name: values.name.trim(),
        priceCents,
        quarterlyPriceCents: periodCents.QUARTERLY,
        semiannualPriceCents: periodCents.SEMIANNUAL,
        annualPriceCents: periodCents.ANNUAL,
        maxWhatsappNumbers: Number(values.maxWhatsappNumbers) || 1,
        maxProfessionals: values.maxProfessionalsUnlimited ? null : Number(values.maxProfessionals) || 1,
        active: values.active,
        sortOrder: Number(values.sortOrder) || 0,
        ...(confirmLowPrice ? { confirmLowPrice: true } : {}),
      });

      if (!result.ok) {
        if (result.error.code === "LOW_CYCLE_PRICE_UNCONFIRMED") {
          setLowPriceWarning(result.error.message);
          return;
        }
        setLowPriceWarning(null);
        setFormError(result.error.message);
        return;
      }
      setLowPriceWarning(null);

      const saved = result.data as PlanRow;
      setPlans((prev) => prev.map((p) => (p.id === saved.id ? saved : p)).sort((a, b) => a.sortOrder - b.sortOrder));
      setEditing(null);
      setForm(null);
      setSuggestion(null);
      notify({ variant: "success", title: "Plano atualizado." });
    });
  }

  const hasUndefinedPrice = plans.some((p) => p.priceCents === 0);

  return (
    <div>
      <PageHeader icon={navIconFor("admin/planos")} title="Planos" description="Limites, preço e ativação de cada plano." />

      {hasUndefinedPrice ? (
        <Alert variant="warning" title="Preço ainda não definido" className="mb-4">
          Planos com preço R$ 0,00 e inativos continuam permitindo o teste gratuito. Eles só não podem ser
          vendidos até você definir um preço e ativá-los.
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {plans.map((plan) => (
          <div
            key={plan.id}
            className="group relative flex flex-col rounded-hero border border-border bg-surface p-5 transition-[transform,box-shadow,border-color] duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-card-hover motion-reduce:transition-none motion-reduce:hover:translate-y-0"
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-display text-base font-bold text-text">{plan.name}</p>
                <p className="text-xs text-text-secondary">{plan.code}</p>
              </div>
              <Badge variant={plan.active ? "success" : "neutral"}>{plan.active ? "Ativo" : "Inativo"}</Badge>
            </div>

            <p className="mt-3 font-display text-3xl font-black tabular-nums text-text">
              {plan.priceCents > 0 ? (
                formatBRL(plan.priceCents)
              ) : (
                <span className="text-lg font-bold text-text-secondary">A definir</span>
              )}
              {plan.priceCents > 0 ? <span className="text-sm font-medium text-text-secondary">/mês</span> : null}
            </p>
            <ul className="mt-2 flex flex-col gap-1 text-sm text-text-secondary" data-testid="plano-ciclos">
              {LONG_CYCLES.filter((cycle) => plan[CYCLE_PRICE_FIELD[cycle]] !== null).map((cycle) => {
                const line = savingsLine(planPricesOf(plan), cycle);
                return (
                  <li key={cycle} data-testid={`plano-ciclo-${cycle}`}>
                    <span className="font-medium text-text">{CYCLE_INFO[cycle].label}:</span>{" "}
                    <span className="font-semibold text-text">{formatBRL(plan[CYCLE_PRICE_FIELD[cycle]] as number)}</span> a cada {CYCLE_INFO[cycle].every}
                    {line ? <span className="font-semibold text-success"> ({line})</span> : null}
                  </li>
                );
              })}
              {LONG_CYCLES.every((cycle) => plan[CYCLE_PRICE_FIELD[cycle]] === null) ? <li>Só cobrança mensal</li> : null}
            </ul>

            <ul className="mt-4 flex flex-col gap-2 text-sm text-text-secondary">
              <li className="flex items-center gap-2">
                <MessageCircle className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                {plan.maxWhatsappNumbers} número(s) de WhatsApp
              </li>
              <li className="flex items-center gap-2">
                <Users2 className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                {plan.maxProfessionals === null ? "Profissionais ilimitados" : `Até ${plan.maxProfessionals} profissional(is)`}
              </li>
            </ul>

            <Button
              variant="secondary"
              size="sm"
              className="mt-5 w-full transition-transform duration-200 group-hover:scale-[1.02] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
              onClick={() => openEdit(plan)}
            >
              <Pencil className="h-4 w-4" aria-hidden="true" />
              Editar plano
            </Button>
          </div>
        ))}
      </div>

      <Dialog open={lowPriceWarning !== null} onOpenChange={(open) => !open && setLowPriceWarning(null)}>
        <DialogContent>
          <DialogHeader icon={AlertTriangle} tone="warning">
            <DialogTitle>Esse preço está muito baixo</DialogTitle>
            <DialogDescription data-testid="aviso-preco-baixo">{lowPriceWarning}</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-text-secondary">Se foi engano (por exemplo, 4,90 no lugar de 490,00), volte e corrija. Se é de propósito, confirme.</p>
          <DialogFooter>
            <Button icon={X} type="button" variant="secondary" onClick={() => setLowPriceWarning(null)}>
              Voltar e corrigir
            </Button>
            <Button
              icon={Check}
              type="button"
              isLoading={isPending}
              loadingText="Salvando…"
              data-testid="confirmar-preco-baixo"
              onClick={() => {
                if (!editing || !form) return;
                const priceCents = toCents(form.priceReais);
                const periodCents: Record<LongCycle, number | null> = { QUARTERLY: null, SEMIANNUAL: null, ANNUAL: null };
                for (const cycle of LONG_CYCLES) {
                  const text = form.periodReais[cycle].trim();
                  periodCents[cycle] = text === "" ? null : toCents(text);
                }
                submitPlan(editing, form, priceCents, periodCents, true);
              }}
            >
              Salvar mesmo assim
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={(open) => !open && closeEdit()}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <DialogHeader icon={navIconFor("admin/planos")}>
            <DialogTitle>Editar plano</DialogTitle>
            <DialogDescription>Alterações valem para novas cobranças a partir de agora.</DialogDescription>
          </DialogHeader>
          {form ? (
            <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-4">
              {formError ? <Alert variant="danger">{formError}</Alert> : null}

              <Field label="Nome" required>
                {(fieldProps) => (
                  <Input {...fieldProps} value={form.name} onChange={(e) => setForm((f) => f && { ...f, name: e.target.value })} required maxLength={80} />
                )}
              </Field>

              <Field label="Preço mensal (R$)" required hint="R$ 0,00 mantém o plano fora de venda, mas não afeta o teste.">
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    inputMode="decimal"
                    value={form.priceReais}
                    onChange={(e) => setForm((f) => f && { ...f, priceReais: e.target.value })}
                    required
                  />
                )}
              </Field>

              <fieldset className="flex flex-col gap-4 rounded-card border border-border p-4" data-testid="plano-precos-periodo">
                <legend className="flex items-center gap-1 px-1 text-sm font-semibold text-text">
                  Preços por período
                  <HelpButton helpKey="admin.planoCiclos" />
                </legend>
                <p className="text-xs text-text-secondary">
                  Valor cobrado de uma vez pelo período inteiro. Em branco, o plano não oferece aquele período.
                </p>
                {LONG_CYCLES.map((cycle) => (
                  <Field
                    key={cycle}
                    label={`${CYCLE_INFO[cycle].label}, a cada ${CYCLE_INFO[cycle].every} (R$)`}
                    hint={cycleHint(cycle, form, editing ? (cycleUsage[editing.id]?.[cycle] ?? 0) : 0)}
                  >
                    {(fieldProps) => (
                      <Input
                        {...fieldProps}
                        inputMode="decimal"
                        name={`preco-${cycle}`}
                        placeholder="Em branco = não oferece"
                        value={form.periodReais[cycle]}
                        onChange={(e) => {
                          const value = e.target.value;
                          setForm((f) => f && { ...f, periodReais: { ...f.periodReais, [cycle]: value } });
                        }}
                      />
                    )}
                  </Field>
                ))}
                <div className="flex flex-col gap-2">
                  <Button type="button" variant="secondary" size="sm" icon={Sparkles} onClick={applySuggestion} data-testid="sugerir-precos" className="w-full sm:w-auto">
                    Sugerir preços
                  </Button>
                  {suggestion ? (
                    <ul className="flex flex-col gap-1 rounded-card bg-bg/70 p-3 text-xs text-text-secondary ring-1 ring-border" data-testid="sugestao-calculo">
                      {suggestion.map((item) => (
                        <li key={item.cycle}>{suggestionLine(toCents(form.priceReais), item)}</li>
                      ))}
                      <li className="font-medium text-text">Os valores já estão nos campos. Edite se quiser e salve.</li>
                    </ul>
                  ) : null}
                </div>
              </fieldset>

              <Field label="Limite de números de WhatsApp" required>
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    type="number"
                    min={1}
                    value={form.maxWhatsappNumbers}
                    onChange={(e) => setForm((f) => f && { ...f, maxWhatsappNumbers: e.target.value })}
                    required
                  />
                )}
              </Field>

              <div>
                <label className="flex items-center gap-2 text-sm text-text">
                  <input
                    type="checkbox"
                    checked={form.maxProfessionalsUnlimited}
                    onChange={(e) => setForm((f) => f && { ...f, maxProfessionalsUnlimited: e.target.checked })}
                    className="h-4 w-4 rounded border-border accent-primary"
                  />
                  Profissionais ilimitados
                </label>
                {!form.maxProfessionalsUnlimited ? (
                  <div className="mt-3">
                    <Field label="Limite de profissionais" required>
                      {(fieldProps) => (
                        <Input
                          {...fieldProps}
                          type="number"
                          min={1}
                          value={form.maxProfessionals}
                          onChange={(e) => setForm((f) => f && { ...f, maxProfessionals: e.target.value })}
                          required
                        />
                      )}
                    </Field>
                  </div>
                ) : null}
              </div>

              <label className="flex items-center gap-2 text-sm text-text">
                <input
                  type="checkbox"
                  checked={form.active}
                  onChange={(e) => setForm((f) => f && { ...f, active: e.target.checked })}
                  className="h-4 w-4 rounded border-border accent-primary"
                />
                Ativo (pode ser vendido/exibido para novas empresas)
              </label>

              <Field label="Ordem de exibição">
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    type="number"
                    value={form.sortOrder}
                    onChange={(e) => setForm((f) => f && { ...f, sortOrder: e.target.value })}
                  />
                )}
              </Field>

              <DialogFooter>
                <Button icon={X} type="button" variant="secondary" onClick={closeEdit}>
                  Cancelar
                </Button>
                <Button icon={Check} type="submit" isLoading={isPending} loadingText="Salvando…">
                  Salvar
                </Button>
              </DialogFooter>
            </form>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
