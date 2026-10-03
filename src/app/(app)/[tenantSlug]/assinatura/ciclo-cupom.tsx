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
import { couponSummary, CYCLE_INFO, cycleLabel, cycleTitle, invoiceCoverageSuffix, type BillingCycle, type CouponDuration, type CouponKind, type CycleOptionData } from "@/core/billing";
import { CycleSelector } from "@/components/billing/cycle-selector";
import { applyMyCouponAction, changeBillingCycleAction, previewMyCouponAction } from "@/modules/billing/coupon-actions";
import type { CouponPreview } from "@/modules/billing/coupons";

export type CycleSnapshot = {
  /** Ciclo EFETIVO (o que a próxima fatura cobra). */
  billingCycle: BillingCycle;
  /** Ciclos que o plano atual oferece, com valor do período, equivalente por mês e economia. O mensal vem sempre. */
  options: CycleOptionData[];
  /** Ciclo guardado na assinatura que o plano não oferece mais (a fatura sai mensal); `null` = tudo certo. */
  fallbackFrom: BillingCycle | null;
  /** O que a próxima fatura vai cobrar (já com ciclo e cupom). */
  next: { grossCents: number; discountCents: number; netCents: number; cycle: BillingCycle };
  coupon: {
    code: string;
    kind: CouponKind;
    value: number;
    duration: CouponDuration;
    durationCycles: number | null;
    /** Faturas com desconto que ainda restam; `null` = sem fim. */
    cyclesRemaining: number | null;
    /** O cupom não vale no ciclo atual (fica guardado, sem gastar faturas). */
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
      {invoiceCoverageSuffix(next.cycle)}
      {next.discountCents > 0 ? <span className="text-text-secondary"> em vez de {formatBRL(next.grossCents)}, com o desconto do cupom</span> : null}.
    </p>
  );
}

/** Cartão "Cobrança": mensal, trimestral, semestral ou anual. A troca vale na próxima fatura, sem proporcional. */
export function CicloCard({ tenantSlug, cycle, isOwner }: { tenantSlug: string; cycle: CycleSnapshot; isOwner: boolean }) {
  const router = useRouter();
  const { notify } = useToast();
  const [choice, setChoice] = useState<BillingCycle>(cycle.billingCycle);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const offersChoice = cycle.options.length > 1;
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
        title: `Cobrança ${cycleLabel(choice)} escolhida.`,
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
          Hoje a cobrança é {cycleLabel(cycle.billingCycle)}.
          {offersChoice ? "" : " O plano atual só tem cobrança mensal."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {offersChoice ? (
          <CycleSelector options={cycle.options} value={choice} onChange={setChoice} name="ciclo" legend={`Pagar a cada (hoje: ${cycleTitle(cycle.billingCycle).toLowerCase()})`} disabled={!isOwner || isPending} />
        ) : null}

        {cycle.fallbackFrom ? (
          <Alert variant="warning" data-testid="ciclo-caiu-no-mensal">
            Seu plano não tem mais pagamento a cada {CYCLE_INFO[cycle.fallbackFrom].every}; a próxima fatura sai mensal.
            {offersChoice ? " Se preferir outro ciclo, escolha abaixo." : ""}
          </Alert>
        ) : null}

        <NextInvoiceLine next={cycle.next} />

        {offersChoice ? (
          <p className="text-xs text-text-secondary">
            A troca vale a partir da próxima fatura, sem cálculo proporcional. A fatura que já está em aberto e o período já pago continuam como estão.
          </p>
        ) : null}

        {!isOwner && offersChoice ? <p className="text-xs text-text-secondary">Só o dono da empresa pode trocar a cobrança.</p> : null}
        {error ? <Alert variant="danger">{error}</Alert> : null}
      </CardContent>
      {offersChoice && isOwner ? (
        <CardFooter>
          <Button icon={Check} type="button" onClick={save} disabled={!changed} isLoading={isPending} loadingText="Salvando…" className="w-full sm:w-auto">
            Salvar cobrança
          </Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}

function remainingText(cyclesRemaining: number | null): string {
  if (cyclesRemaining === null) return "O desconto vale em todas as próximas faturas.";
  return cyclesRemaining === 1 ? "O desconto vale em mais 1 fatura." : `O desconto vale em mais ${cyclesRemaining} faturas.`;
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
              <p className="mt-2 text-xs text-warning">Esse cupom não vale no tipo de cobrança que você escolheu. Ele fica guardado, sem gastar faturas.</p>
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
