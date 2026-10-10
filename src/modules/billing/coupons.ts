import type { Prisma } from "@/lib/db/types";
import { getPrisma } from "@/lib/db/prisma";
import { claimCouponRedemption } from "@/lib/db/coupon-redeem";
import { lockSubscriptionRow } from "@/lib/db/billing-row-locks";
import { isUniqueViolation } from "@/lib/db/prisma-errors";
import { DomainError } from "@/lib/errors";
import type { MercadoPagoGateway } from "./mercadopago";
import { logger } from "@/lib/logger";
import {
  asBillingCycle,
  BILLING_CYCLES,
  COUPON_CODE_PATTERN,
  couponAcceptsCycle,
  couponIneligibleReason,
  CYCLE_INFO,
  effectiveCycle,
  initialCouponCycles,
  isValidCouponCode,
  normalizeCouponCode,
  normalizeCouponCycles,
  priceInvoice,
  type BillingCycle,
  type CouponDuration,
  type CouponIneligibleReason,
  type CouponKind,
  type InvoicePricing,
  type PlanPrices,
} from "@/core/billing";
import { DEFAULT_PAGE_SIZE, pageInfoOf, resolvePage, type PageInfo, type PageSize } from "./paging";

/**
 * Cupons de desconto (Melhoria 6). Regras que o código garante:
 * - Código único, MAIÚSCULO, `^[A-Z0-9_-]{3,32}$`. Cupom nunca é apagado: só desativado.
 * - Uma empresa adota um cupom uma vez (`CouponRedemption` único por cupom e empresa). As faturas
 *   descontadas depois NÃO geram outro resgate: contam em `Subscription.couponCyclesRemaining`.
 * - O uso (`redemptionsCount`) é tomado por um UPDATE condicional atômico (`claimCouponRedemption`).
 * - Desativar impede NOVAS adoções; quem já adotou segue com o desconto até acabarem os ciclos.
 * - Depois que alguém adotou, o que muda o valor para quem já adotou (tipo, valor, duração, ciclo) trava.
 */

export type CouponErrorCode =
  | "COUPON_INVALID"
  | "COUPON_NOT_STARTED"
  | "COUPON_EXPIRED"
  | "COUPON_EXHAUSTED"
  | "COUPON_WRONG_PLAN"
  | "COUPON_WRONG_CYCLE"
  | "COUPON_ALREADY_USED"
  | "COUPON_ALREADY_APPLIED";

const REASON_ERROR: Record<CouponIneligibleReason, { code: CouponErrorCode; message: string }> = {
  INACTIVE: { code: "COUPON_INVALID", message: "Esse cupom não existe ou não está mais valendo." },
  NOT_STARTED: { code: "COUPON_NOT_STARTED", message: "Esse cupom ainda não começou a valer." },
  EXPIRED: { code: "COUPON_EXPIRED", message: "Esse cupom já venceu." },
  EXHAUSTED: { code: "COUPON_EXHAUSTED", message: "Esse cupom já atingiu o limite de usos." },
  WRONG_PLAN: { code: "COUPON_WRONG_PLAN", message: "Esse cupom não vale para este plano." },
  WRONG_CYCLE: { code: "COUPON_WRONG_CYCLE", message: "Esse cupom não vale para este tipo de cobrança." },
};

/** "Esse cupom vale só para o plano trimestral." / "...para os planos trimestral e semestral." */
function wrongCycleMessage(appliesToCycles: readonly string[]): string {
  const cycles = normalizeCouponCycles(appliesToCycles);
  const words = cycles.map((c) => CYCLE_INFO[c].word);
  if (words.length === 0) return REASON_ERROR.WRONG_CYCLE.message;
  if (words.length === 1) return `Esse cupom vale só para o plano ${words[0]}.`;
  return `Esse cupom vale só para os planos ${words.slice(0, -1).join(", ")} e ${words[words.length - 1]}.`;
}

function reasonError(reason: CouponIneligibleReason, appliesToCycles: readonly string[] = []): DomainError {
  const base = REASON_ERROR[reason];
  if (reason === "WRONG_CYCLE") return new DomainError(base.code, wrongCycleMessage(appliesToCycles));
  return new DomainError(base.code, base.message);
}

type CouponRow = Prisma.CouponGetPayload<{ include: { plans: { select: { planId: true } } } }>;

function eligibilityOf(c: CouponRow) {
  return {
    active: c.active,
    validFrom: c.validFrom,
    validUntil: c.validUntil,
    maxRedemptions: c.maxRedemptions,
    redemptionsCount: c.redemptionsCount,
    appliesToCycles: c.appliesToCycles,
    planIds: c.plans.map((p) => p.planId),
  };
}

/** Única resposta pública (cadastro e prévia do cadastro) para qualquer cupom que não vale: não existe, venceu, esgotou, outro plano ou ciclo. */
export const PUBLIC_COUPON_REFUSAL = "Esse cupom não existe ou não vale para este cadastro.";

async function findCouponByCode(db: Pick<Prisma.TransactionClient, "coupon">, rawCode: string): Promise<CouponRow> {
  const code = normalizeCouponCode(rawCode);
  if (!isValidCouponCode(code)) throw new DomainError("COUPON_INVALID", "Esse cupom não existe ou não está mais valendo.");
  const coupon = await db.coupon.findUnique({ where: { code }, include: { plans: { select: { planId: true } } } });
  // Mesma resposta para "não existe" e "desativado": a tela pública não serve para descobrir códigos.
  if (!coupon) throw new DomainError("COUPON_INVALID", "Esse cupom não existe ou não está mais valendo.");
  return coupon;
}

// ---------------------------------------------------------------------------
// Prévia (validação ao vivo no cadastro e na tela de Assinatura)
// ---------------------------------------------------------------------------

export type CouponPublicInfo = {
  code: string;
  description: string | null;
  kind: CouponKind;
  value: number;
  duration: CouponDuration;
  durationCycles: number | null;
  /** Ciclos em que vale; vazio = todos. */
  appliesToCycles: BillingCycle[];
};

export type CouponPreview = { coupon: CouponPublicInfo; pricing: InvoicePricing };

function publicInfo(c: CouponRow): CouponPublicInfo {
  return {
    code: c.code,
    description: c.description,
    kind: c.kind as CouponKind,
    value: c.value,
    duration: c.duration as CouponDuration,
    durationCycles: c.durationCycles,
    appliesToCycles: normalizeCouponCycles(c.appliesToCycles),
  };
}

/**
 * Confere se o cupom vale para o plano e ciclo e mostra quanto fica a primeira fatura. Não grava nada.
 * Com `tenantId`, também avisa se a empresa já usou o cupom.
 */
export async function previewCoupon(params: {
  code: string;
  planId: string;
  cycle: BillingCycle;
  tenantId?: string;
  now?: Date;
}): Promise<CouponPreview> {
  const prisma = getPrisma();
  const now = params.now ?? new Date();
  const [coupon, plan] = await Promise.all([findCouponByCode(prisma, params.code), prisma.plan.findUnique({ where: { id: params.planId } })]);
  if (!plan) throw new DomainError("INVALID_PLAN", "Plano indisponível.");
  const cycle = effectiveCycle(plan, params.cycle);
  const reason = couponIneligibleReason(eligibilityOf(coupon), { planId: plan.id, cycle, now });
  if (reason) throw reasonError(reason, coupon.appliesToCycles);
  if (params.tenantId) {
    const used = await prisma.couponRedemption.findUnique({ where: { couponId_tenantId: { couponId: coupon.id, tenantId: params.tenantId } }, select: { id: true } });
    if (used) throw new DomainError("COUPON_ALREADY_USED", "Esta empresa já usou esse cupom.");
  }
  return { coupon: publicInfo(coupon), pricing: priceInvoice(plan, cycle, { kind: coupon.kind as CouponKind, value: coupon.value }) };
}

// ---------------------------------------------------------------------------
// Adoção (cadastro e tela de Assinatura)
// ---------------------------------------------------------------------------

export type AdoptedCoupon = {
  couponId: string;
  code: string;
  kind: CouponKind;
  value: number;
  cyclesRemaining: number | null;
};

/**
 * Dentro da transação do chamador: confere o cupom, registra o resgate da empresa e toma o uso de forma atômica.
 * Quem chama grava `couponId` e `couponCyclesRemaining` na assinatura. Qualquer falha desfaz a transação inteira.
 */
export async function adoptCouponInTx(
  tx: Prisma.TransactionClient,
  params: { code: string; tenantId: string; planId: string; cycle: BillingCycle; now: Date },
): Promise<AdoptedCoupon> {
  const coupon = await findCouponByCode(tx, params.code);
  const reason = couponIneligibleReason(eligibilityOf(coupon), { planId: params.planId, cycle: params.cycle, now: params.now });
  if (reason) throw reasonError(reason, coupon.appliesToCycles);

  // A restrição única (cupom, empresa) é o árbitro: duas ações simultâneas da mesma empresa só deixam uma passar.
  try {
    await tx.couponRedemption.create({ data: { couponId: coupon.id, tenantId: params.tenantId } });
  } catch (error) {
    if (isUniqueViolation(error)) throw new DomainError("COUPON_ALREADY_USED", "Esta empresa já usou esse cupom.");
    throw error;
  }

  // Duas empresas disputando o último uso: o UPDATE condicional deixa só uma ganhar.
  const won = await claimCouponRedemption(tx, coupon.id, params.now);
  if (!won) {
    const fresh = await tx.coupon.findUnique({ where: { id: coupon.id }, include: { plans: { select: { planId: true } } } });
    const lost = fresh ? couponIneligibleReason(eligibilityOf(fresh), { planId: params.planId, cycle: params.cycle, now: params.now }) : "INACTIVE";
    throw reasonError(lost ?? "EXHAUSTED", coupon.appliesToCycles);
  }

  return {
    couponId: coupon.id,
    code: coupon.code,
    kind: coupon.kind as CouponKind,
    value: coupon.value,
    cyclesRemaining: initialCouponCycles(coupon.duration as CouponDuration, coupon.durationCycles),
  };
}

export type CouponApplication = CouponPreview & {
  /** `true` se a fatura aberta do TESTE foi anulada e recriada já com o desconto (o Pix antigo foi cancelado). */
  trialInvoiceRepriced: boolean;
};

/**
 * Aplica um cupom à assinatura da própria empresa (tela Assinatura). Vale a partir da próxima fatura — exceto no TESTE que
 * ainda não pagou: ali a fatura aberta do fim do teste é anulada e recriada com o desconto (`trial-reprice.ts`), na mesma
 * transação, com a assinatura travada.
 */
export async function applyCouponToSubscription(tenantId: string, code: string, now: Date = new Date(), gateway?: MercadoPagoGateway): Promise<CouponApplication> {
  const prisma = getPrisma();
  const subscription = await prisma.subscription.findUnique({ where: { tenantId }, include: { plan: true } });
  if (!subscription) throw new DomainError("NOT_FOUND", "Assinatura não encontrada para esta empresa.");
  if (subscription.status === "CANCELED") throw new DomainError("INVALID_STATE", "Reative a assinatura antes de aplicar um cupom.");
  if (subscription.couponId) throw new DomainError("COUPON_ALREADY_APPLIED", "Esta empresa já tem um cupom em uso. Espere ele acabar para usar outro.");

  // Import dinâmico: `trial-reprice` importa este módulo (ciclo coupons <-> trial-reprice).
  const { afterTrialReprice, repriceTrialInvoiceInTx } = await import("./trial-reprice");
  const cycle = effectiveCycle(subscription.plan, asBillingCycle(subscription.billingCycle));
  const { adopted, reprice } = await prisma.$transaction(async (tx) => {
    // Trava a assinatura: troca de ciclo, de plano e cupom não reprecificam a fatura do teste ao mesmo tempo.
    await lockSubscriptionRow(tx, tenantId);
    const adoptedNow = await adoptCouponInTx(tx, { code, tenantId, planId: subscription.planId, cycle, now });
    // `updateMany` condicional: duas abas aplicando cupons ao mesmo tempo, só uma grava.
    const claimed = await tx.subscription.updateMany({
      where: { id: subscription.id, couponId: null },
      data: { couponId: adoptedNow.couponId, couponCyclesRemaining: adoptedNow.cyclesRemaining },
    });
    if (claimed.count !== 1) throw new DomainError("COUPON_ALREADY_APPLIED", "Esta empresa já tem um cupom em uso. Espere ele acabar para usar outro.");
    return { adopted: adoptedNow, reprice: await repriceTrialInvoiceInTx(tx, tenantId, now) };
  });
  await afterTrialReprice(reprice, tenantId, gateway);
  logger.info("billing.coupon.applied", { tenantId, couponId: adopted.couponId, trialInvoiceRepriced: reprice.repriced });
  const coupon = await prisma.coupon.findUniqueOrThrow({ where: { id: adopted.couponId }, include: { plans: { select: { planId: true } } } });
  return { coupon: publicInfo(coupon), pricing: priceInvoice(subscription.plan, cycle, { kind: adopted.kind, value: adopted.value }), trialInvoiceRepriced: reprice.repriced };
}

// ---------------------------------------------------------------------------
// Preço da próxima fatura e consumo de ciclo
// ---------------------------------------------------------------------------

export type InvoiceChargeSnapshot = InvoicePricing & { couponId: string | null; couponCode: string | null };

/**
 * Preço da fatura de uma assinatura: ciclo escolhido e cupom em vigor (se vale para o plano e o ciclo;
 * senão a fatura sai sem desconto e o ciclo do cupom NÃO é gasto). `plan` é o plano que será cobrado
 * (o pendente, quando há downgrade agendado).
 */
export async function loadInvoiceCharge(
  subscription: { couponId: string | null; billingCycle: string },
  plan: PlanPrices & { id: string },
): Promise<InvoiceChargeSnapshot> {
  const cycle = effectiveCycle(plan, asBillingCycle(subscription.billingCycle));
  const noCoupon = (): InvoiceChargeSnapshot => ({ ...priceInvoice(plan, cycle, null), couponId: null, couponCode: null });
  if (!subscription.couponId) return noCoupon();

  const coupon = await getPrisma().coupon.findUnique({ where: { id: subscription.couponId }, include: { plans: { select: { planId: true } } } });
  if (!coupon) return noCoupon();
  const planOk = coupon.plans.length === 0 || coupon.plans.some((p) => p.planId === plan.id);
  const cycleOk = couponAcceptsCycle(coupon.appliesToCycles, cycle);
  if (!planOk || !cycleOk) return noCoupon();
  const pricing = priceInvoice(plan, cycle, { kind: coupon.kind as CouponKind, value: coupon.value });
  return { ...pricing, couponId: coupon.id, couponCode: coupon.code };
}

/**
 * Dentro da transação que criou a fatura: gasta um ciclo do cupom da assinatura e marca a fatura em que o desconto
 * entrou pela primeira vez no resgate. Só gasta quando o desconto foi de fato aplicado (`discountCents > 0`).
 * `couponCyclesRemaining` nulo = para sempre (nada a gastar). Ao chegar a 0, limpa `couponId` e o contador juntos.
 */
export async function consumeCouponCycleInTx(
  tx: Prisma.TransactionClient,
  params: { subscriptionId: string; tenantId: string; couponId: string; invoiceId: string; discountCents: number },
): Promise<void> {
  if (params.discountCents <= 0) return;
  await tx.couponRedemption.updateMany({
    where: { couponId: params.couponId, tenantId: params.tenantId, invoiceId: null },
    data: { invoiceId: params.invoiceId, discountCents: params.discountCents },
  });
  await tx.subscription.updateMany({
    where: { id: params.subscriptionId, couponId: params.couponId, couponCyclesRemaining: { gt: 0 } },
    data: { couponCyclesRemaining: { decrement: 1 } },
  });
  await tx.subscription.updateMany({
    where: { id: params.subscriptionId, couponId: params.couponId, couponCyclesRemaining: 0 },
    data: { couponId: null, couponCyclesRemaining: null },
  });
}

// ---------------------------------------------------------------------------
// Admin: criar, editar, desativar, listar e ver resgates
// ---------------------------------------------------------------------------

export type CouponInput = {
  code: string;
  description?: string | null;
  kind: CouponKind;
  value: number;
  validFrom?: Date | null;
  validUntil?: Date | null;
  maxRedemptions?: number | null;
  duration: CouponDuration;
  durationCycles?: number | null;
  /** Ciclos em que vale; vazio ou os 4 = todos. */
  appliesToCycles?: readonly string[];
  /** Planos em que vale; vazio = todos. */
  planIds?: string[];
  active?: boolean;
};

const MAX_AMOUNT_CENTS = 10_000_000; // R$ 100.000,00: teto de sanidade contra erro de digitação.

function validateCouponShape(input: Pick<CouponInput, "kind" | "value" | "duration" | "durationCycles" | "validFrom" | "validUntil" | "maxRedemptions" | "description" | "appliesToCycles">) {
  if (!Number.isInteger(input.value)) throw new DomainError("INVALID_COUPON", "O valor do desconto precisa ser um número inteiro.");
  if (input.kind === "PERCENT" && (input.value < 1 || input.value > 100)) {
    throw new DomainError("INVALID_COUPON", "O desconto em porcentagem vai de 1 a 100.");
  }
  if (input.kind === "AMOUNT" && (input.value < 1 || input.value > MAX_AMOUNT_CENTS)) {
    throw new DomainError("INVALID_COUPON", "O desconto em reais precisa ser maior que zero e razoável.");
  }
  if (input.duration === "N_CYCLES") {
    if (!input.durationCycles || !Number.isInteger(input.durationCycles) || input.durationCycles < 1 || input.durationCycles > 60) {
      throw new DomainError("INVALID_COUPON", "Informe por quantas faturas o desconto vale (de 1 a 60).");
    }
  } else if (input.durationCycles !== null && input.durationCycles !== undefined) {
    throw new DomainError("INVALID_COUPON", "A quantidade de faturas só vale quando a duração é por um número de faturas.");
  }
  if (input.validFrom && input.validUntil && input.validFrom > input.validUntil) {
    throw new DomainError("INVALID_COUPON", "A data final precisa ser depois da inicial.");
  }
  if (input.appliesToCycles && input.appliesToCycles.some((c) => !(BILLING_CYCLES as readonly string[]).includes(c))) {
    throw new DomainError("INVALID_COUPON", "Algum ciclo escolhido não existe.");
  }
  if (input.maxRedemptions !== null && input.maxRedemptions !== undefined && (!Number.isInteger(input.maxRedemptions) || input.maxRedemptions < 1)) {
    throw new DomainError("INVALID_COUPON", "O limite de usos precisa ser pelo menos 1.");
  }
  if (input.description && input.description.length > 200) throw new DomainError("INVALID_COUPON", "A descrição pode ter no máximo 200 caracteres.");
}

async function assertPlansExist(planIds: string[]) {
  if (planIds.length === 0) return;
  const count = await getPrisma().plan.count({ where: { id: { in: planIds } } });
  if (count !== planIds.length) throw new DomainError("INVALID_COUPON", "Algum dos planos escolhidos não existe.");
}

export async function createCoupon(input: CouponInput, createdByUserId: string | null) {
  const code = normalizeCouponCode(input.code);
  if (!COUPON_CODE_PATTERN.test(code)) {
    throw new DomainError("INVALID_COUPON_CODE", "O código usa só letras, números, hífen e sublinhado, de 3 a 32 caracteres.");
  }
  validateCouponShape(input);
  const planIds = [...new Set(input.planIds ?? [])];
  await assertPlansExist(planIds);
  try {
    return await getPrisma().coupon.create({
      data: {
        code,
        description: input.description?.trim() || null,
        kind: input.kind,
        value: input.value,
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
        maxRedemptions: input.maxRedemptions ?? null,
        duration: input.duration,
        durationCycles: input.duration === "N_CYCLES" ? (input.durationCycles ?? null) : null,
        appliesToCycles: normalizeCouponCycles(input.appliesToCycles ?? []),
        active: input.active ?? true,
        createdByUserId,
        plans: { create: planIds.map((planId) => ({ planId })) },
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new DomainError("COUPON_CODE_TAKEN", "Já existe um cupom com esse código.");
    throw error;
  }
}

export type CouponUpdate = Omit<CouponInput, "code">;

/** O código nunca muda. Com resgates, tipo, valor, duração e ciclo ficam travados (mudariam o desconto de quem já adotou). */
export async function updateCoupon(couponId: string, input: CouponUpdate) {
  const prisma = getPrisma();
  const existing = await prisma.coupon.findUnique({ where: { id: couponId } });
  if (!existing) throw new DomainError("NOT_FOUND", "Cupom não encontrado.");
  validateCouponShape(input);
  const planIds = [...new Set(input.planIds ?? [])];
  await assertPlansExist(planIds);

  if (existing.redemptionsCount > 0) {
    const locked =
      input.kind !== existing.kind ||
      input.value !== existing.value ||
      input.duration !== existing.duration ||
      (input.durationCycles ?? null) !== existing.durationCycles ||
      normalizeCouponCycles(input.appliesToCycles ?? []).join(",") !== normalizeCouponCycles(existing.appliesToCycles).join(",");
    if (locked) {
      throw new DomainError("COUPON_LOCKED", "Esse cupom já foi usado. Tipo, valor, duração e ciclo não mudam mais. Crie outro cupom para um desconto diferente.");
    }
  }
  if (input.maxRedemptions !== null && input.maxRedemptions !== undefined && input.maxRedemptions < existing.redemptionsCount) {
    throw new DomainError("INVALID_COUPON", `O limite não pode ser menor que os ${existing.redemptionsCount} usos que já aconteceram.`);
  }

  return prisma.$transaction(async (tx) => {
    await tx.couponPlan.deleteMany({ where: { couponId } });
    if (planIds.length > 0) await tx.couponPlan.createMany({ data: planIds.map((planId) => ({ couponId, planId })) });
    return tx.coupon.update({
      where: { id: couponId },
      data: {
        description: input.description?.trim() || null,
        kind: input.kind,
        value: input.value,
        validFrom: input.validFrom ?? null,
        validUntil: input.validUntil ?? null,
        maxRedemptions: input.maxRedemptions ?? null,
        duration: input.duration,
        durationCycles: input.duration === "N_CYCLES" ? (input.durationCycles ?? null) : null,
        appliesToCycles: normalizeCouponCycles(input.appliesToCycles ?? []),
        ...(input.active === undefined ? {} : { active: input.active }),
      },
    });
  });
}

export async function setCouponActive(couponId: string, active: boolean) {
  const existing = await getPrisma().coupon.findUnique({ where: { id: couponId }, select: { id: true } });
  if (!existing) throw new DomainError("NOT_FOUND", "Cupom não encontrado.");
  return getPrisma().coupon.update({ where: { id: couponId }, data: { active } });
}

export type CouponState = "ACTIVE" | "INACTIVE" | "SCHEDULED" | "EXPIRED" | "EXHAUSTED";

export function couponStateOf(
  c: { active: boolean; validFrom: Date | null; validUntil: Date | null; maxRedemptions: number | null; redemptionsCount: number },
  now: Date,
): CouponState {
  if (!c.active) return "INACTIVE";
  if (c.validUntil && now > c.validUntil) return "EXPIRED";
  if (c.maxRedemptions !== null && c.redemptionsCount >= c.maxRedemptions) return "EXHAUSTED";
  if (c.validFrom && now < c.validFrom) return "SCHEDULED";
  return "ACTIVE";
}

export type CouponListItem = {
  id: string;
  code: string;
  description: string | null;
  kind: CouponKind;
  value: number;
  validFrom: Date | null;
  validUntil: Date | null;
  maxRedemptions: number | null;
  redemptionsCount: number;
  duration: CouponDuration;
  durationCycles: number | null;
  appliesToCycles: BillingCycle[];
  active: boolean;
  state: CouponState;
  planIds: string[];
  createdAt: Date;
};

function toListItem(c: CouponRow, now: Date): CouponListItem {
  return {
    id: c.id,
    code: c.code,
    description: c.description,
    kind: c.kind as CouponKind,
    value: c.value,
    validFrom: c.validFrom,
    validUntil: c.validUntil,
    maxRedemptions: c.maxRedemptions,
    redemptionsCount: c.redemptionsCount,
    duration: c.duration as CouponDuration,
    durationCycles: c.durationCycles,
    appliesToCycles: normalizeCouponCycles(c.appliesToCycles),
    active: c.active,
    state: couponStateOf(c, now),
    planIds: c.plans.map((p) => p.planId),
    createdAt: c.createdAt,
  };
}

/** Sempre por página (numerada). Busca por código ou descrição. `status`: ativos (flag ligada), desativados ou todos. */
export async function listCoupons(
  params: { page?: number; pageSize?: PageSize; search?: string; status?: "all" | "active" | "inactive"; now?: Date } = {},
): Promise<{ items: CouponListItem[] } & PageInfo> {
  const prisma = getPrisma();
  const now = params.now ?? new Date();
  const search = params.search?.trim().slice(0, 60);
  const where: Prisma.CouponWhereInput = {
    ...(params.status === "active" ? { active: true } : params.status === "inactive" ? { active: false } : {}),
    ...(search ? { OR: [{ code: { contains: search.toUpperCase() } }, { description: { contains: search, mode: "insensitive" as const } }] } : {}),
  };
  const totalItems = await prisma.coupon.count({ where });
  const info = resolvePage(params.page, params.pageSize ?? DEFAULT_PAGE_SIZE, totalItems);
  const rows = await prisma.coupon.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    skip: info.skip,
    take: info.pageSize,
    include: { plans: { select: { planId: true } } },
  });
  return { items: rows.map((c) => toListItem(c, now)), ...pageInfoOf(info) };
}

export type CouponRedemptionItem = {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  invoiceId: string | null;
  discountCents: number;
  createdAt: Date;
};

export async function listCouponRedemptions(
  couponId: string,
  params: { page?: number; pageSize?: PageSize } = {},
): Promise<{ coupon: CouponListItem; items: CouponRedemptionItem[] } & PageInfo> {
  const prisma = getPrisma();
  const coupon = await prisma.coupon.findUnique({ where: { id: couponId }, include: { plans: { select: { planId: true } } } });
  if (!coupon) throw new DomainError("NOT_FOUND", "Cupom não encontrado.");
  const totalItems = await prisma.couponRedemption.count({ where: { couponId } });
  const info = resolvePage(params.page, params.pageSize ?? DEFAULT_PAGE_SIZE, totalItems);
  const rows = await prisma.couponRedemption.findMany({
    where: { couponId },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    skip: info.skip,
    take: info.pageSize,
    include: { tenant: { select: { name: true, slug: true } } },
  });
  return {
    coupon: toListItem(coupon, new Date()),
    items: rows.map((r) => ({ id: r.id, tenantId: r.tenantId, tenantName: r.tenant.name, tenantSlug: r.tenant.slug, invoiceId: r.invoiceId, discountCents: r.discountCents, createdAt: r.createdAt })),
    ...pageInfoOf(info),
  };
}
