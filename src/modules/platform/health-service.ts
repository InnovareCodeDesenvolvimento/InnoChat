import { getPrisma } from "@/lib/db/prisma";
import type { SubscriptionStatus, WhatsappInstanceStatus } from "@/lib/db/types";
import { getActiveMercadoPagoCredentials } from "./mercadopago-config";
import { loadPlatformSettingsRow, readGenericSecret } from "./secrets";
import { testEvolutionConnection, testMercadoPagoConnection, testN8nConnection, testSmtpConnection, type ConnectionTestResult } from "./connection-tests";

/**
 * Admin → Saúde (docs/contratos.md, "Admin Saúde") — visão consolidada de integrações, dos
 * jobs periódicos (`billing/tick`/`maintenance/tick`) e de volume operacional, para o admin da
 * plataforma ver rapidamente "está tudo funcionando?" sem entrar em cada tela separada.
 */

// ---------------------------------------------------------------------------
// Status das integrações — reaproveita os testes de conexão de `connection-tests.ts`, com
// cache de ~60s (a tela pode ser aberta/recarregada com frequência; os testes fazem chamada de
// rede de verdade a 4 serviços externos — sem cache, cada visita à tela martelaria Evolution/
// n8n/SMTP/Mercado Pago).
// ---------------------------------------------------------------------------

export type IntegrationHealth = ConnectionTestResult & { configured: boolean };

export type IntegrationsHealth = {
  evolution: IntegrationHealth;
  n8n: IntegrationHealth;
  smtp: IntegrationHealth;
  mercadoPago: IntegrationHealth;
  checkedAt: string;
};

const NOT_CONFIGURED: ConnectionTestResult = { ok: false, detalhe: "Não configurado." };
const INTEGRATIONS_CACHE_TTL_MS = 60_000;

let cachedIntegrations: { at: number; data: IntegrationsHealth } | null = null;

async function computeIntegrationsHealth(): Promise<IntegrationsHealth> {
  const row = await loadPlatformSettingsRow(); // já migrado; segredos decifrados abaixo
  const mp = await getActiveMercadoPagoCredentials();
  const settings = {
    evolutionApiUrl: row?.evolutionApiUrl ?? null,
    evolutionApiKey: readGenericSecret(row?.evolutionApiKey, "evolutionApiKey"),
    n8nBaseUrl: row?.n8nBaseUrl ?? null,
    n8nApiKey: readGenericSecret(row?.n8nApiKey, "n8nApiKey"),
    mercadoPagoAccessToken: mp.accessToken,
    smtpHost: row?.smtpHost ?? null,
    smtpPort: row?.smtpPort ?? null,
    smtpSecure: row?.smtpSecure ?? null,
    smtpUser: row?.smtpUser ?? null,
    smtpPassword: readGenericSecret(row?.smtpPassword, "smtpPassword"),
  };

  const [evolution, n8n, smtp, mercadoPago] = await Promise.all([
    settings?.evolutionApiUrl && settings.evolutionApiKey
      ? testEvolutionConnection(settings.evolutionApiUrl, settings.evolutionApiKey)
      : Promise.resolve(NOT_CONFIGURED),
    settings?.n8nBaseUrl && settings.n8nApiKey
      ? testN8nConnection(settings.n8nBaseUrl, settings.n8nApiKey)
      : Promise.resolve(NOT_CONFIGURED),
    settings?.smtpHost && settings.smtpPort
      ? testSmtpConnection({
          host: settings.smtpHost,
          port: settings.smtpPort,
          secure: !!settings.smtpSecure,
          user: settings.smtpUser,
          password: settings.smtpPassword,
        })
      : Promise.resolve(NOT_CONFIGURED),
    settings?.mercadoPagoAccessToken ? testMercadoPagoConnection(settings.mercadoPagoAccessToken) : Promise.resolve(NOT_CONFIGURED),
  ]);

  return {
    evolution: { ...evolution, configured: !!(settings?.evolutionApiUrl && settings.evolutionApiKey) },
    n8n: { ...n8n, configured: !!(settings?.n8nBaseUrl && settings.n8nApiKey) },
    smtp: { ...smtp, configured: !!(settings?.smtpHost && settings.smtpPort) },
    mercadoPago: { ...mercadoPago, configured: !!settings?.mercadoPagoAccessToken },
    checkedAt: new Date().toISOString(),
  };
}

/** Devolve o resultado em cache se tiver menos de 60s; recalcula (bate nos 4 serviços) senão. */
export async function getIntegrationsHealth(): Promise<IntegrationsHealth> {
  if (cachedIntegrations && Date.now() - cachedIntegrations.at < INTEGRATIONS_CACHE_TTL_MS) {
    return cachedIntegrations.data;
  }
  const data = await computeIntegrationsHealth();
  cachedIntegrations = { at: Date.now(), data };
  return data;
}

/** Só para os testes de integração: força o próximo `getIntegrationsHealth()` a recalcular. */
export function resetIntegrationsHealthCache(): void {
  cachedIntegrations = null;
}

// ---------------------------------------------------------------------------
// Jobs periódicos (billing/maintenance tick) — persistidos por `recordBillingTickRun`/
// `recordMaintenanceTickRun` (chamados pelos próprios ticks, `src/modules/billing/tick.ts` e
// `src/modules/maintenance/tick.ts`) ao final de cada execução.
// ---------------------------------------------------------------------------

const BILLING_TICK_STALE_MS = 2 * 60 * 60 * 1000; // 2h
const MAINTENANCE_TICK_STALE_MS = 26 * 60 * 60 * 1000; // 26h

export async function recordBillingTickRun(result: unknown, at: Date = new Date()): Promise<void> {
  await getPrisma().platformSettings.upsert({
    where: { id: 1 },
    create: { id: 1, lastBillingTickAt: at, lastBillingTickResult: result as never },
    update: { lastBillingTickAt: at, lastBillingTickResult: result as never },
  });
}

export async function recordMaintenanceTickRun(result: unknown, at: Date = new Date()): Promise<void> {
  await getPrisma().platformSettings.upsert({
    where: { id: 1 },
    create: { id: 1, lastMaintenanceTickAt: at, lastMaintenanceTickResult: result as never },
    update: { lastMaintenanceTickAt: at, lastMaintenanceTickResult: result as never },
  });
}

// ---------------------------------------------------------------------------
// Contagens operacionais + alertas
// ---------------------------------------------------------------------------

export type TickHealth = {
  lastRunAt: string | null;
  lastResult: unknown;
  stale: boolean;
};

/** Diagnóstico do webhook do MP (nunca contém corpo/segredo — só desfecho, motivo e ambiente). */
export type MercadoPagoWebhookHealth = {
  lastReceivedAt: string | null;
  lastOutcome: string | null;
  lastRejectedAt: string | null;
  lastRejectionReason: string | null;
  /** Ambiente ATIVO hoje (o segredo usado na validação é o dele). */
  activeEnvironment: "PRODUCTION" | "SANDBOX";
};

export type PlatformHealth = {
  integrations: IntegrationsHealth;
  mercadoPagoWebhook: MercadoPagoWebhookHealth;
  billingTick: TickHealth;
  maintenanceTick: TickHealth;
  whatsappInstancesByStatus: Record<WhatsappInstanceStatus, number>;
  companiesBySubscriptionStatus: Record<SubscriptionStatus, number>;
  inboundEventsLast24h: number;
  alerts: string[];
};

const WHATSAPP_STATUSES: WhatsappInstanceStatus[] = ["QRCODE", "CONNECTED", "DISCONNECTED"];
const SUBSCRIPTION_STATUSES: SubscriptionStatus[] = ["TRIALING", "ACTIVE", "PAST_DUE", "SUSPENDED", "CANCELED"];

function tickHealthFrom(lastRunAt: Date | null, lastResult: unknown, now: Date, staleAfterMs: number): TickHealth {
  const stale = !lastRunAt || now.getTime() - lastRunAt.getTime() > staleAfterMs;
  return { lastRunAt: lastRunAt?.toISOString() ?? null, lastResult, stale };
}

export async function getPlatformHealth(now: Date = new Date()): Promise<PlatformHealth> {
  const prisma = getPrisma();

  const [integrations, settings, whatsappGroups, subscriptionGroups, inboundEventsLast24h] = await Promise.all([
    getIntegrationsHealth(),
    prisma.platformSettings.findUnique({
      where: { id: 1 },
      select: {
        mpEnvironment: true,
        lastMpWebhookAt: true,
        lastMpWebhookResult: true,
        lastMpWebhookRejectedAt: true,
        lastMpWebhookRejection: true,
        lastBillingTickAt: true, lastBillingTickResult: true, lastMaintenanceTickAt: true, lastMaintenanceTickResult: true },
    }),
    prisma.whatsappInstance.groupBy({ by: ["status"], where: { deletedAt: null }, _count: { _all: true } }),
    prisma.subscription.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.inboundEvent.count({ where: { createdAt: { gte: new Date(now.getTime() - 24 * 60 * 60 * 1000) } } }),
  ]);

  const whatsappInstancesByStatus = Object.fromEntries(WHATSAPP_STATUSES.map((s) => [s, 0])) as Record<WhatsappInstanceStatus, number>;
  for (const group of whatsappGroups) whatsappInstancesByStatus[group.status] = group._count._all;

  const companiesBySubscriptionStatus = Object.fromEntries(SUBSCRIPTION_STATUSES.map((s) => [s, 0])) as Record<SubscriptionStatus, number>;
  for (const group of subscriptionGroups) companiesBySubscriptionStatus[group.status] = group._count._all;

  const billingTick = tickHealthFrom(settings?.lastBillingTickAt ?? null, settings?.lastBillingTickResult ?? null, now, BILLING_TICK_STALE_MS);
  const maintenanceTick = tickHealthFrom(
    settings?.lastMaintenanceTickAt ?? null,
    settings?.lastMaintenanceTickResult ?? null,
    now,
    MAINTENANCE_TICK_STALE_MS,
  );

  const alerts: string[] = [];
  if (billingTick.stale) alerts.push("O billing/tick não roda há mais de 2h. As assinaturas podem parar de avançar e de cobrar no prazo.");
  if (maintenanceTick.stale) alerts.push("O maintenance/tick não roda há mais de 26h. A retenção e a anonimização da LGPD podem estar atrasadas.");
  if (!integrations.evolution.ok) alerts.push("Evolution API fora do ar ou mal configurada. Conectar números novos de WhatsApp pode falhar.");
  if (!integrations.mercadoPago.ok) alerts.push("Mercado Pago fora do ar ou mal configurado. Pix novos podem não ser gerados.");

  const jsonField = (value: unknown, key: string): string | null => {
    const v = value && typeof value === "object" ? (value as Record<string, unknown>)[key] : null;
    return typeof v === "string" ? v : null;
  };
  const mercadoPagoWebhook: MercadoPagoWebhookHealth = {
    lastReceivedAt: settings?.lastMpWebhookAt?.toISOString() ?? null,
    lastOutcome: jsonField(settings?.lastMpWebhookResult, "outcome"),
    lastRejectedAt: settings?.lastMpWebhookRejectedAt?.toISOString() ?? null,
    lastRejectionReason: jsonField(settings?.lastMpWebhookRejection, "reason"),
    activeEnvironment: settings?.mpEnvironment ?? "PRODUCTION",
  };

  if (mercadoPagoWebhook.lastOutcome === "rejected") {
    alerts.push("O último webhook do Mercado Pago foi rejeitado. Os pagamentos Pix podem não estar sendo baixados sozinhos. Veja o diagnóstico abaixo.");
  }

  return {
    integrations,
    mercadoPagoWebhook,
    billingTick,
    maintenanceTick,
    whatsappInstancesByStatus,
    companiesBySubscriptionStatus,
    inboundEventsLast24h,
    alerts,
  };
}
