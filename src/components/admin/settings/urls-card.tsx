"use client";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { PlatformSettingsView } from "@/modules/platform/service";
import { CopyField } from "./config-parts";

export function UrlsCard({ settings }: { settings: PlatformSettingsView }) {
  return (
    <Card className="rounded-hero">
      <CardHeader>
        <CardTitle>URLs detectadas</CardTitle>
        <CardDescription>O servidor detecta esses endereços sozinho. Não precisa digitar.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <CopyField
          label="URL pública do painel"
          value={settings.publicBaseUrl}
          hint={
            settings.publicBaseUrl
              ? "É o que o n8n usa para chamar a API interna do painel."
              : "Detectada sozinha na primeira vez que qualquer configuração abaixo for salva."
          }
        />
        <CopyField
          label="URL base de webhook do n8n"
          value={settings.n8nWebhookBaseUrl}
          hint="A Evolution chama esta URL seguida do token da instância (gerado ao conectar cada número, na tela de WhatsApp da empresa)."
        />
      </CardContent>
    </Card>
  );
}
