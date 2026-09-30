"use client";

import { useState, useTransition } from "react";
import { Check, CheckCircle2, Copy, KeyRound, Power, PowerOff, RefreshCw, Scale, X, XCircle, Zap } from "lucide-react";
import { cn } from "@/components/lib/cn";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { Alert } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { maskCpfCnpj } from "@/components/lib/document-mask";
import { normalizeDocumentDigits } from "@/core/billing/document";
import {
  activateBotWorkflowAction,
  deactivateBotWorkflowAction,
  regenerateInternalApiSecretAction,
  syncN8nAction,
  testEvolutionConnectionAction,
  testN8nConnectionAction,
  testSmtpConnectionAction,
  updatePlatformLegalInfoAction,
  updatePlatformSettingsAction,
} from "@/modules/platform/actions";
import { BotFlowCard } from "@/components/admin/bot-flow-card";
import { GoogleLoginCard, type GoogleAuthConfig } from "@/components/admin/google-login-card";
import { MercadoPagoPanel } from "@/components/admin/mercado-pago-panel";
import type { MercadoPagoConfig } from "@/components/admin/mercado-pago-types";
import type { N8nSyncSummary } from "@/modules/platform/n8n-sync";
import type { PlatformSettingsView } from "@/modules/platform/service";
import type { PlatformLegalInfo } from "@/core/legal/placeholders";

type TestResult = { ok: boolean; detalhe: string } | null;

/** Botão "Testar conexão" com resultado inline — usa os valores AINDA NÃO SALVOS do formulário
 * (decisão do dono: testar antes de gravar), nunca lê o que já está no banco. */
function TestConnectionButton({ onTest }: { onTest: () => Promise<TestResult> }) {
  const [result, setResult] = useState<TestResult>(null);
  const [isPending, startTransition] = useTransition();

  function run() {
    setResult(null);
    startTransition(async () => {
      const r = await onTest();
      setResult(r);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Button icon={Zap} type="button" variant="secondary" size="sm" onClick={run} isLoading={isPending} loadingText="Testando…" className="self-start">
        Testar conexão
      </Button>
      {result ? (
        <p role="status" className={`flex items-center gap-1.5 text-sm ${result.ok ? "text-success" : "text-danger"}`}>
          {result.ok ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" />
          ) : (
            <XCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
          {result.detalhe}
        </p>
      ) : null}
    </div>
  );
}

function CopyField({ label, value, hint }: { label: string; value: string | null; hint?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  }

  return (
    <div>
      <p className="text-sm font-medium text-text">{label}</p>
      <div className="mt-1 flex items-center gap-2 rounded-card border border-border bg-bg p-2.5">
        <code className="flex-1 overflow-x-auto whitespace-nowrap text-xs text-text">
          {value ?? "Ainda não detectada"}
        </code>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={`Copiar ${label}`}
          onClick={copy}
          disabled={!value}
        >
          {copied ? <Check className="h-4 w-4 text-success" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
        </Button>
      </div>
      {hint ? <p className="mt-1 text-xs text-text-secondary">{hint}</p> : null}
    </div>
  );
}

/** Card de status do checklist (docs/design/screens/premium/onda2) — em vez do rótulo com
 * ícone solto de antes, cada item vira um cartão pequeno com selo tingido de sucesso/pendência,
 * escaneável num único olhar. */
function StatusCard({ label, ready }: { label: string; ready: boolean }) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-hero border p-4 transition-colors duration-150",
        ready ? "border-success/25 bg-success-bg/60" : "border-border bg-bg",
      )}
    >
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
          ready ? "bg-success/15 text-success" : "bg-text-secondary/10 text-text-secondary",
        )}
      >
        {ready ? <CheckCircle2 className="h-4.5 w-4.5" aria-hidden="true" /> : <XCircle className="h-4.5 w-4.5" aria-hidden="true" />}
      </div>
      <div>
        <p className={cn("text-sm font-semibold", ready ? "text-text" : "text-text-secondary")}>{label}</p>
        <p className="text-xs text-text-secondary">{ready ? "Configurado" : "Pendente"}</p>
      </div>
    </div>
  );
}

const EMPTY_LEGAL_INFO: PlatformLegalInfo = {
  companyLegalName: null,
  companyCnpj: null,
  companyAddress: null,
  contactEmail: null,
  dpoName: null,
  dpoEmail: null,
  forumCity: null,
  hostingRegion: null,
  backupRetentionDays: null,
};

/** "Completo" = os 9 campos preenchidos — o mesmo texto que `/termos`/`/privacidade` usam via
 * `fillLegalPlaceholders` (docs/contratos.md, "Dados jurídicos"); um campo vazio ainda aparece
 * como "a definir" nas páginas públicas. */
function isLegalInfoComplete(info: PlatformLegalInfo): boolean {
  return (
    !!info.companyLegalName &&
    !!info.companyCnpj &&
    !!info.companyAddress &&
    !!info.contactEmail &&
    !!info.dpoName &&
    !!info.dpoEmail &&
    !!info.forumCity &&
    !!info.hostingRegion &&
    info.backupRetentionDays != null
  );
}

export function AdminConfiguracoesClient({
  initialSettings,
  initialLegal,
  initialMercadoPago,
  initialGoogle,
}: {
  initialSettings: PlatformSettingsView;
  initialLegal: PlatformLegalInfo | null;
  initialMercadoPago: MercadoPagoConfig | null;
  initialGoogle: GoogleAuthConfig | null;
}) {
  const { notify } = useToast();
  const [settings, setSettings] = useState(initialSettings);
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [evolutionApiUrl, setEvolutionApiUrl] = useState(settings.evolutionApiUrl ?? "");
  const [evolutionApiKey, setEvolutionApiKey] = useState("");

  const [n8nBaseUrl, setN8nBaseUrl] = useState(settings.n8nBaseUrl ?? "");
  const [n8nApiKey, setN8nApiKey] = useState("");
  const [n8nWebhookBaseUrl, setN8nWebhookBaseUrl] = useState(settings.n8nWebhookBaseUrl ?? "");

  const [smtpHost, setSmtpHost] = useState(settings.smtpHost ?? "");
  const [smtpPort, setSmtpPort] = useState(settings.smtpPort ? String(settings.smtpPort) : "");
  const [smtpSecure, setSmtpSecure] = useState(!!settings.smtpSecure);
  const [smtpUser, setSmtpUser] = useState(settings.smtpUser ?? "");
  const [smtpPassword, setSmtpPassword] = useState("");
  const [smtpFrom, setSmtpFrom] = useState(settings.smtpFrom ?? "");

  const [secretDialogOpen, setSecretDialogOpen] = useState(false);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [syncSummary, setSyncSummary] = useState<N8nSyncSummary | null>(null);
  const [botActive, setBotActive] = useState<boolean | null>(null);
  const [confirmActivate, setConfirmActivate] = useState<"on" | "off" | null>(null);

  const [mpConfig, setMpConfig] = useState<MercadoPagoConfig | null>(initialMercadoPago);
  const [legal, setLegal] = useState<PlatformLegalInfo>(initialLegal ?? EMPTY_LEGAL_INFO);
  const [legalForm, setLegalForm] = useState({
    companyLegalName: legal.companyLegalName ?? "",
    companyCnpj: legal.companyCnpj ?? "",
    companyAddress: legal.companyAddress ?? "",
    contactEmail: legal.contactEmail ?? "",
    dpoName: legal.dpoName ?? "",
    dpoEmail: legal.dpoEmail ?? "",
    forumCity: legal.forumCity ?? "",
    hostingRegion: legal.hostingRegion ?? "",
    backupRetentionDays: legal.backupRetentionDays != null ? String(legal.backupRetentionDays) : "",
  });
  const [legalError, setLegalError] = useState<string | null>(null);

  // Checklist do topo (pedido do dono): o que já está pronto para o bot funcionar.
  const evolutionReady = !!settings.evolutionApiUrl && !!settings.evolutionApiKeyMasked;
  const n8nReady = !!settings.n8nBaseUrl && !!settings.n8nApiKeyMasked;
  const smtpReady = !!settings.smtpHost;
  // Pronto = o par do ambiente ATIVO tem access token e webhook secret (mesmo critério do servidor;
  // o painel atualiza `mpConfig` a cada ação, então o card reage sem recarregar a página).
  const mpActive = mpConfig ? (mpConfig.environment === "PRODUCTION" ? mpConfig.production : mpConfig.sandbox) : null;
  const mpReady = mpActive ? mpActive.accessTokenSaved && mpActive.webhookSecretSaved : settings.mercadoPagoReady;
  const legalReady = isLegalInfoComplete(legal);

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
    });
  }

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
    });
  }

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
    });
  }

  function handleRegenerateSecret() {
    startTransition(async () => {
      const result = await regenerateInternalApiSecretAction();
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível gerar o segredo", description: result.error.message });
        return;
      }
      setNewSecret(result.data.secret);
      setCopied(false);
      setSecretDialogOpen(true);
      setSettings((prev) => ({ ...prev, internalApiSecretConfigured: true }));
    });
  }

  async function copySecret() {
    if (!newSecret) return;
    await navigator.clipboard.writeText(newSecret);
    setCopied(true);
  }

  function handleSaveLegal(e: React.FormEvent) {
    e.preventDefault();
    setLegalError(null);
    const cnpjDigits = legalForm.companyCnpj ? normalizeDocumentDigits(legalForm.companyCnpj) : "";
    startTransition(async () => {
      const result = await updatePlatformLegalInfoAction({
        companyLegalName: legalForm.companyLegalName,
        companyCnpj: cnpjDigits,
        companyAddress: legalForm.companyAddress,
        contactEmail: legalForm.contactEmail,
        dpoName: legalForm.dpoName,
        dpoEmail: legalForm.dpoEmail,
        forumCity: legalForm.forumCity,
        hostingRegion: legalForm.hostingRegion,
        backupRetentionDays: legalForm.backupRetentionDays ? Number(legalForm.backupRetentionDays) : null,
      });
      if (!result.ok) {
        setLegalError(result.error.message);
        return;
      }
      setLegal(result.data);
      setLegalForm({
        companyLegalName: result.data.companyLegalName ?? "",
        companyCnpj: result.data.companyCnpj ?? "",
        companyAddress: result.data.companyAddress ?? "",
        contactEmail: result.data.contactEmail ?? "",
        dpoName: result.data.dpoName ?? "",
        dpoEmail: result.data.dpoEmail ?? "",
        forumCity: result.data.forumCity ?? "",
        hostingRegion: result.data.hostingRegion ?? "",
        backupRetentionDays: result.data.backupRetentionDays != null ? String(result.data.backupRetentionDays) : "",
      });
      notify({ variant: "success", title: "Dados da empresa salvos." });
    });
  }

  function handleSyncN8n() {
    setSyncSummary(null);
    startTransition(async () => {
      const result = await syncN8nAction();
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível sincronizar o n8n", description: result.error.message });
        return;
      }
      setSyncSummary(result.data);
      setBotActive(null); // sync nunca ativa/desativa — status volta a "não verificado"
      notify({ variant: "success", title: "n8n sincronizado." });
    });
  }

  function handleToggleBot(activate: boolean) {
    startTransition(async () => {
      const result = activate ? await activateBotWorkflowAction() : await deactivateBotWorkflowAction();
      if (!result.ok) {
        notify({
          variant: "error",
          title: activate ? "Não foi possível ativar o bot" : "Não foi possível desativar o bot",
          description: result.error.message,
        });
        setConfirmActivate(null);
        return;
      }
      setBotActive(activate);
      notify({ variant: "success", title: activate ? "Bot ativado." : "Bot desativado." });
      setConfirmActivate(null);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader icon={navIconFor("admin/configuracoes")}
        title="Configurações da plataforma"
        description="Evolution, n8n, e-mail transacional, Mercado Pago e o segredo da API interna — tudo cadastrado aqui, nunca em variável de ambiente."
      />

      {error ? <Alert variant="danger">{error}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatusCard label="Evolution" ready={evolutionReady} />
        <StatusCard label="n8n" ready={n8nReady} />
        <StatusCard label="SMTP" ready={smtpReady} />
        <StatusCard label="Mercado Pago" ready={mpReady} />
        <StatusCard label="Dados da empresa" ready={legalReady} />
      </div>

      <Card className="rounded-hero">
        <CardHeader>
          <CardTitle>URLs detectadas</CardTitle>
          <CardDescription>Detectadas automaticamente pelo servidor — não são digitadas aqui.</CardDescription>
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

      <Card className="rounded-hero">
        <CardHeader>
          <CardTitle>Evolution API</CardTitle>
          <CardDescription>Usada para conectar os números de WhatsApp das empresas.</CardDescription>
        </CardHeader>
        <form onSubmit={handleSaveEvolution}>
          <CardContent className="flex flex-col gap-4">
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

      <Card id="n8n-config" className="rounded-hero">
        <CardHeader>
          <CardTitle>n8n</CardTitle>
          <CardDescription>Orquestra as conversas do bot no WhatsApp.</CardDescription>
        </CardHeader>
        <form onSubmit={handleSaveN8n}>
          <CardContent className="flex flex-col gap-4">
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

      <Card id="bot-n8n" className="rounded-hero">
        <CardHeader>
          <CardTitle>Bot no n8n</CardTitle>
          <CardDescription>
            Sincroniza a URL do painel, a URL da Evolution e as credenciais no workflow do bot — nunca ativa
            sozinho.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Badge variant={botActive === null ? "neutral" : botActive ? "success" : "danger"}>
              {botActive === null ? "Status não verificado" : botActive ? "Bot ativo" : "Bot inativo"}
            </Badge>
          </div>
          {syncSummary ? (
            <Alert variant="success">
              Sincronizado: {syncSummary.credentialsRotated} credencial(is) rotacionada(s), {syncSummary.nodesRebound}{" "}
              nó(s) reconectado(s). Workflow do bot: <code className="text-xs">{syncSummary.botWorkflowId}</code>. Webhook
              reapontado em {syncSummary.webhooksReapontados} número(s) de WhatsApp
              {syncSummary.webhooksFalhos > 0 ? `, ${syncSummary.webhooksFalhos} com falha` : ""}.
              {syncSummary.warnings.map((w) => (
                <span key={w} className="block">
                  {w}
                </span>
              ))}
            </Alert>
          ) : null}
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onClick={handleSyncN8n} isLoading={isPending}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Sincronizar n8n
          </Button>
          <Button type="button" variant="secondary" onClick={() => setConfirmActivate("on")} disabled={isPending}>
            <Power className="h-4 w-4" aria-hidden="true" />
            Ativar bot
          </Button>
          <Button type="button" variant="danger" onClick={() => setConfirmActivate("off")} disabled={isPending}>
            <PowerOff className="h-4 w-4" aria-hidden="true" />
            Desativar bot
          </Button>
        </CardFooter>
      </Card>

      <BotFlowCard />

      <GoogleLoginCard initial={initialGoogle} />

      <MercadoPagoPanel initial={initialMercadoPago} publicBaseUrl={settings.publicBaseUrl} onConfigChange={setMpConfig} />

      <Card className="rounded-hero">
        <CardHeader>
          <CardTitle>E-mail transacional (SMTP)</CardTitle>
          <CardDescription>Usado para lembretes e notificações por e-mail.</CardDescription>
        </CardHeader>
        <form onSubmit={handleSaveSmtp}>
          <CardContent className="flex flex-col gap-4">
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
            <Field label="Remetente" hint="Como aparece na caixa de entrada. Ex.: InnoChat <no-reply@seudominio.com.br>. Só o e-mail também funciona — o nome InnoChat é usado.">
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
      </Card>

      <Card className="rounded-hero">
        <CardHeader>
          <CardTitle>Segredo da API interna (n8n → painel)</CardTitle>
          <CardDescription>
            Usado pelo n8n para autenticar chamadas ao painel. Gerar um novo segredo invalida o anterior
            imediatamente — sincronize o n8n de novo em seguida.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <Badge variant={settings.internalApiSecretConfigured ? "success" : "neutral"}>
              {settings.internalApiSecretConfigured ? "Configurado" : "Não configurado"}
            </Badge>
          </div>
        </CardContent>
        <CardFooter>
          <Button variant="secondary" onClick={handleRegenerateSecret} isLoading={isPending}>
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            {settings.internalApiSecretConfigured ? "Gerar novo segredo" : "Gerar segredo"}
          </Button>
        </CardFooter>
      </Card>

      <Card className="rounded-hero">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Scale className="h-4 w-4 text-text-secondary" aria-hidden="true" />
            <CardTitle>Dados da empresa (Termos e Privacidade)</CardTitle>
          </div>
          <CardDescription>
            Preenche os marcadores como <code className="text-xs">[CNPJ]</code>/<code className="text-xs">[ENDEREÇO]</code> nas
            páginas públicas <code className="text-xs">/termos</code> e <code className="text-xs">/privacidade</code>. Nenhum
            destes dados é segredo. Deixar um campo vazio limpa o dado e volta a mostrar &ldquo;a definir&rdquo; nas páginas
            públicas.
          </CardDescription>
        </CardHeader>
        <form onSubmit={handleSaveLegal}>
          <CardContent className="flex flex-col gap-4">
            {legalError ? <Alert variant="danger">{legalError}</Alert> : null}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Razão social">
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    value={legalForm.companyLegalName}
                    onChange={(e) => setLegalForm((f) => ({ ...f, companyLegalName: e.target.value }))}
                    placeholder="Innovare Code Tecnologia Ltda."
                  />
                )}
              </Field>
              <Field label="CNPJ">
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    inputMode="numeric"
                    autoComplete="off"
                    value={maskCpfCnpj(legalForm.companyCnpj)}
                    onChange={(e) => setLegalForm((f) => ({ ...f, companyCnpj: normalizeDocumentDigits(e.target.value) }))}
                    maxLength={18}
                    placeholder="00.000.000/0000-00"
                  />
                )}
              </Field>
            </div>
            <Field label="Endereço">
              {(fieldProps) => (
                <Input
                  {...fieldProps}
                  value={legalForm.companyAddress}
                  onChange={(e) => setLegalForm((f) => ({ ...f, companyAddress: e.target.value }))}
                  placeholder="Rua Exemplo, 123, Bairro, Cidade — UF, CEP 00000-000"
                />
              )}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="E-mail de contato">
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    type="email"
                    value={legalForm.contactEmail}
                    onChange={(e) => setLegalForm((f) => ({ ...f, contactEmail: e.target.value }))}
                    placeholder="contato@innovarecode.com.br"
                  />
                )}
              </Field>
              <Field label="Comarca (foro)">
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    value={legalForm.forumCity}
                    onChange={(e) => setLegalForm((f) => ({ ...f, forumCity: e.target.value }))}
                    placeholder="São Paulo/SP"
                  />
                )}
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nome do encarregado (DPO)">
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    value={legalForm.dpoName}
                    onChange={(e) => setLegalForm((f) => ({ ...f, dpoName: e.target.value }))}
                  />
                )}
              </Field>
              <Field label="E-mail do encarregado (DPO)">
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    type="email"
                    value={legalForm.dpoEmail}
                    onChange={(e) => setLegalForm((f) => ({ ...f, dpoEmail: e.target.value }))}
                    placeholder="dpo@innovarecode.com.br"
                  />
                )}
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="País/região da hospedagem">
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    value={legalForm.hostingRegion}
                    onChange={(e) => setLegalForm((f) => ({ ...f, hostingRegion: e.target.value }))}
                    placeholder="Brasil"
                  />
                )}
              </Field>
              <Field label="Prazo de retenção dos backups (dias)">
                {(fieldProps) => (
                  <Input
                    {...fieldProps}
                    type="number"
                    min={1}
                    max={3650}
                    value={legalForm.backupRetentionDays}
                    onChange={(e) => setLegalForm((f) => ({ ...f, backupRetentionDays: e.target.value }))}
                    placeholder="30"
                  />
                )}
              </Field>
            </div>
          </CardContent>
          <CardFooter>
            <Button icon={Check} type="submit" isLoading={isPending} loadingText="Salvando…">
              Salvar
            </Button>
          </CardFooter>
        </form>
      </Card>

      <Dialog open={secretDialogOpen} onOpenChange={setSecretDialogOpen}>
        <DialogContent>
          <DialogHeader icon={KeyRound}>
            <DialogTitle>Segredo gerado</DialogTitle>
            <DialogDescription>
              Copie agora — por segurança, ele não pode ser mostrado de novo depois que você fechar esta janela.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex items-center gap-2 rounded-card border border-border bg-bg p-3">
            <code className="flex-1 overflow-x-auto whitespace-nowrap text-sm text-text">{newSecret}</code>
            <Button type="button" variant="ghost" size="icon" aria-label="Copiar segredo" onClick={copySecret}>
              {copied ? <Check className="h-4 w-4 text-success" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
            </Button>
          </div>
          <DialogFooter>
            <Button icon={Check} type="button" onClick={() => setSecretDialogOpen(false)}>
              Já copiei, fechar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirmActivate} onOpenChange={(open) => !open && setConfirmActivate(null)}>
        <DialogContent>
          <DialogHeader icon={confirmActivate === "on" ? Power : PowerOff} tone={confirmActivate === "on" ? "primary" : "danger"}>
            <DialogTitle>{confirmActivate === "on" ? "Ativar o bot" : "Desativar o bot"}</DialogTitle>
            <DialogDescription>
              {confirmActivate === "on"
                ? "O workflow do bot passa a responder no WhatsApp de todas as empresas conectadas. Sincronize o n8n antes, se ainda não sincronizou."
                : "O workflow do bot deixa de responder no WhatsApp de todas as empresas conectadas."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button icon={X} type="button" variant="secondary" onClick={() => setConfirmActivate(null)}>
              Cancelar
            </Button>
            <Button
              icon={confirmActivate === "on" ? Power : PowerOff}
              type="button"
              variant={confirmActivate === "off" ? "danger" : "primary"}
              onClick={() => handleToggleBot(confirmActivate === "on")}
              isLoading={isPending}
             loadingText="Confirmando…">
              Confirmar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
