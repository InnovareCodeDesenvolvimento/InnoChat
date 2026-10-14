import { randomBytes } from "node:crypto";
import { getPrisma } from "@/lib/db/prisma";
import { isUniqueViolation } from "@/lib/db/prisma-errors";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { tryGetPublicBaseUrl } from "@/lib/public-url";
import { mapEvolutionState } from "@/core/whatsapp/connection-event";
import { normalizePhoneFromJid } from "@/core/whatsapp/phone";
import {
  buildPlatformInstanceName,
  deadTokenHash,
  digitsOnly,
  formatPhoneDisplay,
  generateWebhookToken,
  hashWebhookToken,
  isQrAbandoned,
  LABEL_MAX,
  maskPhone,
  phoneDigitVariants,
  PLATFORM_AUTOREPLY_PROVIDER,
  PLATFORM_REPLY_PROVIDER,
  PLATFORM_REPLY_RETENTION_DAYS,
  QR_ABANDON_MS,
  roundCapFor,
  WARMUP_MS,
} from "@/core/platform-whatsapp/rules";
import { getEvolutionClient, type EvolutionClient } from "@/modules/whatsapp/evolution-client";
import { getPlatformWhatsappDiagnostics, patchDiagnostics, type PlatformWhatsappDiagnostics } from "./diagnostics";
import { invalidatePlatformSenderCache } from "./sender-guard";

/**
 * Ciclo de vida das conexões do WhatsApp da plataforma (docs/regua-de-cobranca.md §2.4).
 *
 * Papéis: PENDING (QR aberto, no máximo 1) -> ACTIVE (quem envia, no máximo 1) -> RETIRED. Os dois
 * limites são garantidos NO BANCO por índices únicos parciais (migration da F1): a troca de número é UMA
 * transação (`promotePending`) que aposenta a antiga e ativa a nova, então não existe instante sem canal
 * nem com dois ativos. O logout/exclusão da instância antiga acontece DEPOIS, fora da transação, e
 * a tentativa pendente fica registrada em `ProviderEvent` (provider `platform-whatsapp-cleanup`) para o
 * tick repetir (`runPlatformWhatsappMaintenance`).
 *
 * Nunca é uma `WhatsappInstance` de empresa: o `syncN8n` só enxerga essa tabela, então nunca reaponta
 * o webhook destas instâncias para o bot.
 */

export const CLEANUP_PROVIDER = "platform-whatsapp-cleanup";
export const ENABLED_MARKER_PROVIDER = "platform-whatsapp-enabled";
const CLEANUP_BATCH = 20;
/** A manutenção roda ANTES da régua no mesmo pedido do tick: não pode comer o tempo dela se a Evolution travar. */
const MAINTENANCE_BUDGET_MS = 90_000;
const STATE_CHECK_TIMEOUT_MS = 15_000;
const PURGE_BATCH = 500;
const PURGE_MAX_BATCHES = 10;
const HISTORY_LIMIT = 20;

export type PlatformWhatsappPurpose = "BILLING" | "RESCUE";

export type PlatformWhatsappDeps = { evolution?: EvolutionClient; now?: Date; /** Orçamento de tempo da manutenção (padrão 90 s). */ budgetMs?: number };

export type PlatformWhatsappState = {
  enabled: boolean;
  active: {
    id: string;
    label: string;
    status: "CONNECTED" | "DISCONNECTED";
    phoneDisplay: string | null;
    activatedAt: string;
    disconnectedAt: string | null;
    /** Nos 3 primeiros dias o teto de envios por rodada é menor (anti-bloqueio). */
    inWarmup: boolean;
    roundCap: number;
    /** O que chegou e o que foi respondido (card do Admin). */
    diagnostics: PlatformWhatsappDiagnostics;
  } | null;
  pending: { id: string; label: string; status: "QRCODE" | "CONNECTED"; createdAt: string } | null;
  history: Array<{
    id: string;
    label: string;
    phoneDisplay: string | null;
    activatedAt: string | null;
    retiredAt: string;
    retiredReason: string;
    noticesSent: number;
  }>;
};

export type PlatformQrView = {
  /** QR (data URL pronta para `<img src>`), ou `null` quando não há QR (conectado ou ainda gerando). */
  status: "QRCODE" | "CONNECTED" | "DISCONNECTED";
  qrBase64: string | null;
  phoneDisplay: string | null;
  role: "PENDING" | "ACTIVE";
};

async function resolveEvolution(deps?: PlatformWhatsappDeps): Promise<EvolutionClient> {
  return deps?.evolution ?? (await getEvolutionClient());
}

function normalizeLabel(raw: unknown): string {
  const label = typeof raw === "string" ? raw.trim() : "";
  if (!label || label.length > LABEL_MAX) {
    throw new DomainError("INVALID_PAYLOAD", `Dê um nome de 1 a ${LABEL_MAX} letras para o número (exemplo: Cobrança).`);
  }
  return label;
}

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------------------------

export async function getPlatformWhatsappState(
  purpose: PlatformWhatsappPurpose = "BILLING",
  deps?: PlatformWhatsappDeps,
): Promise<PlatformWhatsappState> {
  const now = deps?.now ?? new Date();
  await expireAbandonedPending(now);
  const prisma = getPrisma();
  const isRescue = purpose === "RESCUE";
  const [settings, active, pending, retired] = await Promise.all([
    prisma.platformSettings.findUnique({
      where: { id: 1 },
      select: isRescue ? { rescueWhatsappEnabled: true } : { platformWhatsappEnabled: true },
    }),
    prisma.platformWhatsappConnection.findFirst({ where: { role: "ACTIVE", purpose } }),
    prisma.platformWhatsappConnection.findFirst({ where: { role: "PENDING", purpose } }),
    prisma.platformWhatsappConnection.findMany({
      where: { role: "RETIRED", purpose, activatedAt: { not: null } },
      orderBy: { retiredAt: "desc" },
      take: HISTORY_LIMIT,
      include: {
        _count: isRescue
          ? { select: { rescueLeads: { where: { status: { in: ["MESSAGE_1_SENT", "MESSAGE_2_SENT", "RESPONDED", "CONVERTED"] } } } } }
          : { select: { notices: { where: { status: "SENT" } } } },
      },
    }),
  ]);

  const diagnostics = active ? await getPlatformWhatsappDiagnostics(active.id) : null;
  const enabled = isRescue
    ? ((settings as { rescueWhatsappEnabled?: boolean } | null)?.rescueWhatsappEnabled ?? false)
    : ((settings as { platformWhatsappEnabled?: boolean } | null)?.platformWhatsappEnabled ?? false);

  return {
    enabled,
    active: active && diagnostics
      ? {
          id: active.id,
          label: active.label,
          status: active.status === "CONNECTED" ? "CONNECTED" : "DISCONNECTED",
          phoneDisplay: formatPhoneDisplay(active.phoneE164),
          activatedAt: (active.activatedAt ?? active.createdAt).toISOString(),
          disconnectedAt: active.disconnectedAt?.toISOString() ?? null,
          inWarmup: active.activatedAt ? now.getTime() - active.activatedAt.getTime() < WARMUP_MS : false,
          roundCap: roundCapFor(active.activatedAt, now),
          diagnostics,
        }
      : null,
    pending: pending
      ? { id: pending.id, label: pending.label, status: pending.status === "CONNECTED" ? "CONNECTED" : "QRCODE", createdAt: pending.createdAt.toISOString() }
      : null,
    history: retired.map((row) => ({
      id: row.id,
      label: row.label,
      phoneDisplay: maskPhone(row.phoneE164),
      activatedAt: row.activatedAt?.toISOString() ?? null,
      retiredAt: (row.retiredAt ?? row.updatedAt).toISOString(),
      retiredReason: row.retiredReason ?? "REPLACED",
      noticesSent: isRescue
        ? ((row._count as { rescueLeads?: number }).rescueLeads ?? 0)
        : ((row._count as { notices?: number }).notices ?? 0),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Chave geral
// ---------------------------------------------------------------------------------------------

export async function setPlatformWhatsappEnabled(enabled: boolean, adminId: string): Promise<{ enabled: boolean }> {
  const prisma = getPrisma();
  const before = await prisma.platformSettings.findUnique({ where: { id: 1 }, select: { platformWhatsappEnabled: true } });
  await prisma.platformSettings.upsert({
    where: { id: 1 },
    create: { id: 1, platformWhatsappEnabled: enabled, updatedByUserId: adminId },
    update: { platformWhatsappEnabled: enabled, updatedByUserId: adminId },
  });
  if (enabled && !before?.platformWhatsappEnabled) {
    // Instante estável do "ligou": é a data do alerta PLATFORM_WHATSAPP_MISSING enquanto não há número.
    await prisma.providerEvent.create({
      data: { provider: ENABLED_MARKER_PROVIDER, providerEventId: `${Date.now()}-${randomBytes(3).toString("hex")}`, payload: { adminId }, processedAt: new Date() },
    });
  }
  logger.info("platform_whatsapp.enabled_changed", { adminId, enabled });
  return { enabled };
}

// ---------------------------------------------------------------------------------------------
// Conectar / trocar
// ---------------------------------------------------------------------------------------------

async function publicWebhookUrl(token: string): Promise<string> {
  const base = await tryGetPublicBaseUrl();
  if (!base) {
    throw new DomainError("PUBLIC_URL_NOT_CONFIGURED", "Salve as configurações da plataforma uma vez para definir o endereço público do painel e tente de novo.");
  }
  return `${base.replace(/\/+$/, "")}/api/webhooks/platform-whatsapp/${token}`;
}

/** Cria a conexão PENDING e a instância na Evolution (com webhook próprio). Serve para conectar o 1º número e para trocar. */
export async function startPlatformConnection(
  input: { label: unknown; adminId: string; purpose?: PlatformWhatsappPurpose },
  deps?: PlatformWhatsappDeps,
): Promise<{ connectionId: string }> {
  const label = normalizeLabel(input.label);
  const purpose: PlatformWhatsappPurpose = input.purpose ?? "BILLING";
  const now = deps?.now ?? new Date();
  await expireAbandonedPending(now);
  const prisma = getPrisma();

  if (await prisma.platformWhatsappConnection.findFirst({ where: { role: "PENDING", purpose }, select: { id: true } })) {
    throw new DomainError("INVALID_STATE", "Já existe um QR aberto. Termine a conexão ou cancele a troca antes de começar outra.");
  }

  const evolution = await resolveEvolution(deps);
  const token = generateWebhookToken();
  const webhookUrl = await publicWebhookUrl(token);
  const instanceName = buildPlatformInstanceName(randomBytes(4).toString("hex"));

  let connectionId: string;
  try {
    const created = await prisma.platformWhatsappConnection.create({
      data: { instanceName, webhookTokenHash: hashWebhookToken(token), label, status: "QRCODE", role: "PENDING", purpose, createdByUserId: input.adminId },
      select: { id: true },
    });
    connectionId = created.id;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new DomainError("INVALID_STATE", "Já existe um QR aberto. Termine a conexão ou cancele a troca antes de começar outra.");
    }
    throw error;
  }

  try {
    await evolution.createInstance(instanceName);
    await evolution.setWebhook(instanceName, webhookUrl);
  } catch (error) {
    logger.error("platform_whatsapp.start_failed", { connectionId, errorMessage: errMsg(error) });
    await prisma.platformWhatsappConnection.delete({ where: { id: connectionId } }).catch(() => undefined);
    await bestEffortDeleteInstance(evolution, instanceName);
    throw new DomainError("EVOLUTION_UNAVAILABLE", "Não deu para falar com a Evolution agora. Confira a conexão em Configurações e tente de novo.");
  }

  logger.info("platform_whatsapp.start", { connectionId, adminId: input.adminId });
  return { connectionId };
}

async function bestEffortDeleteInstance(evolution: EvolutionClient, instanceName: string): Promise<void> {
  try {
    await evolution.deleteInstance(instanceName);
  } catch (error) {
    logger.warn("platform_whatsapp.delete_instance_failed", { instanceName, errorMessage: errMsg(error) });
  }
}

// ---------------------------------------------------------------------------------------------
// Limpeza da instância aposentada (fora da transação, com nova tentativa)
// ---------------------------------------------------------------------------------------------

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: number }).status === 404;
}

/** Logout + exclusão. 404 conta como feito (a instância já não existe). Devolve `true` se terminou. */
async function logoutAndDelete(evolution: EvolutionClient, instanceName: string): Promise<boolean> {
  let ok = true;
  for (const step of [() => evolution.logout(instanceName), () => evolution.deleteInstance(instanceName)]) {
    try {
      await step();
    } catch (error) {
      if (!isNotFound(error)) {
        ok = false;
        logger.warn("platform_whatsapp.cleanup_step_failed", { instanceName, errorMessage: errMsg(error) });
      }
    }
  }
  return ok;
}

async function runCleanupFor(markerId: string, instanceName: string, deps?: PlatformWhatsappDeps): Promise<boolean> {
  let evolution: EvolutionClient;
  try {
    evolution = await resolveEvolution(deps);
  } catch (error) {
    logger.warn("platform_whatsapp.cleanup_evolution_unavailable", { instanceName, errorMessage: errMsg(error) });
    return false;
  }
  const done = await logoutAndDelete(evolution, instanceName);
  if (done) {
    await getPrisma().providerEvent.update({ where: { id: markerId }, data: { processedAt: new Date() } }).catch(() => undefined);
  }
  return done;
}

/** Marcador de limpeza pendente: criado DENTRO da transação que aposenta/apaga a conexão. */
type TxLike = Pick<ReturnType<typeof getPrisma>, "providerEvent">;
async function createCleanupMarker(tx: TxLike, connectionId: string, instanceName: string): Promise<string> {
  const marker = await tx.providerEvent.create({
    data: { provider: CLEANUP_PROVIDER, providerEventId: `${connectionId}:${randomBytes(3).toString("hex")}`, payload: { connectionId, instanceName } },
    select: { id: true },
  });
  return marker.id;
}

// ---------------------------------------------------------------------------------------------
// QR abandonado
// ---------------------------------------------------------------------------------------------

/** QR aberto há mais de 30 min sem conectar vira `RETIRED/ABANDONED_QR`; a instância sai pela limpeza. */
export async function expireAbandonedPending(now: Date, deps?: PlatformWhatsappDeps): Promise<number> {
  const prisma = getPrisma();
  const stale = await prisma.platformWhatsappConnection.findMany({
    where: { role: "PENDING", createdAt: { lt: new Date(now.getTime() - QR_ABANDON_MS) } },
    select: { id: true, instanceName: true },
  });
  let expired = 0;
  for (const row of stale) {
    const marker = await prisma.$transaction(async (tx) => {
      const res = await tx.platformWhatsappConnection.updateMany({
        where: { id: row.id, role: "PENDING" },
        data: { role: "RETIRED", retiredAt: now, retiredReason: "ABANDONED_QR" },
      });
      if (res.count === 0) return null;
      return createCleanupMarker(tx, row.id, row.instanceName);
    });
    if (!marker) continue;
    expired += 1;
    if (deps?.evolution) await runCleanupFor(marker, row.instanceName, deps);
  }
  return expired;
}

// ---------------------------------------------------------------------------------------------
// Cancelar troca / desconectar
// ---------------------------------------------------------------------------------------------

export async function cancelPlatformConnection(connectionId: string, adminId: string, deps?: PlatformWhatsappDeps): Promise<{ canceled: boolean }> {
  const prisma = getPrisma();
  const row = await prisma.platformWhatsappConnection.findUnique({ where: { id: connectionId } });
  if (!row) throw new DomainError("NOT_FOUND", "Conexão não encontrada.");
  if (row.role !== "PENDING") throw new DomainError("INVALID_STATE", "Só dá para cancelar uma conexão que ainda está esperando o QR.");

  const markerId = await prisma.$transaction(async (tx) => {
    const res = await tx.platformWhatsappConnection.deleteMany({ where: { id: connectionId, role: "PENDING" } });
    return res.count === 0 ? null : createCleanupMarker(tx, connectionId, row.instanceName);
  });
  if (!markerId) throw new DomainError("INVALID_STATE", "Essa conexão já não está esperando o QR.");

  await runCleanupFor(markerId, row.instanceName, deps);
  logger.info("platform_whatsapp.cancel", { connectionId, adminId });
  return { canceled: true };
}

export async function disconnectPlatformWhatsapp(
  adminId: string,
  purpose: PlatformWhatsappPurpose = "BILLING",
  deps?: PlatformWhatsappDeps,
): Promise<{ retired: boolean }> {
  const now = deps?.now ?? new Date();
  const prisma = getPrisma();
  const result = await prisma.$transaction(async (tx) => {
    const active = await tx.platformWhatsappConnection.findFirst({ where: { role: "ACTIVE", purpose } });
    if (!active) return null;
    const res = await tx.platformWhatsappConnection.updateMany({
      where: { id: active.id, role: "ACTIVE", purpose },
      data: { role: "RETIRED", retiredAt: now, retiredReason: "DISCONNECTED_BY_ADMIN" },
    });
    if (res.count === 0) return null;
    return { id: active.id, instanceName: active.instanceName, markerId: await createCleanupMarker(tx, active.id, active.instanceName) };
  });
  if (!result) {
    const purposeLabel = purpose === "RESCUE" ? "resgate" : "cobrança";
    throw new DomainError("INVALID_STATE", `Não há número de ${purposeLabel} conectado.`);
  }

  invalidatePlatformSenderCache();
  await runCleanupFor(result.markerId, result.instanceName, deps);
  logger.info("platform_whatsapp.disconnect", { connectionId: result.id, adminId, purpose });
  return { retired: true };
}

// ---------------------------------------------------------------------------------------------
// QR + estado (polling de 3 s) e promoção
// ---------------------------------------------------------------------------------------------

type ConnectionRow = NonNullable<Awaited<ReturnType<ReturnType<typeof getPrisma>["platformWhatsappConnection"]["findUnique"]>>>;

/** O número conectado não pode ser o comercial do site nem o de um bot de empresa (loop e regra do dono). */
async function assertPhoneAllowed(phone: string): Promise<void> {
  const prisma = getPrisma();
  const variants = phoneDigitVariants(phone);
  const settings = await prisma.platformSettings.findUnique({ where: { id: 1 }, select: { salesWhatsappE164: true } });
  if (settings?.salesWhatsappE164 && phoneDigitVariants(settings.salesWhatsappE164).some((v) => variants.includes(v))) {
    throw new DomainError("PHONE_IS_SALES_NUMBER", "Esse é o WhatsApp comercial do site. O número de cobrança precisa ser outro, só para os avisos.");
  }
  const forms = variants.flatMap((v) => [v, `+${v}`]);
  const tenantBot = await prisma.whatsappInstance.findFirst({ where: { deletedAt: null, phoneE164: { in: forms } }, select: { id: true } });
  if (tenantBot) {
    throw new DomainError("PHONE_IN_USE_BY_TENANT", "Esse número já é o WhatsApp do bot de uma empresa. Use um chip só para os avisos de cobrança.");
  }
}

type PromoteResult = { promoted: boolean; retiredInstance: { markerId: string; instanceName: string } | null };

/**
 * A troca (ou a 1ª conexão): UMA transação aposenta a ACTIVE antiga e ativa a PENDING. Idempotente e
 * segura contra webhook + polling chegando juntos: o `updateMany ... role: PENDING` faz uma das duas
 * perder a corrida sem efeito.
 */
async function promotePending(pending: ConnectionRow, phone: string, now: Date): Promise<PromoteResult> {
  const prisma = getPrisma();
  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.platformWhatsappConnection.updateMany({
      where: { id: pending.id, role: "PENDING" },
      data: { status: "CONNECTED", phoneE164: phone, connectedAt: now },
    });
    if (claimed.count === 0) return { promoted: false, retiredInstance: null } as PromoteResult;

    const old = await tx.platformWhatsappConnection.findFirst({
      where: { role: "ACTIVE", purpose: pending.purpose, id: { not: pending.id } },
    });
    let retiredInstance: PromoteResult["retiredInstance"] = null;
    if (old) {
      await tx.platformWhatsappConnection.update({ where: { id: old.id }, data: { role: "RETIRED", retiredAt: now, retiredReason: "REPLACED" } });
      retiredInstance = { markerId: await createCleanupMarker(tx, old.id, old.instanceName), instanceName: old.instanceName };
    }
    await tx.platformWhatsappConnection.update({ where: { id: pending.id }, data: { role: "ACTIVE", activatedAt: now, disconnectedAt: null } });
    return { promoted: true, retiredInstance };
  });
  invalidatePlatformSenderCache();
  return result;
}

/**
 * Reconexão da ACTIVE lida por OUTRO celular: a instância na Evolution é a mesma (agora do chip novo),
 * então a linha antiga vira histórico cedendo o nome da instância e o token do webhook para a linha nova.
 * Sem logout (derrubaria justamente a sessão nova).
 */
async function replaceSameInstance(old: ConnectionRow, phone: string, now: Date): Promise<void> {
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    const res = await tx.platformWhatsappConnection.updateMany({
      where: { id: old.id, role: "ACTIVE" },
      data: {
        role: "RETIRED",
        retiredAt: now,
        retiredReason: "REPLACED",
        instanceName: `${old.instanceName}-r${now.getTime()}`,
        webhookTokenHash: deadTokenHash(old.id),
      },
    });
    if (res.count === 0) return;
    await tx.platformWhatsappConnection.create({
      data: {
        instanceName: old.instanceName,
        webhookTokenHash: old.webhookTokenHash,
        label: old.label,
        status: "CONNECTED",
        role: "ACTIVE",
        purpose: old.purpose,
        phoneE164: phone,
        connectedAt: now,
        activatedAt: now,
        createdByUserId: old.createdByUserId,
      },
    });
  });
  invalidatePlatformSenderCache();
}

/** A Evolution disse "conectado" para esta conexão: ativa (PENDING) ou confere o número (ACTIVE). */
export async function applyOpenConnection(row: ConnectionRow, ownerJid: string | null, deps?: PlatformWhatsappDeps): Promise<void> {
  const now = deps?.now ?? new Date();
  const normalized = normalizePhoneFromJid(ownerJid);
  const phone = normalized ? digitsOnly(normalized) : null;
  if (!phone) return; // ainda sem o dono: o próximo poll resolve

  const prisma = getPrisma();
  if (row.role === "PENDING") {
    try {
      await assertPhoneAllowed(phone);
    } catch (error) {
      if (error instanceof DomainError) {
        // Número proibido: descarta a conexão (como QR abandonado) para o admin tentar com outro.
        const marker = await prisma.$transaction(async (tx) => {
          const res = await tx.platformWhatsappConnection.updateMany({
            where: { id: row.id, role: "PENDING" },
            data: { role: "RETIRED", retiredAt: now, retiredReason: "ABANDONED_QR" },
          });
          return res.count === 0 ? null : createCleanupMarker(tx, row.id, row.instanceName);
        });
        if (marker) await runCleanupFor(marker, row.instanceName, deps);
      }
      throw error;
    }
    const promoted = await promotePending(row, phone, now);
    if (promoted.promoted) logger.info("platform_whatsapp.activated", { connectionId: row.id, replaced: promoted.retiredInstance !== null });
    if (promoted.retiredInstance) await runCleanupFor(promoted.retiredInstance.markerId, promoted.retiredInstance.instanceName, deps);
    return;
  }

  if (row.role !== "ACTIVE") return;
  if (row.phoneE164 && phoneDigitVariants(row.phoneE164).includes(phone)) {
    if (row.status !== "CONNECTED" || row.disconnectedAt) {
      await prisma.platformWhatsappConnection.updateMany({
        where: { id: row.id, role: "ACTIVE" },
        data: { status: "CONNECTED", disconnectedAt: null, connectedAt: now },
      });
      logger.info("platform_whatsapp.reconnected", { connectionId: row.id });
    }
    return;
  }
  await assertPhoneAllowed(phone);
  await replaceSameInstance(row, phone, now);
  logger.info("platform_whatsapp.replaced_on_reconnect", { connectionId: row.id });
}

/** Queda inesperada (webhook ou conferência do tick): só a ACTIVE que estava CONNECTED regride. */
export async function markActiveDisconnected(connectionId: string, now: Date = new Date()): Promise<boolean> {
  const res = await getPrisma().platformWhatsappConnection.updateMany({
    where: { id: connectionId, role: "ACTIVE", status: "CONNECTED" },
    data: { status: "DISCONNECTED", disconnectedAt: now },
  });
  if (res.count > 0) logger.warn("platform_whatsapp.dropped", { connectionId });
  return res.count > 0;
}

/** `GET` de 3 em 3 s da tela: confere o estado na Evolution, promove quando conectou e devolve o QR vigente. */
export async function getPlatformQr(connectionId: string, deps?: PlatformWhatsappDeps): Promise<PlatformQrView> {
  const now = deps?.now ?? new Date();
  const prisma = getPrisma();
  let row = await prisma.platformWhatsappConnection.findUnique({ where: { id: connectionId } });
  if (!row) throw new DomainError("NOT_FOUND", "Conexão não encontrada.");
  if (row.role === "RETIRED") throw new DomainError("INVALID_STATE", "Essa conexão foi encerrada. Comece de novo para gerar outro QR.");
  if (row.role === "PENDING" && isQrAbandoned(row.createdAt, now)) {
    await expireAbandonedPending(now, deps);
    throw new DomainError("INVALID_STATE", "O QR ficou aberto por mais de 30 minutos e foi encerrado. Comece de novo para gerar outro.");
  }

  const evolution = await resolveEvolution(deps);
  let rawState: string;
  try {
    rawState = await evolution.connectionState(row.instanceName);
  } catch (error) {
    logger.warn("platform_whatsapp.state_failed", { connectionId, errorMessage: errMsg(error) });
    throw new DomainError("EVOLUTION_UNAVAILABLE", "Não deu para falar com a Evolution agora. Tente de novo em instantes.");
  }
  const mapped = mapEvolutionState(rawState);

  if (mapped === "CONNECTED") {
    let ownerJid: string | null = null;
    try {
      ownerJid = await evolution.fetchOwnerJid(row.instanceName);
    } catch {
      // próximo poll
    }
    await applyOpenConnection(row, ownerJid, deps);
    row = (await prisma.platformWhatsappConnection.findFirst({ where: { OR: [{ id: connectionId }, { instanceName: row.instanceName, role: "ACTIVE" }] }, orderBy: { createdAt: "desc" } })) ?? row;
    if (row.status === "CONNECTED") {
      return { status: "CONNECTED", qrBase64: null, phoneDisplay: formatPhoneDisplay(row.phoneE164), role: row.role === "PENDING" ? "PENDING" : "ACTIVE" };
    }
    return { status: "QRCODE", qrBase64: null, phoneDisplay: null, role: row.role === "PENDING" ? "PENDING" : "ACTIVE" };
  }

  if (row.role === "ACTIVE") {
    if (mapped === "DISCONNECTED") await markActiveDisconnected(row.id, now);
    if (row.status === "CONNECTED" && mapped !== "DISCONNECTED") {
      return { status: "CONNECTED", qrBase64: null, phoneDisplay: formatPhoneDisplay(row.phoneE164), role: "ACTIVE" };
    }
  }

  let qr: string | null = null;
  try {
    qr = (await evolution.connect(row.instanceName)).qrCodeDataUrl;
  } catch (error) {
    logger.warn("platform_whatsapp.qr_failed", { connectionId, errorMessage: errMsg(error) });
  }
  return { status: row.role === "ACTIVE" ? "DISCONNECTED" : "QRCODE", qrBase64: qr, phoneDisplay: null, role: row.role === "PENDING" ? "PENDING" : "ACTIVE" };
}

// ---------------------------------------------------------------------------------------------
// Manutenção (chamada pelo tick da cobrança)
// ---------------------------------------------------------------------------------------------

export type PlatformWhatsappMaintenanceSummary = {
  abandonedQr: number;
  cleanupsDone: number;
  cleanupsPending: number;
  stateChecked: boolean;
  stateChanged: boolean;
  /** Resultado da conferência do webhook na Evolution (`null` = não conferiu). */
  webhook: WebhookCheck | null;
  /** Respostas/autorrespostas de assinantes apagadas pela retenção. */
  purgedEvents: number;
};

/** Apaga `platform-whatsapp-reply`/`-autoreply` mais velhos que a retenção (dado pessoal; em lotes). */
export async function purgeExpiredReplyEvents(now: Date): Promise<number> {
  const prisma = getPrisma();
  const cutoff = new Date(now.getTime() - PLATFORM_REPLY_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  let purged = 0;
  for (let i = 0; i < PURGE_MAX_BATCHES; i += 1) {
    const batch = await prisma.providerEvent.findMany({
      where: { provider: { in: [PLATFORM_REPLY_PROVIDER, PLATFORM_AUTOREPLY_PROVIDER] }, createdAt: { lt: cutoff } },
      select: { id: true },
      take: PURGE_BATCH,
    });
    if (batch.length === 0) break;
    const res = await prisma.providerEvent.deleteMany({ where: { id: { in: batch.map((b) => b.id) } } });
    purged += res.count;
    if (batch.length < PURGE_BATCH) break;
  }
  return purged;
}

export type WebhookCheck = "OK" | "REPAIRED" | "REPAIR_FAILED" | "CHECK_FAILED" | "UNSUPPORTED";

const WEBHOOK_PATH_MARK = "/api/webhooks/platform-whatsapp/";

/** Token do final do endereço (`.../api/webhooks/platform-whatsapp/<token>`), ou `null` se o endereço não é o nosso. */
function tokenFromWebhookUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const { pathname } = new URL(url);
    const at = pathname.indexOf(WEBHOOK_PATH_MARK);
    if (at < 0) return null;
    const token = pathname.slice(at + WEBHOOK_PATH_MARK.length).split("/")[0] ?? "";
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Confere o webhook da instância ACTIVE na Evolution e o reaplica se estiver desligado, sem MESSAGES_UPSERT ou apontando
 * para outro token (algo trocou). Só o HASH do token fica no banco: se o endereço atual ainda carrega o nosso token, reaplica
 * o mesmo endereço; se não, GIRA o token (novo hash no banco + novo endereço na Evolution; falhando, volta o hash antigo).
 * Nunca lança.
 */
/** Evento do webhook mais novo que isto prova que o endereço atual funciona. */
const WEBHOOK_ALIVE_MS = 2 * 60 * 60 * 1000;

export async function ensureActiveWebhook(
  active: { id: string; instanceName: string; webhookTokenHash: string },
  evolution: EvolutionClient,
  now: Date,
): Promise<WebhookCheck> {
  if (!evolution.findWebhook) return "UNSUPPORTED";
  const prisma = getPrisma();
  const record = (state: WebhookCheck, extra: { webhookRepairedAt?: string } = {}) =>
    patchDiagnostics(active.id, { webhookCheckedAt: now.toISOString(), webhookState: state, ...extra });
  let repairing = false;
  try {
    const info = await withTimeout(evolution.findWebhook(active.instanceName), STATE_CHECK_TIMEOUT_MS);
    const urlToken = tokenFromWebhookUrl(info?.url ?? null);
    const tokenMatches = urlToken !== null && hashWebhookToken(urlToken) === active.webhookTokenHash;
    const events = (info?.events ?? []).map((e) => e.toUpperCase().replace(/[.]/g, "_"));
    const hasMessages = events.length === 0 || events.includes("MESSAGES_UPSERT");
    if (info && info.enabled && tokenMatches && hasMessages) {
      await record("OK");
      return "OK";
    }
    // Resposta da Evolution vazia ou num formato que não entendemos. Se eventos do webhook chegaram nas últimas 2 h, o
    // endereço está funcionando: não gira o token por causa de uma leitura incerta (revisão v1.7.2 do Órion). Sem eventos
    // recentes, aí sim cria um endereço novo.
    if (!info) {
      const diag = await getPlatformWhatsappDiagnostics(active.id).catch(() => null);
      const lastEventMs = diag?.lastEventAt ? Date.parse(diag.lastEventAt) : Number.NaN;
      if (Number.isFinite(lastEventMs) && now.getTime() - lastEventMs < WEBHOOK_ALIVE_MS) {
        logger.warn("platform_whatsapp.webhook_check_unreadable", { connectionId: active.id });
        await record("OK");
        return "OK";
      }
    }

    repairing = true;
    const why = !info ? "missing" : !info.enabled ? "disabled" : !tokenMatches ? "other_url" : "events";
    let url: string;
    let rotatedTo: string | null = null;
    if (info && tokenMatches && info.url) {
      url = info.url;
    } else {
      const base = await tryGetPublicBaseUrl();
      if (!base) throw new Error("PUBLIC_URL_NOT_CONFIGURED");
      const token = generateWebhookToken();
      rotatedTo = hashWebhookToken(token);
      url = `${base.replace(/[/]+$/, "")}${WEBHOOK_PATH_MARK}${token}`;
      const res = await prisma.platformWhatsappConnection.updateMany({ where: { id: active.id, role: "ACTIVE", webhookTokenHash: active.webhookTokenHash }, data: { webhookTokenHash: rotatedTo } });
      if (res.count === 0) return "OK"; // outra rodada/troca mexeu na linha agora: a próxima confere de novo
    }
    try {
      await evolution.setWebhook(active.instanceName, url);
    } catch (error) {
      if (rotatedTo) {
        // Resultado ambíguo (ex.: o prazo estourou mas a Evolution aplicou o endereço novo): só volta o hash antigo se
        // a Evolution NÃO estiver com o token novo; senão o webhook ficaria sem token válido até a próxima rodada.
        const applied = await withTimeout(evolution.findWebhook(active.instanceName), STATE_CHECK_TIMEOUT_MS).catch(() => null);
        const appliedToken = tokenFromWebhookUrl(applied?.url ?? null);
        const newIsLive = appliedToken !== null && hashWebhookToken(appliedToken) === rotatedTo;
        if (!newIsLive) {
          await prisma.platformWhatsappConnection.updateMany({ where: { id: active.id, webhookTokenHash: rotatedTo }, data: { webhookTokenHash: active.webhookTokenHash } });
        }
      }
      throw error;
    }
    logger.warn("platform_whatsapp.webhook_repaired", { connectionId: active.id, why, rotated: rotatedTo !== null });
    await record("REPAIRED", { webhookRepairedAt: now.toISOString() });
    return "REPAIRED";
  } catch (error) {
    logger.warn("platform_whatsapp.webhook_check_failed", { connectionId: active.id, repairing, errorMessage: errMsg(error) });
    const state: WebhookCheck = repairing ? "REPAIR_FAILED" : "CHECK_FAILED";
    await record(state);
    return state;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("TIMEOUT")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Roda a cada rodada do tick: (1) encerra QR abandonado; (2) repete logout/exclusão de instâncias
 * aposentadas; (3) confere o `connectionState` da conexão ACTIVE (o `connection.update` pode se perder).
 * Nunca lança: falha vira log e contador.
 */
export async function runPlatformWhatsappMaintenance(deps?: PlatformWhatsappDeps): Promise<PlatformWhatsappMaintenanceSummary> {
  const now = deps?.now ?? new Date();
  const summary: PlatformWhatsappMaintenanceSummary = { abandonedQr: 0, cleanupsDone: 0, cleanupsPending: 0, stateChecked: false, stateChanged: false, webhook: null, purgedEvents: 0 };
  const prisma = getPrisma();
  const startedAtMs = Date.now();
  const budgetMs = deps?.budgetMs ?? MAINTENANCE_BUDGET_MS;
  const isOver = () => Date.now() - startedAtMs > budgetMs;

  // Retenção primeiro: só banco, rápida, e isolada (falha aqui não impede o resto da manutenção).
  try {
    summary.purgedEvents = await purgeExpiredReplyEvents(now);
  } catch (error) {
    logger.warn("platform_whatsapp.reply_purge_failed", { errorMessage: errMsg(error) });
  }

  try {
    summary.abandonedQr = await expireAbandonedPending(now);
    const pendingMarkers = await prisma.providerEvent.findMany({
      where: { provider: CLEANUP_PROVIDER, processedAt: null },
      orderBy: { createdAt: "asc" },
      take: CLEANUP_BATCH,
      select: { id: true, payload: true },
    });
    for (const marker of pendingMarkers) {
      if (isOver()) {
        summary.cleanupsPending += 1; // o resto fica para a próxima rodada
        continue;
      }
      const instanceName = (marker.payload as { instanceName?: unknown } | null)?.instanceName;
      if (typeof instanceName !== "string") {
        await prisma.providerEvent.update({ where: { id: marker.id }, data: { processedAt: now } });
        continue;
      }
      if (await runCleanupFor(marker.id, instanceName, deps)) summary.cleanupsDone += 1;
      else summary.cleanupsPending += 1;
    }

    const actives = await prisma.platformWhatsappConnection.findMany({ where: { role: "ACTIVE" } });
    if (actives.length > 0 && !isOver()) {
      const evolution = await resolveEvolution(deps).catch(() => null);
      if (evolution) {
        for (const active of actives) {
          if (isOver()) break;
          const mapped = mapEvolutionState(await withTimeout(evolution.connectionState(active.instanceName), STATE_CHECK_TIMEOUT_MS));
          summary.stateChecked = true;
          if (mapped === "DISCONNECTED" && active.status === "CONNECTED") {
            const changed = await markActiveDisconnected(active.id, now);
            if (changed) summary.stateChanged = true;
          } else if (mapped === "CONNECTED" && active.status !== "CONNECTED") {
            await prisma.platformWhatsappConnection.updateMany({
              where: { id: active.id, role: "ACTIVE" },
              data: { status: "CONNECTED", disconnectedAt: null, connectedAt: now },
            });
            summary.stateChanged = true;
          }
          // Só vale conferir o endereço de recebimento com a sessão aberta: sem ela a Evolution nem entrega mensagem.
          if (!isOver()) {
            const res = await ensureActiveWebhook(active, evolution, now);
            if (active.purpose === "BILLING" || !summary.webhook) summary.webhook = res;
          }
        }
      }
    }
  } catch (error) {
    logger.error("platform_whatsapp.maintenance_failed", { errorMessage: errMsg(error) });
  }
  return summary;
}
