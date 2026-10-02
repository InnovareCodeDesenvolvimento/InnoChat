"use server";

import { z } from "zod";
import { requireTenantMember } from "@/lib/auth/guards";
import { runAction, type Result } from "@/lib/result";
import { DomainError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { reconcileInvoicePayment, type ReconcileOutcome } from "./reconcile";
import { getPrisma } from "@/lib/db/prisma";
import { memberActor, recordAudit } from "@/modules/audit/record";
import { CANCEL_REASON_MAX_LENGTH, requestCancellation, startReactivation, undoCancellation, type CancelResult } from "./cancellation";
import { changePlan, findBillingRecipientEmail, findOwnInvoiceOrThrow, listActivePlans, regeneratePixForInvoice, type ChangePlanResult } from "./service";

/**
 * Server Actions de cobrança do lado da empresa (docs/arquitetura.md §7.2, tela de Assinatura).
 * Sem `assertTenantCanWrite`: a tela de Assinatura funciona mesmo com a assinatura `SUSPENDED`
 * (§7.4 — é o único jeito de a empresa conseguir pagar/trocar de plano para saír de lá).
 */

export type PlanListItem = {
  id: string;
  code: string;
  name: string;
  priceCents: number;
  maxWhatsappNumbers: number;
  maxProfessionals: number | null;
  sortOrder: number;
};

export async function listActivePlansAction(tenantSlug: string): Promise<Result<PlanListItem[]>> {
  return runAction(async () => {
    await requireTenantMember(tenantSlug);
    const plans = await listActivePlans();
    return plans.map((p) => ({
      id: p.id,
      code: p.code,
      name: p.name,
      priceCents: p.priceCents,
      maxWhatsappNumbers: p.maxWhatsappNumbers,
      maxProfessionals: p.maxProfessionals,
      sortOrder: p.sortOrder,
    }));
  });
}

const changePlanSchema = z.object({ planId: z.string().min(1) });

/** Restrito a `OWNER` — troca de plano é decisão de dinheiro da empresa, não do dia a dia (mesma régua de `updateTenantThemeAction`). */
export async function changePlanAction(tenantSlug: string, input: unknown): Promise<Result<ChangePlanResult>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug, ["OWNER"]);
    const { tenant } = ctx;
    const data = changePlanSchema.parse(input);
    const prisma = getPrisma();
    const [current, target] = await Promise.all([
      prisma.subscription.findUnique({ where: { tenantId: tenant.id }, select: { plan: { select: { name: true } } } }),
      prisma.plan.findUnique({ where: { id: data.planId }, select: { name: true } }),
    ]);
    const result = await changePlan(tenant.id, data.planId);
    if (current?.plan.name !== target?.name) {
      await recordAudit({
        tenantId: tenant.id,
        actor: memberActor(ctx),
        action: "subscription.plan_changed",
        targetType: "subscription",
        summary: result.appliedImmediately
          ? `Trocou o plano de ${current?.plan.name ?? "?"} para ${target?.name ?? "?"}.`
          : `Pediu a troca do plano ${current?.plan.name ?? "?"} para ${target?.name ?? "?"} (vale na próxima renovação).`,
        changes: { plano: { de: current?.plan.name ?? null, para: target?.name ?? null }, aplicadoAgora: { de: null, para: result.appliedImmediately } },
      });
    }
    return result;
  });
}

const REGENERATE_PIX_LIMIT = 5;
const REGENERATE_PIX_WINDOW_MS = 10 * 60 * 1000; // 5 tentativas/10min por empresa — chama o Mercado Pago de verdade

/**
 * "Gerar Pix agora"/"Tentar de novo" (tela de Assinatura) — hoje `regeneratePixForInvoice` só
 * rodava em segundo plano pelo `billing/tick` (de hora em hora); esta action deixa a EMPRESA
 * disparar na hora, depois de ver `MERCADOPAGO_MISSING_DOCUMENT` (cadastrar documento em
 * Configurações e tentar de novo) ou `MERCADOPAGO_UNAVAILABLE` (tentar de novo). Restrito a
 * `OWNER` (mesma régua de `changePlanAction`) e escopado por `findOwnInvoiceOrThrow` — o
 * `invoiceId` nunca é confiado sem confirmar que pertence à assinatura DESTE tenant (nunca de
 * outra empresa, mesmo que alguém adivinhe/tente um id de fatura de outra conta). Rate limit
 * leve por tenant: é uma chamada de rede de verdade ao Mercado Pago, não um clique de UI barato.
 */
export async function regenerateMyInvoicePixAction(tenantSlug: string, invoiceId: string): Promise<Result<{ invoiceId: string; pixCopyPaste: string | null }>> {
  return runAction(async () => {
    const { tenant } = await requireTenantMember(tenantSlug, ["OWNER"]);

    const rateLimit = checkRateLimit(`regenerate-pix:${tenant.id}`, REGENERATE_PIX_LIMIT, REGENERATE_PIX_WINDOW_MS);
    if (!rateLimit.allowed) {
      throw new DomainError("RATE_LIMITED", "Muitas tentativas. Aguarde alguns minutos antes de tentar de novo.", {
        retryAfterMs: rateLimit.retryAfterMs,
      });
    }

    await findOwnInvoiceOrThrow(tenant.id, invoiceId);

    const payerEmail = (await findBillingRecipientEmail(tenant.id)) ?? undefined;
    if (!payerEmail) {
      // Não deveria acontecer (toda empresa nasce com um OWNER, e `Membership` nunca perde o
      // último OWNER) — mas sem e-mail de cobrança não há para quem o Mercado Pago devolver
      // notificação, então falha cedo com uma mensagem clara em vez de mandar `undefined`.
      throw new DomainError("NOT_FOUND", "Nenhum e-mail de cobrança encontrado para esta empresa. Contate o suporte.");
    }

    const invoice = await regeneratePixForInvoice(invoiceId, payerEmail);
    return { invoiceId: invoice.id, pixCopyPaste: invoice.pixCopyPaste };
  });
}

const checkPaymentSchema = z.object({ tenantSlug: z.string().min(1) });

export type CheckMyInvoicePaymentResult = {
  status: "paid" | "pending" | "throttled" | "payment_failed" | "no_open_invoice" | "unavailable";
};

/**
 * Conciliação ativa disparada pela tela de Assinatura (polling enquanto o Pix está exibido): consulta
 * o Mercado Pago e dá baixa se já foi pago — não depende do webhook. Qualquer membro da empresa pode
 * chamar (só lê o estado da PRÓPRIA fatura em aberto); o `tenantSlug` vem do guard, nunca de um
 * `invoiceId` do cliente. Rate limit de 1 consulta ao MP a cada 5s por fatura, no banco.
 */
export async function checkMyInvoicePaymentAction(input: { tenantSlug: string }): Promise<Result<CheckMyInvoicePaymentResult>> {
  return runAction(async () => {
    const { tenantSlug } = checkPaymentSchema.parse(input);
    const { tenant } = await requireTenantMember(tenantSlug);

    const invoice = await getPrisma().invoice.findFirst({
      where: { status: "OPEN", mpPaymentId: { not: null }, subscription: { tenantId: tenant.id } },
      orderBy: { periodStart: "desc" },
      select: { id: true },
    });
    if (!invoice) return { status: "no_open_invoice" as const };

    const outcome = await reconcileInvoicePayment(invoice.id, { source: "tenant_poll" });
    return { status: toClientStatus(outcome) };
  });
}

function toClientStatus(outcome: ReconcileOutcome): CheckMyInvoicePaymentResult["status"] {
  switch (outcome.status) {
    case "paid":
    case "already_paid":
      return "paid";
    case "pending":
    case "no_payment":
      return "pending";
    case "throttled":
      return "throttled";
    case "payment_failed":
      return "payment_failed";
    case "not_open":
    case "voided_invoice_paid":
      return "no_open_invoice";
    case "error":
      return "unavailable";
  }
}

// ---------------------------------------------------------------------------
// Cancelamento pelo painel (Termos §9) — só OWNER; ver `cancellation.ts` e docs/contratos.md
// ---------------------------------------------------------------------------

const cancelSchema = z.object({ reason: z.string().max(CANCEL_REASON_MAX_LENGTH).optional() });

const CANCEL_LIMIT = 5;
const CANCEL_WINDOW_MS = 10 * 60 * 1000;

/** Cancela (agenda, ou imediato se suspensa/atrasada). `reason` é texto livre opcional (até 500). Idempotente. */
export async function cancelSubscriptionAction(tenantSlug: string, input: unknown): Promise<Result<CancelResult>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug, ["OWNER"]);
    const { tenant } = ctx;
    const data = cancelSchema.parse(input ?? {});
    const rateLimit = checkRateLimit(`cancel-subscription:${tenant.id}`, CANCEL_LIMIT, CANCEL_WINDOW_MS);
    if (!rateLimit.allowed) {
      throw new DomainError("RATE_LIMITED", "Muitas tentativas. Aguarde alguns minutos antes de tentar de novo.", { retryAfterMs: rateLimit.retryAfterMs });
    }
    const result = await requestCancellation(tenant.id, { reason: data.reason });
    if (!result.alreadyRequested) {
      // O motivo é texto livre do cliente: não entra no histórico (só o fato e o modo).
      await recordAudit({
        tenantId: tenant.id,
        actor: memberActor(ctx),
        action: "subscription.cancel_requested",
        targetType: "subscription",
        summary: result.mode === "IMMEDIATE" ? "Cancelou a assinatura (valeu na hora)." : "Pediu o cancelamento da assinatura (vale ao fim do período pago).",
        changes: { acessoAte: { de: null, para: result.endsAt } },
      });
    }
    return result;
  });
}

/** Desfaz o cancelamento agendado, até a data em que o acesso termina. */
export async function undoCancellationAction(tenantSlug: string): Promise<Result<{ undone: boolean }>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug, ["OWNER"]);
    const { tenant } = ctx;
    const rateLimit = checkRateLimit(`undo-cancellation:${tenant.id}`, CANCEL_LIMIT, CANCEL_WINDOW_MS);
    if (!rateLimit.allowed) {
      throw new DomainError("RATE_LIMITED", "Muitas tentativas. Aguarde alguns minutos antes de tentar de novo.", { retryAfterMs: rateLimit.retryAfterMs });
    }
    const result = await undoCancellation(tenant.id);
    if (result.undone) {
      await recordAudit({ tenantId: tenant.id, actor: memberActor(ctx), action: "subscription.cancel_undone", targetType: "subscription", summary: "Desfez o cancelamento da assinatura." });
    }
    return result;
  });
}

/** Reativa uma assinatura já cancelada: devolve a fatura (com Pix) a pagar; ao pagar, volta a `ACTIVE`. */
export async function reactivateSubscriptionAction(tenantSlug: string): Promise<Result<{ invoiceId: string }>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug, ["OWNER"]);
    const { tenant } = ctx;
    const rateLimit = checkRateLimit(`reactivate-subscription:${tenant.id}`, CANCEL_LIMIT, CANCEL_WINDOW_MS);
    if (!rateLimit.allowed) {
      throw new DomainError("RATE_LIMITED", "Muitas tentativas. Aguarde alguns minutos antes de tentar de novo.", { retryAfterMs: rateLimit.retryAfterMs });
    }
    const result = await startReactivation(tenant.id);
    await recordAudit({
      tenantId: tenant.id,
      actor: memberActor(ctx),
      action: "subscription.reactivation_started",
      targetType: "subscription",
      targetId: result.invoiceId,
      summary: "Pediu a reativação da assinatura (fatura gerada para pagamento).",
    });
    return result;
  });
}
