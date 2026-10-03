import { addMonths } from "date-fns";
import { getPrisma } from "@/lib/db/prisma";
import { DomainError } from "@/lib/errors";
import {
  addDaysToLocalDate,
  asBillingCycle,
  billingEventLabel,
  DEFAULT_BILLING_TIMEZONE,
  effectiveStatus,
  grossCentsFor,
  localDateOf,
  mrrContributionCents,
  noticeTimelineLabel,
  PLAN_PRICES_SELECT,
  safeTimezone,
  startOfLocalDay,
  type BillingCycle,
  type SubscriptionStatus,
} from "@/core/billing";
import { listInvoicesAdmin, type AdminInvoiceListItem } from "./admin-service";
import { maskEmail } from "./dunning/outbox";
import { DEFAULT_PAGE_SIZE, pageInfoOf, resolvePage, type PageInfo, type PageSize } from "./paging";

/**
 * Visão financeira do Admin (docs/regua-de-cobranca.md §3). Só I/O: a checagem `requirePlatformAdmin` fica em
 * `finance-actions.ts`. Todas as somas de mês usam o fuso `America/Sao_Paulo` (corrige o R14 do plano: o mês do
 * servidor deslocava a virada de mês).
 */

const FINANCE_TIMEZONE = DEFAULT_BILLING_TIMEZONE;
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Fuso: limites do mês local
// ---------------------------------------------------------------------------

/** Primeiro instante do mês local de `now` e dos meses vizinhos. */
export function monthBounds(now: Date, timezone: string = FINANCE_TIMEZONE): { lastStart: Date; start: Date; nextStart: Date } {
  const tz = safeTimezone(timezone);
  const today = localDateOf(now, tz); // YYYY-MM-DD
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const first = (y: number, m: number) => startOfLocalDay(`${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-01`, tz);
  const prev = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
  const next = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  return { lastStart: first(prev.y, prev.m), start: first(year, month), nextStart: first(next.y, next.m) };
}

// ---------------------------------------------------------------------------
// Visão geral
// ---------------------------------------------------------------------------

export type FinanceOverview = {
  asOf: string;
  mrrCents: number;
  subscribers: { trialing: number; active: number; pastDue: number; suspended: number; canceledThisMonth: number };
  receivedThisMonthCents: number;
  receivedLastMonthCents: number;
  upcoming: { next7: { count: number; cents: number }; next30: { count: number; cents: number } };
  delinquency: { count: number; cents: number; over30DaysCount: number };
  churn: {
    canceledCount: number;
    voluntary: number;
    involuntary: number;
    ratePct: number | null;
    /** Cancelamentos de quem JÁ HAVIA pago (numerador do `ratePct`; teste não convertido fica de fora). */
    payingCanceledCount: number;
    /** Pagantes (já pagaram e não estavam cancelados) no início do mês: denominador do `ratePct`. */
    baseAtMonthStart: number;
  };
  recoveredThisMonth: { count: number; cents: number };
  /** Eventos anteriores à F6 vêm de uma carga inicial aproximada: a tela deve avisar que o churn do passado é estimado. */
  approximateHistory: { hasBackfilledEvents: boolean };
};

function readMeta(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>) : {};
}

export async function getFinanceOverview(now: Date = new Date()): Promise<FinanceOverview> {
  const prisma = getPrisma();
  const { lastStart, start, nextStart } = monthBounds(now);
  const in7 = new Date(now.getTime() + 7 * DAY_MS);
  const in30 = new Date(now.getTime() + 30 * DAY_MS);
  const over30 = new Date(now.getTime() - 30 * DAY_MS);
  const delinquentWhere = { status: "OPEN", isTrialConversion: false, subscription: { firstPaidAt: { not: null }, status: { not: "CANCELED" } } } as const;

  const [receivedThis, receivedLast, delinquent, delinquentOver30, liveSubscriptions, canceledThisMonth, canceledEvents, recoveredEvents, base, backfilled] =
    await Promise.all([
      prisma.invoice.aggregate({ _sum: { amountCents: true }, where: { status: "PAID", paidAt: { gte: start, lt: nextStart } } }),
      prisma.invoice.aggregate({ _sum: { amountCents: true }, where: { status: "PAID", paidAt: { gte: lastStart, lt: start } } }),
      // Inadimplência: fatura OPEN vencida de quem JÁ PAGOU alguma vez (regra do dono: teste não entra).
      prisma.invoice.aggregate({ _sum: { amountCents: true }, _count: { _all: true }, where: { ...delinquentWhere, dueAt: { lt: now } } }),
      prisma.invoice.count({ where: { ...delinquentWhere, dueAt: { lt: over30 } } }),
      // O status EFETIVO depende de fuso e carência (função pura): uma leitura estreita das assinaturas vivas, sem join pesado.
      prisma.subscription.findMany({
        where: { status: { not: "CANCELED" } },
        select: {
          status: true,
          trialEndsAt: true,
          currentPeriodEnd: true,
          firstPaidAt: true,
          cancelAtPeriodEnd: true,
          manualSuspendedAt: true,
          tenant: { select: { timezone: true } },
          billingCycle: true,
          plan: { select: PLAN_PRICES_SELECT },
        },
      }),
      prisma.subscription.count({ where: { canceledAt: { gte: start, lt: nextStart } } }),
      prisma.billingEvent.findMany({
        where: { type: "CANCELED", createdAt: { gte: start, lt: nextStart } },
        select: { metadata: true, subscription: { select: { firstPaidAt: true } } },
      }),
      prisma.billingEvent.findMany({
        where: { type: "PAYMENT_CONFIRMED", fromStatus: { in: ["PAST_DUE", "SUSPENDED"] }, createdAt: { gte: start, lt: nextStart } },
        select: { metadata: true },
      }),
      prisma.subscription.count({
        where: { firstPaidAt: { not: null, lt: start }, OR: [{ canceledAt: null }, { canceledAt: { gte: start } }] },
      }),
      prisma.billingEvent.findFirst({ where: { metadata: { path: ["backfill"], equals: true } }, select: { id: true } }),
    ]);

  let mrrCents = 0;
  const subscribers = { trialing: 0, active: 0, pastDue: 0, suspended: 0, canceledThisMonth };
  const upcoming = { next7: { count: 0, cents: 0 }, next30: { count: 0, cents: 0 } };
  for (const s of liveSubscriptions) {
    const status: SubscriptionStatus = effectiveStatus(
      {
        status: s.status,
        trialEndsAt: s.trialEndsAt,
        currentPeriodEnd: s.currentPeriodEnd,
        firstPaidAt: s.firstPaidAt,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        timezone: s.tenant.timezone,
        manualSuspendedAt: s.manualSuspendedAt,
      },
      now,
    );
    if (status === "TRIALING") subscribers.trialing += 1;
    else if (status === "ACTIVE") subscribers.active += 1;
    else if (status === "PAST_DUE") subscribers.pastDue += 1;
    else if (status === "SUSPENDED") subscribers.suspended += 1;

    // MRR: quem paga (já pagou alguma vez) e está ACTIVE ou PAST_DUE. Teste e suspensas ficam de fora.
    const paying = s.firstPaidAt !== null;
    // MRR: preço do período / meses do ciclo (trimestral /3, semestral /6, anual /12).
    const cycle = asBillingCycle(s.billingCycle);
    if (paying && (status === "ACTIVE" || status === "PAST_DUE")) mrrCents += mrrContributionCents(s.plan, cycle);

    // Próximas renovações: ACTIVE pagante sem cancelamento agendado, pelo fim do período corrente (30 dias é cumulativo).
    if (paying && status === "ACTIVE" && !s.cancelAtPeriodEnd && s.currentPeriodEnd >= now) {
      // Renovação é caixa: o valor cheio do período (3, 6 ou 12 meses), não o equivalente mensal do MRR.
      const renewalCents = grossCentsFor(s.plan, cycle);
      if (s.currentPeriodEnd < in7) {
        upcoming.next7.count += 1;
        upcoming.next7.cents += renewalCents;
      }
      if (s.currentPeriodEnd < in30) {
        upcoming.next30.count += 1;
        upcoming.next30.cents += renewalCents;
      }
    }
  }

  let voluntary = 0;
  let involuntary = 0;
  let payingCanceled = 0;
  for (const event of canceledEvents) {
    const source = readMeta(event.metadata).cancelSource;
    if (source === "OWNER") voluntary += 1;
    else involuntary += 1; // AUTO_SUSPENDED, TRIAL_NOT_CONVERTED e ADMIN: a decisão não foi do cliente
    if (event.subscription.firstPaidAt !== null) payingCanceled += 1;
  }

  let recoveredCents = 0;
  for (const event of recoveredEvents) {
    const amount = readMeta(event.metadata).amountCents;
    if (typeof amount === "number") recoveredCents += amount;
  }

  return {
    asOf: now.toISOString(),
    mrrCents,
    subscribers,
    receivedThisMonthCents: receivedThis._sum.amountCents ?? 0,
    receivedLastMonthCents: receivedLast._sum.amountCents ?? 0,
    upcoming,
    delinquency: { count: delinquent._count._all, cents: delinquent._sum.amountCents ?? 0, over30DaysCount: delinquentOver30 },
    churn: {
      canceledCount: canceledEvents.length,
      voluntary,
      involuntary,
      ratePct: base > 0 ? Math.round((payingCanceled / base) * 1000) / 10 : null,
      payingCanceledCount: payingCanceled,
      baseAtMonthStart: base,
    },
    recoveredThisMonth: { count: recoveredEvents.length, cents: recoveredCents },
    approximateHistory: { hasBackfilledEvents: backfilled !== null },
  };
}

// ---------------------------------------------------------------------------
// Detalhe da empresa
// ---------------------------------------------------------------------------

export type CompanyBilling = {
  company: {
    id: string;
    name: string;
    slug: string;
    planName: string;
    billingCycle: BillingCycle;
    couponCode: string | null;
    status: SubscriptionStatus;
    currentPeriodEnd: string;
    firstPaidAt: string | null;
    billingEmailMasked: string | null;
    billingWhatsappMasked: string | null;
    whatsappOptIn: boolean;
  };
  invoices: AdminInvoiceListItem[];
  lifetimeValueCents: number;
};

const COMPANY_INVOICES_LIMIT = 100 as const;

export async function getCompanyBilling(tenantId: string, now: Date = new Date()): Promise<CompanyBilling> {
  const prisma = getPrisma();
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      id: true,
      name: true,
      slug: true,
      timezone: true,
      billingEmail: true,
      billingWhatsappE164: true,
      billingWhatsappOptOutAt: true,
      subscription: {
        select: { status: true, trialEndsAt: true, currentPeriodEnd: true, firstPaidAt: true, cancelAtPeriodEnd: true, manualSuspendedAt: true, billingCycle: true, coupon: { select: { code: true } }, plan: { select: { name: true } } },
      },
    },
  });
  if (!tenant || !tenant.subscription) throw new DomainError("NOT_FOUND", "Empresa não encontrada.");
  const sub = tenant.subscription;

  const [invoices, lifetime] = await Promise.all([
    listInvoicesAdmin({ tenantId, pageSize: COMPANY_INVOICES_LIMIT }),
    prisma.invoice.aggregate({ _sum: { amountCents: true }, where: { status: "PAID", subscription: { tenantId } } }),
  ]);

  const phone = tenant.billingWhatsappE164;
  return {
    company: {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      planName: sub.plan.name,
      billingCycle: asBillingCycle(sub.billingCycle),
      couponCode: sub.coupon?.code ?? null,
      status: effectiveStatus({ ...sub, timezone: tenant.timezone }, now),
      currentPeriodEnd: sub.currentPeriodEnd.toISOString(),
      firstPaidAt: sub.firstPaidAt?.toISOString() ?? null,
      billingEmailMasked: tenant.billingEmail ? maskEmail(tenant.billingEmail) : null,
      billingWhatsappMasked: phone ? `${phone.slice(0, 4)}****${phone.slice(-4)}` : null,
      // WhatsApp ativo para todos com opt-out (decisão D5): "opt-in" = tem número e não pediu para sair.
      whatsappOptIn: phone !== null && tenant.billingWhatsappOptOutAt === null,
    },
    invoices: invoices.items,
    lifetimeValueCents: lifetime._sum.amountCents ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Paginação por página (compartilhada com o registro de envios)
// ---------------------------------------------------------------------------

/**
 * Fora do registro: as linhas `SKIPPED/LEGACY_SENT` são só a marca de "o motor antigo já enviou" (migração de dados),
 * não um envio novo. Escrito com OR explícito porque `NOT` do SQL descarta `skippedReason` nulo.
 */
export const NOT_LEGACY_NOTICE = { OR: [{ skippedReason: null }, { skippedReason: { not: "LEGACY_SENT" } }] };

// ---------------------------------------------------------------------------
// Linha do tempo (avisos + eventos)
// ---------------------------------------------------------------------------

export type TimelineItem = {
  at: string;
  kind: "NOTICE" | "EVENT";
  label: string;
  id: string;
  // NOTICE
  noticeId?: string;
  step?: string;
  channel?: "EMAIL" | "WHATSAPP";
  status?: string;
  skipReason?: string | null;
  recipientMasked?: string | null;
  /** Destino completo (só avisos posteriores à F6; o Admin da plataforma é o controlador). */
  recipient?: string | null;
  attempts?: number;
  // EVENT
  type?: string;
  from?: string | null;
  to?: string | null;
  actor?: "SYSTEM" | "OWNER" | "ADMIN";
};

export async function listCompanyBillingTimeline(
  tenantId: string,
  params: { page?: number; pageSize?: PageSize } = {},
): Promise<{ items: TimelineItem[] } & PageInfo> {
  const prisma = getPrisma();
  const pageSize = params.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!(await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }))) throw new DomainError("NOT_FOUND", "Empresa não encontrada.");

  const noticeWhere = { AND: [{ tenantId }, NOT_LEGACY_NOTICE] };
  const [noticeCount, eventCount] = await Promise.all([prisma.billingNotice.count({ where: noticeWhere }), prisma.billingEvent.count({ where: { tenantId } })]);
  const info = resolvePage(params.page, pageSize, noticeCount + eventCount);

  // As duas fontes têm ordem própria (instante desc, id desc): a página N da união está dentro das primeiras
  // `skip + pageSize` linhas de CADA fonte, então busca esse prefixo, funde e corta.
  const take = info.skip + info.pageSize;
  const [notices, events] = await Promise.all([
    prisma.billingNotice.findMany({ where: noticeWhere, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take }),
    prisma.billingEvent.findMany({ where: { tenantId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take }),
  ]);

  type Sortable = { sortAt: Date; id: string; item: TimelineItem };
  const merged: Sortable[] = [
    ...notices.map(
      (n): Sortable => ({
        sortAt: n.updatedAt,
        id: n.id,
        item: {
          at: (n.sentAt ?? n.updatedAt).toISOString(),
          kind: "NOTICE",
          id: n.id,
          noticeId: n.id,
          label: noticeTimelineLabel(n.step, n.channel, n.status, n.skippedReason),
          step: n.step,
          channel: n.channel === "WHATSAPP" ? "WHATSAPP" : "EMAIL",
          status: n.status,
          skipReason: n.skippedReason,
          recipientMasked: n.recipientMasked,
          recipient: n.recipient,
          attempts: n.attempts,
        },
      }),
    ),
    ...events.map((e): Sortable => {
      const actor = e.actorType === "ADMIN" ? "ADMIN" : e.actorType === "OWNER" ? "OWNER" : "SYSTEM";
      return {
        sortAt: e.createdAt,
        id: e.id,
        item: {
          at: e.createdAt.toISOString(),
          kind: "EVENT",
          id: e.id,
          type: e.type,
          from: e.fromStatus,
          to: e.toStatus,
          actor,
          label: billingEventLabel(e.type, { from: e.fromStatus, to: e.toStatus, actor }),
        },
      };
    }),
  ];
  merged.sort((x, y) => y.sortAt.getTime() - x.sortAt.getTime() || (x.id < y.id ? 1 : x.id > y.id ? -1 : 0));
  return { items: merged.slice(info.skip, info.skip + info.pageSize).map((m) => m.item), ...pageInfoOf(info) };
}

// ---------------------------------------------------------------------------
// Período do CSV (12 meses, fuso de São Paulo)
// ---------------------------------------------------------------------------

export const CSV_MAX_MONTHS = 12;

/**
 * Resolve `[from, toExclusive)` do CSV no fuso local. `from`/`to` são datas "YYYY-MM-DD" inclusivas.
 * Padrão: os últimos 12 meses terminando hoje. Passou de 12 meses: `INVALID_PAYLOAD` (nunca trunca em silêncio).
 */
export function resolveCsvRange(
  input: { from?: string; to?: string },
  now: Date = new Date(),
): { from: Date; toExclusive: Date; fromDate: string; toDate: string } {
  const toDate = input.to ?? localDateOf(now, FINANCE_TIMEZONE);
  const toExclusive = startOfLocalDay(addDaysToLocalDate(toDate, 1), FINANCE_TIMEZONE);
  const fromDate = input.from ?? localDateOf(addMonths(toExclusive, -CSV_MAX_MONTHS), FINANCE_TIMEZONE);
  const from = startOfLocalDay(fromDate, FINANCE_TIMEZONE);
  if (Number.isNaN(from.getTime()) || Number.isNaN(toExclusive.getTime())) throw new DomainError("INVALID_PAYLOAD", "Data inválida.");
  if (from >= toExclusive) throw new DomainError("INVALID_PAYLOAD", "A data inicial precisa ser anterior à final.");
  if (addMonths(from, CSV_MAX_MONTHS) < toExclusive) {
    throw new DomainError("INVALID_PAYLOAD", `O período do arquivo é de no máximo ${CSV_MAX_MONTHS} meses.`);
  }
  return { from, toExclusive, fromDate, toDate };
}
