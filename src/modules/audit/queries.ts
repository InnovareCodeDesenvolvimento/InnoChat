import { getPrisma } from "@/lib/db/prisma";
import type { Prisma } from "@/lib/db/types";
import { DEFAULT_PAGE_SIZE, pageInfoOf, resolvePage, type PageInfo, type PageSize } from "@/modules/billing/paging";
import { actionLabel, fieldLabel, findArea, formatAuditValue, ROLE_LABELS } from "./labels";

/**
 * Leitura do registro de auditoria. `AuditLog` não é tenant-scoped (o Admin lê todas as empresas), então QUEM CHAMA
 * decide o escopo: `listTenantAudit` SEMPRE fixa o `tenantId` na consulta, o Admin (`listAdminAudit`) enxerga tudo.
 * Nunca exponha o escopo por parâmetro vindo do navegador: o id da empresa da tela do dono vem do guard.
 */

/**
 * RETENÇÃO: o dono ainda não decidiu por quanto tempo guardar. Enquanto `null`, NADA é apagado automaticamente
 * (nem por tick, nem por tela). Quando houver decisão, o apagamento é um DELETE por `createdAt` (o trigger só barra UPDATE)
 * num job próprio; esta constante é o único lugar a mudar. Pendência registrada no handoff da Melhoria 4.
 */
export const AUDIT_RETENTION_DAYS: number | null = null;

export type AuditFilters = {
  /** Admin: nome ou endereço (slug) da empresa. */
  tenantQuery?: string;
  /** Id de uma área de `AUDIT_AREAS`. */
  area?: string;
  /** E-mail ou nome de quem fez. */
  actor?: string;
  /** AAAA-MM-DD, início do dia em Brasília. */
  from?: string;
  /** AAAA-MM-DD, fim do dia em Brasília. */
  to?: string;
};

export type AuditChangeView = { field: string; label: string; from: string; to: string };

export type AuditItem = {
  id: string;
  createdAt: string;
  action: string;
  actionLabel: string;
  actorRole: string;
  actorRoleLabel: string;
  /** Quem fez, em texto: nome ou e-mail; "Equipe InnoChat" e "Sistema" nos casos sem pessoa. */
  actorName: string;
  tenant: { id: string; name: string; slug: string } | null;
  targetType: string | null;
  summary: string;
  changes: AuditChangeView[];
  /** Só o Admin recebe (a empresa não precisa saber de onde). */
  ipTruncated: string | null;
};

export type AuditPage = { items: AuditItem[] } & PageInfo;

const TZ_OFFSET = "-03:00";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACTOR_MATCH_LIMIT = 100;
const TENANT_MATCH_LIMIT = 200;

export function parseDayStart(date: string | undefined): Date | undefined {
  if (!date || !DATE_RE.test(date)) return undefined;
  const d = new Date(`${date}T00:00:00.000${TZ_OFFSET}`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function parseDayEnd(date: string | undefined): Date | undefined {
  if (!date || !DATE_RE.test(date)) return undefined;
  const d = new Date(`${date}T23:59:59.999${TZ_OFFSET}`);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

type Paging = { page?: number; pageSize?: PageSize };

async function buildWhere(base: Prisma.AuditLogWhereInput, filters: AuditFilters, options: { allowTenantQuery: boolean }): Promise<Prisma.AuditLogWhereInput | null> {
  const and: Prisma.AuditLogWhereInput[] = [base];

  const area = findArea(filters.area);
  if (area) and.push({ OR: area.prefixes.map((prefix) => ({ action: { startsWith: prefix } })) });

  const from = parseDayStart(filters.from);
  const to = parseDayEnd(filters.to);
  if (from || to) and.push({ createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } });

  const actorText = filters.actor?.trim();
  if (actorText) {
    const users = await getPrisma().user.findMany({
      where: { OR: [{ email: { contains: actorText, mode: "insensitive" } }, { name: { contains: actorText, mode: "insensitive" } }] },
      select: { id: true },
      take: ACTOR_MATCH_LIMIT,
    });
    if (users.length === 0) return null;
    and.push({ actorUserId: { in: users.map((u) => u.id) } });
  }

  const tenantText = options.allowTenantQuery ? filters.tenantQuery?.trim() : undefined;
  if (tenantText) {
    const tenants = await getPrisma().tenant.findMany({
      where: { OR: [{ name: { contains: tenantText, mode: "insensitive" } }, { slug: { contains: tenantText, mode: "insensitive" } }] },
      select: { id: true },
      take: TENANT_MATCH_LIMIT,
    });
    if (tenants.length === 0) return null;
    and.push({ tenantId: { in: tenants.map((t) => t.id) } });
  }

  return { AND: and };
}

function changesOf(raw: unknown, timezone: string): AuditChangeView[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out: AuditChangeView[] = [];
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    const pair = (value ?? {}) as { de?: unknown; para?: unknown };
    out.push({ field, label: fieldLabel(field), from: formatAuditValue(field, pair.de, timezone), to: formatAuditValue(field, pair.para, timezone) });
  }
  return out;
}

async function runQuery(where: Prisma.AuditLogWhereInput | null, paging: Paging, options: { includeIp: boolean; timezone: string; hidePlatformAdminName: boolean }): Promise<AuditPage> {
  const pageSize = paging.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!where) return { items: [], ...pageInfoOf(resolvePage(1, pageSize, 0)) };

  const prisma = getPrisma();
  const total = await prisma.auditLog.count({ where });
  const info = resolvePage(paging.page, pageSize, total);
  const rows = await prisma.auditLog.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: info.skip,
    take: pageSize,
    include: { tenant: { select: { id: true, name: true, slug: true } } },
  });

  const userIds = Array.from(new Set(rows.map((r) => r.actorUserId).filter((id): id is string => !!id)));
  const users = userIds.length > 0 ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }) : [];
  const userById = new Map(users.map((u) => [u.id, u]));

  const items: AuditItem[] = rows.map((row) => {
    const user = row.actorUserId ? userById.get(row.actorUserId) : undefined;
    let actorName: string;
    if (row.actorRole === "SYSTEM") actorName = "Sistema";
    else if (row.actorRole === "PLATFORM_ADMIN" && options.hidePlatformAdminName) actorName = "Equipe InnoChat";
    else actorName = user?.name?.trim() || user?.email || "Usuário removido";
    return {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      action: row.action,
      actionLabel: actionLabel(row.action),
      actorRole: row.actorRole,
      actorRoleLabel: ROLE_LABELS[row.actorRole] ?? row.actorRole,
      actorName,
      tenant: row.tenant,
      targetType: row.targetType,
      summary: row.summary,
      changes: changesOf(row.changes, options.timezone),
      ipTruncated: options.includeIp ? row.ipTruncated : null,
    };
  });
  return { items, ...pageInfoOf(info) };
}

/** Admin → Auditoria: todas as empresas e as ações da plataforma. */
export async function listAdminAudit(filters: AuditFilters, paging: Paging): Promise<AuditPage> {
  const where = await buildWhere({}, filters, { allowTenantQuery: true });
  return runQuery(where, paging, { includeIp: true, timezone: "America/Sao_Paulo", hidePlatformAdminName: false });
}

/** Configurações → Histórico de alterações: SÓ as linhas desta empresa, nunca as da plataforma. */
export async function listTenantAudit(tenantId: string, timezone: string, filters: AuditFilters, paging: Paging): Promise<AuditPage> {
  const where = await buildWhere({ tenantId }, filters, { allowTenantQuery: false });
  return runQuery(where, paging, { includeIp: false, timezone, hidePlatformAdminName: true });
}
