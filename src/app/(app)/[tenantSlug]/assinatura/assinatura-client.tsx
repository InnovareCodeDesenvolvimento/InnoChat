"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatInTimeZone } from "date-fns-tz";
import QRCode from "qrcode";
import { AlertTriangle, ArrowDown, ArrowUp, Check, Copy, QrCode, Sparkles, X } from "lucide-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { HelpButton } from "@/components/help/help-button";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/components/lib/cn";
import { cycleLabel, cycleMonths, invoiceCoverageSuffix, planOffersCycle, type BillingCycle } from "@/core/billing";
import { formatDateTimeLabel } from "@/components/lib/format-date";
import { BillingContactCard } from "@/components/billing/billing-contact-card";
import type { BillingContactData, SaveBillingContact } from "@/components/billing/billing-contact-types";
import { PaymentHistoryCard, type PaymentHistoryItem } from "@/components/billing/payment-history-card";
import { SupportModeBadge } from "@/components/support/SupportModeBadge";
import { SupportAccessCard } from "@/components/billing/support-access-card";
import { SupportActionsCard, type SupportInvoiceOption } from "@/components/billing/support-actions-card";
import type { SupportSessionItem } from "@/modules/billing/support-actions-types";
import { AssinaturaCanceladaCard, CancelamentoAgendadoAviso, CancelarAssinaturaCard } from "./cancelamento";
import { CicloCard, CupomCard, type CycleSnapshot } from "./ciclo-cupom";
import { PixDocumentForm } from "./pix-document-form";
import { changePlanAction, checkMyInvoicePaymentAction, regenerateMyInvoicePixAction, type PlanListItem } from "@/modules/billing/actions";

export type BillingStatus = "TRIALING" | "ACTIVE" | "PAST_DUE" | "SUSPENDED" | "CANCELED";

export type BillingSnapshot = {
  planId: string;
  planName: string;
  planSortOrder: number;
  priceCents: number;
  /** Cobrança (mensal, trimestral, semestral ou anual) e cupom em uso (Melhoria 6). */
  cycle: CycleSnapshot;
  status: BillingStatus;
  trialEndsAt: string | null;
  currentPeriodEnd: string;
  timezone: string;
  pendingPlanId: string | null;
  pendingPlanName: string | null;
  /** Cancelamento agendado pelo dono (vale no fim do período/teste). */
  cancelAtPeriodEnd: boolean;
  /** Quando o acesso termina, se há cancelamento agendado. */
  accessEndsAt: string | null;
  canceledAt: string | null;
  /** Fim da guarda dos dados (cancelamento + 90 dias). */
  retentionEndsAt: string | null;
  /** `true` quando o prazo de guarda (90 dias após o cancelamento) já passou: os dados dos clientes foram anonimizados. */
  dataAnonymized: boolean;
  invoice: {
    id: string;
    amountCents: number;
    dueAt: string;
    pixCopyPaste: string | null;
    pixExpiresAt: string | null;
    paidAt: string | null;
    cycle: BillingCycle;
    discountCents: number;
    couponCode: string | null;
  } | null;
};

const REGENERATE_PIX_ERROR_MESSAGE: Record<string, string> = {
  MERCADOPAGO_MISSING_DOCUMENT: "O Mercado Pago exige o CPF ou CNPJ da empresa para gerar o Pix.",
  MERCADOPAGO_MISCONFIGURED: "O Mercado Pago não está configurado corretamente. Fale com o suporte.",
  MERCADOPAGO_UNAVAILABLE: "O Mercado Pago está indisponível agora. Tente em alguns instantes.",
  RATE_LIMITED: "Muitas tentativas em pouco tempo. Aguarde alguns minutos antes de tentar de novo.",
};

const STATUS_LABEL: Record<BillingStatus, string> = {
  TRIALING: "Em teste",
  ACTIVE: "Ativa",
  PAST_DUE: "Fatura atrasada",
  SUSPENDED: "Suspensa",
  CANCELED: "Cancelada",
};

const STATUS_BADGE: Record<BillingStatus, "primary" | "success" | "warning" | "danger"> = {
  TRIALING: "primary",
  ACTIVE: "success",
  PAST_DUE: "warning",
  SUSPENDED: "danger",
  CANCELED: "danger",
};

function formatBRL(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/** "Atualização periódica do status até pagar": `router.refresh()` re-roda o Server Component
 * (`page.tsx`), que relê o banco — sem precisar de uma Server Action nova só para polling. Para
 * de repetir quando a fatura já não está mais em aberto (nada a esperar). */
function useStatusPolling(shouldPoll: boolean, intervalMs = 15_000) {
  const router = useRouter();
  useEffect(() => {
    if (!shouldPoll) return;
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [shouldPoll, intervalMs, router]);
}

const PAYMENT_CHECK_INTERVAL_MS = 9_000;
const PAYMENT_CHECK_MAX_MS = 15 * 60 * 1000;

/**
 * Conciliação ativa enquanto o Pix está na tela: consulta o Mercado Pago (via server action, que
 * dá baixa se já foi pago) a cada ~9s, SÓ com a aba visível, por até 15 min — não depende do
 * webhook. Ao confirmar, chama `onPaid` uma vez e para. O servidor limita 1 consulta/5s por fatura.
 */
function usePaymentCheck(tenantSlug: string, enabled: boolean, onPaid: () => void) {
  const onPaidRef = useRef(onPaid);
  useEffect(() => {
    onPaidRef.current = onPaid;
  }, [onPaid]);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let inFlight = false;
    const startedAt = Date.now();

    async function check() {
      if (stopped || inFlight || document.visibilityState !== "visible") return;
      if (Date.now() - startedAt > PAYMENT_CHECK_MAX_MS) {
        stopped = true;
        clearInterval(intervalId);
        return;
      }
      inFlight = true;
      try {
        const result = await checkMyInvoicePaymentAction({ tenantSlug });
        if (!stopped && result.ok && result.data.status === "paid") {
          stopped = true;
          clearInterval(intervalId);
          onPaidRef.current();
        }
      } catch {
        // Falha de rede: tenta de novo no próximo ciclo.
      } finally {
        inFlight = false;
      }
    }

    const intervalId = setInterval(check, PAYMENT_CHECK_INTERVAL_MS);
    const onVisible = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    void check();
    return () => {
      stopped = true;
      clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [tenantSlug, enabled]);
}

function PixCard({
  invoice,
  timezone,
  tenantSlug,
  hasDocument,
  isOwner,
  focusOnMount,
}: {
  invoice: NonNullable<BillingSnapshot["invoice"]>;
  timezone: string;
  tenantSlug: string;
  hasDocument: boolean;
  isOwner: boolean;
  focusOnMount: boolean;
}) {
  const router = useRouter();
  const cardRef = useRef<HTMLDivElement>(null);

  // Veio do botão "Pagar com Pix" do banner: rola até o cartão e põe o foco nele (o `#pix` do link
  // sozinho não basta, porque o cartão só existe depois que a página termina de carregar).
  useEffect(() => {
    if (!focusOnMount) return;
    const id = setTimeout(() => {
      cardRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
      cardRef.current?.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(id);
  }, [focusOnMount]);
  const [copied, setCopied] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const canvasRequestId = useRef(0);
  const [isRegenerating, startRegenerate] = useTransition();
  const [regenerateError, setRegenerateError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);

  function handleRegeneratePix() {
    setRegenerateError(null);
    startRegenerate(async () => {
      const result = await regenerateMyInvoicePixAction(tenantSlug, invoice.id);
      setAttempted(true);
      if (!result.ok) {
        setRegenerateError(REGENERATE_PIX_ERROR_MESSAGE[result.error.code] ?? result.error.message);
        return;
      }
      if (!result.data.pixCopyPaste) {
        setRegenerateError("O Pix ainda não pôde ser gerado. Tente de novo em alguns instantes.");
        return;
      }
      router.refresh();
    });
  }

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (!invoice.pixCopyPaste) {
        setQrDataUrl(null);
        return;
      }
      const requestId = ++canvasRequestId.current;
      QRCode.toDataURL(invoice.pixCopyPaste, { width: 240, margin: 1 })
        .then((url) => {
          if (canvasRequestId.current === requestId) setQrDataUrl(url);
        })
        .catch(() => {
          if (canvasRequestId.current === requestId) setQrDataUrl(null);
        });
    }, 0);
    return () => clearTimeout(timeoutId);
  }, [invoice.pixCopyPaste]);

  async function copyCode() {
    if (!invoice.pixCopyPaste) return;
    await navigator.clipboard.writeText(invoice.pixCopyPaste);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  }

  return (
    <div
      ref={cardRef}
      id="pix"
      tabIndex={-1}
      className="scroll-mt-20 rounded-hero-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
    >
    <Card className="rounded-hero-lg border-primary/20 bg-gradient-to-br from-primary/5 to-transparent shadow-card-hover">
      <CardHeader help="assinatura.fatura">
        <CardTitle>Fatura em aberto</CardTitle>
        <CardDescription>
          {formatBRL(invoice.amountCents)}{invoiceCoverageSuffix(invoice.cycle)}, com vencimento em {formatDateTimeLabel(invoice.dueAt, timezone)}
        </CardDescription>
        {invoice.discountCents > 0 ? (
          <p className="mt-1 text-sm text-success" data-testid="fatura-desconto">
            {invoice.couponCode ? `Cupom ${invoice.couponCode}: ` : "Desconto: "}
            {formatBRL(invoice.discountCents)} já abatidos do valor.
          </p>
        ) : null}
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-5 sm:flex-row sm:items-start">
        {invoice.pixCopyPaste ? (
          <>
            {qrDataUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- imagem gerada em runtime (data URL), não é asset estático
              <img
                src={qrDataUrl}
                alt="QR code Pix para pagamento da fatura"
                width={180}
                height={180}
                className="shrink-0 rounded-hero border border-border bg-surface p-2 shadow-card"
              />
            ) : (
              <div className="flex h-[180px] w-[180px] shrink-0 items-center justify-center rounded-hero border border-dashed border-border text-xs text-text-secondary">
                Gerando QR…
              </div>
            )}
            {/* `min-w-0` + `w-full`: sem eles o código Pix (uma linha longa, sem quebra) alarga a coluna e a página ganha rolagem horizontal no celular. */}
            <div className="w-full min-w-0 flex-1">
              <p className="text-sm font-medium text-text">Pague pelo app do seu banco</p>
              <p className="mt-1 text-sm text-text-secondary">
                Escaneie o QR code ou copie o código Pix abaixo e cole na opção &ldquo;Pix Copia e Cola&rdquo;.
              </p>
              <div className="mt-3 flex items-center gap-2 rounded-card border border-border bg-surface p-3">
                <code className="flex-1 overflow-x-auto whitespace-nowrap text-xs text-text">{invoice.pixCopyPaste}</code>
                <Button type="button" variant="ghost" size="icon" aria-label="Copiar código Pix" onClick={copyCode}>
                  {copied ? <Check className="h-4 w-4 text-success" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
                </Button>
              </div>
              {copied ? <p className="mt-1.5 text-xs text-success">Código copiado.</p> : null}
              {invoice.pixExpiresAt ? (
                <p className="mt-2 text-xs text-text-secondary">
                  Este Pix vale até {formatDateTimeLabel(invoice.pixExpiresAt, timezone)}. Depois disso um novo é gerado
                  automaticamente.
                </p>
              ) : null}
            </div>
          </>
        ) : (
          <div className="flex w-full flex-col gap-3">
            {!hasDocument ? (
              <PixDocumentForm tenantSlug={tenantSlug} isOwner={isOwner} />
            ) : (
              <>
                {regenerateError ? (
                  <Alert variant="danger" title="Não foi possível gerar o Pix">
                    {regenerateError}
                    {regenerateError === REGENERATE_PIX_ERROR_MESSAGE.MERCADOPAGO_MISSING_DOCUMENT ? (
                      <>
                        {" "}
                        <Link href={`/${tenantSlug}/configuracoes`} className="font-medium underline">
                          Conferir em Configurações
                        </Link>
                        .
                      </>
                    ) : null}
                  </Alert>
                ) : (
                  <Alert variant="info">
                    O Pix desta fatura ainda não foi gerado. Gere agora ou espere um pouco: esta tela se atualiza sozinha.
                  </Alert>
                )}
                <Button type="button" onClick={handleRegeneratePix} isLoading={isRegenerating} className="self-start">
                  <QrCode className="h-4 w-4" aria-hidden="true" />
                  {attempted ? "Tentar de novo" : "Gerar Pix agora"}
                </Button>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
    </div>
  );
}

type DowngradeBlockedDetails = { rule: "maxProfessionals" | "maxWhatsappNumbers"; limit: number; current: number };

const RULE_LABEL: Record<DowngradeBlockedDetails["rule"], string> = {
  maxProfessionals: "profissionais cadastrados",
  maxWhatsappNumbers: "números de WhatsApp conectados",
};

function PlanosCard({
  tenantSlug,
  snapshot,
  plans,
  isOwner,
}: {
  tenantSlug: string;
  snapshot: BillingSnapshot;
  plans: PlanListItem[];
  isOwner: boolean;
}) {
  const { notify } = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pendingPlanTarget, setPendingPlanTarget] = useState<PlanListItem | null>(null);
  const [blockedDetails, setBlockedDetails] = useState<DowngradeBlockedDetails | null>(null);

  const canChangePlan = isOwner && snapshot.status !== "CANCELED";
  // O plano novo precisa ter o ciclo que a empresa paga hoje; senão a próxima fatura sairia mensal sem ela escolher isso.
  const missingCycle = pendingPlanTarget && !planOffersCycle(pendingPlanTarget, snapshot.cycle.billingCycle) ? snapshot.cycle.billingCycle : null;

  function requestChange(plan: PlanListItem) {
    setPendingPlanTarget(plan);
  }

  function confirmChange() {
    if (!pendingPlanTarget) return;
    const target = pendingPlanTarget;
    startTransition(async () => {
      const result = await changePlanAction(tenantSlug, { planId: target.id });
      if (!result.ok) {
        if (result.error.code === "PLAN_DOWNGRADE_BLOCKED") {
          setBlockedDetails(result.error.details as DowngradeBlockedDetails);
          setPendingPlanTarget(null);
          return;
        }
        notify({ variant: "error", title: "Não foi possível trocar de plano", description: result.error.message });
        setPendingPlanTarget(null);
        return;
      }
      setPendingPlanTarget(null);
      notify({
        variant: "success",
        title: result.data.appliedImmediately ? "Plano trocado." : "Troca agendada.",
        description: result.data.trialInvoiceRepriced
          ? "A fatura do teste já foi atualizada com o valor do novo plano."
          : result.data.appliedImmediately
            ? "O novo plano já está em vigor."
            : "A mudança entra em vigor no próximo ciclo de cobrança.",
      });
      router.refresh();
    });
  }

  return (
    <>
      <div>
        <div className="relative mb-4 pr-12">
          <HelpButton helpKey="assinatura.planos" placement="corner" className="right-0 top-0" />
          <h2 className="font-display text-lg font-bold text-text">Planos disponíveis</h2>
          <p className="mt-1 text-sm text-text-secondary">
            {isOwner
              ? "Subir de plano vale na hora. Descer só é aceito se o que você usa hoje couber no plano novo, e vale a partir do próximo ciclo."
              : "Só o dono da empresa pode trocar de plano."}
          </p>
        </div>

        {snapshot.pendingPlanId && snapshot.pendingPlanName ? (
          <Alert variant="info" className="mb-4">
            Mudança para o plano <strong>{snapshot.pendingPlanName}</strong> agendada para o próximo ciclo.
          </Alert>
        ) : null}
        {plans.length === 0 ? (
          <Alert variant="info">Os planos ainda estão sendo definidos. Seu acesso continua normal.</Alert>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map((plan) => {
              const isCurrent = plan.id === snapshot.planId;
              const isPendingTarget = plan.id === snapshot.pendingPlanId;
              const isUpgrade = plan.sortOrder >= snapshot.planSortOrder;
              return (
                <div
                  key={plan.id}
                  className={cn(
                    "group relative flex flex-col rounded-hero border p-5 transition-[transform,box-shadow,border-color] duration-200 motion-reduce:transition-none",
                    isCurrent
                      ? "border-primary bg-primary/5 shadow-card-hover"
                      : "border-border bg-surface hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-card-hover motion-reduce:hover:translate-y-0",
                  )}
                >
                  {isCurrent ? (
                    <span className="absolute -top-3 left-5 inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-0.5 text-xs font-medium text-white">
                      <Sparkles className="h-3 w-3" aria-hidden="true" />
                      Plano atual
                    </span>
                  ) : null}
                  {isPendingTarget ? (
                    <Badge variant="warning" className="absolute -top-3 left-5">
                      Agendado
                    </Badge>
                  ) : null}

                  <p className="font-display text-base font-bold text-text">{plan.name}</p>
                  <p className="mt-2 font-display text-3xl font-black tabular-nums text-text">
                    {plan.priceCents > 0 ? formatBRL(plan.priceCents) : "Grátis"}
                    {plan.priceCents > 0 ? <span className="text-sm font-medium text-text-secondary">/mês</span> : null}
                  </p>

                  <ul className="mt-4 flex flex-col gap-2 text-sm text-text-secondary">
                    <li className="flex items-center gap-2">
                      <Check className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                      {plan.maxProfessionals === null ? "Profissionais ilimitados" : `Até ${plan.maxProfessionals} profissional(is)`}
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                      Até {plan.maxWhatsappNumbers} número(s) de WhatsApp
                    </li>
                  </ul>

                  <div className="mt-5">
                    {isCurrent || isPendingTarget ? (
                      <Button variant="secondary" size="sm" disabled className="w-full">
                        {isCurrent ? "Plano atual" : "Troca agendada"}
                      </Button>
                    ) : (
                      <Button
                        variant={isUpgrade ? "primary" : "secondary"}
                        size="sm"
                        className="w-full"
                        onClick={() => requestChange(plan)}
                        disabled={!canChangePlan || isPending}
                        title={!isOwner ? "Só o dono pode trocar de plano." : undefined}
                      >
                        {isUpgrade ? (
                          <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                        ) : (
                          <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                        )}
                        {isUpgrade ? "Fazer upgrade" : "Fazer downgrade"}
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Dialog open={!!pendingPlanTarget} onOpenChange={(open) => !open && setPendingPlanTarget(null)}>
        <DialogContent>
          <DialogHeader icon={navIconFor("assinatura")}>
            <DialogTitle>Trocar de plano</DialogTitle>
            <DialogDescription>
              {pendingPlanTarget && pendingPlanTarget.sortOrder >= snapshot.planSortOrder
                ? `Trocar agora para o plano "${pendingPlanTarget?.name}"? ${snapshot.cycle.trialNeverPaid ? "A fatura do teste já sai com o valor do novo plano." : "A diferença de preço aparece na próxima fatura."}`
                : `Trocar para o plano "${pendingPlanTarget?.name}"? Se o uso atual couber, a troca vale a partir do próximo ciclo.`}
            </DialogDescription>
          </DialogHeader>
          {missingCycle && pendingPlanTarget ? (
            <Alert variant="warning" data-testid="troca-sem-ciclo">
              O plano {pendingPlanTarget.name} não tem pagamento a cada {cycleMonths(missingCycle)} meses. Escolha outro ciclo antes de trocar de plano
              (o mensal sempre existe), no cartão Cobrança aqui em cima.
            </Alert>
          ) : null}
          <DialogFooter>
            <Button icon={X} type="button" variant="secondary" onClick={() => setPendingPlanTarget(null)}>
              Cancelar
            </Button>
            <Button icon={Check} type="button" onClick={confirmChange} isLoading={isPending} loadingText="Confirmando…" disabled={missingCycle !== null}>
              Confirmar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!blockedDetails} onOpenChange={(open) => !open && setBlockedDetails(null)}>
        <DialogContent>
          <DialogHeader icon={AlertTriangle} tone="warning">
            <DialogTitle>Não é possível fazer esse downgrade ainda</DialogTitle>
            <DialogDescription>
              {blockedDetails ? (
                <>
                  O plano novo permite até <strong>{blockedDetails.limit}</strong> {RULE_LABEL[blockedDetails.rule]}, e a
                  empresa tem <strong>{blockedDetails.current}</strong> hoje. Remova{" "}
                  {blockedDetails.current - blockedDetails.limit} antes de tentar de novo.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button icon={Check} type="button" onClick={() => setBlockedDetails(null)}>
              Entendi
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AssinaturaClient({
  tenantSlug,
  snapshot,
  plans,
  isOwner,
  hasDocument,
  focusPix,
  renewedUntil,
  history,
  contact,
  saveContact,
  isSupportImpersonation = false,
  supportSessions = [],
  supportInvoices = [],
}: {
  tenantSlug: string;
  snapshot: BillingSnapshot;
  plans: PlanListItem[];
  isOwner: boolean;
  hasDocument: boolean;
  focusPix: boolean;
  /** Pagamento confirmado nos últimos 7 dias: até quando a assinatura está renovada. */
  renewedUntil: string | null;
  history: PaymentHistoryItem[];
  contact: BillingContactData;
  saveContact: SaveBillingContact;
  isSupportImpersonation?: boolean;
  supportSessions?: SupportSessionItem[];
  supportInvoices?: SupportInvoiceOption[];
}) {
  const router = useRouter();
  const [paymentConfirmed, setPaymentConfirmed] = useState(false);
  const currentCycleOption = snapshot.cycle.options.find((o) => o.cycle === snapshot.cycle.billingCycle) ?? null;
  const stillWaitingPayment = snapshot.invoice !== null && !snapshot.invoice.paidAt && !paymentConfirmed;
  useStatusPolling(stillWaitingPayment);
  usePaymentCheck(tenantSlug, stillWaitingPayment && !!snapshot.invoice?.pixCopyPaste, () => {
    setPaymentConfirmed(true);
    router.refresh();
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        help="pagina.assinatura"
        icon={navIconFor("assinatura")}
        title="Assinatura"
        description="Plano atual, status e fatura em aberto."
        badge={<SupportModeBadge isSupportImpersonation={isSupportImpersonation} />}
      />

      {isSupportImpersonation ? (
        <SupportActionsCard
          tenantSlug={tenantSlug}
          isSupportImpersonation={isSupportImpersonation}
          isTrialing={snapshot.status === "TRIALING"}
          invoices={supportInvoices}
        />
      ) : null}

      <Card className="rounded-hero">
        <CardHeader help="assinatura.plano">
          <CardTitle>{snapshot.planName}</CardTitle>
          <CardDescription>
            {snapshot.priceCents > 0
              ? currentCycleOption && snapshot.cycle.billingCycle !== "MONTHLY"
                ? `${formatBRL(currentCycleOption.periodCents)} a cada ${currentCycleOption.every} (cobrança ${cycleLabel(snapshot.cycle.billingCycle)})`
                : `${formatBRL(snapshot.priceCents)} por mês`
              : "Preço a definir. O teste continua funcionando."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Badge variant={STATUS_BADGE[snapshot.status]}>{STATUS_LABEL[snapshot.status]}</Badge>
          {snapshot.status === "TRIALING" && snapshot.trialEndsAt ? (
            <span className="text-sm text-text-secondary">
              Teste termina em {formatDateTimeLabel(snapshot.trialEndsAt, snapshot.timezone)}.
            </span>
          ) : null}
          {snapshot.status === "ACTIVE" && !snapshot.cancelAtPeriodEnd ? (
            <span className="text-sm text-text-secondary">
              Próxima cobrança em {formatDateTimeLabel(snapshot.currentPeriodEnd, snapshot.timezone)}.
            </span>
          ) : null}
          {snapshot.status === "ACTIVE" && snapshot.cancelAtPeriodEnd ? (
            <span className="text-sm text-text-secondary">Sem nova cobrança: o cancelamento está agendado.</span>
          ) : null}
        </CardContent>
        {snapshot.status === "SUSPENDED" ? (
          <CardFooter>
            <Alert variant="danger" className="w-full">
              Enquanto a fatura estiver em aberto, o painel fica só para consulta e o bot não responde no WhatsApp. Pague
              o Pix abaixo e tudo volta sozinho.
            </Alert>
          </CardFooter>
        ) : null}
        {snapshot.status === "PAST_DUE" ? (
          <CardFooter>
            <Alert variant="warning" className="w-full">
              A fatura está atrasada. Pague o Pix abaixo antes do fim da carência para evitar a suspensão.
            </Alert>
          </CardFooter>
        ) : null}
      </Card>

      <CancelamentoAgendadoAviso tenantSlug={tenantSlug} snapshot={snapshot} isOwner={isOwner} />

      {snapshot.status === "CANCELED" ? <AssinaturaCanceladaCard tenantSlug={tenantSlug} snapshot={snapshot} isOwner={isOwner} /> : null}

      {renewedUntil && !paymentConfirmed ? (
        <Alert
          variant="success"
          title={`Assinatura renovada até ${formatInTimeZone(new Date(renewedUntil), snapshot.timezone, "dd/MM/yyyy")}`}
          data-testid="assinatura-renovada"
        >
          Recebemos o seu pagamento. Obrigado!
        </Alert>
      ) : null}

      {paymentConfirmed ? (
        <Alert variant="success" title="Pagamento confirmado!" data-testid="assinatura-pagamento-confirmado">
          Recebemos o seu Pix. Sua assinatura está em dia.
        </Alert>
      ) : null}

      {snapshot.invoice && !paymentConfirmed ? (
        <PixCard invoice={snapshot.invoice} timezone={snapshot.timezone} tenantSlug={tenantSlug} hasDocument={hasDocument} isOwner={isOwner} focusOnMount={focusPix} />
      ) : null}

      {snapshot.status !== "CANCELED" && snapshot.priceCents > 0 ? (
        <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
          <CicloCard tenantSlug={tenantSlug} cycle={snapshot.cycle} isOwner={isOwner} />
          <CupomCard tenantSlug={tenantSlug} coupon={snapshot.cycle.coupon} isOwner={isOwner} />
        </div>
      ) : null}

      {snapshot.status !== "CANCELED" ? <PlanosCard tenantSlug={tenantSlug} snapshot={snapshot} plans={plans} isOwner={isOwner} /> : null}

      <PaymentHistoryCard items={history} timezone={snapshot.timezone} />

      <SupportAccessCard items={supportSessions} timezone={snapshot.timezone} />

      <BillingContactCard tenantSlug={tenantSlug} initial={contact} canEdit={isOwner} save={saveContact} />

      <CancelarAssinaturaCard tenantSlug={tenantSlug} snapshot={snapshot} isOwner={isOwner} />
    </div>
  );
}
