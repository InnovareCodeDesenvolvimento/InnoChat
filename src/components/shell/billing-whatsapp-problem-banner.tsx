"use client";

import Link from "next/link";
import { MessageCircleWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import { HelpButton } from "@/components/help/help-button";

/**
 * Aviso do dono quando o WhatsApp de cobrança não está recebendo (docs/regua-de-cobranca.md, F4+). Sem botão de
 * fechar de propósito: some sozinho quando o número é trocado ou quando um envio dá certo. O botão leva direto ao
 * cartão "Contato de cobrança" da Assinatura.
 */
export function BillingWhatsappProblemBanner({ tenantSlug, phoneDisplay }: { tenantSlug: string; phoneDisplay: string }) {
  return (
    <div data-testid="billing-whatsapp-problem" role="status" className="border-b border-warning/30 bg-warning-bg px-4 py-2 text-sm sm:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="flex min-w-0 flex-1 basis-64 items-start gap-2 font-medium text-text">
          <MessageCircleWarning className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <span>
            Não conseguimos te mandar mensagem no WhatsApp {phoneDisplay}. Confira o número.
          </span>
        </p>
        <span className="flex items-center gap-1">
          <Button asChild size="sm" variant="secondary">
            <Link href={`/${tenantSlug}/assinatura#contato-de-cobranca`}>Corrigir número</Link>
          </Button>
          <HelpButton helpKey="assinatura.whatsapp-falhou" placement="inline" />
        </span>
      </div>
    </div>
  );
}
