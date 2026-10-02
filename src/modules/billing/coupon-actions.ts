"use server";

import { z } from "zod";
import { requirePlatformAdmin, requireTenantMember } from "@/lib/auth/guards";
import { getPrisma } from "@/lib/db/prisma";
import { runAction, type Result } from "@/lib/result";
import { DomainError } from "@/lib/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { clientIp } from "@/lib/http/client-ip";
import { normalizeCouponCode } from "@/core/billing";
import { changeBillingCycle, type ChangeBillingCycleResult } from "./billing-cycle";
import {
  applyCouponToSubscription,
  createCoupon,
  listCoupons,
  listCouponRedemptions,
  previewCoupon,
  setCouponActive,
  updateCoupon,
  type CouponInput,
  type CouponListItem,
  type CouponPreview,
  type CouponRedemptionItem,
} from "./coupons";
import { getDefaultSignupPlan } from "./service";
import { pagingInputShape, type PageInfo, type PageSize } from "./paging";

/**
 * Server Actions de plano anual e cupons (Melhoria 6). Três portas:
 * - pública (cadastro): só PRÉVIA, com limite por IP (não serve para minerar códigos);
 * - painel da empresa: só OWNER (dinheiro da empresa);
 * - Admin: só `requirePlatformAdmin()`.
 */

const cycleSchema = z.enum(["MONTHLY", "ANNUAL"]);
const codeSchema = z.string().trim().min(1, "Digite o cupom.").max(40);
const idSchema = z.string().trim().min(1).max(64);

function assertRateLimit(scope: string, key: string, limit: number, windowMs: number) {
  const result = checkRateLimit(`${scope}:${key}`, limit, windowMs);
  if (!result.allowed) {
    throw new DomainError("RATE_LIMITED", "Muitas tentativas. Tente de novo daqui a alguns minutos.", { retryAfterMs: result.retryAfterMs });
  }
}

// ---------------------------------------------------------------------------
// Cadastro (público)
// ---------------------------------------------------------------------------

const PREVIEW_LIMIT = 20;
const PREVIEW_WINDOW_MS = 10 * 60 * 1000;

/** Única resposta pública para qualquer cupom que não vale (não existe, venceu, esgotou, outro plano ou ciclo). */
const PUBLIC_COUPON_REFUSAL = "Esse cupom não existe ou não vale para este cadastro.";

/**
 * Validação ao vivo do cupom no cadastro: vale para o plano padrão do cadastro e o ciclo escolhido? Quanto fica a 1ª fatura?
 * Rota pública: o motivo da recusa NUNCA sai daqui (vencido/esgotado/outro plano confirmaria que o código existe e
 * ajudaria a minerar códigos). Os motivos detalhados ficam para o dono logado (`previewMyCouponAction`) e para o Admin.
 */
export async function previewSignupCouponAction(input: unknown): Promise<Result<CouponPreview>> {
  return runAction(async () => {
    assertRateLimit("coupon-preview", await clientIp(), PREVIEW_LIMIT, PREVIEW_WINDOW_MS);
    const data = z.object({ code: codeSchema, billingCycle: cycleSchema.optional() }).parse(input);
    const plan = await getDefaultSignupPlan();
    try {
      return await previewCoupon({ code: data.code, planId: plan.id, cycle: data.billingCycle ?? "MONTHLY" });
    } catch (error) {
      if (error instanceof DomainError && error.code.startsWith("COUPON_")) throw new DomainError("COUPON_INVALID", PUBLIC_COUPON_REFUSAL);
      throw error;
    }
  });
}

// ---------------------------------------------------------------------------
// Painel da empresa (tela Assinatura)
// ---------------------------------------------------------------------------

const MY_COUPON_LIMIT = 10;
const MY_COUPON_WINDOW_MS = 10 * 60 * 1000;

export async function previewMyCouponAction(tenantSlug: string, input: unknown): Promise<Result<CouponPreview>> {
  return runAction(async () => {
    const { tenant } = await requireTenantMember(tenantSlug, ["OWNER"]);
    assertRateLimit("coupon-my", tenant.id, MY_COUPON_LIMIT, MY_COUPON_WINDOW_MS);
    const data = z.object({ code: codeSchema }).parse(input);
    const subscription = await getPrisma().subscription.findUnique({ where: { tenantId: tenant.id }, select: { planId: true, billingCycle: true } });
    if (!subscription) throw new DomainError("NOT_FOUND", "Assinatura não encontrada para esta empresa.");
    return previewCoupon({ code: data.code, planId: subscription.planId, cycle: subscription.billingCycle === "ANNUAL" ? "ANNUAL" : "MONTHLY", tenantId: tenant.id });
  });
}

/** Aplica o cupom à assinatura: vale a partir da próxima fatura a ser gerada. */
export async function applyMyCouponAction(tenantSlug: string, input: unknown): Promise<Result<CouponPreview>> {
  return runAction(async () => {
    const { tenant } = await requireTenantMember(tenantSlug, ["OWNER"]);
    assertRateLimit("coupon-my", tenant.id, MY_COUPON_LIMIT, MY_COUPON_WINDOW_MS);
    const data = z.object({ code: codeSchema }).parse(input);
    return applyCouponToSubscription(tenant.id, data.code);
  });
}

/** Troca mensal <-> anual; vale a partir da próxima fatura, sem proporcional. */
export async function changeBillingCycleAction(tenantSlug: string, input: unknown): Promise<Result<ChangeBillingCycleResult>> {
  return runAction(async () => {
    const { tenant } = await requireTenantMember(tenantSlug, ["OWNER"]);
    assertRateLimit("billing-cycle", tenant.id, MY_COUPON_LIMIT, MY_COUPON_WINDOW_MS);
    const data = z.object({ cycle: cycleSchema }).parse(input);
    return changeBillingCycle(tenant.id, data.cycle);
  });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/** "2026-11-30" -> início do dia em Brasília (UTC-3, sem horário de verão desde 2019). */
function startOfDayBr(date: string): Date {
  return new Date(`${date}T00:00:00-03:00`);
}
function endOfDayBr(date: string): Date {
  return new Date(`${date}T23:59:59.999-03:00`);
}
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a data no formato AAAA-MM-DD.");

const couponFieldsShape = {
  description: z.string().trim().max(200).nullable().optional(),
  kind: z.enum(["PERCENT", "AMOUNT"]),
  value: z.coerce.number().int(),
  validFrom: dateOnly.nullable().optional(),
  validUntil: dateOnly.nullable().optional(),
  maxRedemptions: z.coerce.number().int().min(1).max(1_000_000).nullable().optional(),
  duration: z.enum(["ONCE", "N_CYCLES", "FOREVER"]),
  durationCycles: z.coerce.number().int().nullable().optional(),
  appliesToCycle: z.enum(["ANY", "MONTHLY", "ANNUAL"]),
  planIds: z.array(idSchema).max(50).optional(),
  active: z.boolean().optional(),
};

function toUpdateInput(data: z.infer<z.ZodObject<typeof couponFieldsShape>>): Omit<CouponInput, "code"> {
  return {
    description: data.description ?? null,
    kind: data.kind,
    value: data.value,
    validFrom: data.validFrom ? startOfDayBr(data.validFrom) : null,
    validUntil: data.validUntil ? endOfDayBr(data.validUntil) : null,
    maxRedemptions: data.maxRedemptions ?? null,
    duration: data.duration,
    durationCycles: data.durationCycles ?? null,
    appliesToCycle: data.appliesToCycle,
    planIds: data.planIds ?? [],
    active: data.active,
  };
}

const createSchema = z.object({ code: z.string().trim().min(1).max(40), ...couponFieldsShape });
const updateSchema = z.object(couponFieldsShape);
const listSchema = z.object({
  ...pagingInputShape,
  search: z.string().trim().max(60).optional(),
  status: z.enum(["all", "active", "inactive"]).optional(),
});

export async function listCouponsAction(input?: unknown): Promise<Result<{ items: CouponListItem[] } & PageInfo>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    const data = listSchema.parse(input ?? {});
    return listCoupons({ page: data.page, pageSize: data.pageSize as PageSize | undefined, search: data.search, status: data.status });
  });
}

export async function createCouponAction(input: unknown): Promise<Result<{ id: string; code: string }>> {
  return runAction(async () => {
    const admin = await requirePlatformAdmin();
    const data = createSchema.parse(input);
    const created = await createCoupon({ code: normalizeCouponCode(data.code), ...toUpdateInput(data) }, admin.id);
    return { id: created.id, code: created.code };
  });
}

export async function updateCouponAction(couponId: string, input: unknown): Promise<Result<{ id: string }>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    const data = updateSchema.parse(input);
    const updated = await updateCoupon(idSchema.parse(couponId), toUpdateInput(data));
    return { id: updated.id };
  });
}

export async function setCouponActiveAction(couponId: string, input: unknown): Promise<Result<{ id: string; active: boolean }>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    const data = z.object({ active: z.boolean() }).parse(input);
    const updated = await setCouponActive(idSchema.parse(couponId), data.active);
    return { id: updated.id, active: updated.active };
  });
}

export async function listCouponRedemptionsAction(
  couponId: string,
  input?: unknown,
): Promise<Result<{ coupon: CouponListItem; items: CouponRedemptionItem[] } & PageInfo>> {
  return runAction(async () => {
    await requirePlatformAdmin();
    const data = z.object(pagingInputShape).parse(input ?? {});
    return listCouponRedemptions(idSchema.parse(couponId), { page: data.page, pageSize: data.pageSize as PageSize | undefined });
  });
}
