"use client";

import { useEffect, useState } from "react";
import { Check, Loader2, Ticket, TriangleAlert } from "lucide-react";
import { cn } from "@/components/lib/cn";
import {
  buildCycleOptions,
  couponSummary,
  CYCLE_INFO,
  effectiveCycle,
  priceInvoice,
  TRIAL_DAYS,
  type BillingCycle,
} from "@/core/billing";
import { CycleSelector } from "@/components/billing/cycle-selector";
import { previewSignupCouponAction } from "@/modules/billing/coupon-actions";
import type { CouponPreview } from "@/modules/billing/coupons";

import type { SignupPricing } from "./signup-pricing";

export type { SignupPricing };

function brl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const DEBOUNCE_MS = 500;

type CouponStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "valid"; preview: CouponPreview }
  | { kind: "invalid"; message: string };

/**
 * Cobrança depois do teste, no cadastro: escolha "Pagar a cada 1, 3, 6 ou 12 meses" (com a economia à vista) e o campo "Tenho um cupom"
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
  const options = pricing ? buildCycleOptions(pricing) : [];
  const offersChoice = options.length > 1;
  // O plano pode não oferecer o ciclo que ficou no estado (ex.: trocou de plano): cai no mensal.
  const activeCycle: BillingCycle = pricing ? effectiveCycle(pricing, cycle) : "MONTHLY";
  const [couponOpen, setCouponOpen] = useState(couponCode.trim() !== "");
  // Resultado da última consulta, com a chave (código + ciclo) a que ele responde. O estado "idle/checking" é DERIVADO
  // (sem setState no efeito): sem chave igual, ainda está conferindo.
  const [answer, setAnswer] = useState<{ key: string; status: CouponStatus } | null>(null);
  const code = couponCode.trim();
  const key = `${code}|${activeCycle}`;
  const status: CouponStatus = code.length < 3 ? { kind: "idle" } : answer && answer.key === key ? answer.status : { kind: "checking" };

  // Validação ao vivo: espera a pessoa parar de digitar e refaz quando o ciclo muda (o cupom pode valer só em alguns ciclos).
  useEffect(() => {
    if (code.length < 3) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      const result = await previewSignupCouponAction({ code, billingCycle: activeCycle });
      if (cancelled) return; // resposta velha: já digitaram outra coisa
      setAnswer({ key, status: result.ok ? { kind: "valid", preview: result.data } : { kind: "invalid", message: result.error.message } });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, activeCycle, key]);

  if (!pricing) return null;

  const gross = priceInvoice(pricing, activeCycle, null).grossCents;
  const net = status.kind === "valid" ? status.preview.pricing.netCents : gross;
  const shownError = status.kind === "invalid" ? status.message : couponError;

  return (
    <div className="flex flex-col gap-4 md:col-span-2 lg:col-span-1 xl:col-span-2" data-testid="signup-cobranca">
      {offersChoice ? (
        <CycleSelector options={options} value={activeCycle} onChange={onCycleChange} legend="Pagar a cada (depois do teste)" />
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
        {activeCycle !== "MONTHLY" ? ` (cobre ${CYCLE_INFO[activeCycle].every})` : ""}
        {net < gross ? <span className="text-text-secondary"> em vez de {brl(gross)}</span> : null}. Sem cartão de crédito agora.
      </p>
    </div>
  );
}
