"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Loader2, Ticket, TriangleAlert } from "lucide-react";
import { cn } from "@/components/lib/cn";
import {
  annualFreeMonths,
  annualMonthlyEquivalentCents,
  annualSavingsCents,
  couponSummary,
  planOffersAnnual,
  priceInvoice,
  TRIAL_DAYS,
  type BillingCycle,
} from "@/core/billing";
import { previewSignupCouponAction } from "@/modules/billing/coupon-actions";
import type { CouponPreview } from "@/modules/billing/coupons";

/** Preços do plano que o cadastro assume (o padrão de cadastro), lidos do banco pela página. */
export type SignupPricing = { planName: string; priceCents: number; annualPriceCents: number | null };

function brl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function freeMonthsLabel(plan: { priceCents: number; annualPriceCents: number | null }): string | null {
  const savings = annualSavingsCents(plan);
  if (savings <= 0) return null;
  const months = annualFreeMonths(plan);
  if (months >= 1 && months * plan.priceCents === savings) return months === 1 ? "1 mês grátis" : `${months} meses grátis`;
  return `economize ${brl(savings)}`;
}

const DEBOUNCE_MS = 500;

type CouponStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "valid"; preview: CouponPreview }
  | { kind: "invalid"; message: string };

/**
 * Cobrança depois do teste, no cadastro: escolha mensal/anual (com a economia à vista) e o campo "Tenho um cupom"
 * com validação ao vivo. O servidor revalida tudo no cadastro; aqui é só para a pessoa saber antes de enviar.
 */
export function SignupBillingSection({
  pricing,
  cycle,
  onCycleChange,
  couponCode,
  onCouponCodeChange,
  couponError,
}: {
  pricing: SignupPricing | null;
  cycle: BillingCycle;
  onCycleChange: (cycle: BillingCycle) => void;
  couponCode: string;
  onCouponCodeChange: (code: string) => void;
  /** Erro de cupom devolvido pelo servidor no envio (código inválido, esgotado...). */
  couponError: string | null;
}) {
  const offersAnnual = pricing ? planOffersAnnual(pricing) : false;
  const effectiveCycle: BillingCycle = offersAnnual ? cycle : "MONTHLY";
  const [couponOpen, setCouponOpen] = useState(couponCode.trim() !== "");
  const [status, setStatus] = useState<CouponStatus>({ kind: "idle" });
  const requestRef = useRef(0);

  // Validação ao vivo: espera a pessoa parar de digitar e refaz quando o ciclo muda (o cupom pode valer só no anual).
  useEffect(() => {
    const code = couponCode.trim();
    if (code.length < 3) {
      requestRef.current += 1;
      setStatus({ kind: "idle" });
      return;
    }
    const current = ++requestRef.current;
    setStatus({ kind: "checking" });
    const timer = setTimeout(async () => {
      const result = await previewSignupCouponAction({ code, billingCycle: effectiveCycle });
      if (current !== requestRef.current) return; // resposta velha: já digitaram outra coisa
      setStatus(result.ok ? { kind: "valid", preview: result.data } : { kind: "invalid", message: result.error.message });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [couponCode, effectiveCycle]);

  if (!pricing) return null;

  const gross = priceInvoice(pricing, effectiveCycle, null).grossCents;
  const net = status.kind === "valid" ? status.preview.pricing.netCents : gross;
  const free = freeMonthsLabel(pricing);
  const shownError = status.kind === "invalid" ? status.message : couponError;

  return (
    <div className="flex flex-col gap-4 md:col-span-2 lg:col-span-1 xl:col-span-2" data-testid="signup-cobranca">
      {offersAnnual ? (
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-text">Como você prefere pagar depois do teste</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <CycleOption
              name="billingCycle"
              value="MONTHLY"
              checked={effectiveCycle === "MONTHLY"}
              onSelect={() => onCycleChange("MONTHLY")}
              title="Mensal"
              price={`${brl(pricing.priceCents)} por mês`}
              note="Cancele quando quiser."
            />
            <CycleOption
              name="billingCycle"
              value="ANNUAL"
              checked={effectiveCycle === "ANNUAL"}
              onSelect={() => onCycleChange("ANNUAL")}
              title="Anual"
              badge={free}
              price={`${brl(pricing.annualPriceCents as number)} por ano`}
              note={`Dá ${brl(annualMonthlyEquivalentCents(pricing.annualPriceCents as number))} por mês, pagos de uma vez.`}
            />
          </div>
        </fieldset>
      ) : null}

      <div>
        {couponOpen ? (
          <div>
            <label htmlFor="couponCode" className="mb-2 block text-sm font-medium text-text">
              Cupom de desconto
            </label>
            <div className="relative">
              <Ticket className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" aria-hidden="true" />
              <input
                id="couponCode"
                name="couponCode"
                value={couponCode}
                onChange={(e) => onCouponCodeChange(e.target.value.toUpperCase())}
                maxLength={40}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                aria-invalid={!!shownError || undefined}
                aria-describedby="couponCode-status"
                placeholder="Digite o código"
                className={cn(
                  "h-11 w-full rounded-card border border-border bg-surface pl-9 pr-10 font-mono text-sm uppercase text-text",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
                  shownError && "border-danger",
                )}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2" aria-hidden="true">
                {status.kind === "checking" ? <Loader2 className="h-4 w-4 animate-spin text-text-secondary" /> : null}
                {status.kind === "valid" ? <Check className="h-4 w-4 text-success" /> : null}
                {status.kind === "invalid" ? <TriangleAlert className="h-4 w-4 text-danger" /> : null}
              </span>
            </div>
            <div id="couponCode-status" aria-live="polite" className="mt-1.5 min-h-5 text-xs">
              {status.kind === "valid" ? (
                <p className="text-success">
                  Cupom válido: {couponSummary(status.preview.coupon.kind, status.preview.coupon.value, status.preview.coupon.duration, status.preview.coupon.durationCycles)}.
                </p>
              ) : shownError ? (
                <p role="alert" className="text-danger">
                  {shownError}
                </p>
              ) : null}
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setCouponOpen(true)}
            className="inline-flex min-h-11 items-center gap-2 rounded-card text-sm font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <Ticket className="h-4 w-4" aria-hidden="true" />
            Tenho um cupom
          </button>
        )}
      </div>

      <p className="rounded-card bg-bg/70 p-3 text-sm text-text ring-1 ring-border" data-testid="signup-resumo-cobranca">
        Depois dos {TRIAL_DAYS} dias de teste, a primeira fatura do plano {pricing.planName} é de <strong className="tabular-nums">{brl(net)}</strong>
        {effectiveCycle === "ANNUAL" ? " (cobre 12 meses)" : ""}
        {net < gross ? <span className="text-text-secondary"> em vez de {brl(gross)}</span> : null}. Sem cartão de crédito agora.
      </p>
    </div>
  );
}

function CycleOption({
  name,
  value,
  checked,
  onSelect,
  title,
  price,
  note,
  badge,
}: {
  name: string;
  value: string;
  checked: boolean;
  onSelect: () => void;
  title: string;
  price: string;
  note: string;
  badge?: string | null;
}) {
  return (
    <label
      className={cn(
        "relative flex min-h-11 cursor-pointer flex-col gap-1 rounded-card border p-4 transition-colors motion-reduce:transition-none",
        "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-primary",
        checked ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "border-border bg-surface hover:border-primary/40",
      )}
    >
      <input type="radio" name={name} value={value} checked={checked} onChange={onSelect} className="sr-only" />
      <span className="flex items-center justify-between gap-2">
        <span className="font-display text-sm font-bold text-text">{title}</span>
        {badge ? <span className="rounded-full bg-success-bg px-2 py-0.5 text-xs font-semibold text-success">{badge}</span> : null}
      </span>
      <span className="font-display text-lg font-black tabular-nums text-text">{price}</span>
      <span className="text-xs text-text-secondary">{note}</span>
      <span
        aria-hidden="true"
        className={cn("absolute bottom-3 right-3 flex h-5 w-5 items-center justify-center rounded-full border", checked ? "border-primary bg-primary text-white" : "border-border")}
      >
        {checked ? <Check className="h-3 w-3" /> : null}
      </span>
    </label>
  );
}
