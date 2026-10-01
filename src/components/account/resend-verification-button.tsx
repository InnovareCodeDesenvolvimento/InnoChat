"use client";

import { Send } from "lucide-react";
import { useState, useTransition } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { resendVerificationEmailAction } from "@/modules/signup/actions";

/**
 * Botão "Reenviar e-mail de confirmação" — reutilizado onde o usuário encontra
 * `EMAIL_NOT_VERIFIED` (diálogo do WhatsApp) e no banner discreto do painel
 * (`panel-shell.tsx`). Contrato: `resendVerificationEmailAction()`
 * (`docs/contratos.md`) — sem entrada, rate limit de 3/hora, `alreadyVerified: true`
 * quando o e-mail já foi confirmado enquanto isso (ex.: outra aba).
 */
export function ResendVerificationButton({
  variant = "secondary",
  size = "sm",
  className,
}: Pick<ButtonProps, "variant" | "size" | "className">) {
  const { notify } = useToast();
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<"idle" | "sent" | "already-verified">("idle");

  function handleClick() {
    startTransition(async () => {
      const result = await resendVerificationEmailAction();
      if (!result.ok) {
        if (result.error.code === "RATE_LIMITED") {
          notify({
            variant: "error",
            title: "Muitas tentativas",
            description: "Espere um pouco antes de pedir outro e-mail de confirmação.",
          });
          return;
        }
        notify({ variant: "error", title: "Não foi possível reenviar", description: result.error.message });
        return;
      }
      if (result.data.alreadyVerified) {
        setState("already-verified");
        notify({ variant: "info", title: "E-mail já confirmado", description: "Atualize a página para continuar." });
        return;
      }
      setState("sent");
      notify({
        variant: "success",
        title: "E-mail reenviado",
        description: "Confira sua caixa de entrada (e o spam).",
      });
    });
  }

  if (state === "already-verified") {
    return <p className="text-sm text-text-secondary">Seu e-mail já está confirmado. Atualize a página.</p>;
  }

  if (state === "sent") {
    return <p className="text-sm text-text-secondary">E-mail reenviado. Confira sua caixa de entrada.</p>;
  }

  return (
    <Button icon={Send} type="button" variant={variant} size={size} onClick={handleClick} isLoading={isPending} className={className}>
      Reenviar e-mail de confirmação
    </Button>
  );
}
