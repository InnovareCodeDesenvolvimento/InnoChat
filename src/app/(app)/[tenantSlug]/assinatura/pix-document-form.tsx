"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { QrCode } from "lucide-react";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { HelpButton } from "@/components/help/help-button";
import { normalizeDocumentDigits, validateCpfCnpj } from "@/core/billing/document";
import { maskCpfCnpj } from "@/components/lib/document-mask";
import { saveDocumentAndGeneratePixAction } from "@/modules/billing/actions";

const INVALID_DOCUMENT = "Confira o CPF ou CNPJ: parece que falta ou sobra algum número.";

/**
 * CPF/CNPJ pedido na hora de pagar, dentro do cartão do Pix. O cadastro não pede mais o documento;
 * aqui a pessoa já quer pagar, então o campo faz sentido. Salvar grava o documento e gera o Pix da
 * fatura aberta numa tacada só. Se o Mercado Pago falhar, o documento fica salvo e a tela recarrega
 * mostrando "Gerar Pix agora" (o ramo com documento do `PixCard`).
 */
export function PixDocumentForm({ tenantSlug, isOwner }: { tenantSlug: string; isOwner: boolean }) {
  const router = useRouter();
  const [document, setDocument] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  if (!isOwner) {
    return (
      <Alert variant="warning" title="Falta o CPF ou CNPJ da empresa">
        O Pix só sai depois que o dono da empresa informar o CPF ou CNPJ nesta tela. Peça para ele entrar e preencher.
      </Alert>
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    if (!validateCpfCnpj(document).valid) {
      setError(INVALID_DOCUMENT);
      return;
    }
    startTransition(async () => {
      const result = await saveDocumentAndGeneratePixAction(tenantSlug, { document: normalizeDocumentDigits(document) });
      if (!result.ok) {
        const code = result.error.code;
        if (code === "INVALID_DOCUMENT") {
          setError(INVALID_DOCUMENT);
          return;
        }
        if (code.startsWith("MERCADOPAGO_")) {
          // O documento já ficou salvo: recarrega para o cartão mostrar "Gerar Pix agora".
          setNotice("Salvamos o CPF ou CNPJ, mas o Pix não saiu agora. Toque em gerar de novo em alguns instantes.");
          router.refresh();
          return;
        }
        setError(result.error.message);
        return;
      }
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="flex w-full flex-col gap-3" data-testid="pix-document-form">
      <p className="text-sm text-text-secondary">
        O Mercado Pago pede o CPF ou CNPJ de quem paga. Informe o da empresa e o Pix aparece aqui na hora.
      </p>
      {notice ? <Alert variant="warning">{notice}</Alert> : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Field
            label="CPF ou CNPJ da empresa"
            htmlFor="pix-document"
            required
            error={error ?? undefined}
            labelAction={<HelpButton helpKey="assinatura.documento" placement="inline" />}
          >
            {(fieldProps) => (
              <Input
                {...fieldProps}
                name="document"
                inputMode="numeric"
                autoComplete="off"
                enterKeyHint="done"
                value={maskCpfCnpj(document)}
                onChange={(e) => setDocument(normalizeDocumentDigits(e.target.value))}
                maxLength={18}
                invalid={!!error}
              />
            )}
          </Field>
        </div>
        <Button type="submit" isLoading={isPending} loadingText="Gerando Pix…" className="sm:mb-0">
          <QrCode className="h-4 w-4" aria-hidden="true" />
          Salvar e gerar Pix
        </Button>
      </div>
    </form>
  );
}
