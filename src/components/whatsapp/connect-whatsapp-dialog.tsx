"use client";

import { navIconFor } from "@/components/shell/nav-items";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, CheckCircle2, CircleCheck, QrCode, RefreshCw, Smartphone, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { ResendVerificationButton } from "@/components/account/resend-verification-button";
import {
  createWhatsappInstanceAction,
  getQrCodeAction,
  type WhatsappInstanceView,
} from "@/modules/whatsapp/actions";

/**
 * Fluxo completo de conexão de um número (rótulo → cria a instância → mostra o QR → acompanha
 * até conectar). Componente único e reutilizável: a tela "WhatsApp" e o passo 3 do onboarding
 * (mission: "reutiliza o mesmo componente de conexão") usam exatamente este, sem forkar.
 *
 * Estado interno em três passos ("label" | "qr" | "success") — cada passo é pequeno de propósito
 * (nunca um componente gigante fazendo tudo); a orquestração fica aqui porque é ela quem decide
 * quando trocar de passo.
 */

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 2 * 60 * 1000;

type Step = "label" | "qr" | "success";

type ErrorView = {
  title: string;
  description: React.ReactNode;
  showAssinaturaLink?: boolean;
  showResendVerification?: boolean;
};

function mapCreateError(code: string, message: string, details: unknown): ErrorView {
  switch (code) {
    case "EMAIL_NOT_VERIFIED":
      return {
        title: "Confirme seu e-mail antes de conectar",
        description:
          "Enviamos um link de confirmação para o seu e-mail quando a conta foi criada. Verifique sua caixa de entrada (e o spam) e clique nele antes de conectar um número.",
        showResendVerification: true,
      };
    case "PLAN_LIMIT_REACHED": {
      const d = details as { limit?: number; current?: number } | undefined;
      return {
        title: "Limite do plano atingido",
        description:
          d?.limit !== undefined
            ? `Seu plano permite até ${d.limit} número(s) de WhatsApp e você já tem ${d.current}. Mude para um plano maior para conectar mais um.`
            : message,
        showAssinaturaLink: true,
      };
    }
    case "N8N_NOT_CONFIGURED":
    case "EVOLUTION_NOT_CONFIGURED":
      return {
        title: "Ainda não é possível conectar",
        description: "A plataforma ainda não foi configurada para conexões de WhatsApp. Fale com o suporte.",
      };
    case "TENANT_SUSPENDED":
      return {
        title: "Assinatura suspensa",
        description: "Sua assinatura está suspensa. Pague a fatura para conectar um número novo.",
        showAssinaturaLink: true,
      };
    default:
      return { title: "Não foi possível conectar", description: message };
  }
}

function QrImage({ dataUrl }: { dataUrl: string }) {
  return (
    <div className="flex items-center justify-center rounded-hero border border-border bg-white p-5 shadow-card">
      {/* eslint-disable-next-line @next/next/no-img-element -- imagem base64 gerada em runtime pela Evolution, não é asset estático */}
      <img
        src={dataUrl}
        alt="QR code para conectar o WhatsApp. Abra a câmera do WhatsApp e escaneie."
        width={272}
        height={272}
        className="h-[272px] w-[272px]"
      />
    </div>
  );
}

export function ConnectWhatsappDialog({
  tenantSlug,
  onConnected,
  trigger,
  disabled,
  disabledHint,
  open: openProp,
  onOpenChange: onOpenChangeProp,
}: {
  tenantSlug: string;
  onConnected?: (instance: WhatsappInstanceView) => void;
  /** Elemento que abre o diálogo. Padrão: botão "Conectar número". Ignorado no modo controlado
   * (quando `open`/`onOpenChange` são passados) — quem chama cuida do próprio gatilho visual. */
  trigger?: React.ReactNode;
  disabled?: boolean;
  disabledHint?: string;
  /**
   * Modo controlado: quem chama guarda o `open` (ex.: para manter UMA instância deste
   * componente sempre montada, mesmo quando o gatilho visual precisa migrar de lugar na tela —
   * ver `whatsapp-client.tsx`, bug do EmptyState desmontando o diálogo na 1ª conexão).
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const isControlled = openProp !== undefined;
  const [internalOpen, setInternalOpen] = useState(false);
  const open = isControlled ? openProp : internalOpen;
  function setOpen(next: boolean) {
    if (isControlled) {
      onOpenChangeProp?.(next);
    } else {
      setInternalOpen(next);
    }
  }
  const [step, setStep] = useState<Step>("label");
  const [label, setLabel] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createError, setCreateError] = useState<ErrorView | null>(null);

  const [instance, setInstance] = useState<WhatsappInstanceView | null>(null);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string | null>(null);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [blockedReason, setBlockedReason] = useState<"TRIAL_PHONE_ALREADY_USED" | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Gerando QR code…");

  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickInFlightRef = useRef(false);
  // Fonte da verdade para o `tick` (fechamento de `setInterval`/`setTimeout` não vê o `instance`
  // mais novo do estado — `setInstance` é assíncrono). Sempre atualizado junto com `setInstance`.
  const instanceRef = useRef<WhatsappInstanceView | null>(null);

  function updateInstance(next: WhatsappInstanceView | null) {
    instanceRef.current = next;
    setInstance(next);
  }

  function clearTimers() {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (timeoutTimerRef.current) {
      clearTimeout(timeoutTimerRef.current);
      timeoutTimerRef.current = null;
    }
  }

  function resetToLabelStep() {
    clearTimers();
    setStep("label");
    setLabel("");
    setCreateError(null);
    updateInstance(null);
    setQrCodeDataUrl(null);
    setPairingCode(null);
    setBlockedReason(null);
    setTimedOut(false);
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      // Fecha durante a conexão: limpa timers, mas não desfaz a instância já criada (ela
      // continua existindo — o usuário pode reabrir "Conectar número" e ver na lista).
      clearTimers();
      resetToLabelStep();
    }
  }

  async function tick(currentInstanceId: string) {
    if (tickInFlightRef.current) return;
    tickInFlightRef.current = true;
    try {
      const result = await getQrCodeAction(tenantSlug, currentInstanceId);
      if (!result.ok) {
        setStatusMessage("Não deu para atualizar o QR code agora. Tentando de novo…");
        return;
      }
      const data = result.data;
      if (data.blockedReason) {
        clearTimers();
        setBlockedReason(data.blockedReason);
        setStatusMessage("Este número já foi usado em outro teste grátis.");
        return;
      }
      if (data.status === "CONNECTED") {
        clearTimers();
        setStatusMessage("Conectado!");
        setStep("success");
        const base = instanceRef.current;
        if (base) {
          const connected: WhatsappInstanceView = { ...base, status: "CONNECTED", phoneE164: data.phoneE164 };
          updateInstance(connected);
          onConnected?.(connected);
        }
        return;
      }
      setQrCodeDataUrl(data.qrCodeDataUrl);
      setPairingCode(data.pairingCode);
      setStatusMessage("Aguardando leitura do QR code…");
    } finally {
      tickInFlightRef.current = false;
    }
  }

  function startPolling(currentInstanceId: string) {
    clearTimers();
    setTimedOut(false);
    void tick(currentInstanceId);
    pollTimerRef.current = setInterval(() => {
      if (document.hidden) return;
      void tick(currentInstanceId);
    }, POLL_INTERVAL_MS);
    timeoutTimerRef.current = setTimeout(() => {
      clearTimers();
      setTimedOut(true);
      setStatusMessage("O QR code expirou. Gere um novo para continuar.");
    }, POLL_TIMEOUT_MS);
  }

  // Aba oculta → para de consultar (a checagem já vive em `startPolling`, mas ao VOLTAR a ficar
  // visível vale buscar um QR fresco na hora, sem esperar o próximo tick de 3s).
  useEffect(() => {
    if (step !== "qr" || !instance || blockedReason || timedOut) return;
    function handleVisibility() {
      if (!document.hidden) void tick(instance!.id);
    }
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- só precisa reagir a mudar de instância/etapa
  }, [step, instance?.id, blockedReason, timedOut]);

  useEffect(() => clearTimers, []);

  function handleGenerateNewQr() {
    if (!instance) return;
    startPolling(instance.id);
  }

  async function handleSubmitLabel(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);
    const trimmed = label.trim();
    if (trimmed.length === 0) {
      setCreateError({ title: "Informe um rótulo", description: "Dê um nome para identificar este número (ex.: \"Recepção\")." });
      return;
    }
    setIsSubmitting(true);
    try {
      const result = await createWhatsappInstanceAction(tenantSlug, { label: trimmed });
      if (!result.ok) {
        setCreateError(mapCreateError(result.error.code, result.error.message, result.error.details));
        return;
      }
      updateInstance(result.data);
      setStep("qr");
      startPolling(result.data.id);
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {isControlled ? null : trigger ? (
        <span
          onClick={() => {
            if (!disabled) setOpen(true);
          }}
          title={disabled ? disabledHint : undefined}
        >
          {trigger}
        </span>
      ) : (
        <Button onClick={() => setOpen(true)} disabled={disabled} title={disabled ? disabledHint : undefined}>
          <Smartphone className="h-4 w-4" aria-hidden="true" />
          Conectar número
        </Button>
      )}

      <DialogContent>
        {step === "label" ? (
          <>
            <DialogHeader icon={navIconFor("whatsapp")}>
              <DialogTitle>Conectar número de WhatsApp</DialogTitle>
              <DialogDescription>Dê um nome para identificar este número. Ele aparece na lista de conexões.</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmitLabel} className="mt-4 flex flex-col gap-4">
              {createError ? (
                <Alert variant="danger" title={createError.title}>
                  {createError.description}
                  {createError.showAssinaturaLink ? (
                    <>
                      {" "}
                      <Link href={`/${tenantSlug}/assinatura`} className="font-medium underline">
                        Ver assinatura
                      </Link>
                    </>
                  ) : null}
                  {createError.showResendVerification ? (
                    <div className="mt-3">
                      <ResendVerificationButton />
                    </div>
                  ) : null}
                </Alert>
              ) : null}
              <Field label="Rótulo" required hint="Ex.: Recepção, Vendas, Suporte.">
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    maxLength={60}
                    autoFocus
                  />
                )}
              </Field>
              <DialogFooter>
                <Button icon={X} type="button" variant="secondary" onClick={() => setOpen(false)}>
                  Cancelar
                </Button>
                <Button icon={QrCode} type="submit" isLoading={isSubmitting} loadingText="Gerando QR…">
                  Gerar QR code
                </Button>
              </DialogFooter>
            </form>
          </>
        ) : null}

        {step === "qr" ? (
          <>
            <DialogHeader icon={QrCode}>
              <DialogTitle>Escaneie o QR code</DialogTitle>
              <DialogDescription>Conecte o número &ldquo;{instance?.label}&rdquo; em poucos segundos.</DialogDescription>
            </DialogHeader>

            <div className="mt-4 flex flex-col items-center gap-4">
              <div aria-live="polite" className="sr-only">
                {statusMessage}
              </div>

              {blockedReason === "TRIAL_PHONE_ALREADY_USED" ? (
                <Alert variant="danger" title="Este número já usou o teste grátis" className="w-full">
                  Esse número de WhatsApp já foi conectado em outro teste grátis do InnoChat. Para conectá-lo aqui, é
                  preciso ter uma assinatura ativa.{" "}
                  <Link href={`/${tenantSlug}/assinatura`} className="font-medium underline">
                    Ver assinatura
                  </Link>
                </Alert>
              ) : timedOut ? (
                <>
                  <div className="flex h-[272px] w-[272px] flex-col items-center justify-center gap-2 rounded-hero border border-dashed border-border text-center text-sm text-text-secondary">
                    <p>O QR code expirou.</p>
                  </div>
                  <Button icon={RefreshCw} type="button" onClick={handleGenerateNewQr}>
                    Gerar novo QR
                  </Button>
                </>
              ) : qrCodeDataUrl ? (
                <>
                  <QrImage dataUrl={qrCodeDataUrl} />
                  {pairingCode ? (
                    <p className="text-sm text-text-secondary">
                      Ou digite o código: <span className="font-mono font-medium text-text">{pairingCode}</span>
                    </p>
                  ) : null}
                  <ol className="w-full list-decimal space-y-1 pl-5 text-sm text-text-secondary">
                    <li>Abra o WhatsApp no celular do número que vai atender.</li>
                    <li>Toque em Aparelhos conectados.</li>
                    <li>Toque em Conectar aparelho.</li>
                    <li>Aponte a câmera para o QR code acima.</li>
                  </ol>
                  <p className="text-xs text-text-secondary">Atualizando automaticamente…</p>
                </>
              ) : (
                <div className="flex h-[272px] w-[272px] flex-col items-center justify-center gap-2">
                  <Skeleton className="h-full w-full rounded-hero" />
                  <p className="sr-only">Gerando QR code…</p>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button icon={X} type="button" variant="secondary" onClick={() => setOpen(false)}>
                Fechar
              </Button>
            </DialogFooter>
          </>
        ) : null}

        {step === "success" ? (
          <>
            <DialogHeader icon={CircleCheck} tone="success">
              <DialogTitle>Número conectado</DialogTitle>
              <DialogDescription aria-live="polite">
                &ldquo;{instance?.label}&rdquo; está conectado e já pode atender pelo WhatsApp.
              </DialogDescription>
            </DialogHeader>
            <div className="mt-6 flex flex-col items-center gap-3 py-2">
              <CheckCircle2
                className="h-12 w-12 text-success motion-safe:animate-in motion-safe:zoom-in motion-safe:duration-300 motion-reduce:animate-none"
                aria-hidden="true"
              />
            </div>
            <DialogFooter>
              <Button icon={Check} type="button" onClick={() => setOpen(false)}>
                Concluir
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
