"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Globe } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Alert } from "@/components/ui/alert";
import { useToast } from "@/components/ui/toast";
import { setPublicBaseUrlAction } from "@/modules/platform/actions";
import type { PlatformSettingsView } from "@/modules/platform/service";
import { CopyField } from "./config-parts";

export function UrlsCard({ settings }: { settings: PlatformSettingsView }) {
  const router = useRouter();
  const { notify } = useToast();
  const [isPending, startTransition] = useTransition();
  // Sugestão pronta só quando a detecção automática falhou — o endereço que o próprio navegador
  // está usando agora é o melhor palpite (quem está vendo esta tela chegou por um domínio válido).
  const suggestion = !settings.publicBaseUrl && typeof window !== "undefined" ? window.location.origin : "";
  const [baseUrl, setBaseUrl] = useState(settings.publicBaseUrl ?? suggestion);
  const [error, setError] = useState<string | null>(null);

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await setPublicBaseUrlAction({ baseUrl });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setBaseUrl(result.data.publicBaseUrl);
      notify({ variant: "success", title: "Endereço público salvo." });
      router.refresh();
    });
  }

  return (
    <Card className="rounded-hero">
      <CardHeader>
        <CardTitle>URLs do painel</CardTitle>
        <CardDescription>
          O servidor tenta detectar o endereço público sozinho. Quando não consegue, defina-o manualmente abaixo: é a forma garantida de resolver.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <CopyField
          label="URL pública do painel"
          value={settings.publicBaseUrl}
          hint={settings.publicBaseUrl ? "É o que o n8n usa para chamar a API interna do painel." : undefined}
        />
        <CopyField
          label="URL base de webhook do n8n"
          value={settings.n8nWebhookBaseUrl}
          hint="A Evolution chama esta URL seguida do token da instância (gerado ao conectar cada número, na tela de WhatsApp da empresa). Preenchida junto com a URL pública do painel, acima."
        />

        {!settings.publicBaseUrl ? (
          <Alert variant="warning" title="Endereço público ainda não detectado">
            A detecção automática não funcionou para este servidor. Preencha o campo abaixo com o endereço público do painel para destravar os links de
            e-mail e a integração com o n8n.
          </Alert>
        ) : null}

        <form onSubmit={handleSave} className="flex flex-col gap-3 rounded-card border border-border bg-bg p-4">
          <Field
            label="Definir endereço público manualmente"
            hint={`Use quando a URL pública acima continuar mostrando "Ainda não detectada" depois de salvar outra configuração.`}
            helpKey="config.urlPublica"
          >
            {(fieldProps) => (
              <Input
                {...fieldProps}
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://painel.suaempresa.com.br"
                autoComplete="off"
              />
            )}
          </Field>
          {error ? <Alert variant="danger">{error}</Alert> : null}
          <Button type="submit" icon={Globe} isLoading={isPending} loadingText="Salvando…" className="self-start">
            Salvar endereço
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
