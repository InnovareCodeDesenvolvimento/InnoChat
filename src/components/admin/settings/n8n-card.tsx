"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Alert } from "@/components/ui/alert";
import { useToast } from "@/components/ui/toast";
import { testN8nConnectionAction, updatePlatformSettingsAction } from "@/modules/platform/actions";
import type { PlatformSettingsView } from "@/modules/platform/service";
import { TestConnectionButton } from "./config-parts";
import { useReportDirty } from "./dirty-forms";

export function N8nCard({ initialSettings }: { initialSettings: PlatformSettingsView }) {
  const router = useRouter();
  const { notify } = useToast();
  const [settings, setSettings] = useState(initialSettings);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [n8nBaseUrl, setN8nBaseUrl] = useState(settings.n8nBaseUrl ?? "");
  const [n8nApiKey, setN8nApiKey] = useState("");
  const [n8nWebhookBaseUrl, setN8nWebhookBaseUrl] = useState(settings.n8nWebhookBaseUrl ?? "");

  useReportDirty(
    "n8n",
    n8nBaseUrl !== (settings.n8nBaseUrl ?? "") || n8nApiKey !== "" || n8nWebhookBaseUrl !== (settings.n8nWebhookBaseUrl ?? ""),
  );

  function handleSaveN8n(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await updatePlatformSettingsAction({
        n8nBaseUrl,
        n8nApiKey: n8nApiKey || undefined,
        n8nWebhookBaseUrl,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setSettings(result.data);
      setN8nApiKey("");
      notify({ variant: "success", title: "n8n salvo." });
      router.refresh();
    });
  }

  return (
    <Card id="n8n-config" className="rounded-hero">
      <CardHeader>
        <CardTitle>n8n</CardTitle>
        <CardDescription>Orquestra as conversas do bot no WhatsApp.</CardDescription>
      </CardHeader>
      <form onSubmit={handleSaveN8n}>
        <CardContent className="flex flex-col gap-4">
        {error ? <Alert variant="danger">{error}</Alert> : null}
          <Field label="URL do n8n" hint="Endereço base da instância do n8n (API pública).">
            {(fieldProps) => (
              <Input
                {...fieldProps}
                type="url"
                value={n8nBaseUrl}
                onChange={(e) => setN8nBaseUrl(e.target.value)}
                placeholder="https://n8n.exemplo.com"
              />
            )}
          </Field>
          <Field
            label="Chave da API do n8n"
            hint={
              settings.n8nApiKeyMasked
                ? `Chave atual: ${settings.n8nApiKeyMasked}. Deixe em branco para manter.`
                : "Nenhuma chave configurada ainda. Gere em Settings → n8n API, dentro do n8n."
            }
          >
            {(fieldProps) => (
              <Input
                {...fieldProps}
                type="password"
                autoComplete="off"
                value={n8nApiKey}
                onChange={(e) => setN8nApiKey(e.target.value)}
                placeholder="••••••••"
              />
            )}
          </Field>
          <Field label="URL base de webhook do n8n" hint="Preenchido automaticamente por “Sincronizar n8n” (a partir do nó Webhook do bot); a sincronização sobrescreve o que estiver aqui.">
            {(fieldProps) => (
              <Input
                {...fieldProps}
                type="url"
                value={n8nWebhookBaseUrl}
                onChange={(e) => setN8nWebhookBaseUrl(e.target.value)}
                placeholder="https://n8n.exemplo.com/webhook"
              />
            )}
          </Field>
          <TestConnectionButton
            onTest={async () => {
              if (!n8nBaseUrl) {
                return { ok: false, detalhe: "Informe a URL do n8n para testar." };
              }
              const result = await testN8nConnectionAction({ n8nBaseUrl, n8nApiKey: n8nApiKey || undefined });
              return result.ok ? result.data : { ok: false, detalhe: result.error.message };
            }}
          />
        </CardContent>
        <CardFooter>
          <Button icon={Check} type="submit" isLoading={isPending} loadingText="Salvando…">
            Salvar
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}
