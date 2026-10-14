"use server";

import { z } from "zod";
import { getPrisma } from "@/lib/db/prisma";
import { requirePlatformAdmin, requireTenantMember } from "@/lib/auth/guards";
import { runAction, type Result } from "@/lib/result";
import { DomainError } from "@/lib/errors";
import { platformAdminActor, recordAudit } from "@/modules/audit/record";
import { applyCouponToSubscription, type CouponApplication } from "@/modules/billing/coupons";
import { regeneratePixForInvoice, findBillingRecipientEmail, findOwnInvoiceOrThrow, billingUrlFor } from "@/modules/billing/service";
import { sendMail, loadEmailContext, invoiceGeneratedEmail } from "@/lib/email";
import { formatCentsBRL, formatDateBR } from "@/modules/billing/format";
import { recordBillingEvent } from "@/modules/billing/dunning/events";
import type { ExtendTrialResult, ResendPaymentLinkResult, SupportSessionItem, SupportSessionsPage } from "./support-actions-types";

/**
 * Server Actions e Queries para Suporte em Assinatura e Cobrança (Onda 5).
 * Todas as operações exigem ser administrador da plataforma (seja com sessão direta de admin
 * ou via impersonação de suporte ativa no tenant).
 */

const extendTrialSchema = z.object({
  days: z.coerce.number().int().min(1, "O trial deve ser estendido em pelo menos 1 dia.").max(30, "O trial só pode ser estendido em até 30 dias."),
  reason: z.string().trim().min(15, "O motivo deve ter pelo menos 15 caracteres.").max(500, "O motivo não pode ultrapassar 500 caracteres."),
});

const applyCouponSchema = z.object({
  code: z.string().trim().min(1, "Digite o código do cupom.").max(40),
  reason: z.string().trim().min(15, "O motivo deve ter pelo menos 15 caracteres.").max(500, "O motivo não pode ultrapassar 500 caracteres."),
});

const resendPaymentLinkSchema = z.object({
  invoiceId: z.string().trim().min(1, "ID da fatura é obrigatório."),
  reason: z.string().trim().min(15, "O motivo deve ter pelo menos 15 caracteres.").max(500, "O motivo não pode ultrapassar 500 caracteres."),
});

/**
 * Autentica o operador como admin da plataforma (direto ou via suporte).
 * Se o operador estiver impersonando o tenantSlug via cookie de suporte, devolve o context com supportSessionId.
 * Se não tiver cookie de suporte, exige requirePlatformAdmin().
 */
async function requireSupportOrPlatformAdmin(tenantSlug: string) {
  const prisma = getPrisma();
  const tenant = await prisma.tenant.findUnique({
    where: { slug: tenantSlug },
    select: { id: true, slug: true, name: true, timezone: true },
  });
  if (!tenant) throw new DomainError("NOT_FOUND", "Empresa não encontrada.");

  // Tenta resolver como membro/suporte
  try {
    const ctx = await requireTenantMember(tenantSlug);
    if (ctx.isSupportImpersonation) {
      return {
        tenant,
        adminUserId: ctx.user.id,
        supportSessionId: ctx.supportSessionId ?? null,
      };
    }
  } catch {
    // Se falhar requireTenantMember, confere se é admin direto
  }

  // Se não foi via impersonação válida daquele tenant, exige requirePlatformAdmin()
  const admin = await requirePlatformAdmin();
  return {
    tenant,
    adminUserId: admin.id,
    supportSessionId: null,
  };
}

/**
 * 2) Estender trial
 * - Valida days >= 1 && days <= 30
 * - Valida que total de trial (trialEndsAt + days) não passa de createdAt + 30 dias
 * - Atualiza subscription.trialEndsAt = max(trialEndsAt, now) + days
 * - Atualiza a fatura OPEN de teste (se houver) com dueAt e periodEnd iguais ao novo trialEndsAt
 * - Audit log: action: "billing.trial_extended", summary, actorRole: "PLATFORM_ADMIN", supportSessionId
 */
export async function extendTrialAction(
  tenantSlug: string,
  input: unknown
): Promise<Result<ExtendTrialResult>> {
  return runAction(async () => {
    const { tenant, adminUserId, supportSessionId } = await requireSupportOrPlatformAdmin(tenantSlug);
    const data = extendTrialSchema.parse(input);

    const prisma = getPrisma();
    const subscription = await prisma.subscription.findUnique({
      where: { tenantId: tenant.id },
      select: { id: true, status: true, trialEndsAt: true, createdAt: true },
    });

    if (!subscription) throw new DomainError("NOT_FOUND", "Assinatura não encontrada para esta empresa.");
    if (subscription.status !== "TRIALING" || !subscription.trialEndsAt) {
      throw new DomainError("INVALID_STATE", "Só é possível estender o trial enquanto a empresa está em teste (trial).");
    }

    const now = new Date();
    const maxAllowedTrialEnd = new Date(subscription.createdAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    const baseDate = subscription.trialEndsAt > now ? subscription.trialEndsAt : now;
    const newTrialEndsAt = new Date(baseDate.getTime() + data.days * 24 * 60 * 60 * 1000);

    if (newTrialEndsAt > maxAllowedTrialEnd) {
      throw new DomainError(
        "TRIAL_LIMIT_EXCEEDED",
        "O período total de teste não pode ultrapassar 30 dias a partir da criação da conta."
      );
    }

    await prisma.subscription.update({
      where: { tenantId: tenant.id },
      data: {
        trialEndsAt: newTrialEndsAt,
        currentPeriodEnd: newTrialEndsAt,
      },
    });

    // Atualiza vencimento da fatura aberta do teste
    await prisma.invoice.updateMany({
      where: {
        subscriptionId: subscription.id,
        status: "OPEN",
        periodStart: { lte: subscription.trialEndsAt },
      },
      data: {
        dueAt: newTrialEndsAt,
        periodEnd: newTrialEndsAt,
      },
    });

    await recordBillingEvent({
      tenantId: tenant.id,
      subscriptionId: subscription.id,
      type: "TRIAL_EXTENDED",
      actorType: "ADMIN",
      actorUserId: adminUserId,
      metadata: {
        extraDays: data.days,
        trialEndsAt: newTrialEndsAt.toISOString(),
        reason: data.reason,
        supportSessionId,
      },
    });

    await recordAudit({
      tenantId: tenant.id,
      actor: platformAdminActor(adminUserId),
      action: "billing.trial_extended",
      targetType: "subscription",
      targetId: subscription.id,
      summary: `Estendeu o trial em ${data.days} dia(s). Motivo: ${data.reason}`,
      changes: {
        diasExtras: { de: null, para: data.days },
        trialEndsAt: { de: subscription.trialEndsAt.toISOString(), para: newTrialEndsAt.toISOString() },
      },
      supportSessionId,
    });

    return {
      trialEndsAt: newTrialEndsAt.toISOString(),
    };
  });
}

/**
 * 3) Aplicar cupom via suporte
 * Reusa applyCouponToSubscription
 * Audit log com actorRole: "PLATFORM_ADMIN", supportSessionId, reason
 */
export async function applySupportCouponAction(
  tenantSlug: string,
  input: unknown
): Promise<Result<CouponApplication>> {
  return runAction(async () => {
    const { tenant, adminUserId, supportSessionId } = await requireSupportOrPlatformAdmin(tenantSlug);
    const data = applyCouponSchema.parse(input);

    const applied = await applyCouponToSubscription(tenant.id, data.code);

    await recordAudit({
      tenantId: tenant.id,
      actor: platformAdminActor(adminUserId),
      action: "billing.coupon_applied",
      targetType: "subscription",
      summary: `Suporte aplicou o cupom ${applied.coupon.code} na assinatura. Motivo: ${data.reason}`,
      changes: { cupom: { de: null, para: applied.coupon.code } },
      supportSessionId,
    });

    return applied;
  });
}

// Tipos públicos re-exportados de `./support-actions-types` (compartilhado com
// componentes Client para evitar arrastar a cadeia de imports server-only
// como `next/headers` e `prisma` para o bundle do navegador).

/**
 * 4) Reenviar link de pagamento de fatura pendente
 * - Localiza a fatura da empresa
 * - Garante que está OPEN
 * - Garante/regenera Pix válido se expirado ou ausente
 * - Dispara e-mail de cobrança para o destinatário da empresa
 * - Audit log com reason, actorRole: "PLATFORM_ADMIN", supportSessionId
 */
export async function resendPaymentLinkAction(
  tenantSlug: string,
  input: unknown
): Promise<Result<ResendPaymentLinkResult>> {
  return runAction(async () => {
    const { tenant, adminUserId, supportSessionId } = await requireSupportOrPlatformAdmin(tenantSlug);
    const data = resendPaymentLinkSchema.parse(input);

    const invoice = await findOwnInvoiceOrThrow(tenant.id, data.invoiceId);
    if (invoice.status !== "OPEN") {
      throw new DomainError("INVALID_STATE", "Só é possível reenviar cobrança de uma fatura em aberto.");
    }

    const payerEmail = await findBillingRecipientEmail(tenant.id);
    if (!payerEmail) {
      throw new DomainError("NOT_FOUND", "Nenhum e-mail de cobrança encontrado para esta empresa.");
    }

    let currentInvoice = invoice;
    const now = new Date();
    // Se não tem Pix ou já expirou, regera
    if (!currentInvoice.pixCopyPaste || !currentInvoice.pixExpiresAt || currentInvoice.pixExpiresAt <= now) {
      const regenerated = await regeneratePixForInvoice(invoice.id, payerEmail);
      currentInvoice = { ...currentInvoice, ...regenerated };
    }

    const billingUrl = await billingUrlFor(tenant.slug);
    const mailContext = await loadEmailContext();
    const mail = invoiceGeneratedEmail({
      tenantName: tenant.name,
      amountReais: formatCentsBRL(currentInvoice.amountCents),
      dueDateBr: formatDateBR(currentInvoice.dueAt, tenant.timezone),
      pixCopyPaste: currentInvoice.pixCopyPaste,
      billingUrl,
      ctx: mailContext,
    });

    await sendMail({
      to: payerEmail,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });

    await recordAudit({
      tenantId: tenant.id,
      actor: platformAdminActor(adminUserId),
      action: "billing.payment_link_resent",
      targetType: "invoice",
      targetId: invoice.id,
      summary: `Reenviou link/código de pagamento da fatura ${invoice.id} para ${payerEmail}. Motivo: ${data.reason}`,
      supportSessionId,
    });

    return {
      invoiceId: currentInvoice.id,
      recipientEmail: payerEmail,
      pixCopyPaste: currentInvoice.pixCopyPaste,
    };
  });
}

// ---------------------------------------------------------------------------
// 5) Card "Acessos do Suporte" (LGPD) — backend
// ---------------------------------------------------------------------------

// Os tipos `SupportSessionItem` e `SupportSessionsPage` vivem em
// `./support-actions-types` (re-exportados no topo deste arquivo).

/**
 * Retorna histórico paginado de sessões de suporte para a empresa.
 * Pode ser consumido pelo OWNER da empresa e pelo suporte/admin da plataforma.
 */
export async function listSupportSessionsAction(
  tenantSlug: string,
  params?: { page?: number; pageSize?: number }
): Promise<Result<SupportSessionsPage>> {
  return runAction(async () => {
    const { tenant } = await requireTenantMember(tenantSlug);
    const prisma = getPrisma();

    const page = Math.max(1, params?.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, params?.pageSize ?? 10));
    const skip = (page - 1) * pageSize;

    const [totalItems, rows] = await Promise.all([
      prisma.supportSession.count({ where: { tenantId: tenant.id } }),
      prisma.supportSession.findMany({
        where: { tenantId: tenant.id },
        orderBy: { startedAt: "desc" },
        skip,
        take: pageSize,
        include: {
          admin: { select: { name: true, email: true } },
        },
      }),
    ]);

    const now = new Date();
    const items: SupportSessionItem[] = rows.map((s) => {
      let status: "ACTIVE" | "EXPIRED" | "CLOSED" = "ACTIVE";
      if (s.closedAt) {
        status = s.closeReason === "EXPIRED" ? "EXPIRED" : "CLOSED";
      } else if (s.expiresAt < now) {
        status = "EXPIRED";
      }

      return {
        id: s.id,
        adminName: s.admin.name ?? "Administrador",
        adminEmail: s.admin.email,
        reason: s.reason,
        startedAt: s.startedAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        closedAt: s.closedAt?.toISOString() ?? null,
        closeReason: s.closeReason ?? null,
        status,
      };
    });

    const totalPages = Math.ceil(totalItems / pageSize) || 1;

    return {
      items,
      page,
      pageSize,
      totalItems,
      totalPages,
    };
  });
}
