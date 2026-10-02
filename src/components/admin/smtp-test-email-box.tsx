"use client";

import { useState, useTransition } from "react";
import { CheckCircle2, Send, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Alert } from "@/components/ui/alert";
import { HelpButton } from "@/components/help/help-button";
import { sendSmtpTestEmailAction } from "@/modules/platform/actions";
import type { SmtpTestEmailResult } from "@/modules/platform/smtp-test-email";

/** Linha "rótulo: valor" da resposta do servidor. */
function Row({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="flex flex-col gap-0.5 sm:flex-row sm:gap-2">
      <dt className="shrink-0 text-text-secondary sm:w-40">{label}</dt>
      <dd className="break-all text-text" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

/** E-mail de teste do SMTP (Admin > Configurações). Usa o SMTP SALVO; mostra a resposta real do servidor. */
export function SmtpTestEmailBox() {
  const [to, setTo] = useState("");
  const [result, setResult] = useState<SmtpTestEmailResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function run() {
    setResult(null);
    setError(null);
    startTransition(async () => {
      const response = await sendSmtpTestEmailAction({ to });
      if (response.ok) setResult(response.data);
      else setError(response.error.message);
    });
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border px-6 py-5">
      <Field
        label="Enviar e-mail de teste"
        labelAction={<HelpButton helpKey="admin.smtpTeste" />}
        hint="Manda um e-mail simples pelo SMTP salvo e mostra o que o servidor respondeu. Use o seu Gmail para ver se chega."
      >
        {(fieldProps) => (
          <Input
            {...fieldProps}
            type="email"
            autoComplete="off"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (to && !isPending) run();
              }
            }}
            placeholder="voce@gmail.com"
          />
        )}
      </Field>
      <Button icon={Send} type="button" variant="secondary" size="sm" onClick={run} isLoading={isPending} loadingText="Enviando…" disabled={!to} className="self-start">
        Enviar e-mail de teste
      </Button>

      {error ? <Alert variant="danger">{error}</Alert> : null}

      {result ? (
        <div role="status" className="flex flex-col gap-2 text-sm" data-testid="smtp-test-result">
          <p className={`flex items-center gap-1.5 ${result.ok ? "text-success" : "text-danger"}`}>
            {result.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" /> : <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />}
            {result.detalhe}
          </p>
          <dl className="flex flex-col gap-1">
            <Row label="Aceitos" value={result.accepted.length ? result.accepted.join(", ") : "nenhum"} testId="smtp-test-accepted" />
            <Row label="Recusados" value={result.rejected.length ? result.rejected.join(", ") : "nenhum"} testId="smtp-test-rejected" />
            <Row label="Id da mensagem" value={result.messageId ?? "o servidor não informou"} testId="smtp-test-message-id" />
            <Row label="Resposta do servidor" value={result.response ?? "o servidor não informou"} testId="smtp-test-response" />
            {result.from ? <Row label="Remetente usado" value={result.from} testId="smtp-test-from" /> : null}
          </dl>
          {result.warnings.map((warning) => (
            <Alert key={warning} variant="warning">
              {warning}
            </Alert>
          ))}
        </div>
      ) : null}
    </div>
  );
}
