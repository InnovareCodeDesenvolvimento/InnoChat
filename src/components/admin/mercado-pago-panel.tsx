"use client";

import { useState } from "react";
import { AlertTriangle, Check, Copy, FlaskConical, RefreshCw, ShieldAlert, ShieldCheck, Trash2, X } from "lucide-react";
import { cn } from "@/components/lib/cn";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import {
  getMercadoPagoConfigAction,
  removeMercadoPagoSecretAction,
  saveMercadoPagoCredentialsAction,
  setMercadoPagoEnabledAction,
  setMercadoPagoEnvironmentAction,
  testMercadoPagoConnectionAction,
} from "@/modules/platform/actions";
import { MercadoPagoCredentialsCard, type CredentialsDraft } from "./mercado-pago-credentials-card";
import type {
  ConnectionTest,
  MercadoPagoConfig,
  MercadoPagoEnv,
  MercadoPagoSecretField,
} from "./mercado-pago-types";

type Pending = { kind: "production" } | { kind: "sandbox" } | { kind: "remove"; env: MercadoPagoEnv; field: MercadoPagoSecretField };
type ActionResult = { ok: true; data: MercadoPagoConfig } | { ok: false; error: { message: string } };

const EMPTY_DRAFT: CredentialsDraft = { accessToken: "", webhookSecret: "" };
const FIELD_LABEL: Record<MercadoPagoSecretField, string> = {
  accessToken: "Access Token",
  webhookSecret: "Webhook Secret",
};

function EnvironmentOption({
  selected,
  tone,
  icon: Icon,
  title,
  description,
  disabled,
  onClick,
}: {
  selected: boolean;
  tone: "primary" | "danger";
  icon: typeof FlaskConical;
  title: string;
  description: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={cn(
        "flex min-h-11 flex-col items-start gap-1.5 rounded-hero border-2 p-4 text-left transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60",
        selected
          ? tone === "danger"
            ? "border-danger bg-danger-bg"
            : "border-primary bg-primary/5"
          : "border-border bg-surface hover:bg-bg",
      )}
    >
      <span className="inline-flex items-center gap-2">
        <Icon className={cn("h-4 w-4", tone === "danger" ? "text-danger" : "text-primary")} aria-hidden="true" />
        <span className="font-display text-sm font-bold text-text">{title}</span>
        {selected ? <span className="text-xs font-semibold text-text-secondary">· selecionado</span> : null}
      </span>
      <span className="text-xs text-text-secondary">{description}</span>
    </button>
  );
}

function WebhookUrl({ baseUrl }: { baseUrl: string | null }) {
  const [copied, setCopied] = useState(false);
  const url = baseUrl ? `${baseUrl.replace(/\/+$/, "")}/api/webhooks/mercadopago` : null;

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div>
      <p className="text-sm font-medium text-text">URL do webhook</p>
      <div className="mt-1 flex items-center gap-2 rounded-card border border-border bg-bg p-2.5">
        <code className="flex-1 overflow-x-auto whitespace-nowrap text-xs text-text">
          {url ?? "Ainda não detectada"}
        </code>
        <Button type="button" variant="ghost" size="icon" aria-label="Copiar URL do webhook" onClick={copy} disabled={!url}>
          {copied ? (
            <Check className="h-4 w-4 text-success" aria-hidden="true" />
          ) : (
            <Copy className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>
      </div>
      <p className="mt-1 text-xs text-text-secondary">
        Cadastre este endereço no painel do Mercado Pago (Webhooks) para receber as notificações de pagamento.
      </p>
    </div>
  );
}

export function MercadoPagoPanel({
  initial,
  publicBaseUrl,
  onConfigChange,
}: {
  initial: MercadoPagoConfig | null;
  publicBaseUrl: string | null;
  onConfigChange?: (config: MercadoPagoConfig) => void;
}) {
  const { notify } = useToast();
  const [config, setConfigState] = useState<MercadoPagoConfig | null>(initial);
  const [drafts, setDrafts] = useState<Record<MercadoPagoEnv, CredentialsDraft>>({
    PRODUCTION: EMPTY_DRAFT,
    SANDBOX: EMPTY_DRAFT,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  function applyConfig(next: MercadoPagoConfig) {
    setConfigState(next);
    onConfigChange?.(next);
  }

  /** Executa uma action `Result<MercadoPagoConfig>`; erro vira toast e `busy` nunca fica preso. */
  async function run(key: string, fn: () => Promise<ActionResult>, successTitle: string, onDone?: () => void) {
    setBusy(key);
    try {
      const result = await fn();
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível concluir", description: result.error.message });
        return;
      }
      applyConfig(result.data);
      onDone?.();
      notify({ variant: "success", title: successTitle });
    } catch {
      notify({ variant: "error", title: "Não foi possível concluir", description: "Falha de conexão. Tente de novo." });
    } finally {
      setBusy(null);
    }
  }

  async function reload() {
    setBusy("reload");
    setLoadError(null);
    try {
      const result = await getMercadoPagoConfigAction();
      if (result.ok) applyConfig(result.data);
      else setLoadError(result.error.message);
    } catch {
      setLoadError("Falha de conexão. Tente de novo.");
    } finally {
      setBusy(null);
    }
  }

  if (!config) {
    return (
      <Card className="rounded-hero">
        <CardHeader>
          <CardTitle>Mercado Pago</CardTitle>
          <CardDescription>Usado para gerar o Pix das faturas e validar o webhook de pagamento.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-3">
          <Alert variant="danger" className="w-full">
            {loadError ?? "Não deu para carregar a configuração do Mercado Pago."}
          </Alert>
          <Button icon={RefreshCw} type="button" variant="secondary" onClick={reload} isLoading={busy === "reload"}>
            Tentar de novo
          </Button>
        </CardContent>
      </Card>
    );
  }

  const current = config;
  const isProd = current.environment === "PRODUCTION";
  const anyBusy = busy !== null;

  function patchDraft(env: MercadoPagoEnv, patch: Partial<CredentialsDraft>) {
    setDrafts((d) => ({ ...d, [env]: { ...d[env], ...patch } }));
  }

  function save(env: MercadoPagoEnv) {
    const d = drafts[env];
    const publicKey = d.publicKey?.trim();
    const accessToken = d.accessToken.trim();
    const webhookSecret = d.webhookSecret.trim();
    if (!publicKey && !accessToken && !webhookSecret) {
      notify({ variant: "info", title: "Nada para salvar", description: "Em branco mantém o que já está salvo." });
      return;
    }
    void run(
      `save-${env}`,
      () =>
        saveMercadoPagoCredentialsAction({
          env,
          ...(publicKey ? { publicKey } : {}),
          ...(accessToken ? { accessToken } : {}),
          ...(webhookSecret ? { webhookSecret } : {}),
        }),
      env === "PRODUCTION" ? "Credenciais de produção salvas." : "Credenciais de teste salvas.",
      () => setDrafts((all) => ({ ...all, [env]: EMPTY_DRAFT })),
    );
  }

  async function test(env: MercadoPagoEnv): Promise<ConnectionTest> {
    try {
      const token = drafts[env].accessToken.trim();
      const result = await testMercadoPagoConnectionAction({ env, ...(token ? { accessToken: token } : {}) });
      return result.ok ? result.data : { ok: false, detalhe: result.error.message };
    } catch {
      return { ok: false, detalhe: "Falha de conexão ao testar. Tente de novo." };
    }
  }

  function changeEnvironment(target: MercadoPagoEnv) {
    if (target === current.environment) return;
    setPending({ kind: target === "PRODUCTION" ? "production" : "sandbox" });
  }

  function confirmPending() {
    const p = pending;
    if (!p) return;
    if (p.kind === "production" || p.kind === "sandbox") {
      const environment = p.kind === "production" ? "PRODUCTION" : "SANDBOX";
      void run(
        "env",
        () => setMercadoPagoEnvironmentAction({ environment }),
        environment === "PRODUCTION" ? "Produção ativada." : "Ambiente de teste ativado.",
        () => setPending(null),
      );
    } else {
      void run(
        "remove",
        () => removeMercadoPagoSecretAction({ env: p.env, field: p.field }),
        `${FIELD_LABEL[p.field]} removido.`,
        () => setPending(null),
      );
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card className="rounded-hero">
        <CardHeader>
          <CardTitle>Mercado Pago</CardTitle>
          <CardDescription>
            Gera o Pix das faturas e valida o webhook de pagamento. Cada ambiente tem o seu trio de credenciais.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <div className="grid gap-3 sm:grid-cols-2" role="group" aria-label="Ambiente ativo">
            <EnvironmentOption
              selected={!isProd}
              tone="primary"
              icon={FlaskConical}
              title="Teste (sandbox)"
              description="Pagamentos simulados. Nada é cobrado de verdade."
              disabled={anyBusy}
              onClick={() => changeEnvironment("SANDBOX")}
            />
            <EnvironmentOption
              selected={isProd}
              tone="danger"
              icon={ShieldAlert}
              title="Produção"
              description="Cobranças reais no Pix das empresas."
              disabled={anyBusy}
              onClick={() => changeEnvironment("PRODUCTION")}
            />
          </div>

          <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
            <div>
              <p id="mp-enabled-label" className="text-sm font-semibold text-text">
                Cobrança liberada
              </p>
              <p id="mp-enabled-hint" className="text-xs text-text-secondary">
                Desligada, nenhuma fatura gera Pix, em nenhum dos dois ambientes.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={current.enabled}
              aria-labelledby="mp-enabled-label"
              aria-describedby="mp-enabled-hint"
              disabled={anyBusy}
              onClick={() =>
                void run(
                  "enabled",
                  () => setMercadoPagoEnabledAction({ enabled: !current.enabled }),
                  current.enabled ? "Cobrança desligada." : "Cobrança liberada.",
                )
              }
              className="relative inline-flex h-11 w-16 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-60"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "relative h-7 w-12 rounded-full border transition-colors motion-reduce:transition-none",
                  current.enabled ? "border-primary bg-primary" : "border-border bg-bg",
                )}
              >
                <span
                  className={cn(
                    "absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow-card transition-[left] motion-reduce:transition-none",
                    current.enabled ? "left-6" : "left-0.5",
                  )}
                />
              </span>
            </button>
          </div>

          <WebhookUrl baseUrl={publicBaseUrl} />
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <MercadoPagoCredentialsCard
          title="Credenciais de produção"
          description="O trio do ambiente. Access Token e Webhook Secret ficam cifrados no servidor e nunca voltam para a tela."
          active={isProd}
          saved={current.production}
          draft={drafts.PRODUCTION}
          labelSuffix=""
          publicKeyPlaceholder="APP_USR-..."
          busy={busy === "save-PRODUCTION"}
          onDraftChange={(patch) => patchDraft("PRODUCTION", patch)}
          onSave={() => save("PRODUCTION")}
          onTest={() => test("PRODUCTION")}
          onRemoveSecret={(field) => setPending({ kind: "remove", env: "PRODUCTION", field })}
        />
        <MercadoPagoCredentialsCard
          title="Credenciais de teste (sandbox)"
          description="O mesmo trio, do ambiente de teste. Os segredos ficam cifrados e nunca voltam para a tela."
          active={!isProd}
          saved={current.sandbox}
          draft={drafts.SANDBOX}
          labelSuffix=" de teste"
          publicKeyPlaceholder="TEST-..."
          busy={busy === "save-SANDBOX"}
          onDraftChange={(patch) => patchDraft("SANDBOX", patch)}
          onSave={() => save("SANDBOX")}
          onTest={() => test("SANDBOX")}
          onRemoveSecret={(field) => setPending({ kind: "remove", env: "SANDBOX", field })}
        />
      </div>

      {/* Sempre montado: nunca dentro de condicional que a própria ação desmonta. */}
      <Dialog open={pending !== null} onOpenChange={(open) => !open && busy === null && setPending(null)}>
        <DialogContent>
          <DialogHeader
            icon={pending?.kind === "remove" ? Trash2 : pending?.kind === "sandbox" ? FlaskConical : AlertTriangle}
            tone={pending?.kind === "remove" ? "danger" : pending?.kind === "sandbox" ? "primary" : "warning"}
          >
            <DialogTitle>
              {pending?.kind === "remove"
                ? `Remover ${FIELD_LABEL[pending.field]}?`
                : pending?.kind === "sandbox"
                  ? "Mudar para o ambiente de teste?"
                  : "Ativar cobranças em produção?"}
            </DialogTitle>
            <DialogDescription>
              {pending?.kind === "remove"
                ? `A credencial salva de ${pending.env === "PRODUCTION" ? "produção" : "teste"} será apagada do servidor. Sem ela, esse ambiente deixa de funcionar até você cadastrar outra.`
                : pending?.kind === "sandbox"
                  ? "As faturas passam a gerar Pix simulado e as notificações de pagamentos reais deixam de ser aceitas até voltar para produção."
                  : "A partir de agora as faturas geram Pix reais pelo Mercado Pago, e o dinheiro é cobrado de verdade. Só confirme se as credenciais de produção estiverem certas."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button icon={X} type="button" variant="secondary" onClick={() => setPending(null)} disabled={busy !== null}>
              Cancelar
            </Button>
            <Button icon={pending?.kind === "remove" ? Trash2 : pending?.kind === "sandbox" ? FlaskConical : ShieldCheck} type="button" variant={pending?.kind === "sandbox" ? "primary" : "danger"} onClick={confirmPending} isLoading={busy === "env" || busy === "remove"}>
              {pending?.kind === "remove" ? "Sim, remover" : pending?.kind === "sandbox" ? "Sim, usar teste" : "Sim, ativar produção"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
