"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, MessageCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { HelpButton } from "@/components/help/help-button";
import { useToast } from "@/components/ui/toast";
import { parseBrazilianPhoneToE164 } from "@/core/whatsapp/phone";
import type { SaveBillingContact } from "@/components/billing/billing-contact-types";
import { useSessionDismiss } from "./subscription-banner";

/**
 * Pedido discreto do WhatsApp de cobrança (decisão do dono, 2026-10-01): aparece só para o OWNER
 * de empresa que ainda não informou o número. Dispensável por sessão (X); some de vez quando o
 * número é salvo (o layout relê o banco no `router.refresh()`).
 */
export function BillingPhonePrompt({ tenantSlug, save }: { tenantSlug: string; save: SaveBillingContact }) {
  const router = useRouter();
  const { notify } = useToast();
  const [isPending, startTransition] = useTransition();
  const [dismissed, dismiss] = useSessionDismiss(`innochat:billing-phone-dismissed:${tenantSlug}`);
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  // A conferência disse "esse número não tem WhatsApp": oferece salvar mesmo assim.
  const [noWhatsapp, setNoWhatsapp] = useState(false);

  if (dismissed) return null;

  function submit(skipWhatsappCheck: boolean) {
    const e164 = parseBrazilianPhoneToE164(phone);
    if (!e164) {
      setError("Digite o WhatsApp com DDD, por exemplo (84) 99999-0000.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await save(tenantSlug, { billingWhatsapp: e164, ...(skipWhatsappCheck ? { skipWhatsappCheck: true } : {}) });
      if (!result.ok) {
        setNoWhatsapp(result.error.code === "NO_WHATSAPP");
        setError(result.error.message);
        return;
      }
      notify({ variant: "success", title: "WhatsApp salvo.", description: "Os avisos de cobrança chegam nele." });
      router.refresh();
    });
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit(false);
  }

  return (
    <div data-testid="billing-phone-prompt" className="border-b border-border bg-bg px-4 py-2 text-sm sm:px-6">
      <form onSubmit={handleSubmit} noValidate className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <label htmlFor="billing-phone-prompt-input" className="flex min-w-0 flex-1 basis-64 items-center gap-2 font-medium text-text">
          <MessageCircle className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          Qual WhatsApp recebe os avisos de cobrança?
        </label>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-nowrap">
          <div className="w-full min-w-0 sm:w-56">
            <Input
              id="billing-phone-prompt-input"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              placeholder="(84) 99999-0000"
              value={phone}
              invalid={!!error}
              aria-describedby={error ? "billing-phone-prompt-error" : undefined}
              onChange={(e) => {
                setPhone(e.target.value);
                setNoWhatsapp(false);
              }}
            />
          </div>
          <Button type="submit" size="sm" icon={Check} isLoading={isPending} loadingText="Salvando…">
            Salvar WhatsApp
          </Button>
          {noWhatsapp ? (
            <Button type="button" size="sm" variant="secondary" disabled={isPending} onClick={() => submit(true)}>
              Salvar mesmo assim
            </Button>
          ) : null}
          <span className="flex items-center">
            <HelpButton helpKey="assinatura.aviso-whatsapp" placement="inline" />
            <Button type="button" variant="ghost" size="icon" aria-label="Dispensar o pedido de WhatsApp" onClick={dismiss}>
              <X className="h-4 w-4" aria-hidden="true" />
            </Button>
          </span>
        </div>
        {error ? (
          <p id="billing-phone-prompt-error" role="alert" className="w-full text-xs text-danger">
            {error}
          </p>
        ) : null}
      </form>
    </div>
  );
}
