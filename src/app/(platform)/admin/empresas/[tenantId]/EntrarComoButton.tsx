"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { AlertTriangle, LogIn, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { HelpButton } from "@/components/help/help-button";
import { startSupportAction } from "./_actions/startSupportAction";
import type { StartSupportInput, StartSupportOutput } from "@/modules/support/types";
import type { Result } from "@/lib/result";

export type EntrarComoButtonProps = {
  /** ID da empresa para impersonação */
  tenantId: string;
  /** Nome da empresa para exibição amigável */
  tenantName: string;
  /** Se o admin atual possui verificação em 2 etapas ativa */
  adminHasTwoFactor: boolean;
  /** Permite abrir por padrão (útil para testes de UI) */
  defaultOpen?: boolean;
  /** Custom action para início (injetável para testes) */
  onStartAction?: (input: StartSupportInput) => Promise<Result<StartSupportOutput>>;
};

const MIN_REASON_LENGTH = 15;
const MAX_REASON_LENGTH = 500;

export function EntrarComoButton({
  tenantId,
  tenantName,
  adminHasTwoFactor,
  defaultOpen = false,
  onStartAction = startSupportAction,
}: EntrarComoButtonProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [reason, setReason] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const reasonId = useId();

  const trimmedReason = reason.trim();
  const isValidLength =
    trimmedReason.length >= MIN_REASON_LENGTH && trimmedReason.length <= MAX_REASON_LENGTH;

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      setReason("");
      setErrorMsg(null);
      setIsSubmitting(false);
    }
  }

  async function handleConfirm() {
    if (!adminHasTwoFactor) return;

    if (!isValidLength) {
      setErrorMsg("O motivo deve conter no mínimo 15 caracteres explicando o atendimento.");
      return;
    }

    setIsSubmitting(true);
    setErrorMsg(null);

    try {
      const res = await onStartAction({ tenantId, reason: trimmedReason });
      if (!res.ok) {
        setErrorMsg(res.error.message);
        setIsSubmitting(false);
        return;
      }

      // Redireciona para o painel da empresa
      window.location.assign(res.data.redirectTo);
    } catch {
      setErrorMsg("Não foi possível iniciar a sessão de suporte. Tente novamente.");
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <div className="inline-flex items-center gap-1.5">
        <DialogTrigger asChild>
          <Button
            type="button"
            variant="primary"
            icon={LogIn}
            className="font-medium"
            data-testid="entrar-como-empresa-btn"
          >
            Entrar como empresa
          </Button>
        </DialogTrigger>

        <HelpButton
          helpKey="admin.modoSuporte"
          placement="inline"
          className="text-text-secondary"
        />
      </div>

      <DialogContent
        forceMount={defaultOpen ? true : undefined}
        container={defaultOpen ? null : undefined}
        className="sm:max-w-md"
      >
        <DialogHeader icon={adminHasTwoFactor ? ShieldAlert : AlertTriangle} tone={adminHasTwoFactor ? "primary" : "warning"}>
          <DialogTitle>
            {adminHasTwoFactor ? "Entrar como suporte" : "Verificação em duas etapas necessária"}
          </DialogTitle>
          <DialogDescription>
            {adminHasTwoFactor
              ? `Acessar o painel da empresa ${tenantName} em modo de assistência técnica.`
              : "Por segurança da plataforma e dos clientes, a entrada em contas exige autenticação em duas etapas ativa."}
          </DialogDescription>
        </DialogHeader>

        {!adminHasTwoFactor ? (
          <div className="mt-4 flex flex-col gap-4">
            <div className="rounded-card border border-warning/40 bg-warning-bg p-3.5 text-sm text-warning">
              <p className="font-medium">
                Ative a verificação em duas etapas no seu perfil para entrar como suporte.
              </p>
              <p className="mt-1 text-xs opacity-90">
                Leva menos de 1 minuto e protege o acesso com um código do seu celular.
              </p>
            </div>

            <DialogFooter className="mt-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
              >
                Voltar
              </Button>
              <Button asChild variant="primary" icon={ShieldCheck}>
                <Link href="/admin/minha-conta">
                  Ativar agora
                </Link>
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="mt-4 flex flex-col gap-4">
            <div className="rounded-card border border-border bg-bg p-3 text-xs leading-relaxed text-text-secondary">
              Esta sessão expira em 1 hora. Todas as ações serão registradas com seu nome para auditoria.
            </div>

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label
                  htmlFor={reasonId}
                  className="text-sm font-medium text-text"
                >
                  Motivo do atendimento <span className="text-danger">*</span>
                </label>
                <HelpButton
                  helpKey="admin.modoSuporte"
                  placement="inline"
                  className="text-text-secondary"
                />
              </div>

              <Textarea
                id={reasonId}
                rows={3}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  if (errorMsg) setErrorMsg(null);
                }}
                placeholder="Exemplo: Ajuste na grade de horários a pedido da cliente Maria — chamado 1234."
                maxLength={MAX_REASON_LENGTH}
                disabled={isSubmitting}
                invalid={Boolean(errorMsg)}
                data-testid="support-reason-textarea"
              />

              <div className="flex items-center justify-between text-xs text-text-secondary">
                <span>Mínimo de 15 caracteres.</span>
                <span className={trimmedReason.length > MAX_REASON_LENGTH ? "text-danger" : ""}>
                  {trimmedReason.length}/{MAX_REASON_LENGTH}
                </span>
              </div>

              {errorMsg ? (
                <p className="text-xs font-medium text-danger" role="alert">
                  {errorMsg}
                </p>
              ) : null}
            </div>

            <DialogFooter className="mt-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpen(false)}
                disabled={isSubmitting}
              >
                Cancelar
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={handleConfirm}
                disabled={!isValidLength || isSubmitting}
                isLoading={isSubmitting}
                loadingText="Iniciando…"
                data-testid="confirm-enter-support-btn"
              >
                Confirmar e entrar
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
