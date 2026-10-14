"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Wrench, CalendarPlus, Tag, Send, X, AlertCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select } from "@/components/ui/select";
import { Alert } from "@/components/ui/alert";
import { useToast } from "@/components/ui/toast";
import {
  extendTrialAction,
  applySupportCouponAction,
  resendPaymentLinkAction,
} from "@/modules/billing/support-actions";

export type SupportInvoiceOption = {
  id: string;
  amountCents: number;
  dueAt: string;
  status: string;
};

export type SupportActionsCardProps = {
  tenantSlug: string;
  isSupportImpersonation?: boolean;
  isTrialing?: boolean;
  invoices?: SupportInvoiceOption[];
  className?: string;
  container?: HTMLElement | null;
};

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

/**
 * Card com as ações de suporte para assinatura e cobrança da empresa:
 * 1) Estender trial (dias de 1 a 30, motivo 15-500)
 * 2) Aplicar cupom (código e motivo 15-500)
 * 3) Reenviar link de pagamento Pix (fatura e motivo 15-500)
 *
 * Cada ação abre um modal padronizado com motivo obrigatório, contador de caracteres,
 * ajuda contextual nos campos sensíveis e tratamento de erro e sucesso.
 */
export function SupportActionsCard({
  tenantSlug,
  isSupportImpersonation,
  isTrialing,
  invoices = [],
  className,
  container,
}: SupportActionsCardProps) {
  const router = useRouter();
  const { notify } = useToast();

  const [activeModal, setActiveModal] = useState<"trial" | "coupon" | "resend" | null>(null);

  // Estados dos modais
  const [trialDays, setTrialDays] = useState(7);
  const [trialReason, setTrialReason] = useState("");

  const [couponCode, setCouponCode] = useState("");
  const [couponReason, setCouponReason] = useState("");

  const [resendInvoiceId, setResendInvoiceId] = useState(invoices[0]?.id ?? "");
  const [resendReason, setResendReason] = useState("");

  const [modalError, setModalError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!isSupportImpersonation) {
    return null;
  }

  function closeModal() {
    setActiveModal(null);
    setModalError(null);
    setTrialReason("");
    setCouponReason("");
    setResendReason("");
  }

  function handleExtendTrial(e: React.FormEvent) {
    e.preventDefault();
    setModalError(null);

    const reason = trialReason.trim();
    if (reason.length < 15) {
      setModalError("O motivo deve ter pelo menos 15 caracteres.");
      return;
    }
    if (reason.length > 500) {
      setModalError("O motivo não pode ultrapassar 500 caracteres.");
      return;
    }

    startTransition(async () => {
      const result = await extendTrialAction(tenantSlug, {
        days: trialDays,
        reason,
      });

      if (!result.ok) {
        setModalError(result.error.message);
        return;
      }

      notify({
        variant: "success",
        title: "Período de teste estendido com sucesso.",
        description: `Adicionados ${trialDays} dias extras de teste.`,
      });
      closeModal();
      router.refresh();
    });
  }

  function handleApplyCoupon(e: React.FormEvent) {
    e.preventDefault();
    setModalError(null);

    const code = couponCode.trim();
    if (!code) {
      setModalError("Digite o código do cupom.");
      return;
    }

    const reason = couponReason.trim();
    if (reason.length < 15) {
      setModalError("O motivo deve ter pelo menos 15 caracteres.");
      return;
    }
    if (reason.length > 500) {
      setModalError("O motivo não pode ultrapassar 500 caracteres.");
      return;
    }

    startTransition(async () => {
      const result = await applySupportCouponAction(tenantSlug, {
        code,
        reason,
      });

      if (!result.ok) {
        setModalError(result.error.message);
        return;
      }

      notify({
        variant: "success",
        title: "Cupom aplicado com sucesso.",
        description: `O cupom ${result.data.coupon.code} foi aplicado à assinatura da empresa.`,
      });
      closeModal();
      router.refresh();
    });
  }

  function handleResendPaymentLink(e: React.FormEvent) {
    e.preventDefault();
    setModalError(null);

    if (!resendInvoiceId) {
      setModalError("Selecione uma fatura para reenviar.");
      return;
    }

    const reason = resendReason.trim();
    if (reason.length < 15) {
      setModalError("O motivo deve ter pelo menos 15 caracteres.");
      return;
    }
    if (reason.length > 500) {
      setModalError("O motivo não pode ultrapassar 500 caracteres.");
      return;
    }

    startTransition(async () => {
      const result = await resendPaymentLinkAction(tenantSlug, {
        invoiceId: resendInvoiceId,
        reason,
      });

      if (!result.ok) {
        setModalError(result.error.message);
        return;
      }

      notify({
        variant: "success",
        title: "Cobrança reenviada com sucesso.",
        description: `E-mail enviado para ${result.data.recipientEmail}.`,
      });
      closeModal();
      router.refresh();
    });
  }

  return (
    <>
      <Card className={className} data-testid="support-actions-card">
        <CardHeader help="suporte.acoesCobranca">
          <CardTitle className="flex items-center gap-2">
            <Wrench className="h-5 w-5 text-warning" aria-hidden="true" />
            Ações de Suporte (Cobrança)
          </CardTitle>
          <CardDescription>
            Ferramentas exclusivas do modo suporte para atendimento e auxílio operacional nesta empresa.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              variant="secondary"
              icon={CalendarPlus}
              onClick={() => {
                setModalError(null);
                setActiveModal("trial");
              }}
              data-testid="btn-open-extend-trial"
            >
              Estender período de teste
            </Button>

            <Button
              type="button"
              variant="secondary"
              icon={Tag}
              onClick={() => {
                setModalError(null);
                setActiveModal("coupon");
              }}
              data-testid="btn-open-apply-coupon"
            >
              Aplicar cupom
            </Button>

            <Button
              type="button"
              variant="secondary"
              icon={Send}
              onClick={() => {
                setModalError(null);
                if (!resendInvoiceId && invoices[0]) {
                  setResendInvoiceId(invoices[0].id);
                }
                setActiveModal("resend");
              }}
              data-testid="btn-open-resend-link"
            >
              Reenviar link de pagamento
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Modal 1: Estender Trial */}
      <Dialog open={activeModal === "trial"} onOpenChange={(open) => !open && closeModal()}>
        <DialogContent container={container} className="max-w-md">
          <form onSubmit={handleExtendTrial}>
            <DialogHeader icon={CalendarPlus}>
              <DialogTitle>Estender período de teste</DialogTitle>
              <DialogDescription>
                Conceda mais dias de avaliação para a empresa. O período total de teste tem teto máximo de 30 dias a partir da criação da conta.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-3">
              {modalError ? (
                <Alert variant="danger" title="Não foi possível estender o teste">
                  {modalError}
                </Alert>
              ) : null}

              {!isTrialing ? (
                <div className="rounded-card border border-warning/40 bg-warning-bg p-3 text-xs text-warning">
                  Atenção: Esta empresa atualmente não está com status em teste. Estender trial só surtirá efeito se a assinatura estiver em teste.
                </div>
              ) : null}

              <Field
                label="Dias extras de teste"
                htmlFor="trial-days-input"
                helpKey="suporte.estenderTrial"
                hint="Escolha entre 1 e 30 dias adicionais."
                required
              >
                {({ id, "aria-describedby": ariaDescribedby }) => (
                  <Input
                    id={id}
                    type="number"
                    min={1}
                    max={30}
                    value={trialDays}
                    onChange={(e) => setTrialDays(Number(e.target.value))}
                    aria-describedby={ariaDescribedby}
                    required
                  />
                )}
              </Field>

              <Field
                label="Motivo do suporte"
                htmlFor="trial-reason-input"
                hint="Explique com detalhes por que o teste está sendo estendido (mínimo de 15 caracteres)."
                required
              >
                {({ id, "aria-describedby": ariaDescribedby }) => (
                  <div className="space-y-1">
                    <Textarea
                      id={id}
                      rows={3}
                      value={trialReason}
                      onChange={(e) => setTrialReason(e.target.value)}
                      placeholder="Exemplo: Cliente solicitou mais 7 dias para concluir a capacitação dos atendentes."
                      maxLength={500}
                      aria-describedby={ariaDescribedby}
                      required
                    />
                    <div className="flex justify-between text-xs text-text-secondary">
                      <span>{trialReason.trim().length < 15 ? `Faltam ${15 - trialReason.trim().length} letras` : "Tamanho válido"}</span>
                      <span>{trialReason.length}/500</span>
                    </div>
                  </div>
                )}
              </Field>
            </div>

            <DialogFooter>
              <Button type="button" variant="secondary" onClick={closeModal} disabled={isPending}>
                Cancelar
              </Button>
              <Button type="submit" isLoading={isPending} disabled={trialReason.trim().length < 15}>
                Confirmar extensão
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Modal 2: Aplicar Cupom */}
      <Dialog open={activeModal === "coupon"} onOpenChange={(open) => !open && closeModal()}>
        <DialogContent container={container} className="max-w-md">
          <form onSubmit={handleApplyCoupon}>
            <DialogHeader icon={Tag}>
              <DialogTitle>Aplicar cupom via suporte</DialogTitle>
              <DialogDescription>
                Insira um cupom promocional ou cortesia aprovado para abater no valor das próximas faturas da empresa.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-3">
              {modalError ? (
                <Alert variant="danger" title="Não foi possível aplicar o cupom">
                  {modalError}
                </Alert>
              ) : null}

              <Field
                label="Código do cupom"
                htmlFor="coupon-code-input"
                helpKey="suporte.aplicarCupom"
                hint="Digite o código exatamente como cadastrado."
                required
              >
                {({ id, "aria-describedby": ariaDescribedby }) => (
                  <Input
                    id={id}
                    type="text"
                    value={couponCode}
                    onChange={(e) => setCouponCode(e.target.value.toUpperCase())}
                    placeholder="Ex: PARCEIRO20"
                    maxLength={40}
                    aria-describedby={ariaDescribedby}
                    required
                  />
                )}
              </Field>

              <Field
                label="Motivo do suporte"
                htmlFor="coupon-reason-input"
                hint="Descreva o motivo da aplicação (mínimo de 15 caracteres)."
                required
              >
                {({ id, "aria-describedby": ariaDescribedby }) => (
                  <div className="space-y-1">
                    <Textarea
                      id={id}
                      rows={3}
                      value={couponReason}
                      onChange={(e) => setCouponReason(e.target.value)}
                      placeholder="Exemplo: Concessão de desconto autorizada pela diretoria para parceria estratégica."
                      maxLength={500}
                      aria-describedby={ariaDescribedby}
                      required
                    />
                    <div className="flex justify-between text-xs text-text-secondary">
                      <span>{couponReason.trim().length < 15 ? `Faltam ${15 - couponReason.trim().length} letras` : "Tamanho válido"}</span>
                      <span>{couponReason.length}/500</span>
                    </div>
                  </div>
                )}
              </Field>
            </div>

            <DialogFooter>
              <Button type="button" variant="secondary" onClick={closeModal} disabled={isPending}>
                Cancelar
              </Button>
              <Button type="submit" isLoading={isPending} disabled={couponReason.trim().length < 15 || !couponCode.trim()}>
                Confirmar cupom
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Modal 3: Reenviar link de pagamento */}
      <Dialog open={activeModal === "resend"} onOpenChange={(open) => !open && closeModal()}>
        <DialogContent container={container} className="max-w-md">
          <form onSubmit={handleResendPaymentLink}>
            <DialogHeader icon={Send}>
              <DialogTitle>Reenviar link de pagamento</DialogTitle>
              <DialogDescription>
                Gera um novo Pix se o atual estiver expirado e dispara a mensagem de cobrança por e-mail para o responsável.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-3">
              {modalError ? (
                <Alert variant="danger" title="Não foi possível reenviar o link">
                  {modalError}
                </Alert>
              ) : null}

              {invoices.length === 0 ? (
                <Alert variant="warning" title="Nenhuma fatura encontrada">
                  Não há fatura registrada para reenviar cobrança.
                </Alert>
              ) : (
                <Field
                  label="Fatura para reenvio"
                  htmlFor="invoice-select"
                  helpKey="suporte.reenviarLink"
                  hint="Escolha a fatura que deve ser reenviada."
                  required
                >
                  {({ id, "aria-describedby": ariaDescribedby }) => (
                    <Select
                      id={id}
                      value={resendInvoiceId}
                      onChange={(e) => setResendInvoiceId(e.target.value)}
                      aria-describedby={ariaDescribedby}
                      required
                    >
                      {invoices.map((inv) => (
                        <option key={inv.id} value={inv.id}>
                          {BRL.format(inv.amountCents / 100)} ({inv.status}) - ID: {inv.id.slice(0, 8)}...
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              )}

              <Field
                label="Motivo do suporte"
                htmlFor="resend-reason-input"
                hint="Explique o motivo do reenvio da cobrança (mínimo de 15 caracteres)."
                required
              >
                {({ id, "aria-describedby": ariaDescribedby }) => (
                  <div className="space-y-1">
                    <Textarea
                      id={id}
                      rows={3}
                      value={resendReason}
                      onChange={(e) => setResendReason(e.target.value)}
                      placeholder="Exemplo: Cliente entrou em contato informando que o código Pix anterior expirou."
                      maxLength={500}
                      aria-describedby={ariaDescribedby}
                      required
                    />
                    <div className="flex justify-between text-xs text-text-secondary">
                      <span>{resendReason.trim().length < 15 ? `Faltam ${15 - resendReason.trim().length} letras` : "Tamanho válido"}</span>
                      <span>{resendReason.length}/500</span>
                    </div>
                  </div>
                )}
              </Field>
            </div>

            <DialogFooter>
              <Button type="button" variant="secondary" onClick={closeModal} disabled={isPending}>
                Cancelar
              </Button>
              <Button
                type="submit"
                isLoading={isPending}
                disabled={resendReason.trim().length < 15 || !resendInvoiceId || invoices.length === 0}
              >
                Reenviar cobrança
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
