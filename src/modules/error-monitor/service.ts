import { getPrisma } from "@/lib/db/prisma";
import { DomainError } from "@/lib/errors";
import { pageInfoOf, resolvePage, type PageInfo, type PageSize } from "@/modules/billing/paging";

/** Leitura e ações da tela Admin → Erros. Só chamado por Server Actions atrás de `requirePlatformAdmin()`. */

export type ErrorStatus = "OPEN" | "RESOLVED" | "IGNORED";
export type ErrorSourceFilter = "SERVER" | "CLIENT";

export type ErrorGroupItem = {
  id: string;
  type: string;
  message: string;
  source: ErrorSourceFilter;
  route: string | null;
  count: number;
  status: ErrorStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  firstVersion: string | null;
  lastVersion: string | null;
  resolvedAt: string | null;
};

export type ErrorEventItem = {
  id: string;
  occurredAt: string;
  version: string | null;
  route: string | null;
  stack: string | null;
  context: unknown;
  hasUser: boolean;
  hasTenant: boolean;
};

export type ErrorGroupDetail = { group: ErrorGroupItem; events: ErrorEventItem[] };

export type ErrorListFilters = { status?: ErrorStatus; source?: ErrorSourceFilter; page?: number; pageSize?: PageSize };

export type ErrorListResult = PageInfo & {
  items: ErrorGroupItem[];
  /** Totais por situação, já respeitando o filtro de origem (e não o de situação). */
  totals: { open: number; resolved: number; ignored: number };
};

const EVENTS_IN_DETAIL = 20;

type GroupRow = {
  id: string;
  type: string;
  message: string;
  source: string;
  route: string | null;
  count: number;
  status: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  firstVersion: string | null;
  lastVersion: string | null;
  resolvedAt: Date | null;
};

function toItem(row: GroupRow): ErrorGroupItem {
  return {
    id: row.id,
    type: row.type,
    message: row.message,
    source: row.source === "CLIENT" ? "CLIENT" : "SERVER",
    route: row.route,
    count: row.count,
    status: row.status === "RESOLVED" || row.status === "IGNORED" ? row.status : "OPEN",
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    firstVersion: row.firstVersion,
    lastVersion: row.lastVersion,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

const GROUP_SELECT = {
  id: true,
  type: true,
  message: true,
  source: true,
  route: true,
  count: true,
  status: true,
  firstSeenAt: true,
  lastSeenAt: true,
  firstVersion: true,
  lastVersion: true,
  resolvedAt: true,
} as const;

export async function listErrorGroups(filters: ErrorListFilters): Promise<ErrorListResult> {
  const prisma = getPrisma();
  const pageSize = filters.pageSize ?? 25;
  const sourceWhere = filters.source ? { source: filters.source } : {};
  const where = { ...sourceWhere, ...(filters.status ? { status: filters.status } : {}) };

  const [total, byStatus] = await Promise.all([
    prisma.errorGroup.count({ where }),
    prisma.errorGroup.groupBy({ by: ["status"], where: sourceWhere, _count: { _all: true } }),
  ]);
  const paging = resolvePage(filters.page, pageSize, total);
  const rows = await prisma.errorGroup.findMany({
    where,
    orderBy: [{ lastSeenAt: "desc" }, { id: "asc" }],
    skip: paging.skip,
    take: pageSize,
    select: GROUP_SELECT,
  });
  const count = (s: string) => byStatus.find((r) => r.status === s)?._count._all ?? 0;
  return { ...pageInfoOf(paging), items: rows.map(toItem), totals: { open: count("OPEN"), resolved: count("RESOLVED"), ignored: count("IGNORED") } };
}

export async function getErrorGroupDetail(id: string): Promise<ErrorGroupDetail> {
  const prisma = getPrisma();
  const group = await prisma.errorGroup.findUnique({ where: { id }, select: GROUP_SELECT });
  if (!group) throw new DomainError("ERROR_GROUP_NOT_FOUND", "Esse erro não existe mais.");
  const events = await prisma.errorEvent.findMany({
    where: { groupId: id },
    orderBy: { occurredAt: "desc" },
    take: EVENTS_IN_DETAIL,
    select: { id: true, occurredAt: true, version: true, route: true, stack: true, context: true, userId: true, tenantId: true },
  });
  return {
    group: toItem(group),
    events: events.map((e) => ({
      id: e.id,
      occurredAt: e.occurredAt.toISOString(),
      version: e.version,
      route: e.route,
      stack: e.stack,
      context: e.context,
      hasUser: e.userId !== null,
      hasTenant: e.tenantId !== null,
    })),
  };
}

/** Resolver / Ignorar / Reabrir. Resolver guarda quem e quando; Reabrir e Ignorar limpam essa marca. */
export async function setErrorGroupStatus(id: string, status: ErrorStatus, adminUserId: string, now: Date = new Date()): Promise<ErrorGroupItem> {
  const prisma = getPrisma();
  const data =
    status === "RESOLVED"
      ? { status, resolvedAt: now, resolvedByUserId: adminUserId }
      : { status, resolvedAt: null, resolvedByUserId: null };
  const updated = await prisma.errorGroup.updateMany({ where: { id }, data });
  if (updated.count === 0) throw new DomainError("ERROR_GROUP_NOT_FOUND", "Esse erro não existe mais.");
  const row = await prisma.errorGroup.findUniqueOrThrow({ where: { id }, select: GROUP_SELECT });
  return toItem(row);
}

/**
 * Retenção (manutenção diária): ocorrências com mais de 30 dias saem (o grupo e o contador ficam), e grupo RESOLVED ou
 * IGNORED sem ocorrência há 90 dias também sai (as ocorrências vão junto, em cascata). Grupo OPEN do SERVIDOR nunca é apagado:
 * é trabalho pendente do admin. Grupo OPEN do NAVEGADOR sem ocorrência há 30 dias vira RESOLVED (e sai 90 dias depois).
 */
export const ERROR_EVENT_RETENTION_DAYS = 30;
export const ERROR_GROUP_RETENTION_DAYS = 90;
/** Grupo OPEN do navegador (relato público, ninguém "assume") sem ocorrência há tanto tempo vira RESOLVED sozinho. */
export const CLIENT_OPEN_GROUP_EXPIRY_DAYS = 30;

export async function purgeOldErrorEvents(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ERROR_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const prisma = getPrisma();
  const result = await prisma.errorEvent.deleteMany({ where: { occurredAt: { lt: cutoff } } });
  const clientCutoff = new Date(now.getTime() - CLIENT_OPEN_GROUP_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  await prisma.errorGroup.updateMany({ where: { source: "CLIENT", status: "OPEN", lastSeenAt: { lt: clientCutoff } }, data: { status: "RESOLVED", resolvedAt: now, resolvedByUserId: null } });
  const groupCutoff = new Date(now.getTime() - ERROR_GROUP_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await prisma.errorGroup.deleteMany({ where: { status: { in: ["RESOLVED", "IGNORED"] }, lastSeenAt: { lt: groupCutoff } } });
  // Linhas de reserva da janela de alerta (1 por 15 min) não precisam durar.
  await prisma.providerEvent.deleteMany({ where: { provider: "error-alert", createdAt: { lt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000) } } });
  return result.count;
}
