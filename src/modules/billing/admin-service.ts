import { addMonths } from "date-fns";
import { getPrisma } from "@/lib/db/prisma";
import { DomainError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { effectiveStatus, GRACE_DAYS_PAYING, GRACE_DAYS_TRIAL, usesTrialRules } from "@/core/billing";
import { recordBillingEvent } from "./dunning/events";
import { applyInvoicePayment, findBillingRecipientEmail, regeneratePixForInvoice as regeneratePixForInvoiceService } from "./service";
import type { MercadoPagoGateway } from "./mercadopago";
import type { InvoiceStatus } from "@/lib/db/types";
import { DEFAULT_PAGE_SIZE, pageInfoOf, resolvePage, type PageInfo, type PageSize } from "./paging";

/**
 * Admin de planos e empresas (docs/arquitetura.md §9, Fase 7). Guardado por
 * `requirePlatformAdmin()` na camada de Server Action (`admin-actions.ts`) — este arquivo é só
 * I/O, sem checagem de permissão (assume que quem chamou já validou).
 */

// ---------------------------------------------------------------------------
// Planos
// ---------------------------------------------------------------------------

export async function listPlans() {
  return getPrisma().plan.findMany({ orderBy: { sortOrder: "asc" } });
}

export type UpdatePlanInput = {
  name?: string;
  priceCents?: number;
  maxWhatsappNumbers?: number;
  maxProfessionals?: number | null;
  active?: boolean;
  sortOrder?: number;
};

export async function updatePlan(planId: string, input: UpdatePlanInput) {
  const existing = await getPrisma().plan.findUnique({ where: { id: planId } });
  if (!existing) throw new DomainError("NOT_FOUND", "Plano não encontrado.");
  return getPrisma().plan.update({ where: { id: planId }, data: input });
}

// ---------------------------------------------------------------------------
// Empresas (lista com status efetivo, suspender/reativar, estender trial)
// ---------------------------------------------------------------------------

export type CompanyListItem = {
  tenantId: string;
  slug: string;
  name: string;
  planCode: string;
  persistedStatus: string;
  effectiveStatus: string;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date;
};

/** Sempre paginado por página (nunca "todas as empresas" de uma vez): ordem estável por `tenantId`. */
export async function listCompanies(params: { page?: number; pageSize?: PageSize } = {}): Promise<{ items: CompanyListItem[] } & PageInfo> {
  const prisma = getPrisma();
  const now = new Date();
  const totalItems = await prisma.subscription.count();
  const info = resolvePage(params.page, params.pageSize ?? DEFAULT_PAGE_SIZE, totalItems);

  const page = await prisma.subscription.findMany({
    skip: info.skip,
    take: info.pageSize,
    orderBy: { tenantId: "asc" },
    include: { tenant: true, plan: true },
  });

  return {
    ...pageInfoOf(info),
    items: page.map((s) => ({
      tenantId: s.tenantId,
      slug: s.tenant.slug,
      name: s.tenant.name,
      planCode: s.plan.code,
      persistedStatus: s.status,
      effectiveStatus: effectiveStatus(s, now),
      trialEndsAt: s.trialEndsAt,
      currentPeriodEnd: s.currentPeriodEnd,
    })),
  };
}

/**
 * Suspende manualmente (ex.: fraude, pedido do dono) — força `SUSPENDED` mesmo que a data de
 * vencimento ainda não tenha chegado. `effectiveStatus` é pura e só olha `currentPeriodEnd`;
 * para o efetivo bater com `SUSPENDED` sem reescrever a matemática de ciclo, empurramos
 * `currentPeriodEnd` para o passado o suficiente (vencido + carência já vencida). Isso é seguro
 * porque um pagamento futuro SEMPRE conta a partir de `paidAt` quando a assinatura estava
 * `SUSPENDED` (`computeNextPeriodEnd`), então essa data "artificial" nunca vaza para o próximo
 * ciclo cobrado.
 */
export async function suspendCompanyManually(tenantId: string, adminId?: string): Promise<void> {
  const prisma = getPrisma();
  const subscription = await prisma.subscription.findUnique({ where: { tenantId } });
  if (!subscription) throw new DomainError("NOT_FOUND", "Assinatura não encontrada.");
  if (subscription.status === "CANCELED") {
    throw new DomainError("INVALID_STATE", "Esta assinatura já está cancelada.");
  }

  const now = new Date();
  // Quem paga tem 3 dias de carência e o vencimento vai até o fim do dia local (D7): a data "artificial" precisa
  // cair antes disso com folga. Quem nunca pagou usa a regra de teste (1 dia, instante exato).
  const dayMs = 24 * 60 * 60 * 1000;
  const backDays = usesTrialRules({ status: "SUSPENDED", firstPaidAt: subscription.firstPaidAt }) ? GRACE_DAYS_TRIAL + 1 : GRACE_DAYS_PAYING + 2;
  const pastDueAt = new Date(now.getTime() - backDays * dayMs);

  // O evento MANUAL_SUSPEND vem ANTES da mudança: é ele que diz à régua "isto não é atraso, não cobre". Se o
  // update falhar, sobra um evento órfão que nunca casa com um `currentPeriodEnd` real (inofensivo).
  await recordBillingEvent({
    tenantId,
    subscriptionId: subscription.id,
    type: "MANUAL_SUSPEND",
    fromStatus: subscription.status,
    toStatus: "SUSPENDED",
    actorType: "ADMIN",
    actorUserId: adminId ?? null,
    metadata: { currentPeriodEnd: pastDueAt.toISOString() },
  });
  await prisma.subscription.update({
    where: { tenantId },
    // `manualSuspendedAt` é o marcador ROBUSTO da suspensão manual (status efetivo e régua o respeitam); o evento
    // MANUAL_SUSPEND continua como histórico/auditoria.
    data: { status: "SUSPENDED", currentPeriodEnd: pastDueAt, trialEndsAt: null, manualSuspendedAt: now },
  });
}

/** Reativa manualmente: volta para `ACTIVE` com um ciclo novo de 1 mês a partir de hoje. */
export async function reactivateCompanyManually(tenantId: string, adminId?: string): Promise<void> {
  const prisma = getPrisma();
  const subscription = await prisma.subscription.findUnique({ where: { tenantId } });
  if (!subscription) throw new DomainError("NOT_FOUND", "Assinatura não encontrada.");

  const now = new Date();
  await prisma.$transaction([
    prisma.subscription.update({
      where: { tenantId },
      data: { status: "ACTIVE", currentPeriodEnd: addMonths(now, 1), trialEndsAt: null, canceledAt: null, manualSuspendedAt: null },
    }),
    // Reativação manual = o admin liberou sem cobrar: a fatura do teste (ainda OPEN, se a conta
    // estava só suspensa) é anulada — senão ficaria em "Em teste" para sempre e travaria a
    // geração das próximas faturas do tick. Faturas VOID/PAID não são tocadas.
    prisma.invoice.updateMany({
      where: { subscription: { tenantId }, status: "OPEN", isTrialConversion: true },
      data: { status: "VOID" },
    }),
  ]);
  await recordBillingEvent({
    tenantId,
    subscriptionId: subscription.id,
    type: "MANUAL_REACTIVATE",
    fromStatus: subscription.status,
    toStatus: "ACTIVE",
    actorType: "ADMIN",
    actorUserId: adminId ?? null,
  });
}

/** Estende o trial em `extraDays` dias — só válido enquanto ainda está em TRIALING. */
export async function extendTrialManually(tenantId: string, extraDays: number, adminId?: string): Promise<void> {
  if (extraDays <= 0 || extraDays > 30) {
    throw new DomainError("INVALID_PAYLOAD", "A extensão precisa ser entre 1 e 30 dias.");
  }

  const prisma = getPrisma();
  const subscription = await prisma.subscription.findUnique({ where: { tenantId } });
  if (!subscription) throw new DomainError("NOT_FOUND", "Assinatura não encontrada.");
  if (subscription.status !== "TRIALING" || !subscription.trialEndsAt) {
    throw new DomainError("INVALID_STATE", "Só é possível estender o trial enquanto a empresa está em trial.");
  }

  const newTrialEndsAt = new Date(subscription.trialEndsAt.getTime() + extraDays * 24 * 60 * 60 * 1000);
  await prisma.subscription.update({
    where: { tenantId },
    data: { trialEndsAt: newTrialEndsAt, currentPeriodEnd: newTrialEndsAt },
  });

  // A fatura do trial (única, criada no cadastro) também precisa refletir o novo vencimento —
  // senão o cliente recebe lembrete/suspensão na data antiga mesmo com o trial estendido.
  await prisma.invoice.updateMany({
    where: { subscriptionId: subscription.id, periodStart: { lte: subscription.trialEndsAt }, status: "OPEN" },
    data: { dueAt: newTrialEndsAt, periodEnd: newTrialEndsAt },
  });
  await recordBillingEvent({
    tenantId,
    subscriptionId: subscription.id,
    type: "TRIAL_EXTENDED",
    actorType: "ADMIN",
    actorUserId: adminId ?? null,
    metadata: { extraDays, trialEndsAt: newTrialEndsAt.toISOString() },
  });
}

// ---------------------------------------------------------------------------
// Admin → Cobrança (docs/contratos.md, "Admin Cobrança") — lista de faturas de TODAS as
// empresas, totais do mês, empresas inadimplentes, e as duas ações "Regerar Pix"/"Marcar como
// paga manualmente". Tudo guardado por `requirePlatformAdmin()` em `admin-actions.ts` — este
// arquivo continua só I/O.
// ---------------------------------------------------------------------------

export type AdminInvoiceListItem = {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  amountCents: number;
  status: InvoiceStatus;
  periodStart: Date;
  periodEnd: Date;
  dueAt: Date;
  paidAt: Date | null;
  hasPix: boolean;
  /** Há pagamento no Mercado Pago para conferir (`mpPaymentId`) — habilita "Conferir no Mercado Pago". */
  hasMpPayment: boolean;
  createdAt: Date;
  /** `TRIAL` = fatura do cadastro (teste); a UI rotula "Teste". */
  kind: "TRIAL" | "REGULAR";
};

export type ListInvoicesAdminParams = {
  status?: InvoiceStatus;
  tenantId?: string;
  /** Filtra por `dueAt` dentro de `[fromDate, toDate)` — período de vencimento, não de criação. */
  fromDate?: Date;
  toDate?: Date;
  page?: number;
  pageSize?: PageSize;
};

/**
 * Faturas de TODAS as empresas, paginadas por cursor (nunca "todas de uma vez" — a base pode
 * crescer sem limite com o tempo). Um único `findMany` com `include` (join no Prisma) resolve
 * `tenantName`/`tenantSlug` — sem N+1 (nunca um `findUnique` de tenant por fatura dentro de um
 * loop).
 */
export async function listInvoicesAdmin(params: ListInvoicesAdminParams = {}): Promise<{ items: AdminInvoiceListItem[] } & PageInfo> {
  const prisma = getPrisma();

  const where = {
    ...(params.status ? { status: params.status } : {}),
    ...(params.tenantId ? { subscription: { tenantId: params.tenantId } } : {}),
    ...(params.fromDate || params.toDate
      ? {
          dueAt: {
            ...(params.fromDate ? { gte: params.fromDate } : {}),
            ...(params.toDate ? { lt: params.toDate } : {}),
          },
        }
      : {}),
  };

  // `count` com os MESMOS filtros da lista; ordem estável por id (cuid, mais novo primeiro).
  const totalItems = await prisma.invoice.count({ where });
  const info = resolvePage(params.page, params.pageSize ?? DEFAULT_PAGE_SIZE, totalItems);
  const invoices = await prisma.invoice.findMany({
    where,
    skip: info.skip,
    take: info.pageSize,
    orderBy: { id: "desc" },
    include: { subscription: { include: { tenant: { select: { id: true, name: true, slug: true } } } } },
  });

  return {
    ...pageInfoOf(info),
    items: invoices.map((invoice) => ({
      id: invoice.id,
      tenantId: invoice.subscription.tenant.id,
      tenantName: invoice.subscription.tenant.name,
      tenantSlug: invoice.subscription.tenant.slug,
      amountCents: invoice.amountCents,
      status: invoice.status,
      periodStart: invoice.periodStart,
      periodEnd: invoice.periodEnd,
      dueAt: invoice.dueAt,
      paidAt: invoice.paidAt,
      hasPix: !!invoice.pixCopyPaste,
      hasMpPayment: !!invoice.mpPaymentId,
      createdAt: invoice.createdAt,
      kind: invoice.isTrialConversion ? "TRIAL" : "REGULAR",
    })),
  };
}

export type BillingMonthlyTotals = {
  receivedCents: number;
  openCents: number;
  overdueCents: number;
  /** Faturas de teste ainda não convertido (`OPEN`, conta não cancelada): card "Em teste". Nunca somam em `openCents`/`overdueCents`. */
  trialCents: number;
  trialCount: number;
  mrrCents: number;
};

/**
 * Totais para o painel do mês de `now` (docs/contratos.md, "Admin Cobrança"):
 * - `receivedCents`: soma de faturas `PAID` com `paidAt` dentro do mês de `now`.
 * - `openCents`: faturas `OPEN` ainda não vencidas (`dueAt >= now`) — não soma por mês, é o
 *   estado ATUAL do que está para vencer (uma fatura `OPEN` de qualquer mês entra aqui).
 *   Exclui a fatura de teste (`isTrialConversion`) — ela vai para `trialCents`.
 * - `overdueCents`: faturas `OPEN` já vencidas (`dueAt < now`) — o que a persistência ainda não
 *   marcou `PAST_DUE`/`SUSPENDED` pode demorar até 1h (próximo `billing/tick`); esta soma é
 *   sempre em tempo real, direto da tabela. Também exclui a fatura de teste.
 * - `trialCents`/`trialCount`: faturas `OPEN` de teste não convertido, de conta não cancelada
 *   (decisão do dono, 2026-09-29: teste não é "a receber" nem inadimplência).
 * - `mrrCents`: soma de `Plan.priceCents` de toda `Subscription` com `status = ACTIVE`
 *   (persistido, não efetivo — é a assinatura que JÁ está sendo cobrada mensalmente).
 *
 * 4 agregações (`aggregate`/`groupBy` seriam uma query cada; aqui são 3 `aggregate` de Invoice +
 * 1 de Subscription — nenhum loop carregando linha por linha para somar em memória).
 */
export async function billingMonthlyTotals(now: Date = new Date()): Promise<BillingMonthlyTotals> {
  const prisma = getPrisma();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const [received, open, overdue, trial, activeSubscriptions] = await Promise.all([
    prisma.invoice.aggregate({
      _sum: { amountCents: true },
      where: { status: "PAID", paidAt: { gte: monthStart, lt: monthEnd } },
    }),
    prisma.invoice.aggregate({
      _sum: { amountCents: true },
      where: { status: "OPEN", isTrialConversion: false, dueAt: { gte: now } },
    }),
    prisma.invoice.aggregate({
      _sum: { amountCents: true },
      where: { status: "OPEN", isTrialConversion: false, dueAt: { lt: now } },
    }),
    prisma.invoice.aggregate({
      _sum: { amountCents: true },
      _count: { _all: true },
      where: { status: "OPEN", isTrialConversion: true, subscription: { status: { not: "CANCELED" } } },
    }),
    prisma.subscription.findMany({ where: { status: "ACTIVE" }, include: { plan: true } }),
  ]);

  return {
    receivedCents: received._sum.amountCents ?? 0,
    openCents: open._sum.amountCents ?? 0,
    overdueCents: overdue._sum.amountCents ?? 0,
    trialCents: trial._sum.amountCents ?? 0,
    trialCount: trial._count._all,
    mrrCents: activeSubscriptions.reduce((sum, s) => sum + s.plan.priceCents, 0),
  };
}

export type DelinquentCompany = {
  tenantId: string;
  slug: string;
  name: string;
  status: "PAST_DUE" | "SUSPENDED";
  daysOverdue: number;
};

/**
 * Empresas pagantes (já pagaram alguma vez) com assinatura `PAST_DUE`/`SUSPENDED` (status PERSISTIDO — a reconciliação com o
 * status efetivo acontece no próximo `billing/tick`, no máximo 1h de atraso). `daysOverdue`
 * conta a partir de `currentPeriodEnd` (o vencimento do ciclo que não foi pago) — mesmo campo
 * que `effectiveStatus` usa para decidir a transição de status.
 */
export async function listDelinquentCompanies(now: Date = new Date()): Promise<DelinquentCompany[]> {
  const subscriptions = await getPrisma().subscription.findMany({
    // `firstPaidAt` não nulo: quem nunca pagou é teste não convertido, não inadimplente.
    where: { status: { in: ["PAST_DUE", "SUSPENDED"] }, firstPaidAt: { not: null } },
    include: { tenant: { select: { id: true, slug: true, name: true } } },
    orderBy: { currentPeriodEnd: "asc" },
  });

  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return subscriptions.map((s) => ({
    tenantId: s.tenant.id,
    slug: s.tenant.slug,
    name: s.tenant.name,
    status: s.status as "PAST_DUE" | "SUSPENDED",
    daysOverdue: Math.max(0, Math.floor((now.getTime() - s.currentPeriodEnd.getTime()) / MS_PER_DAY)),
  }));
}

/** "Regerar Pix" (tela Admin Cobrança) — resolve o e-mail do OWNER e reaproveita `regeneratePixForInvoice` (mesma lógica/erros da tela de Assinatura da própria empresa). */
export async function regeneratePixForInvoiceAdmin(invoiceId: string, gateway?: MercadoPagoGateway) {
  const invoice = await getPrisma().invoice.findUnique({ where: { id: invoiceId }, include: { subscription: true } });
  if (!invoice) throw new DomainError("NOT_FOUND", "Fatura não encontrada.");

  const payerEmail = await findBillingRecipientEmail(invoice.subscription.tenantId);
  if (!payerEmail) throw new DomainError("NOT_FOUND", "Nenhum e-mail de cobrança encontrado para esta empresa.");

  return regeneratePixForInvoiceService(invoiceId, payerEmail, gateway);
}

/**
 * "Marcar como paga manualmente" (tela Admin Cobrança) — mesmo efeito de `applyInvoicePayment`
 * (marca `PAID`, avança o ciclo, reativa a assinatura), mas disparada por um humano em vez do
 * webhook do Mercado Pago, com motivo obrigatório e registro de auditoria.
 *
 * Auditoria: `ProviderEvent(provider = "manual", providerEventId = invoiceId)` — reaproveita o
 * model de idempotência de webhook (docs/arquitetura.md) já existente em vez de criar uma
 * tabela nova só para isto. `payload` guarda quem/quando/por quê (`adminId`, `reason`,
 * `markedAt`); a constraint `@@unique([provider, providerEventId])` garante UM registro de
 * auditoria por fatura — a segunda chamada (dupla submissão do botão, ou fatura que já estava
 * `PAID` por outro caminho) só é detectada e devolvida como `alreadyProcessed: true`, nunca cria
 * um segundo registro nem soma um segundo mês.
 */
export async function markInvoicePaidManually(
  invoiceId: string,
  adminId: string,
  reason: string,
  now: Date = new Date(),
): Promise<{ alreadyProcessed: boolean }> {
  const prisma = getPrisma();

  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new DomainError("NOT_FOUND", "Fatura não encontrada.");

  const existingAudit = await prisma.providerEvent.findUnique({
    where: { provider_providerEventId: { provider: "manual", providerEventId: invoiceId } },
  });
  if (invoice.status === "PAID" || existingAudit) {
    return { alreadyProcessed: true };
  }
  if (invoice.status === "VOID") {
    throw new DomainError("INVALID_STATE", "Fatura anulada (teste não convertido). Para liberar a empresa, use Reativar.");
  }

  const result = await applyInvoicePayment(invoiceId, now);
  if (result.alreadyProcessed) {
    return result;
  }

  await prisma.providerEvent.create({
    data: {
      provider: "manual",
      providerEventId: invoiceId,
      payload: { invoiceId, adminId, reason, markedAt: now.toISOString() },
      processedAt: now,
    },
  });

  const owner = await prisma.subscription.findUnique({ where: { id: invoice.subscriptionId }, select: { tenantId: true } });
  if (owner) {
    await recordBillingEvent({
      tenantId: owner.tenantId,
      subscriptionId: invoice.subscriptionId,
      invoiceId,
      type: "MANUAL_PAYMENT",
      actorType: "ADMIN",
      actorUserId: adminId,
      metadata: { reason: reason.slice(0, 200) },
    });
  }
  logger.info("billing.admin.invoice_marked_paid_manually", { invoiceId, adminId });
  return { alreadyProcessed: false };
}
