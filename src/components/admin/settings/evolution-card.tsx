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
import { testEvolutionConnectionAction, updatePlatformSettingsAction } from "@/modules/platform/actions";
import type { PlatformSettingsView } from "@/modules/platform/service";
import { TestConnectionButton } from "./config-parts";
import { useReportDirty } from "./dirty-forms";

export function EvolutionCard({ initialSettings }: { initialSettings: PlatformSettingsView }) {
  const router = useRouter();
  const { notify } = useToast();
  const [settings, setSettings] = useState(initialSettings);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [evolutionApiUrl, setEvolutionApiUrl] = useState(settings.evolutionApiUrl ?? "");
  const [evolutionApiKey, setEvolutionApiKey] = useState("");

  useReportDirty("evolution", evolutionApiUrl !== (settings.evolutionApiUrl ?? "") || evolutionApiKey !== "");

  function handleSaveEvolution(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await updatePlatformSettingsAction({
        evolutionApiUrl,
        evolutionApiKey: evolutionApiKey || undefined,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setSettings(result.data);
      setEvolutionApiKey("");
      notify({ variant: "success", title: "Evolution API salva." });
      router.refresh();
    });
  }

  return (
    <Card id="evolution-config" className="rounded-hero">
      <CardHeader>
        <CardTitle>Evolution API</CardTitle>
        <CardDescription>Usada para conectar os números de WhatsApp das empresas.</CardDescription>
      </CardHeader>
      <form onSubmit={handleSaveEvolution}>
        <CardContent className="flex flex-col gap-4">
        {error ? <Alert variant="danger">{error}</Alert> : null}
          <Field label="URL da Evolution" hint="Endereço base da instância da Evolution API.">
            {(fieldProps) => (
              <Input
                {...fieldProps}
                type="url"
                value={evolutionApiUrl}
                onChange={(e) => setEvolutionApiUrl(e.target.value)}
                placeholder="https://evolution.exemplo.com"
              />
            )}
          </Field>
          <Field
            label="Chave da Evolution"
            hint={
              settings.evolutionApiKeyMasked
                ? `Chave atual: ${settings.evolutionApiKeyMasked}. Deixe em branco para manter.`
                : "Nenhuma chave configurada ainda."
            }
          >
            {(fieldProps) => (
              <Input
                {...fieldProps}
                type="password"
                autoComplete="off"
                value={evolutionApiKey}
                onChange={(e) => setEvolutionApiKey(e.target.value)}
                placeholder="••••••••"
              />
            )}
          </Field>
          <TestConnectionButton
            onTest={async () => {
              if (!evolutionApiUrl) {
                return { ok: false, detalhe: "Informe a URL da Evolution para testar." };
              }
              const result = await testEvolutionConnectionAction({ evolutionApiUrl, evolutionApiKey: evolutionApiKey || undefined });
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
