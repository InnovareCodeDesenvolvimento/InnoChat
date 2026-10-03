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
import { testSmtpConnectionAction, updatePlatformSettingsAction } from "@/modules/platform/actions";
import type { PlatformSettingsView } from "@/modules/platform/service";
import { SmtpTestEmailBox } from "@/components/admin/smtp-test-email-box";
import { TestConnectionButton } from "./config-parts";
import { useReportDirty } from "./dirty-forms";

export function SmtpCard({ initialSettings }: { initialSettings: PlatformSettingsView }) {
  const router = useRouter();
  const { notify } = useToast();
  const [settings, setSettings] = useState(initialSettings);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [smtpHost, setSmtpHost] = useState(settings.smtpHost ?? "");
  const [smtpPort, setSmtpPort] = useState(settings.smtpPort ? String(settings.smtpPort) : "");
  const [smtpSecure, setSmtpSecure] = useState(!!settings.smtpSecure);
  const [smtpUser, setSmtpUser] = useState(settings.smtpUser ?? "");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [smtpFrom, setSmtpFrom] = useState(settings.smtpFrom ?? "");

  useReportDirty(
    "smtp",
    smtpHost !== (settings.smtpHost ?? "") ||
      smtpPort !== (settings.smtpPort ? String(settings.smtpPort) : "") ||
      smtpSecure !== !!settings.smtpSecure ||
      smtpUser !== (settings.smtpUser ?? "") ||
      smtpPassword !== "" ||
      smtpFrom !== (settings.smtpFrom ?? ""),
  );

  function handleSaveSmtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await updatePlatformSettingsAction({
        smtpHost,
        smtpPort: smtpPort ? Number(smtpPort) : undefined,
        smtpSecure,
        smtpUser,
        smtpPassword: smtpPassword || undefined,
        smtpFrom,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setSettings(result.data);
      setSmtpPassword("");
      notify({ variant: "success", title: "SMTP salvo." });
      router.refresh();
    });
  }

  return (
    <Card id="smtp-config" className="rounded-hero">
      <CardHeader>
        <CardTitle>E-mail transacional (SMTP)</CardTitle>
        <CardDescription>Usado para lembretes e notificações por e-mail.</CardDescription>
      </CardHeader>
      <form onSubmit={handleSaveSmtp}>
        <CardContent className="flex flex-col gap-4">
        {error ? <Alert variant="danger">{error}</Alert> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Servidor SMTP">
              {(fieldProps) => (
                <Input {...fieldProps} value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.exemplo.com" />
              )}
            </Field>
            <Field label="Porta">
              {(fieldProps) => (
                <Input {...fieldProps} type="number" value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} placeholder="587" />
              )}
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={smtpSecure}
              onChange={(e) => setSmtpSecure(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            Conexão segura (TLS/SSL)
          </label>
          <Field label="Usuário SMTP">
            {(fieldProps) => <Input {...fieldProps} value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} />}
          </Field>
          <Field
            label="Senha SMTP"
            hint={
              settings.smtpPasswordMasked
                ? `Senha atual: ${settings.smtpPasswordMasked}. Deixe em branco para manter.`
                : "Nenhuma senha configurada ainda."
            }
          >
            {(fieldProps) => (
              <Input
                {...fieldProps}
                type="password"
                autoComplete="off"
                value={smtpPassword}
                onChange={(e) => setSmtpPassword(e.target.value)}
                placeholder="••••••••"
              />
            )}
          </Field>
          <Field label="Remetente" hint="Como aparece na caixa de entrada. Ex.: InnoChat <no-reply@seudominio.com.br>. Se puser só o e-mail, o nome InnoChat entra no lugar.">
            {(fieldProps) => (
              <Input {...fieldProps} type="text" inputMode="email" autoComplete="off" value={smtpFrom} onChange={(e) => setSmtpFrom(e.target.value)} placeholder="InnoChat <no-reply@seudominio.com.br>" />
            )}
          </Field>
          <TestConnectionButton
            onTest={async () => {
              if (!smtpHost || !smtpPort) {
                return { ok: false, detalhe: "Informe servidor e porta (mesmo que ainda não tenha salvo) para testar." };
              }
              const result = await testSmtpConnectionAction({
                smtpHost,
                smtpPort: Number(smtpPort),
                smtpSecure,
                smtpUser: smtpUser || undefined,
                smtpPassword: smtpPassword || undefined,
              });
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
      <SmtpTestEmailBox />
    </Card>
  );
}
