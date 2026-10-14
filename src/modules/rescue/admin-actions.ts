"use server";

import { z } from "zod";
import { getPrisma } from "@/lib/db/prisma";
import { requirePlatformAdmin } from "@/lib/auth/guards";
import { runAction, type Result } from "@/lib/result";
import { DomainError } from "@/lib/errors";
import { recordAudit } from "@/modules/audit/record";
import type { RescueLeadStatus } from "./service";

const reasonSchema = z
  .string()
  .trim()
  .min(15, "O motivo precisa ter pelo menos 15 caracteres.")
  .max(500, "O motivo pode ter no máximo 500 caracteres.");

const listSchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z
    .enum([
      "PENDING",
      "MESSAGE_1_SENDING",
      "MESSAGE_1_SENT",
      "MESSAGE_2_SENDING",
      "MESSAGE_2_SENT",
      "RESPONDED",
      "CONVERTED",
      "OPTED_OUT",
      "EXPIRED",
      "SKIPPED",
    ])
    .optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  orderBy: z.enum(["createdAt_desc", "createdAt_asc", "nextRunAt_asc", "nextRunAt_desc"]).default("createdAt_desc"),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(10).max(100).default(25),
});

export type RescueLeadListItem = {
  id: string;
  userId: string;
  userName: string | null;
  userEmail: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  phoneE164: string;
  status: RescueLeadStatus;
  nextRunAt: Date | null;
  step1ScheduledAt: Date;
  step1SentAt: Date | null;
  step2ScheduledAt: Date | null;
  step2SentAt: Date | null;
  respondedAt: Date | null;
  convertedAt: Date | null;
  optedOutAt: Date | null;
  lastErrorCode: string | null;
  attempts: number;
  createdAt: Date;
  updatedAt: Date;
};

export type RescueLeadListResult = {
  items: RescueLeadListItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  isRescueEnabled: boolean;
};

/**
 * Lista os leads da régua de resgate com paginação, filtros e ordenação.
 */
export async function listRescueLeadsAction(input: unknown): Promise<Result<RescueLeadListResult>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    const data = listSchema.parse(input ?? {});
    const prisma = getPrisma();

    const where: Record<string, unknown> = {};

    if (data.status) {
      where.status = data.status;
    }

    if (data.from || data.to) {
      const createdAtFilter: { gte?: Date; lte?: Date } = {};
      if (data.from) {
        createdAtFilter.gte = new Date(`${data.from}T00:00:00.000Z`);
      }
      if (data.to) {
        createdAtFilter.lte = new Date(`${data.to}T23:59:59.999Z`);
      }
      where.createdAt = createdAtFilter;
    }

    if (data.search) {
      const term = data.search;
      const digits = term.replace(/\D/g, "");
      where.OR = [
        { user: { name: { contains: term, mode: "insensitive" } } },
        { user: { email: { contains: term, mode: "insensitive" } } },
        { tenant: { name: { contains: term, mode: "insensitive" } } },
        ...(digits ? [{ phoneE164: { contains: digits } }] : []),
      ];
    }

    let orderByQuery: Record<string, "asc" | "desc"> = { createdAt: "desc" };
    if (data.orderBy === "createdAt_asc") orderByQuery = { createdAt: "asc" };
    else if (data.orderBy === "nextRunAt_asc") orderByQuery = { nextRunAt: "asc" };
    else if (data.orderBy === "nextRunAt_desc") orderByQuery = { nextRunAt: "desc" };

    const [total, leads, settings] = await Promise.all([
      prisma.rescueLead.count({ where }),
      prisma.rescueLead.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          tenant: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
        },
        orderBy: orderByQuery,
        skip: (data.page - 1) * data.pageSize,
        take: data.pageSize,
      }),
      prisma.platformSettings.findUnique({
        where: { id: 1 },
        select: { rescueWhatsappEnabled: true },
      }),
    ]);

    const items: RescueLeadListItem[] = leads.map((lead) => ({
      id: lead.id,
      userId: lead.userId,
      userName: lead.user.name,
      userEmail: lead.user.email,
      tenantId: lead.tenantId,
      tenantName: lead.tenant.name,
      tenantSlug: lead.tenant.slug,
      phoneE164: lead.phoneE164,
      status: lead.status as RescueLeadStatus,
      nextRunAt: lead.nextRunAt,
      step1ScheduledAt: lead.step1ScheduledAt,
      step1SentAt: lead.step1SentAt,
      step2ScheduledAt: lead.step2ScheduledAt,
      step2SentAt: lead.step2SentAt,
      respondedAt: lead.respondedAt,
      convertedAt: lead.convertedAt,
      optedOutAt: lead.optedOutAt,
      lastErrorCode: lead.lastErrorCode,
      attempts: lead.attempts,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
    }));

    const totalPages = Math.max(1, Math.ceil(total / data.pageSize));

    return {
      items,
      total,
      page: data.page,
      pageSize: data.pageSize,
      totalPages,
      isRescueEnabled: settings?.rescueWhatsappEnabled ?? false,
    };
  });
}

export type RescueLeadDetail = {
  id: string;
  userId: string;
  userName: string | null;
  userEmail: string;
  userCreatedAt: Date;
  userLastSeenAt: Date | null;
  userEmailVerifiedAt: Date | null;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  tenantDocument: string | null;
  phoneE164: string;
  status: RescueLeadStatus;
  nextRunAt: Date | null;
  step1ScheduledAt: Date;
  step1SentAt: Date | null;
  step2ScheduledAt: Date | null;
  step2SentAt: Date | null;
  respondedAt: Date | null;
  convertedAt: Date | null;
  optedOutAt: Date | null;
  lastErrorCode: string | null;
  attempts: number;
  platformConnectionPhone: string | null;
  senderPhoneE164: string | null;
  providerMessageId1: string | null;
  providerMessageId2: string | null;
  createdAt: Date;
  updatedAt: Date;
  auditLogs: Array<{
    id: string;
    action: string;
    actorRole: string;
    summary: string;
    changes: unknown;
    createdAt: Date;
  }>;
};

/**
 * Detalhe de um lead com usuário, empresa, conexão de WhatsApp e histórico de auditoria.
 */
export async function getRescueLeadDetailAction(leadId: string): Promise<Result<RescueLeadDetail>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    const prisma = getPrisma();

    const lead = await prisma.rescueLead.findUnique({
      where: { id: leadId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            createdAt: true,
            lastSeenAt: true,
            emailVerifiedAt: true,
          },
        },
        tenant: {
          select: {
            id: true,
            name: true,
            slug: true,
            document: true,
          },
        },
        platformConnection: {
          select: {
            phoneE164: true,
          },
        },
      },
    });

    if (!lead) {
      throw new DomainError("NOT_FOUND", "Lead de resgate não encontrado.");
    }

    const auditLogs = await prisma.auditLog.findMany({
      where: {
        targetType: "RescueLead",
        targetId: lead.id,
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        action: true,
        actorRole: true,
        summary: true,
        changes: true,
        createdAt: true,
      },
    });

    return {
      id: lead.id,
      userId: lead.userId,
      userName: lead.user.name,
      userEmail: lead.user.email,
      userCreatedAt: lead.user.createdAt,
      userLastSeenAt: lead.user.lastSeenAt,
      userEmailVerifiedAt: lead.user.emailVerifiedAt,
      tenantId: lead.tenantId,
      tenantName: lead.tenant.name,
      tenantSlug: lead.tenant.slug,
      tenantDocument: lead.tenant.document,
      phoneE164: lead.phoneE164,
      status: lead.status as RescueLeadStatus,
      nextRunAt: lead.nextRunAt,
      step1ScheduledAt: lead.step1ScheduledAt,
      step1SentAt: lead.step1SentAt,
      step2ScheduledAt: lead.step2ScheduledAt,
      step2SentAt: lead.step2SentAt,
      respondedAt: lead.respondedAt,
      convertedAt: lead.convertedAt,
      optedOutAt: lead.optedOutAt,
      lastErrorCode: lead.lastErrorCode,
      attempts: lead.attempts,
      platformConnectionPhone: lead.platformConnection?.phoneE164 ?? null,
      senderPhoneE164: lead.senderPhoneE164,
      providerMessageId1: lead.providerMessageId1,
      providerMessageId2: lead.providerMessageId2,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      auditLogs: auditLogs.map((log) => ({
        id: log.id,
        action: log.action,
        actorRole: log.actorRole,
        summary: log.summary,
        changes: log.changes,
        createdAt: log.createdAt,
      })),
    };
  });
}

/**
 * Lê as configurações atuais da régua de resgate.
 */
export async function getRescueSettingsAction(): Promise<Result<{ rescueWhatsappEnabled: boolean }>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    const prisma = getPrisma();
    const settings = await prisma.platformSettings.findUnique({
      where: { id: 1 },
      select: { rescueWhatsappEnabled: true },
    });
    return {
      rescueWhatsappEnabled: settings?.rescueWhatsappEnabled ?? false,
    };
  });
}

/**
 * Alterna o kill switch global do resgate via WhatsApp.
 * Exige papel PLATFORM_ADMIN com 2FA ativa.
 */
export async function toggleRescueEnabledAction(enabled: boolean, reason: string): Promise<Result<{ enabled: boolean }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const validReason = reasonSchema.parse(reason);
    const prisma = getPrisma();

    const previous = await prisma.platformSettings.findUnique({
      where: { id: 1 },
      select: { rescueWhatsappEnabled: true },
    });

    const wasEnabled = previous?.rescueWhatsappEnabled ?? false;

    await prisma.platformSettings.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        rescueWhatsappEnabled: enabled,
      },
      update: {
        rescueWhatsappEnabled: enabled,
      },
    });

    await recordAudit({
      tenantId: null,
      actor: { userId: admin.id, role: "PLATFORM_ADMIN" },
      action: enabled ? "rescue.enabled" : "rescue.disabled",
      targetType: "PlatformSettings",
      targetId: "1",
      summary: enabled
        ? "Régua de resgate de leads ativada globalmente."
        : "Kill switch acionado: régua de resgate pausada globalmente.",
      changes: {
        rescueWhatsappEnabled: { de: wasEnabled, para: enabled },
        reason: { de: null, para: validReason },
      },
    });

    return { enabled };
  });
}

/**
 * Pausa o envio de mensagens para um lead específico (status vira SKIPPED).
 */
export async function pauseRescueLeadAction(leadId: string, reason: string): Promise<Result<{ status: RescueLeadStatus }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const validReason = reasonSchema.parse(reason);
    const prisma = getPrisma();

    const lead = await prisma.rescueLead.findUnique({ where: { id: leadId } });
    if (!lead) {
      throw new DomainError("NOT_FOUND", "Lead de resgate não encontrado.");
    }

    if (lead.status === "CONVERTED" || lead.status === "OPTED_OUT") {
      throw new DomainError(
        "INVALID_STATE",
        `Não é possível pausar um lead que já está ${lead.status === "CONVERTED" ? "convertido" : "com saída solicitada"}.`,
      );
    }

    const oldStatus = lead.status;
    const now = new Date();

    await prisma.rescueLead.update({
      where: { id: leadId },
      data: {
        status: "SKIPPED",
        nextRunAt: null,
        updatedAt: now,
      },
    });

    await recordAudit({
      tenantId: lead.tenantId,
      actor: { userId: admin.id, role: "PLATFORM_ADMIN" },
      action: "rescue.lead_paused",
      targetType: "RescueLead",
      targetId: lead.id,
      summary: `Lead pausado manualmente pelo administrador: "${validReason}"`,
      changes: {
        status: { de: oldStatus, para: "SKIPPED" },
        reason: { de: null, para: validReason },
      },
    });

    return { status: "SKIPPED" as RescueLeadStatus };
  });
}

/**
 * Retoma um lead que foi pausado (SKIPPED) ou expirado (EXPIRED).
 */
export async function resumeRescueLeadAction(leadId: string, reason: string): Promise<Result<{ status: RescueLeadStatus }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const validReason = reasonSchema.parse(reason);
    const prisma = getPrisma();

    const lead = await prisma.rescueLead.findUnique({ where: { id: leadId } });
    if (!lead) {
      throw new DomainError("NOT_FOUND", "Lead de resgate não encontrado.");
    }

    if (lead.status !== "SKIPPED" && lead.status !== "EXPIRED") {
      throw new DomainError("INVALID_STATE", "Apenas leads pausados ou expirados podem ser retomados.");
    }

    const now = new Date();
    let newStatus: RescueLeadStatus = "PENDING";
    let nextRun: Date = now;

    if (lead.step1SentAt && !lead.step2SentAt) {
      newStatus = "MESSAGE_1_SENT";
      nextRun = lead.step2ScheduledAt && lead.step2ScheduledAt > now ? lead.step2ScheduledAt : now;
    } else if (lead.step1SentAt && lead.step2SentAt) {
      newStatus = "MESSAGE_2_SENT";
    }

    const oldStatus = lead.status;

    await prisma.rescueLead.update({
      where: { id: leadId },
      data: {
        status: newStatus,
        nextRunAt: newStatus === "MESSAGE_2_SENT" ? null : nextRun,
        lastErrorCode: null,
        updatedAt: now,
      },
    });

    await recordAudit({
      tenantId: lead.tenantId,
      actor: { userId: admin.id, role: "PLATFORM_ADMIN" },
      action: "rescue.lead_resumed",
      targetType: "RescueLead",
      targetId: lead.id,
      summary: `Lead retomado pelo administrador: "${validReason}"`,
      changes: {
        status: { de: oldStatus, para: newStatus },
        reason: { de: null, para: validReason },
      },
    });

    return { status: newStatus };
  });
}

/**
 * Marca manualmente o lead como convertido (CONVERTED).
 * Útil caso o cliente tenha acessado por outro meio antes do sistema atualizar lastSeenAt.
 */
export async function markRescueLeadConvertedAction(leadId: string, reason: string): Promise<Result<{ status: RescueLeadStatus }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const validReason = reasonSchema.parse(reason);
    const prisma = getPrisma();

    const lead = await prisma.rescueLead.findUnique({ where: { id: leadId } });
    if (!lead) {
      throw new DomainError("NOT_FOUND", "Lead de resgate não encontrado.");
    }

    if (lead.status === "CONVERTED") {
      return { status: "CONVERTED" as RescueLeadStatus };
    }

    const oldStatus = lead.status;
    const now = new Date();

    await prisma.rescueLead.update({
      where: { id: leadId },
      data: {
        status: "CONVERTED",
        convertedAt: now,
        nextRunAt: null,
        updatedAt: now,
      },
    });

    await recordAudit({
      tenantId: lead.tenantId,
      actor: { userId: admin.id, role: "PLATFORM_ADMIN" },
      action: "rescue.lead_converted_manual",
      targetType: "RescueLead",
      targetId: lead.id,
      summary: `Lead marcado como convertido manualmente: "${validReason}"`,
      changes: {
        status: { de: oldStatus, para: "CONVERTED" },
        reason: { de: null, para: validReason },
      },
    });

    return { status: "CONVERTED" as RescueLeadStatus };
  });
}

/**
 * Reenvia a mensagem atual da régua (reagenda o lead para nextRunAt = now e zera erros).
 */
export async function resendRescueMessageAction(leadId: string, reason: string): Promise<Result<{ status: RescueLeadStatus; nextRunAt: Date }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const validReason = reasonSchema.parse(reason);
    const prisma = getPrisma();

    const lead = await prisma.rescueLead.findUnique({ where: { id: leadId } });
    if (!lead) {
      throw new DomainError("NOT_FOUND", "Lead de resgate não encontrado.");
    }

    if (lead.status === "CONVERTED" || lead.status === "OPTED_OUT") {
      throw new DomainError("INVALID_STATE", "Não é possível reenviar mensagem para um lead já finalizado.");
    }

    const now = new Date();
    let statusToSet = lead.status;
    if (lead.status === "SKIPPED" || lead.status === "EXPIRED") {
      statusToSet = lead.step1SentAt ? "MESSAGE_1_SENT" : "PENDING";
    }

    await prisma.rescueLead.update({
      where: { id: leadId },
      data: {
        status: statusToSet,
        nextRunAt: now,
        attempts: 0,
        lastErrorCode: null,
        updatedAt: now,
      },
    });

    await recordAudit({
      tenantId: lead.tenantId,
      actor: { userId: admin.id, role: "PLATFORM_ADMIN" },
      action: "rescue.message_resend_requested",
      targetType: "RescueLead",
      targetId: lead.id,
      summary: `Reenvio de mensagem solicitado pelo administrador: "${validReason}"`,
      changes: {
        status: { de: lead.status, para: statusToSet },
        nextRunAt: { de: lead.nextRunAt, para: now },
        reason: { de: null, para: validReason },
      },
    });

    return { status: statusToSet as RescueLeadStatus, nextRunAt: now };
  });
}
