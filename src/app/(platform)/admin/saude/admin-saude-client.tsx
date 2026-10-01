"use client";

import { useState, useTransition } from "react";
import { Inbox, Mail, RefreshCw, Server, Wallet, Wifi } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { navIconFor } from "@/components/shell/nav-items";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/alert";
import { cn } from "@/components/lib/cn";
import { formatRelativeTimeLabel } from "@/components/lib/format-date";
import { useToast } from "@/components/ui/toast";
import { getPlatformHealthAction } from "@/modules/platform/actions";
import { InteractiveTestCard } from "./interactive-test-card";
import type { IntegrationHealth, MercadoPagoWebhookHealth, PlatformHealth, TickHealth } from "@/modules/platform/health-service";

const WHATSAPP_STATUS_LABEL: Record<string, string> = {
  CONNECTED: "Conectado",
  QRCODE: "Aguardando QR",
  DISCONNECTED: "Desconectado",
};

const SUBSCRIPTION_STATUS_LABEL: Record<string, string> = {
  TRIALING: "Em teste",
  ACTIVE: "Ativa",
  PAST_DUE: "Fatura atrasada",
  SUSPENDED: "Suspensa",
  CANCELED: "Cancelada",
};

const SUBSCRIPTION_STATUS_BADGE: Record<string, BadgeProps["variant"]> = {
  TRIALING: "primary",
  ACTIVE: "success",
  PAST_DUE: "warning",
  SUSPENDED: "danger",
  CANCELED: "neutral",
};

const WHATSAPP_STATUS_BADGE: Record<string, BadgeProps["variant"]> = {
  CONNECTED: "success",
  QRCODE: "warning",
  DISCONNECTED: "danger",
};

function StatusDot({ ok, configured }: { ok: boolean; configured: boolean }) {
  const dotClass = ok ? "bg-success" : configured ? "bg-danger" : "bg-text-secondary/40";
  return (
    <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden="true">
      {ok ? (
        <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:animate-none", dotClass)} />
      ) : null}
      <span className={cn("relative inline-flex h-2.5 w-2.5 rounded-full", dotClass)} />
    </span>
  );
}

function IntegrationCard({ icon, label, health }: { icon: React.ReactNode; label: string; health: IntegrationHealth }) {
  return (
    <Card className="rounded-hero p-5">
      <div className="flex items-center gap-2.5">
        <StatusDot ok={health.ok} configured={health.configured} />
        <span className="text-text-secondary [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
        <p className="font-display text-sm font-bold text-text">{label}</p>
      </div>
      <p className="mt-3 text-sm text-text-secondary">{health.detalhe}</p>
    </Card>
  );
}

const WEBHOOK_REASON_LABEL: Record<string, string> = {
  missing_signature: "sem assinatura (x-signature ausente)",
  malformed_signature: "assinatura mal formada",
  bad_signature: "assinatura inválida",
  stale_timestamp: "assinatura fora do prazo (relógio ou reenvio antigo)",
  no_secret_for_env: "sem chave secreta salva para o ambiente ativo",
  wrong_environment_secret: "assinatura válida para o OUTRO ambiente (teste x produção)",
  ignored_type: "tipo de notificação ignorado",
  missing_data_id: "notificação sem data.id",
};

const ENV_LABEL = { PRODUCTION: "Produção", SANDBOX: "Teste (sandbox)" } as const;

function MercadoPagoWebhookCard({ webhook }: { webhook: MercadoPagoWebhookHealth }) {
  const rejectedNow = webhook.lastOutcome === "rejected";
  return (
    <Card className="rounded-hero" data-testid="saude-webhook-mp">
      <CardHeader>
        <CardTitle>Webhook do Mercado Pago</CardTitle>
        <CardDescription>Ambiente ativo: {ENV_LABEL[webhook.activeEnvironment]}.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <p className="text-text">
          {webhook.lastReceivedAt ? `Último recebido ${formatRelativeTimeLabel(webhook.lastReceivedAt)}` : "Nenhum webhook recebido ainda"}
          {webhook.lastOutcome ? <Badge variant={rejectedNow ? "danger" : "success"} className="ml-2">{rejectedNow ? "rejeitado" : "aceito"}</Badge> : null}
        </p>
        <p className="text-text">
          {webhook.lastRejectedAt
            ? `Última rejeição ${formatRelativeTimeLabel(webhook.lastRejectedAt)}: ${WEBHOOK_REASON_LABEL[webhook.lastRejectionReason ?? ""] ?? webhook.lastRejectionReason ?? "motivo desconhecido"}`
            : "Nenhuma rejeição registrada."}
        </p>
        <Alert variant="info">
          No painel do Mercado Pago, o webhook tem URL e chave secreta <strong>separadas para modo teste e produção</strong>. A chave
          secreta salva aqui para o ambiente ativo ({ENV_LABEL[webhook.activeEnvironment]}) precisa ser a do mesmo modo no painel do MP. Sem webhook,
          a fatura ainda é baixada pela conferência automática (tela de Assinatura, tick a cada hora ou botão em Cobrança).
        </Alert>
      </CardContent>
    </Card>
  );
}

function TickCard({ title, tick }: { title: string; tick: TickHealth }) {
  return (
    <Card className="rounded-hero">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{tick.lastRunAt ? `Última execução ${formatRelativeTimeLabel(tick.lastRunAt)}` : "Nunca executado"}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div>
          <Badge variant={tick.stale ? "danger" : "success"}>{tick.stale ? "Atrasado" : "Em dia"}</Badge>
        </div>
        {tick.lastResult != null ? (
          <details className="text-xs text-text-secondary">
            <summary className="cursor-pointer select-none font-medium text-text">Ver resultado da última execução</summary>
            <pre className="mt-2 overflow-x-auto rounded-card border border-border bg-bg p-3 [overflow-wrap:anywhere]">
              {JSON.stringify(tick.lastResult, null, 2)}
            </pre>
          </details>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CountRow({ label, counts, labels, badges }: { label: string; counts: Record<string, number>; labels: Record<string, string>; badges: Record<string, BadgeProps["variant"]> }) {
  return (
    <div>
      <p className="text-sm font-medium text-text-secondary">{label}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {Object.entries(counts).map(([status, count]) => (
          <span key={status} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-bg px-2.5 py-1 text-xs">
            <Badge variant={badges[status] ?? "neutral"}>{labels[status] ?? status}</Badge>
            <span className="font-semibold tabular-nums text-text">{count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function AdminSaudeClient({ initialHealth }: { initialHealth: PlatformHealth }) {
  const { notify } = useToast();
  const [health, setHealth] = useState(initialHealth);
  const [isPending, startTransition] = useTransition();

  function handleRefresh() {
    startTransition(async () => {
      const result = await getPlatformHealthAction();
      if (!result.ok) {
        notify({ variant: "error", title: "Não foi possível atualizar", description: result.error.message });
        return;
      }
      setHealth(result.data);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader icon={navIconFor("admin/saude")}
        title="Saúde"
        description="Integrações, jobs periódicos e volume operacional da plataforma."
        action={
          <Button type="button" variant="secondary" onClick={handleRefresh} isLoading={isPending}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Atualizar
          </Button>
        }
      />

      <p className="text-xs text-text-secondary">
        Integrações verificadas {formatRelativeTimeLabel(health.integrations.checkedAt)}. O resultado fica guardado por uns 60 segundos.
      </p>

      {health.alerts.length > 0 ? (
        <div className="flex flex-col gap-2">
          {health.alerts.map((alert) => (
            <Alert key={alert} variant="warning">
              {alert}
            </Alert>
          ))}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <IntegrationCard icon={<Wifi aria-hidden="true" />} label="Evolution" health={health.integrations.evolution} />
        <IntegrationCard icon={<Server aria-hidden="true" />} label="n8n" health={health.integrations.n8n} />
        <IntegrationCard icon={<Mail aria-hidden="true" />} label="SMTP" health={health.integrations.smtp} />
        <IntegrationCard icon={<Wallet aria-hidden="true" />} label="Mercado Pago" health={health.integrations.mercadoPago} />
      </div>

      <MercadoPagoWebhookCard webhook={health.mercadoPagoWebhook} />

      <InteractiveTestCard />

      <div className="grid gap-3 sm:grid-cols-2">
        <TickCard title="billing/tick" tick={health.billingTick} />
        <TickCard title="maintenance/tick" tick={health.maintenanceTick} />
      </div>

      <Card className="rounded-hero">
        <CardHeader>
          <CardTitle>Volume operacional</CardTitle>
          <CardDescription>Contagens em tempo real, direto do banco.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <CountRow
            label="Números de WhatsApp por status"
            counts={health.whatsappInstancesByStatus}
            labels={WHATSAPP_STATUS_LABEL}
            badges={WHATSAPP_STATUS_BADGE}
          />
          <CountRow
            label="Empresas por status de assinatura"
            counts={health.companiesBySubscriptionStatus}
            labels={SUBSCRIPTION_STATUS_LABEL}
            badges={SUBSCRIPTION_STATUS_BADGE}
          />
          <div className="flex items-center gap-3 rounded-card border border-border bg-bg p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Inbox className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm text-text-secondary">Mensagens processadas nas últimas 24h</p>
              <p className="font-display text-2xl font-black tabular-nums text-text">{health.inboundEventsLast24h}</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
