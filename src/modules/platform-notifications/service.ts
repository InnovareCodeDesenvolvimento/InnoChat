import { getPrisma } from "@/lib/db/prisma";
import { DomainError } from "@/lib/errors";
import { GRACE_DAYS_PAYING, subscriptionBoundaries } from "@/core/billing";
import type { AdminNotification } from "./types";
import { loadPlatformWhatsappItems } from "./platform-whatsapp-items";
import { BILLING_TICK_DOWN_AFTER_MINUTES, BILLING_NOTICE_STUCK_AFTER_MINUTES } from "@/core/billing/billing-health";
import { stuckNoticesWhere } from "@/modules/billing/health";

/**
 * Central de notificações do ADMIN da plataforma — mesmo desenho da central do tenant
 * (`src/modules/notifications/service.ts`): DERIVADA do estado existente, sem tabela Notification.
 *
 * - Janela de 30 dias (exceto TICK_LATE, que vale enquanto o tick estiver atrasado).
 * - Ids estáveis (`<tipo>:<chave>`): a leitura individual (`PlatformNotificationRead`) sobrevive
 *   a recargas; "marcar todas" = `User.platformNotificationsReadAllAt` (tudo com createdAt <= ele).
 * - Poll barato: 1 leitura do usuário + 1 consulta pequena e limitada por fonte (SOURCE_CAP),
 *   já filtrada por data/estado a partir de `max(janela, min(since, readAllAt))`, + 1 leitura de
 *   reads. Sem N+1 (tenant vem por select aninhado).
 * - createdAt de cada tipo vem de um instante REAL do estado (paidAt, disconnectedAt, ...); para
 *   suspensão (sem coluna própria) é o fim da carência (`subscriptionBoundaries().graceEndsAt`: 3 dias de quem paga, 1 de teste), estável até o próximo pagamento.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 30 * DAY_MS;
const PAGE_SIZE = 20;
const POLL_MAX = 10;
const SOURCE_CAP = 100;
const TRIAL_WARN_MS = DAY_MS;
// Mesma regra da tela Saúde (`health-service.ts`): billing 2h, maintenance 26h.
const BILLING_TICK_STALE_MS = 2 * 60 * 60 * 1000;
const MAINTENANCE_TICK_STALE_MS = 26 * 60 * 60 * 1000;
const KEY_PATTERN = /^(signup|pay|susp|cancel|cancelreq|pvoid|pdup|trial|wa|mpwh|tick|pwa):[A-Za-z0-9_:.-]{1,100}$/;

type Item = Omit<AdminNotification, "read">;

const brl = (cents: number) => (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

/**
 * Motivo livre do dono, truncado para caber no sino (React escapa na renderização). O corte é por
 * code point (nunca no meio de um par substituto/emoji) e o texto já foi normalizado na gravação.
 */
function reasonSuffix(reason: string | null): string {
  const text = reason?.trim();
  if (!text) return "";
  const chars = Array.from(text);
  return ` Motivo: "${chars.length > 160 ? `${chars.slice(0, 160).join("")}…` : text}"`;
}

function windowStartOf(now: Date): Date {
  return new Date(now.getTime() - WINDOW_MS);
}

/** Todas as fontes com createdAt >= `from`. Cada uma é limitada por SOURCE_CAP. */
async function loadItems(now: Date, from: Date): Promise<Item[]> {
  const prisma = getPrisma();
  const trialLimit = new Date(now.getTime() + TRIAL_WARN_MS);
  // Janela larga de busca (carência de quem paga + folga do vencimento 23:59); o instante exato sai de `subscriptionBoundaries`.
  const graceMs = (GRACE_DAYS_PAYING + 2) * DAY_MS;
  const tenantSel = { select: { id: true, name: true, slug: true } } as const;

  const [signups, payments, suspended, canceled, cancelRequests, voidPayments, duplicatePayments, trials, instances, settings] = await Promise.all([
    prisma.tenant.findMany({
      where: { createdAt: { gte: from } },
      orderBy: { createdAt: "desc" },
      take: SOURCE_CAP,
      select: { id: true, name: true, slug: true, createdAt: true },
    }),
    prisma.invoice.findMany({
      where: { status: "PAID", paidAt: { gte: from } },
      orderBy: { paidAt: "desc" },
      take: SOURCE_CAP,
      select: { id: true, paidAt: true, amountCents: true, subscription: { select: { tenant: tenantSel } } },
    }),
    prisma.subscription.findMany({
      where: { status: "SUSPENDED", currentPeriodEnd: { gte: new Date(from.getTime() - graceMs) } },
      take: SOURCE_CAP,
      select: { id: true, status: true, trialEndsAt: true, firstPaidAt: true, cancelAtPeriodEnd: true, currentPeriodEnd: true, manualSuspendedAt: true, tenant: tenantSel },
    }),
    prisma.subscription.findMany({
      where: { status: "CANCELED", canceledAt: { gte: from } },
      orderBy: { canceledAt: "desc" },
      take: SOURCE_CAP,
      select: { id: true, canceledAt: true, cancelReason: true, tenant: tenantSel },
    }),
    // Cancelamento AGENDADO pelo dono (ainda vale até o fim do período): avisa na hora do pedido.
    prisma.subscription.findMany({
      where: { cancelAtPeriodEnd: true, status: { not: "CANCELED" }, cancelRequestedAt: { gte: from } },
      orderBy: { cancelRequestedAt: "desc" },
      take: SOURCE_CAP,
      select: { id: true, cancelRequestedAt: true, cancelReason: true, trialEndsAt: true, currentPeriodEnd: true, status: true, tenant: tenantSel },
    }),
    // Pix pago numa fatura já ANULADA (cancelamento): o dinheiro entrou e a fatura não foi baixada.
    prisma.invoice.findMany({
      where: { status: "VOID", paidWhileVoidAt: { gte: from } },
      orderBy: { paidWhileVoidAt: "desc" },
      take: SOURCE_CAP,
      select: { id: true, paidWhileVoidAt: true, amountCents: true, subscription: { select: { tenant: tenantSel } } },
    }),
    // Segundo pagamento numa fatura já PAGA (Pix antigo/regerado pago depois): estorno manual no MP.
    prisma.invoice.findMany({
      where: { duplicatePaymentAt: { gte: from } },
      orderBy: { duplicatePaymentAt: "desc" },
      take: SOURCE_CAP,
      select: { id: true, duplicatePaymentAt: true, amountCents: true, subscription: { select: { tenant: tenantSel } } },
    }),
    prisma.subscription.findMany({
      where: { status: "TRIALING", trialEndsAt: { gt: now, lte: trialLimit } },
      take: SOURCE_CAP,
      select: { id: true, trialEndsAt: true, tenant: tenantSel },
    }),
    prisma.whatsappInstance.findMany({
      where: { deletedAt: null, sandbox: false, status: "DISCONNECTED", disconnectedAt: { gte: from } },
      orderBy: { disconnectedAt: "desc" },
      take: SOURCE_CAP,
      select: { id: true, label: true, disconnectedAt: true, tenant: tenantSel },
    }),
    prisma.platformSettings.findUnique({
      where: { id: 1 },
      select: {
        lastMpWebhookRejectedAt: true,
        lastMpWebhookRejection: true,
        lastBillingTickAt: true,
        lastBillingTickResult: true,
        lastMaintenanceTickAt: true,
      },
    }),
  ]);

  const items: Item[] = [];

  for (const t of signups) {
    items.push({
      id: `signup:${t.id}`,
      kind: "TENANT_SIGNED_UP",
      severity: "info",
      title: "Nova empresa cadastrada",
      body: `${t.name} criou uma conta e começou o teste.`,
      href: "/admin/empresas",
      createdAt: t.createdAt.toISOString(),
      tenant: { id: t.id, name: t.name, slug: t.slug },
    });
  }

  for (const inv of payments) {
    if (!inv.paidAt) continue;
    const tenant = inv.subscription.tenant;
    items.push({
      id: `pay:${inv.id}`,
      kind: "PAYMENT_RECEIVED",
      severity: "success",
      title: "Pagamento recebido",
      body: `${tenant.name} pagou ${brl(inv.amountCents)}.`,
      href: "/admin/cobranca",
      createdAt: inv.paidAt.toISOString(),
      tenant,
    });
  }

  for (const s of suspended) {
    const at = Math.min(subscriptionBoundaries({ ...s, timezone: null }).graceEndsAt.getTime(), now.getTime());
    if (at < from.getTime()) continue;
    items.push({
      id: `susp:${s.id}:${s.currentPeriodEnd.getTime()}`,
      kind: "TENANT_SUSPENDED",
      severity: "warning",
      title: "Empresa suspensa",
      body: `${s.tenant.name} foi suspensa por falta de pagamento.`,
      href: "/admin/empresas",
      createdAt: new Date(at).toISOString(),
      tenant: s.tenant,
    });
  }

  for (const c of canceled) {
    if (!c.canceledAt) continue;
    items.push({
      id: `cancel:${c.id}:${c.canceledAt.getTime()}`,
      kind: "TENANT_CANCELED",
      severity: "danger",
      title: "Empresa cancelada",
      body: `A assinatura de ${c.tenant.name} foi cancelada.${reasonSuffix(c.cancelReason)}`,
      href: "/admin/empresas",
      createdAt: c.canceledAt.toISOString(),
      tenant: c.tenant,
    });
  }

  for (const r of cancelRequests) {
    if (!r.cancelRequestedAt) continue;
    const endsAt = r.status === "TRIALING" ? (r.trialEndsAt ?? r.currentPeriodEnd) : r.currentPeriodEnd;
    items.push({
      id: `cancelreq:${r.id}:${r.cancelRequestedAt.getTime()}`,
      kind: "TENANT_CANCEL_SCHEDULED",
      severity: "warning",
      title: "Empresa pediu cancelamento",
      body: `${r.tenant.name} pediu o cancelamento. O acesso vai até ${endsAt.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })}.${reasonSuffix(r.cancelReason)}`,
      href: "/admin/empresas",
      createdAt: r.cancelRequestedAt.toISOString(),
      tenant: r.tenant,
    });
  }

  for (const v of voidPayments) {
    if (!v.paidWhileVoidAt) continue;
    const tenant = v.subscription.tenant;
    items.push({
      id: `pvoid:${v.id}`,
      kind: "PAYMENT_ON_VOID_INVOICE",
      severity: "danger",
      title: "Pagamento em fatura anulada",
      body: `${tenant.name} pagou ${brl(v.amountCents)} numa fatura anulada (fatura ${v.id}). A assinatura não foi reativada: ou faça o estorno no Mercado Pago, ou reative a empresa.`,
      href: "/admin/cobranca",
      createdAt: v.paidWhileVoidAt.toISOString(),
      tenant,
    });
  }

  for (const d of duplicatePayments) {
    if (!d.duplicatePaymentAt) continue;
    const tenant = d.subscription.tenant;
    items.push({
      id: `pdup:${d.id}`,
      kind: "PAYMENT_DUPLICATE",
      severity: "danger",
      title: "Pagamento em duplicidade",
      body: `${tenant.name} pagou ${brl(d.amountCents)} de novo numa fatura que já estava paga (fatura ${d.id}). Faça o estorno do segundo pagamento no Mercado Pago.`,
      href: "/admin/cobranca",
      createdAt: d.duplicatePaymentAt.toISOString(),
      tenant,
    });
  }

  for (const tr of trials) {
    if (!tr.trialEndsAt) continue;
    items.push({
      id: `trial:${tr.id}`,
      kind: "TRIAL_ENDING",
      severity: "warning",
      title: "Teste termina em breve",
      body: `O período de teste de ${tr.tenant.name} termina em menos de 24 horas.`,
      href: "/admin/empresas",
      createdAt: new Date(tr.trialEndsAt.getTime() - TRIAL_WARN_MS).toISOString(),
      tenant: tr.tenant,
    });
  }

  for (const i of instances) {
    if (!i.disconnectedAt) continue;
    items.push({
      id: `wa:${i.id}:${i.disconnectedAt.getTime()}`,
      kind: "WHATSAPP_DISCONNECTED",
      severity: "danger",
      title: "WhatsApp desconectado",
      body: `O número "${i.label}" de ${i.tenant.name} caiu e o bot parou de responder.`,
      href: "/admin/saude",
      createdAt: i.disconnectedAt.toISOString(),
      tenant: i.tenant,
    });
  }

  if (settings?.lastMpWebhookRejectedAt && settings.lastMpWebhookRejectedAt >= from) {
    const rejection = settings.lastMpWebhookRejection;
    const rawReason = rejection && typeof rejection === "object" ? (rejection as Record<string, unknown>).reason : null;
    const reason = typeof rawReason === "string" ? rawReason.slice(0, 200) : null;
    items.push({
      id: `mpwh:${settings.lastMpWebhookRejectedAt.getTime()}`,
      kind: "MP_WEBHOOK_REJECTED",
      severity: "danger",
      title: "Webhook do Mercado Pago rejeitado",
      body: `${reason ? `Motivo: ${reason}. ` : ""}Pagamentos Pix podem não estar sendo baixados automaticamente.`,
      href: "/admin/saude",
      createdAt: settings.lastMpWebhookRejectedAt.toISOString(),
    });
  }

  // Ticks atrasados: fora da janela de 30 dias de propósito — enquanto o job estiver parado o
  // alerta continua valendo. createdAt = instante em que ficou atrasado (última execução + limite).
  const ticks = [
    { job: "billing", label: "billing/tick", at: settings?.lastBillingTickAt ?? null, stale: BILLING_TICK_STALE_MS, hours: 2 },
    { job: "maintenance", label: "maintenance/tick", at: settings?.lastMaintenanceTickAt ?? null, stale: MAINTENANCE_TICK_STALE_MS, hours: 26 },
  ];
  for (const t of ticks) {
    const late = !t.at || now.getTime() - t.at.getTime() > t.stale;
    if (!late) continue;
    let since: Date;
    if (t.at) {
      since = new Date(t.at.getTime() + t.stale);
    } else {
      // Nunca rodou: ancora na empresa mais antiga (sem empresa, não há o que alertar).
      const first = await prisma.tenant.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } });
      if (!first) continue;
      since = new Date(first.createdAt.getTime() + t.stale);
      if (since > now) continue;
    }
    items.push({
      id: `tick:${t.job}:${t.at ? t.at.getTime() : "never"}`,
      kind: "TICK_LATE",
      severity: "warning",
      title: `${t.label} atrasado`,
      body: t.at ? `O ${t.label} não roda há mais de ${t.hours}h. Confira o cron no n8n.` : `O ${t.label} nunca rodou. Confira o cron no n8n.`,
      href: "/admin/saude",
      createdAt: since.toISOString(),
    });
  }

  // Monitor de cobrança (F7): rotina parada há mais de 3 h (mesmo limite que vira 503 em /api/health/billing). Escalada do
  // "atrasado" de 2 h acima: id próprio, então volta como não lida e em vermelho. Também fora da janela de 30 dias.
  const billingDownMs = BILLING_TICK_DOWN_AFTER_MINUTES * 60_000;
  const billingLastAt = settings?.lastBillingTickAt ?? null;
  let billingStaleSince: Date | null = null;
  if (billingLastAt) {
    if (now.getTime() - billingLastAt.getTime() > billingDownMs) billingStaleSince = new Date(billingLastAt.getTime() + billingDownMs);
  } else {
    const first = await prisma.tenant.findFirst({ orderBy: { createdAt: "asc" }, select: { createdAt: true } });
    if (first && now.getTime() - first.createdAt.getTime() > billingDownMs) billingStaleSince = new Date(first.createdAt.getTime() + billingDownMs);
  }
  if (billingStaleSince) {
    items.push({
      id: `tick:billing-stale:${billingLastAt ? billingLastAt.getTime() : "never"}`,
      kind: "BILLING_TICK_STALE",
      severity: "danger",
      title: "A cobrança parou de rodar",
      body: billingLastAt
        ? `A rotina de cobrança não roda há mais de ${BILLING_TICK_DOWN_AFTER_MINUTES / 60} horas. Nenhum aviso de mensalidade sai e as assinaturas não andam. Confira o fluxo do cron no n8n e a tela Saúde.`
        : "A rotina de cobrança nunca rodou. Nenhum aviso de mensalidade sai. Confira o fluxo do cron no n8n e a tela Saúde.",
      href: "/admin/saude",
      createdAt: billingStaleSince.toISOString(),
    });
  }

  // Avisos vencidos que não saíram (PENDING, ou nova tentativa liberada, com a hora de enviar passada há mais de 2 h).
  // Derivado do outbox; um item por dia, some quando a fila anda.
  const stuck = await prisma.billingNotice.aggregate({ where: stuckNoticesWhere(now), _count: { _all: true }, _min: { nextAttemptAt: true } });
  if (stuck._count._all > 0 && stuck._min.nextAttemptAt) {
    const since = new Date(Math.min(now.getTime(), stuck._min.nextAttemptAt.getTime() + BILLING_NOTICE_STUCK_AFTER_MINUTES * 60_000));
    items.push({
      id: `tick:stuck:${now.toISOString().slice(0, 10)}`,
      kind: "BILLING_NOTICES_STUCK",
      severity: "danger",
      title: "Avisos de cobrança presos",
      body: `${stuck._count._all} aviso(s) passaram da hora de sair há mais de ${BILLING_NOTICE_STUCK_AFTER_MINUTES / 60} horas e continuam na fila. Veja a tela Saúde e o registro de envios.`,
      href: "/admin/saude",
      createdAt: since.toISOString(),
    });
  }

  // E-mails de cobrança que não saíram na última rodada do tick (SMTP fora do ar ou sem
  // configuração): o tick não marca como enviado e tenta de novo, mas o dono da plataforma precisa
  // saber. DERIVADO de `lastBillingTickResult.emailsFailed` (sem tabela); some quando uma rodada
  // seguinte envia tudo. Id estável por dia (um aviso por dia, não um por rodada horária).
  const emailsFailed = readEmailsFailed(settings?.lastBillingTickResult);
  if (emailsFailed > 0 && settings?.lastBillingTickAt && settings.lastBillingTickAt >= from) {
    items.push({
      id: `tick:email:${settings.lastBillingTickAt.toISOString().slice(0, 10)}`,
      kind: "BILLING_EMAIL_FAILING",
      severity: "danger",
      title: "E-mails de cobrança não saíram",
      body: `${emailsFailed} e-mail(s) de cobrança não foram enviados na última rodada. Confira o SMTP em Configurações. O sistema tenta de novo a cada hora e nenhum aviso é dado como enviado antes de sair.`,
      href: "/admin/saude",
      createdAt: settings.lastBillingTickAt.toISOString(),
    });
  }

  // WhatsApp de cobrança da plataforma (sem número, caído, resposta de assinante).
  items.push(...(await loadPlatformWhatsappItems(now, from)));

  return items;
}

/** `emailsFailed` do resultado gravado do billing/tick (JSON livre: lê com cuidado). */
function readEmailsFailed(result: unknown): number {
  if (!result || typeof result !== "object") return 0;
  const value = (result as Record<string, unknown>).emailsFailed;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

// ---------------------------------------------------------------------------------------------
// Estado de leitura (por usuário)
// ---------------------------------------------------------------------------------------------

async function loadReadAllAt(userId: string): Promise<Date | null> {
  const u = await getPrisma().user.findUnique({ where: { id: userId }, select: { platformNotificationsReadAllAt: true } });
  return u?.platformNotificationsReadAllAt ?? null;
}

async function loadReadKeys(userId: string, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await getPrisma().platformNotificationRead.findMany({
    where: { userId, notificationKey: { in: keys } },
    select: { notificationKey: true },
  });
  return new Set(rows.map((r) => r.notificationKey));
}

function isRead(item: { id: string; createdAt: string }, readAllAt: Date | null, readKeys: Set<string>): boolean {
  if (readKeys.has(item.id)) return true;
  return readAllAt !== null && new Date(item.createdAt).getTime() <= readAllAt.getTime();
}

function compareDesc(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

function encodeCursor(item: { createdAt: string; id: string }): string {
  return Buffer.from(`${item.createdAt}|${item.id}`).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  try {
    const [createdAt, ...rest] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    const id = rest.join("|");
    if (!createdAt || !id || Number.isNaN(new Date(createdAt).getTime())) throw new Error("bad");
    return { createdAt: new Date(createdAt).toISOString(), id };
  } catch {
    throw new DomainError("INVALID_CURSOR", "Cursor inválido.");
  }
}

/** Não lidas entre `items` (que devem cobrir, no mínimo, tudo depois de readAllAt). */
async function countUnread(
  userId: string,
  items: Item[],
  readAllAt: Date | null,
): Promise<{ unreadCount: number; readKeys: Set<string> }> {
  const candidates = items.filter((i) => readAllAt === null || new Date(i.createdAt).getTime() > readAllAt.getTime());
  const readKeys = await loadReadKeys(
    userId,
    candidates.map((c) => c.id),
  );
  return { unreadCount: candidates.filter((c) => !readKeys.has(c.id)).length, readKeys };
}

// ---------------------------------------------------------------------------------------------
// API do módulo
// ---------------------------------------------------------------------------------------------

export async function listPlatformNotifications(
  userId: string,
  cursor?: string,
): Promise<{ items: AdminNotification[]; unreadCount: number; nextCursor: string | null }> {
  const now = new Date();
  const cur = cursor ? decodeCursor(cursor) : null;
  const [readAllAt, all] = await Promise.all([loadReadAllAt(userId), loadItems(now, windowStartOf(now))]);

  const sorted = [...all].sort(compareDesc);
  const merged = cur ? sorted.filter((i) => compareDesc(i, cur) > 0) : sorted;
  const page = merged.slice(0, PAGE_SIZE);
  const hasMore = merged.length > PAGE_SIZE;

  const { unreadCount } = await countUnread(userId, all, readAllAt);
  const pageKeys = await loadReadKeys(
    userId,
    page.map((p) => p.id),
  );

  return {
    items: page.map((i) => ({ ...i, read: isRead(i, readAllAt, pageKeys) })),
    unreadCount,
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
  };
}

export async function pollPlatformNotifications(
  userId: string,
  since: Date,
): Promise<{ unreadCount: number; fresh: AdminNotification[] }> {
  const now = new Date();
  const windowStart = windowStartOf(now);
  const readAllAt = await loadReadAllAt(userId);
  // Só precisa do que é mais novo que o menor entre `since` e `readAllAt` (não lidas e novidades).
  const lower = readAllAt ? Math.min(readAllAt.getTime(), since.getTime()) : windowStart.getTime();
  const from = new Date(Math.max(windowStart.getTime(), lower));

  const items = await loadItems(now, from);
  const { unreadCount, readKeys } = await countUnread(userId, items, readAllAt);

  const fresh = items
    .filter((i) => new Date(i.createdAt).getTime() > since.getTime())
    .sort(compareDesc)
    .slice(0, POLL_MAX);
  const extra = await loadReadKeys(
    userId,
    fresh.map((f) => f.id).filter((id) => !readKeys.has(id)),
  );
  const allRead = new Set([...readKeys, ...extra]);

  return { unreadCount, fresh: fresh.map((i) => ({ ...i, read: isRead(i, readAllAt, allRead) })) };
}

export async function markPlatformNotificationsRead(
  userId: string,
  input: { ids?: string[]; all?: boolean },
): Promise<{ unreadCount: number }> {
  const ids = [...new Set(input.ids ?? [])];
  if (!input.all && ids.length === 0) {
    throw new DomainError("INVALID_PAYLOAD", "Informe ids ou all=true.");
  }
  if (ids.some((id) => !KEY_PATTERN.test(id))) {
    throw new DomainError("INVALID_PAYLOAD", "Identificador de notificação inválido.");
  }

  const prisma = getPrisma();
  if (input.all) {
    const readAt = new Date();
    await prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: { platformNotificationsReadAllAt: readAt } }),
      prisma.platformNotificationRead.deleteMany({ where: { userId, readAt: { lte: readAt } } }),
    ]);
  } else {
    await prisma.platformNotificationRead.createMany({
      data: ids.map((notificationKey) => ({ userId, notificationKey })),
      skipDuplicates: true,
    });
  }

  const now = new Date();
  const [readAllAt, items] = await Promise.all([loadReadAllAt(userId), loadItems(now, windowStartOf(now))]);
  const { unreadCount } = await countUnread(userId, items, readAllAt);
  return { unreadCount };
}
