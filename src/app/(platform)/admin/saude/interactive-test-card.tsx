"use client";

import { useEffect, useState, useTransition } from "react";
import { List, MessageSquareText, MousePointerClick, Vote } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { listInteractiveTestInstancesAction, sendInteractiveTestAction } from "@/modules/whatsapp/interactive-test-actions";
import type { InteractiveKind, InteractiveTestResult, TestableInstance } from "@/modules/whatsapp/interactive-test";

const KINDS: { kind: InteractiveKind; label: string; icon: React.ReactNode }[] = [
  { kind: "buttons", label: "Botões", icon: <MousePointerClick className="h-4 w-4" aria-hidden="true" /> },
  { kind: "list", label: "Lista", icon: <List className="h-4 w-4" aria-hidden="true" /> },
  { kind: "poll", label: "Enquete", icon: <Vote className="h-4 w-4" aria-hidden="true" /> },
];

/**
 * Teste de botões/lista/enquete do WhatsApp (docs/whatsapp-botoes-listas.md): o dono manda um
 * exemplo pelo número conectado de uma empresa para o PRÓPRIO celular e vê se aparece. O número
 * digitado não é guardado em lugar nenhum.
 */
export function InteractiveTestCard() {
  const [instances, setInstances] = useState<TestableInstance[] | null>(null);
  const [instanceId, setInstanceId] = useState("");
  const [phone, setPhone] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InteractiveTestResult | null>(null);
  const [pendingKind, setPendingKind] = useState<InteractiveKind | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    listInteractiveTestInstancesAction().then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        setLoadError(res.error.message);
        setInstances([]);
        return;
      }
      setInstances(res.data);
      setInstanceId((current) => current || res.data[0]?.id || "");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function handleSend(kind: InteractiveKind) {
    setError(null);
    setResult(null);
    setPendingKind(kind);
    startTransition(async () => {
      const res = await sendInteractiveTestAction({ instanceId, to: phone, kind });
      setPendingKind(null);
      if (!res.ok) {
        setError(res.error.message);
        return;
      }
      setResult(res.data);
    });
  }

  const noInstances = instances !== null && instances.length === 0;

  return (
    <Card className="rounded-hero" data-testid="saude-teste-botoes">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <MessageSquareText className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <CardTitle>Teste de botões do WhatsApp</CardTitle>
            <CardDescription>Envia um exemplo (Corte · Escova · Coloração) para o seu celular e mostra o que a Evolution respondeu.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {loadError ? <Alert variant="warning">{loadError}</Alert> : null}
        {noInstances && !loadError ? (
          <Alert variant="info">Nenhum número de WhatsApp conectado (fora do modo de teste) para usar no envio.</Alert>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Enviar pelo número de">
            {(fieldProps) => (
              <Select {...fieldProps} value={instanceId} onChange={(e) => setInstanceId(e.target.value)} disabled={!instances || noInstances}>
                {(instances ?? []).map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.tenantName} · {i.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Seu celular (com DDD)" hint="Não é guardado. Use um número que não seja cliente cadastrado.">
            {(fieldProps) => (
              <Input {...fieldProps} type="tel" inputMode="tel" autoComplete="off" placeholder="(11) 91234-5678" value={phone} onChange={(e) => setPhone(e.target.value)} />
            )}
          </Field>
        </div>

        <div className="flex flex-wrap gap-2">
          {KINDS.map(({ kind, label, icon }) => (
            <Button
              key={kind}
              type="button"
              variant="secondary"
              disabled={isPending || !instanceId || phone.trim().length < 8}
              isLoading={isPending && pendingKind === kind}
              onClick={() => handleSend(kind)}
            >
              {icon}
              Enviar {label.toLowerCase()}
            </Button>
          ))}
        </div>

        {error ? <Alert variant="danger">{error}</Alert> : null}

        {result ? (
          <div className="flex flex-col gap-2 rounded-card border border-border bg-bg p-4 text-sm" data-testid="saude-teste-botoes-resultado">
            <p className="flex flex-wrap items-center gap-2 text-text">
              <Badge variant={result.accepted ? "success" : "danger"}>{result.accepted ? "Evolution aceitou" : "Evolution recusou"}</Badge>
              <span>Status {result.status ?? "sem resposta"}</span>
            </p>
            <p className="text-text-secondary">
              {result.sentPayloadNote}{" "}
              {result.accepted ? "Agora olhe o celular: apareceu como botões/lista/enquete ou como mensagem em branco?" : null}
            </p>
            <details className="text-xs text-text-secondary" open={!result.accepted}>
              <summary className="cursor-pointer select-none font-medium text-text">Resposta da Evolution</summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded-card border border-border bg-surface p-3 [overflow-wrap:anywhere] whitespace-pre-wrap">
                {result.responseBody}
              </pre>
            </details>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
