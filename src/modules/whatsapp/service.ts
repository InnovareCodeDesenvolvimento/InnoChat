import crypto from "node:crypto";
import { getPrisma } from "@/lib/db/prisma";
import { forTenant } from "@/lib/db/tenant-client";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { tryGetPublicBaseUrl } from "@/lib/public-url";
import type { WhatsappInstanceStatus } from "@/lib/db/types";
import { buildInstanceName } from "@/core/whatsapp/instance-name";
import { mapEvolutionState, resolveNextConnectionStatus } from "@/core/whatsapp/connection-event";
import { normalizePhoneFromJid } from "@/core/whatsapp/phone";
import { assertCanAddWhatsappNumber } from "@/modules/billing/plan-limits";
import { applyConnectedNumber } from "./connection";
import { getEvolutionClient, type EvolutionClient } from "./evolution-client";

/**
 * Camada de serviço da conexão WhatsApp (docs/arquitetura.md §4, mission Fase 3). Reúne o que
 * toca banco/Evolution — `src/core/whatsapp/*` fica só com a normalização pura.
 */

export type WhatsappInstanceView = {
  id: string;
  label: string;
  instanceName: string;
  status: WhatsappInstanceStatus;
  phoneE164: string | null;
  sandbox: boolean;
  lastConnectedAt: string | null;
  createdAt: string;
};

type InstanceRow = {
  id: string;
  label: string;
  instanceName: string;
  status: WhatsappInstanceStatus;
  phoneE164: string | null;
  sandbox: boolean;
  lastConnectedAt: Date | null;
  createdAt: Date;
};

function toView(row: InstanceRow): WhatsappInstanceView {
  return {
    id: row.id,
    label: row.label,
    instanceName: row.instanceName,
    status: row.status,
    phoneE164: row.phoneE164,
    sandbox: row.sandbox,
    lastConnectedAt: row.lastConnectedAt ? row.lastConnectedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listWhatsappInstances(tenantId: string): Promise<WhatsappInstanceView[]> {
  const rows = await forTenant(tenantId).whatsappInstance.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toView);
}

async function findActiveInstanceOrThrow(tenantId: string, instanceId: string): Promise<InstanceRow> {
  const instance = await forTenant(tenantId).whatsappInstance.findFirst({ where: { id: instanceId, deletedAt: null } });
  if (!instance) {
    throw new DomainError("NOT_FOUND", "Número de WhatsApp não encontrado.");
  }
  return instance;
}

/** `<n8nWebhookBaseUrl>/<webhookToken>` (docs/arquitetura.md §4, §6.9). */
async function buildWebhookUrl(webhookToken: string): Promise<string> {
  const settings = await getPrisma().platformSettings.findUnique({
    where: { id: 1 },
    select: { n8nWebhookBaseUrl: true },
  });
  if (!settings?.n8nWebhookBaseUrl) {
    throw new DomainError("N8N_NOT_CONFIGURED", "Configure o n8n na área de administração antes de conectar um número.");
  }
  return `${settings.n8nWebhookBaseUrl.replace(/\/+$/, "")}/${webhookToken}`;
}

async function compensateEvolutionInstance(evolution: EvolutionClient, instanceName: string): Promise<void> {
  try {
    await evolution.deleteInstance(instanceName);
  } catch (cleanupError) {
    // Melhor esforço: registrado para o admin limpar manualmente se a Evolution também estiver
    // instável neste instante — nunca lançamos por cima do erro original (mission: "sem
    // instância órfã: compense ou marque para limpeza").
    logger.error("whatsapp.create.compensation_failed", {
      instanceName,
      error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    });
  }
}

/**
 * Cria uma instância nova (docs/arquitetura.md §4). Ordem deliberada:
 * 1. Limite do plano (`assertCanAddWhatsappNumber`) — falha ANTES de qualquer chamada externa.
 * 2. `n8nWebhookBaseUrl`/URL pública configuradas (mission item 5, §8) — nunca cria uma
 *    instância sem webhook por falta de configuração da plataforma.
 * 3. `POST /instance/create` na Evolution.
 * 4. `POST /webhook/set/{instance}` — se falhar, compensa (apaga a instância criada em 3) e
 *    relança; nada fica gravado localmente.
 * 5. Grava `WhatsappInstance` local — se falhar (infra), compensa a Evolution também: nunca
 *    deixa uma instância órfã lá enquanto o painel não sabe que ela existe.
 */
export async function createWhatsappInstance(params: {
  tenantId: string;
  tenantSlug: string;
  label: string;
  evolution?: EvolutionClient;
}): Promise<WhatsappInstanceView> {
  const { tenantId, tenantSlug, label } = params;

  await assertCanAddWhatsappNumber(tenantId);

  const publicBaseUrl = await tryGetPublicBaseUrl();
  if (!publicBaseUrl) {
    throw new DomainError("N8N_NOT_CONFIGURED", "Configure o n8n na área de administração antes de conectar um número.");
  }

  const webhookToken = crypto.randomBytes(32).toString("base64url");
  const webhookUrl = await buildWebhookUrl(webhookToken);

  const instanceName = buildInstanceName(tenantSlug, crypto.randomBytes(4).toString("hex"));
  const evolution = params.evolution ?? (await getEvolutionClient());

  await evolution.createInstance(instanceName);

  try {
    await evolution.setWebhook(instanceName, webhookUrl);
  } catch (error) {
    await compensateEvolutionInstance(evolution, instanceName);
    throw error;
  }

  try {
    const created = await forTenant(tenantId).whatsappInstance.create({
      data: { tenantId, instanceName, label, webhookToken, status: "QRCODE" },
    });
    return toView(created);
  } catch (error) {
    await compensateEvolutionInstance(evolution, instanceName);
    throw error;
  }
}

export type ConnectionSyncResult = {
  status: WhatsappInstanceStatus;
  phoneE164: string | null;
  blockedReason: "TRIAL_PHONE_ALREADY_USED" | null;
};

/**
 * Consulta o estado atual na Evolution e reconcilia com o banco — compartilhado por
 * `getQrCode`/`refreshConnectionStatus` (evita duplicar a lógica de TrialClaim em dois
 * caminhos).
 */
async function syncConnectionState(instance: InstanceRow, tenantId: string, evolution: EvolutionClient): Promise<ConnectionSyncResult> {
  const rawState = await evolution.connectionState(instance.instanceName);
  const mapped = mapEvolutionState(rawState);

  if (mapped === "CONNECTED") {
    const ownerJid = await evolution.fetchOwnerJid(instance.instanceName);
    const phoneE164 = normalizePhoneFromJid(ownerJid);
    if (phoneE164) {
      const result = await applyConnectedNumber({
        tenantId,
        instanceId: instance.id,
        instanceName: instance.instanceName,
        phoneE164,
        evolution,
      });
      if (result.blocked) {
        return { status: "DISCONNECTED", phoneE164: null, blockedReason: result.reason };
      }
      return { status: "CONNECTED", phoneE164, blockedReason: null };
    }
    // A Evolution diz "open" mas ainda não devolveu o dono (corrida rara logo após conectar) —
    // trata como QRCODE por enquanto; o próximo poll (~3s) resolve.
    return { status: instance.status === "CONNECTED" ? "CONNECTED" : "QRCODE", phoneE164: instance.phoneE164, blockedReason: null };
  }

  const nextStatus = resolveNextConnectionStatus(instance.status, mapped ?? instance.status);
  if (nextStatus !== instance.status) {
    await forTenant(tenantId).whatsappInstance.update({
      where: { id: instance.id },
      data: {
        status: nextStatus,
        // Queda inesperada (estava CONNECTED): alimenta a notificação WHATSAPP_DISCONNECTED.
        ...(nextStatus === "DISCONNECTED" && instance.status === "CONNECTED" ? { disconnectedAt: new Date() } : {}),
      },
    });
  }
  return { status: nextStatus, phoneE164: instance.phoneE164, blockedReason: null };
}

export type QrCodeView = {
  status: WhatsappInstanceStatus;
  qrCodeDataUrl: string | null;
  pairingCode: string | null;
  phoneE164: string | null;
  blockedReason: "TRIAL_PHONE_ALREADY_USED" | null;
};

/**
 * `getQrCodeAction` (mission): o QR expira e o cliente consulta a cada ~3s (docs/arquitetura.md
 * §4) — por isso NUNCA cacheamos o QR localmente, sempre buscamos o estado e (se ainda não
 * conectado) um QR fresco na Evolution a cada chamada.
 */
export async function getQrCode(tenantId: string, instanceId: string, deps?: { evolution?: EvolutionClient }): Promise<QrCodeView> {
  const instance = await findActiveInstanceOrThrow(tenantId, instanceId);

  if (instance.status === "CONNECTED") {
    return { status: "CONNECTED", qrCodeDataUrl: null, pairingCode: null, phoneE164: instance.phoneE164, blockedReason: null };
  }

  const evolution = deps?.evolution ?? (await getEvolutionClient());
  const sync = await syncConnectionState(instance, tenantId, evolution);

  if (sync.status === "CONNECTED" || sync.blockedReason) {
    return { status: sync.status, qrCodeDataUrl: null, pairingCode: null, phoneE164: sync.phoneE164, blockedReason: sync.blockedReason };
  }

  const { qrCodeDataUrl, pairingCode } = await evolution.connect(instance.instanceName);
  return { status: sync.status, qrCodeDataUrl, pairingCode, phoneE164: null, blockedReason: null };
}

export type ConnectionStatusView = {
  status: WhatsappInstanceStatus;
  phoneE164: string | null;
  blockedReason: "TRIAL_PHONE_ALREADY_USED" | null;
};

/** `refreshConnectionStatusAction` — reconcilia sem buscar um QR novo (mais barato que `getQrCode`). */
export async function refreshConnectionStatus(
  tenantId: string,
  instanceId: string,
  deps?: { evolution?: EvolutionClient },
): Promise<ConnectionStatusView> {
  const instance = await findActiveInstanceOrThrow(tenantId, instanceId);

  if (instance.status === "CONNECTED") {
    return { status: "CONNECTED", phoneE164: instance.phoneE164, blockedReason: null };
  }

  const evolution = deps?.evolution ?? (await getEvolutionClient());
  const sync = await syncConnectionState(instance, tenantId, evolution);
  return { status: sync.status, phoneE164: sync.phoneE164, blockedReason: sync.blockedReason };
}

/** `disconnectWhatsappAction` — logout na Evolution (§4 passo 4). Falha remota não impede a atualização local (o usuário pediu para desconectar). */
export async function disconnectWhatsapp(
  tenantId: string,
  instanceId: string,
  deps?: { evolution?: EvolutionClient },
): Promise<WhatsappInstanceView> {
  const instance = await findActiveInstanceOrThrow(tenantId, instanceId);
  const evolution = deps?.evolution ?? (await getEvolutionClient());

  try {
    await evolution.logout(instance.instanceName);
  } catch (error) {
    logger.warn("whatsapp.disconnect.evolution_failed", {
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const updated = await forTenant(tenantId).whatsappInstance.update({
    where: { id: instance.id },
    data: { status: "DISCONNECTED", phoneE164: null, disconnectedAt: null },
  });
  return toView(updated);
}

/**
 * Desconecta TODOS os números da empresa (cancelamento da assinatura — Termos §9: "os números de
 * WhatsApp são desconectados"). Idempotente: só toca o que ainda não está `DISCONNECTED`. Falha na
 * Evolution (fora do ar, não configurada) nunca impede a baixa local — o bot já é barrado pelo
 * status CANCELED; ao reativar, o dono lê o QR de novo. `disconnectedAt` fica nulo de propósito: é
 * desconexão deliberada, não queda (não gera alerta de "WhatsApp caiu"). Devolve quantos números tocou.
 */
export async function disconnectAllWhatsappInstances(tenantId: string, deps?: { evolution?: EvolutionClient }): Promise<number> {
  const scoped = forTenant(tenantId);
  const instances = await scoped.whatsappInstance.findMany({ where: { deletedAt: null, status: { not: "DISCONNECTED" } } });
  if (instances.length === 0) return 0;

  let evolution: EvolutionClient | null = deps?.evolution ?? null;
  if (!evolution) {
    try {
      evolution = await getEvolutionClient();
    } catch (error) {
      logger.warn("whatsapp.disconnect_all.evolution_unavailable", { tenantId, error: error instanceof Error ? error.message : String(error) });
    }
  }

  for (const instance of instances) {
    if (evolution) {
      try {
        await evolution.logout(instance.instanceName);
      } catch (error) {
        logger.warn("whatsapp.disconnect_all.evolution_failed", {
          instanceId: instance.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await scoped.whatsappInstance.update({
      where: { id: instance.id },
      data: { status: "DISCONNECTED", phoneE164: null, disconnectedAt: null },
    });
  }
  return instances.length;
}

/** `removeWhatsappInstanceAction` — delete na Evolution + soft delete local (mesma cautela de `deleteService`/`deleteProfessional`: nunca perde o histórico ligado à instância). */
export async function removeWhatsappInstance(
  tenantId: string,
  instanceId: string,
  deps?: { evolution?: EvolutionClient },
): Promise<{ id: string }> {
  const instance = await findActiveInstanceOrThrow(tenantId, instanceId);
  const evolution = deps?.evolution ?? (await getEvolutionClient());

  try {
    await evolution.deleteInstance(instance.instanceName);
  } catch (error) {
    logger.warn("whatsapp.remove.evolution_failed", {
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  await forTenant(tenantId).whatsappInstance.update({
    where: { id: instance.id },
    data: { deletedAt: new Date(), status: "DISCONNECTED", phoneE164: null, disconnectedAt: null },
  });
  return { id: instance.id };
}

export async function setSandbox(tenantId: string, instanceId: string, sandbox: boolean): Promise<WhatsappInstanceView> {
  const instance = await findActiveInstanceOrThrow(tenantId, instanceId);
  const updated = await forTenant(tenantId).whatsappInstance.update({ where: { id: instance.id }, data: { sandbox } });
  return toView(updated);
}
