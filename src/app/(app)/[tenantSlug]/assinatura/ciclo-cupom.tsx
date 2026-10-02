"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Ticket } from "lucide-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/components/lib/cn";
import { couponSummary, type BillingCycle, type CouponDuration, type CouponKind } from "@/core/billing";
import { applyMyCouponAction, changeBillingCycleAction, previewMyCouponAction } from "@/modules/billing/coupon-actions";
import type { CouponPreview } from "@/modules/billing/coupons";

export type CycleSnapshot = {
  billingCycle: BillingCycle;
  /** `null` = o plano atual não tem opção anual. */
  annualPriceCents: number | null;
  monthlyPriceCents: number;
  /** Economia do anual sobre 12 mensalidades, em centavos (0 se não há). */
  annualSavingsCents: number;
  /** "2 meses grátis" ou `null`. */
  annualSavingsLabel: string | null;
  /** O que a próxima fatura vai cobrar (já com ciclo e cupom). */
  next: { grossCents: number; discountCents: number; netCents: number; cycle: BillingCycle };
  coupon: {
    code: string;
    kind: CouponKind;
    value: number;
    duration: CouponDuration;
    durationCycles: number | null;
    /** Cobranças com desconto que ainda restam; `null` = sem fim. */
    cyclesRemaining: number | null;
    /** O cupom não vale no ciclo atual (fica guardado, sem gastar cobranças). */
    paused: boolean;
  } | null;
};

function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function NextInvoiceLine({ next }: { next: CycleSnapshot["next"] }) {
  return (
    <p className="text-sm text-text" data-testid="proxima-fatura">
      Próxima fatura: <strong className="tabular-nums">{formatBRL(next.netCents)}</strong>
      {next.cycle === "ANNUAL" ? " (cobre 12 meses)" : ""}
      {next.discountCents > 0 ? <span className="text-text-secondary"> em vez de {formatBRL(next.grossCents)}, com o desconto do cupom</span> : null}.
    </p>
  );
}

/** Cartão "Cobrança": mensal ou anual. A troca vale na próxima fatura, sem proporcional. */
export function CicloCard({ tenantSlug, cycle, isOwner }: { tenantSlug: string; cycle: CycleSnapshot; isOwner: boolean }) {
  const router = useRouter();
  const { notify } = useToast();
  const [choice, setChoice] = useState<BillingCycle>(cycle.billingCycle);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const offersAnnual = cycle.annualPriceCents !== null;
  const changed = choice !== cycle.billingCycle;

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await changeBillingCycleAction(tenantSlug, { cycle: choice });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      notify({
        variant: "success",
        title: choice === "ANNUAL" ? "Cobrança anual escolhida." : "Cobrança mensal escolhida.",
        description: result.data.couponPaused ? "Seu cupom não vale nesse tipo de cobrança. Ele fica guardado." : "Vale a partir da próxima fatura.",
      });
      router.refresh();
    });
  }

  return (
    <Card className="rounded-hero" data-testid="assinatura-ciclo">
      <CardHeader help="assinatura.cobranca">
        <CardTitle>Cobrança</CardTitle>
        <CardDescription>
          Hoje a cobrança é {cycle.billingCycle === "ANNUAL" ? "anual" : "mensal"}.
          {offersAnnual ? "" : " O plano atual só tem cobrança mensal."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {offersAnnual ? (
          <fieldset disabled={!isOwner || isPending}>
            <legend className="sr-only">Escolha entre cobrança mensal e anual</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <CycleChoice
                checked={choice === "MONTHLY"}
                onSelect={() => setChoice("MONTHLY")}
                title="Mensal"
                price={`${formatBRL(cycle.monthlyPriceCents)} por mês`}
                note="Uma fatura por mês."
              />
              <CycleChoice
                checked={choice === "ANNUAL"}
                onSelect={() => setChoice("ANNUAL")}
                title="Anual"
                badge={cycle.annualSavingsLabel}
                price={`${formatBRL(cycle.annualPriceCents as number)} por ano`}
                note={cycle.annualSavingsCents > 0 ? `Economiza ${formatBRL(cycle.annualSavingsCents)} no ano.` : "Uma fatura por ano."}
              />
            </div>
          </fieldset>
        ) : null}

        <NextInvoiceLine next={cycle.next} />

        {offersAnnual ? (
          <p className="text-xs text-text-secondary">
            A troca vale a partir da próxima fatura, sem cálculo proporcional. A fatura que já está em aberto e o período já pago continuam como estão.
          </p>
        ) : null}

        {!isOwner && offersAnnual ? <p className="text-xs text-text-secondary">Só o dono da empresa pode trocar a cobrança.</p> : null}
        {error ? <Alert variant="danger">{error}</Alert> : null}
      </CardContent>
      {offersAnnual && isOwner ? (
        <CardFooter>
          <Button icon={Check} type="button" onClick={save} disabled={!changed} isLoading={isPending} loadingText="Salvando…" className="w-full sm:w-auto">
            Salvar cobrança
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}

function CycleChoice({
  checked,
  onSelect,
  title,
  price,
  note,
  badge,
}: {
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
        "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-70",
        checked ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "border-border bg-surface hover:border-primary/40",
      )}
    >
      <input type="radio" name="ciclo" checked={checked} onChange={onSelect} className="sr-only" />
      <span className="flex items-center justify-between gap-2 pr-7">
        <span className="font-display text-sm font-bold text-text">{title}</span>
        {badge ? <span className="rounded-full bg-success-bg px-2 py-0.5 text-xs font-semibold text-success">{badge}</span> : null}
      </span>
      <span className="font-display text-lg font-black tabular-nums text-text">{price}</span>
      <span className="text-xs text-text-secondary">{note}</span>
      <span
        aria-hidden="true"
        className={cn("absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full border", checked ? "border-primary bg-primary text-white" : "border-border")}
      >
        {checked ? <Check className="h-3 w-3" /> : null}
      </span>
    </label>
  );
}

function remainingText(cyclesRemaining: number | null): string {
  if (cyclesRemaining === null) return "O desconto vale em todas as próximas cobranças.";
  return cyclesRemaining === 1 ? "O desconto vale em mais 1 cobrança." : `O desconto vale em mais ${cyclesRemaining} cobranças.`;
}

/** Cartão "Cupom de desconto": mostra o cupom em uso ou deixa conferir e aplicar um novo. */
export function CupomCard({ tenantSlug, coupon, isOwner }: { tenantSlug: string; coupon: CycleSnapshot["coupon"]; isOwner: boolean }) {
  const router = useRouter();
  const { notify } = useToast();
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<CouponPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function check() {
    setError(null);
    setPreview(null);
    startTransition(async () => {
      const result = await previewMyCouponAction(tenantSlug, { code });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setPreview(result.data);
    });
  }

  function apply() {
    setError(null);
    startTransition(async () => {
      const result = await applyMyCouponAction(tenantSlug, { code });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      notify({ variant: "success", title: "Cupom aplicado.", description: "O desconto entra a partir da próxima fatura." });
      setCode("");
      setPreview(null);
      router.refresh();
    });
  }

  return (
    <Card className="rounded-hero" data-testid="assinatura-cupom">
      <CardHeader help="assinatura.cupom">
        <CardTitle>Cupom de desconto</CardTitle>
        <CardDescription>{coupon ? "Seu cupom está guardado e entra na próxima fatura." : "Tem um código de desconto? Digite aqui."}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {coupon ? (
          <div className="rounded-card border border-border bg-bg/60 p-4">
            <p className="flex items-center gap-2 font-mono text-sm font-semibold text-text">
              <Ticket className="h-4 w-4 text-primary" aria-hidden="true" />
              {coupon.code}
            </p>
            <p className="mt-1 text-sm text-text">{couponSummary(coupon.kind, coupon.value, coupon.duration, coupon.durationCycles)}.</p>
            <p className="mt-1 text-xs text-text-secondary">{remainingText(coupon.cyclesRemaining)}</p>
            {coupon.paused ? (
              <p className="mt-2 text-xs text-warning">Esse cupom não vale no tipo de cobrança que você escolheu. Ele fica guardado, sem gastar cobranças.</p>
            ) : null}
          </div>
        ) : isOwner ? (
          <>
            <Field label="Código do cupom">
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value.toUpperCase());
                    setPreview(null);
                    setError(null);
                  }}
                  maxLength={40}
                  autoComplete="off"
                  autoCapitalize="characters"
                  className="font-mono uppercase"
                  placeholder="BEMVINDO20"
                />
              )}
            </Field>
            {error ? <Alert variant="danger">{error}</Alert> : null}
            {preview ? (
              <Alert variant="success" title="Cupom válido">
                {couponSummary(preview.coupon.kind, preview.coupon.value, preview.coupon.duration, preview.coupon.durationCycles)}. A próxima fatura fica em{" "}
                <strong className="tabular-nums">{formatBRL(preview.pricing.netCents)}</strong> em vez de {formatBRL(preview.pricing.grossCents)}.
              </Alert>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-text-secondary">Só o dono da empresa pode aplicar um cupom.</p>
        )}
      </CardContent>
      {!coupon && isOwner ? (
        <CardFooter className="flex-wrap">
          <Button type="button" variant="secondary" onClick={check} disabled={code.trim().length < 3 || isPending} isLoading={isPending && !preview} loadingText="Conferindo…">
            Conferir valor
          </Button>
          <Button icon={Check} type="button" onClick={apply} disabled={code.trim().length < 3 || isPending}>
            Aplicar cupom
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}
