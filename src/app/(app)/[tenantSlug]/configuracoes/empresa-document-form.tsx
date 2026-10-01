"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { normalizeDocumentDigits, validateCpfCnpj } from "@/core/billing/document";
import { maskCpfCnpj } from "@/components/lib/document-mask";
import { updateTenantDocumentAction } from "@/modules/tenant/actions";

/**
 * CPF/CNPJ da empresa para cobrança (pedido do dono, rodada de Mercado Pago) — sem isto o Pix
 * das faturas não é gerado (`MERCADOPAGO_MISSING_DOCUMENT`, ver `assinatura-client.tsx`).
 * Restrito a OWNER no servidor (`updateTenantDocumentAction`); aqui só desabilita o botão para
 * quem não é dono, sem duplicar a regra.
 */
export function EmpresaDocumentForm({
  tenantSlug,
  currentDocument,
  isOwner,
}: {
  tenantSlug: string;
  currentDocument: string | null;
  isOwner: boolean;
}) {
  const { notify } = useToast();
  const [document, setDocument] = useState(currentDocument ?? "");
  const [saved, setSaved] = useState(!!currentDocument);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!validateCpfCnpj(document).valid) {
      setError("Informe um CPF ou CNPJ válido.");
      return;
    }
    startTransition(async () => {
      const result = await updateTenantDocumentAction(tenantSlug, { document: normalizeDocumentDigits(document) });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setSaved(true);
      notify({ variant: "success", title: "CPF/CNPJ salvo." });
    });
  }

  return (
    <Card className="rounded-hero">
      <CardHeader help="config.cobranca">
        <div className="flex items-center gap-2">
          <CardTitle>Dados para cobrança</CardTitle>
          {saved ? <Badge variant="success">Cadastrado</Badge> : <Badge variant="warning">Pendente</Badge>}
        </div>
        <CardDescription>
          O Mercado Pago exige o CPF ou CNPJ da empresa para gerar o Pix das faturas. Sem ele, a cobrança
          não é criada.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <div className="flex-1">
            <Field label="CPF ou CNPJ" htmlFor="tenant-document" required error={error ?? undefined}>
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  name="document"
                  inputMode="numeric"
                  autoComplete="off"
                  value={maskCpfCnpj(document)}
                  onChange={(e) => setDocument(normalizeDocumentDigits(e.target.value))}
                  maxLength={18}
                  disabled={!isOwner}
                  invalid={!!error}
                />
              )}
            </Field>
          </div>
          <Button type="submit" isLoading={isPending} disabled={!isOwner} title={!isOwner ? "Só o dono da empresa pode alterar." : undefined}>
            <Check className="h-4 w-4" aria-hidden="true" />
            Salvar
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
