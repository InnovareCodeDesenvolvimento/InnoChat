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
import { updateTenantDocument } from "@/modules/tenant/service";
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
  /** Preço do período inteiro por ciclo (`null` = o plano não oferece): a tela avisa antes de trocar para plano sem o ciclo atual. */
  quarterlyPriceCents: number | null;
  semiannualPriceCents: number | null;
  annualPriceCents: number | null;
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
      quarterlyPriceCents: p.quarterlyPriceCents,
      semiannualPriceCents: p.semiannualPriceCents,
      annualPriceCents: p.annualPriceCents,
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
    // Troca de plano durante o teste anula e recria a fatura (cancela e gera Pix no Mercado Pago): mesmo limite da troca de ciclo.
    const planLimit = checkRateLimit(`change-plan:${tenant.id}`, 10, 10 * 60 * 1000);
    if (!planLimit.allowed) {
      throw new DomainError("RATE_LIMITED", "Muitas tentativas. Tente de novo daqui a alguns minutos.", { retryAfterMs: planLimit.retryAfterMs });
    }
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

const saveDocumentSchema = z.object({ document: z.string().trim().min(1, "Informe o CPF ou CNPJ.").max(40) });

const SAVE_DOCUMENT_LIMIT = 8;
const SAVE_DOCUMENT_WINDOW_MS = 10 * 60 * 1000; // chama o Mercado Pago de verdade

export type SaveDocumentAndPixResult = {
  /** Fatura aberta que recebeu (ou já tinha) o Pix; `null` = não há fatura aberta (o documento ficou salvo). */
  invoiceId: string | null;
  /** Pix copia e cola vigente da fatura, ou `null` quando não há fatura aberta. */
  pixCopyPaste: string | null;
};

/**
 * "Informe o CPF ou CNPJ e gere o Pix" (cartão do Pix na tela Assinatura, cadastro enxuto: o documento só é pedido na
 * hora de pagar). Só OWNER. Sem `assertTenantCanWrite`, de propósito: a conta SUSPENSA precisa conseguir pagar.
 *
 * Ordem: valida e grava o documento (+ auditoria, que guarda só os 2 últimos dígitos) e SÓ DEPOIS tenta o Pix. Falha do
 * Mercado Pago volta como erro `MERCADOPAGO_*`, mas o documento já ficou salvo (a tela avisa e oferece gerar de novo).
 * Fatura aberta que já tem Pix vigente não ganha outro QR (evita dois Pix vivos para a mesma fatura).
 * Erros: `INVALID_DOCUMENT`, `RATE_LIMITED`, `NOT_FOUND` (sem e-mail de cobrança), `MERCADOPAGO_*`.
 */
export async function saveDocumentAndGeneratePixAction(tenantSlug: string, input: unknown): Promise<Result<SaveDocumentAndPixResult>> {
  return runAction(async () => {
    const ctx = await requireTenantMember(tenantSlug, ["OWNER"]);
    const { tenant } = ctx;

    const rateLimit = checkRateLimit(`save-document:${tenant.id}`, SAVE_DOCUMENT_LIMIT, SAVE_DOCUMENT_WINDOW_MS);
    if (!rateLimit.allowed) {
      throw new DomainError("RATE_LIMITED", "Muitas tentativas. Aguarde alguns minutos antes de tentar de novo.", { retryAfterMs: rateLimit.retryAfterMs });
    }

    const data = saveDocumentSchema.parse(input);
    const prisma = getPrisma();
    const before = await prisma.tenant.findUnique({ where: { id: tenant.id }, select: { document: true } });
    const updated = await updateTenantDocument(tenant.id, data.document);
    if (before?.document !== updated.document) {
      // CPF/CNPJ é dado pessoal: o histórico guarda só que mudou (e os 2 últimos dígitos), nunca o número.
      await recordAudit({
        tenantId: tenant.id,
        actor: memberActor(ctx),
        action: "settings.document_changed",
        targetType: "tenant",
        targetId: tenant.id,
        summary: before?.document ? "Alterou o CPF ou CNPJ da empresa." : "Informou o CPF ou CNPJ da empresa.",
        changes: { documento: { de: before?.document ? `final ${before.document.slice(-2)}` : null, para: `final ${updated.document!.slice(-2)}` } },
      });
    }

    // Mesma escolha da conciliação da tela: a fatura aberta mais recente da assinatura DESTA empresa.
    const invoice = await prisma.invoice.findFirst({
      where: { status: "OPEN", subscription: { tenantId: tenant.id } },
      orderBy: { periodStart: "desc" },
      select: { id: true, pixCopyPaste: true, pixExpiresAt: true },
    });
    if (!invoice) return { invoiceId: null, pixCopyPaste: null };
    if (invoice.pixCopyPaste && invoice.pixExpiresAt && invoice.pixExpiresAt > new Date()) {
      return { invoiceId: invoice.id, pixCopyPaste: invoice.pixCopyPaste };
    }

    const payerEmail = await findBillingRecipientEmail(tenant.id);
    if (!payerEmail) {
      throw new DomainError("NOT_FOUND", "Nenhum e-mail de cobrança encontrado para esta empresa. Contate o suporte.");
    }
    const withPix = await regeneratePixForInvoice(invoice.id, payerEmail);
    return { invoiceId: withPix.id, pixCopyPaste: withPix.pixCopyPaste };
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
