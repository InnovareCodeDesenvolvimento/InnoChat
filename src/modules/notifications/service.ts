import { fromZonedTime } from "date-fns-tz";
import { getPrisma } from "@/lib/db/prisma";
import { forTenant } from "@/lib/db/tenant-client";
import { DomainError } from "@/lib/errors";
import type { TenantContext } from "@/lib/auth/guards";
import {
  appointmentBody,
  contactDisplayName,
  dayISO,
  EVENT_KIND,
  EVENT_SEVERITY,
  eventSource,
  eventTitle,
  handoffBody,
  HANDOFF_TITLE,
  minutesUntil,
  timelineLabel,
  type EventAction,
  type EventAuthorType,
} from "./format";
import type { AppNotification, TimelineItem, UpcomingAppointmentItem } from "./types";

/**
 * Central de notificações do painel — DECISÕES (registradas em docs/contratos.md):
 *
 * 1. DERIVADAS, não materializadas. Não existe tabela `Notification`: cada tipo é lido do estado
 *    que já existe (AppointmentEvent, Appointment, WhatsappInstance, Subscription, Invoice).
 *    Assim é impossível "esquecer um ponto de escrita" (painel, API do bot, drag-to-reschedule,
 *    tick) — todos já gravam AppointmentEvent, e a coluna `AppointmentEvent.tenantId` é
 *    preenchida por TRIGGER no banco.
 * 2. Estado de leitura por (usuário, empresa) = `Membership.notificationsReadAllAt` ("marcar todas":
 *    tudo com createdAt <= esse instante) + `NotificationRead` (marcar uma). Escolhida em vez de
 *    `User.notificationsSeenAt` porque o usuário pode ter mais de uma empresa.
 * 3. Barato: o poll (30s) faz 1 leitura da Membership, 1 índice (tenantId, createdAt) nos eventos
 *    (só depois de max(janela, readAllAt) — normalmente poucas linhas), 4 leituras minúsculas
 *    das fontes derivadas e 1 leitura de NotificationRead. Sem N+1 (hidratação em lote via select).
 * 4. Privacidade: só o NOME do contato (nunca telefone). STAFF vê os agendamentos e a conexão do
 *    WhatsApp; TRIAL_ENDING e PAYMENT_CONFIRMED (cobrança) só o OWNER. Não há restrição de
 *    profissional por STAFF no produto hoje — se surgir, filtrar aqui.
 */

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 20;
const POLL_MAX = 10;
const UPCOMING_WINDOW_MIN = 60;
const TRIAL_WARN_MS = 24 * 60 * 60 * 1000;
const EVENT_CAP = 200; // teto de eventos considerados no contador (30 dias)
const EVENT_PAGE_FETCH = 60;
const KEY_PATTERN = /^(ev|upcoming|wa|trial|pay|handoff):[A-Za-z0-9_:-]{1,100}$/;

type Item = Omit<AppNotification, "read">;

function eventItemKey(eventId: string): string {
  return `ev:${eventId}`;
}

// ---------------------------------------------------------------------------------------------
// Fontes
// ---------------------------------------------------------------------------------------------

type EventRow = {
  id: string;
  action: EventAction;
  authorType: EventAuthorType;
  authorId: string | null;
  createdAt: Date;
  appointment: {
    id: string;
    startsAt: Date;
    source: "WHATSAPP" | "PANEL";
    contact: { name: string | null; pushName: string | null };
    service: { name: string };
    professional: { name: string };
  };
};

function agendaHref(ctx: TenantContext, startsAt: Date): string {
  return `/${ctx.tenant.slug}/agenda?data=${dayISO(startsAt, ctx.tenant.timezone)}`;
}

function eventToItem(ctx: TenantContext, row: EventRow): Item {
  const source = eventSource(row.action, row.authorType, row.appointment.source);
  const contactName = contactDisplayName(row.appointment.contact);
  return {
    id: eventItemKey(row.id),
    kind: EVENT_KIND[row.action],
    severity: EVENT_SEVERITY[row.action],
    title: eventTitle(row.action, source),
    body: appointmentBody({
      contactName,
      serviceName: row.appointment.service.name,
      professionalName: row.appointment.professional.name,
      startsAt: row.appointment.startsAt,
      timezone: ctx.tenant.timezone,
    }),
    href: agendaHref(ctx, row.appointment.startsAt),
    createdAt: row.createdAt.toISOString(),
    source,
    appointment: {
      id: row.appointment.id,
      startsAt: row.appointment.startsAt.toISOString(),
      contactName,
      serviceName: row.appointment.service.name,
      professionalName: row.appointment.professional.name,
    },
    byMe: row.authorType === "USER" && row.authorId === ctx.user.id,
  };
}

/** Eventos hidratados (uma consulta + select aninhado — sem N+1). `tenantId` é explícito: AppointmentEvent não é model do forTenant. */
async function loadEventItems(
  ctx: TenantContext,
  range: { after?: Date; upTo?: Date; windowStart: Date; take: number },
): Promise<Item[]> {
  const rows = await getPrisma().appointmentEvent.findMany({
    where: {
      tenantId: ctx.tenant.id,
      action: { not: "REOPENED" }, // reabrir é só histórico do agendamento, não vira notificação
      createdAt: {
        gte: range.windowStart,
        ...(range.after ? { gt: range.after } : {}),
        ...(range.upTo ? { lte: range.upTo } : {}),
      },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: range.take,
    select: {
      id: true,
      action: true,
      authorType: true,
      authorId: true,
      createdAt: true,
      appointment: {
        select: {
          id: true,
          startsAt: true,
          source: true,
          contact: { select: { name: true, pushName: true } },
          service: { select: { name: true } },
          professional: { select: { name: true } },
        },
      },
    },
  });
  return rows.map((r) => eventToItem(ctx, r as EventRow));
}

/** Fontes derivadas do estado atual (pequenas por natureza: poucos registros por empresa). */
async function loadStateItems(ctx: TenantContext, now: Date, windowStart: Date): Promise<Item[]> {
  const db = forTenant(ctx.tenant.id);
  const isOwner = ctx.membership.role === "OWNER";
  const upcomingLimit = new Date(now.getTime() + UPCOMING_WINDOW_MIN * 60_000);
  const trialLimit = new Date(now.getTime() + TRIAL_WARN_MS);

  const [upcoming, instances, subscription, invoices, handoffs] = await Promise.all([
    db.appointment.findMany({
      where: { status: "SCHEDULED", startsAt: { gt: now, lte: upcomingLimit } },
      orderBy: { startsAt: "asc" },
      take: 20,
      select: {
        id: true,
        startsAt: true,
        contact: { select: { name: true, pushName: true } },
        service: { select: { name: true } },
        professional: { select: { name: true } },
      },
    }),
    db.whatsappInstance.findMany({
      where: { deletedAt: null, sandbox: false, status: "DISCONNECTED", disconnectedAt: { gte: windowStart } },
      take: 20,
      select: { id: true, label: true, disconnectedAt: true },
    }),
    isOwner
      ? db.subscription.findFirst({
          where: { status: "TRIALING", trialEndsAt: { gt: now, lte: trialLimit } },
          select: { id: true, trialEndsAt: true },
        })
      : Promise.resolve(null),
    isOwner
      ? getPrisma().invoice.findMany({
          where: { subscription: { tenantId: ctx.tenant.id }, status: "PAID", paidAt: { gte: windowStart } },
          orderBy: { paidAt: "desc" },
          take: 20,
          select: { id: true, paidAt: true, amountCents: true },
        })
      : Promise.resolve([]),
    // Pedidos de atendente (bot v2) — visíveis a OWNER e STAFF, incluindo os já encerrados (a UI esmaece).
    db.handoffRequest.findMany({
      where: { requestedAt: { gte: windowStart } },
      orderBy: { requestedAt: "desc" },
      take: 20,
      select: {
        id: true,
        requestedAt: true,
        offHours: true,
        answeredAt: true,
        endedAt: true,
        contact: { select: { id: true, name: true, pushName: true } },
      },
    }),
  ]);

  const items: Item[] = [];

  for (const a of upcoming) {
    const contactName = contactDisplayName(a.contact);
    const mins = minutesUntil(a.startsAt, now);
    items.push({
      // startsAt no id: se o agendamento for remarcado, o lembrete do novo horário volta como não lido.
      id: `upcoming:${a.id}:${Math.floor(a.startsAt.getTime() / 60_000)}`,
      kind: "APPOINTMENT_UPCOMING",
      severity: "info",
      title: mins <= 1 ? "Atendimento começando agora" : `Atendimento começa em ${mins} min`,
      body: appointmentBody({
        contactName,
        serviceName: a.service.name,
        professionalName: a.professional.name,
        startsAt: a.startsAt,
        timezone: ctx.tenant.timezone,
      }),
      href: agendaHref(ctx, a.startsAt),
      createdAt: new Date(a.startsAt.getTime() - UPCOMING_WINDOW_MIN * 60_000).toISOString(),
      source: "SYSTEM",
      appointment: {
        id: a.id,
        startsAt: a.startsAt.toISOString(),
        contactName,
        serviceName: a.service.name,
        professionalName: a.professional.name,
      },
    });
  }

  for (const i of instances) {
    if (!i.disconnectedAt) continue;
    items.push({
      id: `wa:${i.id}:${i.disconnectedAt.getTime()}`,
      kind: "WHATSAPP_DISCONNECTED",
      severity: "danger",
      title: "WhatsApp desconectado",
      body: `O número "${i.label}" caiu e o bot parou de responder. Reconecte para voltar a atender.`,
      href: `/${ctx.tenant.slug}/whatsapp`,
      createdAt: i.disconnectedAt.toISOString(),
      source: "SYSTEM",
    });
  }

  if (subscription?.trialEndsAt) {
    items.push({
      id: `trial:${subscription.id}`,
      kind: "TRIAL_ENDING",
      severity: "warning",
      title: "Seu período de teste termina em breve",
      body: "Faltam menos de 24 horas. Assine para não interromper o atendimento.",
      href: `/${ctx.tenant.slug}/assinatura`,
      createdAt: new Date(subscription.trialEndsAt.getTime() - TRIAL_WARN_MS).toISOString(),
      source: "SYSTEM",
    });
  }

  for (const inv of invoices) {
    if (!inv.paidAt) continue;
    items.push({
      id: `pay:${inv.id}`,
      kind: "PAYMENT_CONFIRMED",
      severity: "success",
      title: "Pagamento confirmado",
      body: `Recebemos o pagamento de ${(inv.amountCents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}. Obrigado!`,
      href: `/${ctx.tenant.slug}/assinatura`,
      createdAt: inv.paidAt.toISOString(),
      source: "SYSTEM",
    });
  }

  for (const h of handoffs) {
    const contactName = contactDisplayName(h.contact);
    items.push({
      id: `handoff:${h.id}`,
      kind: "HANDOFF_REQUESTED",
      severity: "warning",
      title: HANDOFF_TITLE,
      body: handoffBody(contactName, h.offHours),
      href: `/${ctx.tenant.slug}/clientes?contato=${h.contact.id}`,
      createdAt: h.requestedAt.toISOString(),
      source: "WHATSAPP",
      handoff: { contactId: h.contact.id, contactName, offHours: h.offHours, answered: h.answeredAt !== null, ended: h.endedAt !== null },
    });
  }

  return items;
}

// ---------------------------------------------------------------------------------------------
// Estado de leitura
// ---------------------------------------------------------------------------------------------

async function loadReadAllAt(membershipId: string): Promise<Date | null> {
  const m = await getPrisma().membership.findUnique({ where: { id: membershipId }, select: { notificationsReadAllAt: true } });
  return m?.notificationsReadAllAt ?? null;
}

async function loadReadKeys(membershipId: string, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await getPrisma().notificationRead.findMany({
    where: { membershipId, notificationKey: { in: keys } },
    select: { notificationKey: true },
  });
  return new Set(rows.map((r) => r.notificationKey));
}

function isRead(item: { id: string; createdAt: string }, readAllAt: Date | null, readKeys: Set<string>): boolean {
  if (readKeys.has(item.id)) return true;
  return readAllAt !== null && new Date(item.createdAt).getTime() <= readAllAt.getTime();
}

/**
 * Contador de não lidas — só o que importa: eventos depois de max(janela, readAllAt) (leves, sem
 * hidratar) + fontes derivadas. Devolve também as chaves lidas para reaproveitar a leitura.
 */
async function countUnread(
  ctx: TenantContext,
  extra: { stateItems: Item[]; readAllAt: Date | null; windowStart: Date },
): Promise<{ unreadCount: number; readKeys: Set<string> }> {
  const floor = new Date(Math.max(extra.windowStart.getTime(), extra.readAllAt?.getTime() ?? 0));
  const events = await getPrisma().appointmentEvent.findMany({
    where: { tenantId: ctx.tenant.id, action: { not: "REOPENED" }, createdAt: { gt: floor } },
    orderBy: { createdAt: "desc" },
    take: EVENT_CAP,
    select: { id: true, createdAt: true },
  });
  const candidates = [
    ...events.map((e) => ({ id: eventItemKey(e.id), createdAt: e.createdAt.toISOString() })),
    ...extra.stateItems.map((s) => ({ id: s.id, createdAt: s.createdAt })),
  ];
  const readKeys = await loadReadKeys(
    ctx.membership.id,
    candidates.map((c) => c.id),
  );
  const unreadCount = candidates.filter((c) => !isRead(c, extra.readAllAt, readKeys)).length;
  return { unreadCount, readKeys };
}

// ---------------------------------------------------------------------------------------------
// API do módulo
// ---------------------------------------------------------------------------------------------

function windowStartOf(now: Date): Date {
  return new Date(now.getTime() - WINDOW_MS);
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

export async function listNotifications(
  ctx: TenantContext,
  cursor?: string,
): Promise<{ items: AppNotification[]; unreadCount: number; nextCursor: string | null }> {
  const now = new Date();
  const windowStart = windowStartOf(now);
  const cur = cursor ? decodeCursor(cursor) : null;

  const [readAllAt, stateItems, eventItems] = await Promise.all([
    loadReadAllAt(ctx.membership.id),
    loadStateItems(ctx, now, windowStart),
    loadEventItems(ctx, { windowStart, upTo: cur ? new Date(cur.createdAt) : undefined, take: EVENT_PAGE_FETCH }),
  ]);

  const merged = [...eventItems, ...stateItems].filter((i) => (cur ? compareDesc(i, cur) > 0 : true)).sort(compareDesc);
  const page = merged.slice(0, PAGE_SIZE);
  const hasMore = merged.length > PAGE_SIZE;

  const [{ unreadCount }, pageReadKeys] = await Promise.all([
    countUnread(ctx, { stateItems, readAllAt, windowStart }),
    loadReadKeys(
      ctx.membership.id,
      page.map((p) => p.id),
    ),
  ]);

  return {
    items: page.map((i) => ({ ...i, read: isRead(i, readAllAt, pageReadKeys) })),
    unreadCount,
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
  };
}

export async function pollNotifications(
  ctx: TenantContext,
  since: Date,
): Promise<{ unreadCount: number; fresh: AppNotification[] }> {
  const now = new Date();
  const windowStart = windowStartOf(now);
  const after = new Date(Math.max(since.getTime(), windowStart.getTime()));

  const [readAllAt, stateItems, freshEvents] = await Promise.all([
    loadReadAllAt(ctx.membership.id),
    loadStateItems(ctx, now, windowStart),
    loadEventItems(ctx, { windowStart, after, take: POLL_MAX }),
  ]);

  const fresh = [...freshEvents, ...stateItems.filter((s) => new Date(s.createdAt).getTime() > after.getTime())]
    .sort(compareDesc)
    .slice(0, POLL_MAX);

  const { unreadCount, readKeys } = await countUnread(ctx, { stateItems, readAllAt, windowStart });
  const extraKeys = await loadReadKeys(
    ctx.membership.id,
    fresh.map((f) => f.id).filter((id) => !readKeys.has(id)),
  );
  const allRead = new Set([...readKeys, ...extraKeys]);

  return { unreadCount, fresh: fresh.map((i) => ({ ...i, read: isRead(i, readAllAt, allRead) })) };
}

export async function markNotificationsRead(
  ctx: TenantContext,
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
      prisma.membership.update({ where: { id: ctx.membership.id }, data: { notificationsReadAllAt: readAt } }),
      // As leituras individuais ficam redundantes (tudo até readAt já é lido).
      prisma.notificationRead.deleteMany({ where: { membershipId: ctx.membership.id, readAt: { lte: readAt } } }),
    ]);
  } else {
    await prisma.notificationRead.createMany({
      data: ids.map((notificationKey) => ({ membershipId: ctx.membership.id, notificationKey })),
      skipDuplicates: true,
    });
  }

  const now = new Date();
  const windowStart = windowStartOf(now);
  const [readAllAt, stateItems] = await Promise.all([loadReadAllAt(ctx.membership.id), loadStateItems(ctx, now, windowStart)]);
  const { unreadCount } = await countUnread(ctx, { stateItems, readAllAt, windowStart });
  return { unreadCount };
}

export async function getUpcomingAppointments(ctx: TenantContext): Promise<{ items: UpcomingAppointmentItem[] }> {
  const now = new Date();
  const tz = ctx.tenant.timezone;
  const [y, m, d] = dayISO(now, tz).split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  const nextISO = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
  const endOfToday = fromZonedTime(`${nextISO}T00:00:00`, tz);

  const rows = await forTenant(ctx.tenant.id).appointment.findMany({
    where: { status: "SCHEDULED", startsAt: { gte: now, lt: endOfToday } },
    orderBy: { startsAt: "asc" },
    take: 5,
    select: {
      id: true,
      startsAt: true,
      endsAt: true,
      source: true,
      contact: { select: { name: true, pushName: true } },
      service: { select: { name: true } },
      professional: { select: { name: true } },
    },
  });

  return {
    items: rows.map((r) => ({
      id: r.id,
      startsAt: r.startsAt.toISOString(),
      endsAt: r.endsAt.toISOString(),
      contactName: contactDisplayName(r.contact),
      serviceName: r.service.name,
      professionalName: r.professional.name,
      status: "SCHEDULED" as const,
      source: r.source,
      minutesUntil: minutesUntil(r.startsAt, now),
    })),
  };
}

export async function getAppointmentTimeline(ctx: TenantContext, appointmentId: string): Promise<{ items: TimelineItem[] }> {
  // Carrega o pai com forTenant: AppointmentEvent não tem escopo próprio de tenant no client.
  const appointment = await forTenant(ctx.tenant.id).appointment.findFirst({
    where: { id: appointmentId },
    select: { id: true, contact: { select: { name: true, pushName: true } } },
  });
  if (!appointment) throw new DomainError("NOT_FOUND", "Agendamento não encontrado.");

  const events = await getPrisma().appointmentEvent.findMany({
    where: { appointmentId: appointment.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: 200,
    // Colunas explícitas: a linha do tempo não depende de `tenantId` (nulo em eventos legados).
    select: { id: true, action: true, authorType: true, authorId: true, note: true, createdAt: true },
  });

  const userIds = [...new Set(events.filter((e) => e.authorType === "USER" && e.authorId).map((e) => e.authorId as string))];
  const users = userIds.length
    ? await getPrisma().user.findMany({
        // Só usuários que são membros DESTA empresa (nunca vaza e-mail de outra).
        where: { id: { in: userIds }, memberships: { some: { tenantId: ctx.tenant.id } } },
        select: { id: true, name: true, email: true },
      })
    : [];
  // Prefere o nome de exibição; sem nome, cai na parte local do e-mail (como antes).
  const userLabel = new Map(users.map((u) => [u.id, u.name?.trim() || u.email.split("@")[0]]));

  return {
    items: events.map((e) => ({
      id: e.id,
      action: e.action,
      authorType: e.authorType,
      authorLabel:
        e.authorType === "CONTACT"
          ? contactDisplayName(appointment.contact)
          : e.authorType === "USER"
            ? (e.authorId && userLabel.get(e.authorId)) || "Equipe"
            : "Sistema",
      note: e.note,
      createdAt: e.createdAt.toISOString(),
      label: timelineLabel(
        e.action,
        e.authorType,
        e.authorType === "USER" && e.authorId ? userLabel.get(e.authorId) : null,
      ),
    })),
  };
}
