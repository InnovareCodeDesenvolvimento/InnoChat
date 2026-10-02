import { Prisma } from "@prisma/client";
import { getPrisma } from "./prisma";

/**
 * Agregações de `Contact` × `Appointment` (contagens/último/próximo agendamento) para a tela de
 * Clientes (`src/modules/contacts/contacts.ts`). Vive aqui — não em `src/modules/` — porque só
 * `src/lib/db/` pode importar `@prisma/client` cru (`Prisma.sql`, ver `eslint.config.mjs`); o
 * módulo de domínio nunca monta SQL.
 *
 * Uma consulta só (LEFT JOIN LATERAL), sem N+1: a alternativa nativa do Prisma
 * (`findMany` + `include`) resolveria em duas idas ao banco e ainda não dá para FILTRAR por
 * "tem agendamento futuro" nem ORDENAR por "próximo agendamento" no banco — teria que carregar
 * TODOS os contatos do tenant para paginar em memória, o que é exatamente o que a paginação
 * existe para evitar.
 *
 * `tenantId` é SEMPRE interpolado via parâmetro (`${tenantId}` dentro do template do
 * `$queryRaw`), nunca concatenado em string — o Prisma parametriza tudo que passa por `${}`
 * dentro do tagged template, mesma garantia de um `?` de prepared statement.
 */

export type ContactFilter = "all" | "upcoming" | "botPaused" | "inactive90d";

export type ContactStatsRow = {
  id: string;
  name: string | null;
  pushName: string | null;
  phoneE164: string | null;
  waJid: string;
  botPausedUntil: Date | null;
  createdAt: Date;
  appointmentsCount: number;
  noShowCount: number;
  lastAppointmentAt: Date | null;
  nextAppointmentAt: Date | null;
};

const ANON_WAJID_PREFIX = "anon:";

export async function queryContactsWithStats(params: {
  tenantId: string;
  q?: string;
  filter: ContactFilter;
  offset: number;
  limit: number;
  now: Date;
}): Promise<{ rows: ContactStatsRow[]; hasMore: boolean }> {
  const { tenantId, q, filter, offset, limit, now } = params;

  const trimmedQ = q?.trim();
  const searchDigits = trimmedQ ? trimmedQ.replace(/\D/g, "") : "";
  const searchClause = trimmedQ
    ? Prisma.sql`AND (
        c.name ILIKE ${`%${trimmedQ}%`}
        OR c."pushName" ILIKE ${`%${trimmedQ}%`}
        ${searchDigits ? Prisma.sql`OR regexp_replace(COALESCE(c."phoneE164", ''), '\\D', '', 'g') LIKE ${`%${searchDigits}%`}` : Prisma.empty}
      )`
    : Prisma.empty;

  // `botPausedUntil` é `timestamp(3)` SEM fuso (UTC): a data entra como texto ISO + `::timestamp` (padrão da casa), senão o
  // Postgres converteria pelo fuso da sessão e o filtro "bot pausado" sairia deslocado. As colunas `startsAt` são
  // `timestamptz`, então comparam com a data direta, sem risco.
  const nowUtcText = now.toISOString();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const filterClause =
    filter === "upcoming"
      ? Prisma.sql`AND stats."nextAppointmentAt" IS NOT NULL`
      : filter === "botPaused"
        ? Prisma.sql`AND c."botPausedUntil" IS NOT NULL AND c."botPausedUntil" > ${nowUtcText}::timestamp`
        : filter === "inactive90d"
          ? Prisma.sql`AND stats."appointmentsCount" > 0 AND (stats."lastAppointmentAt" IS NULL OR stats."lastAppointmentAt" < ${ninetyDaysAgo})`
          : Prisma.empty;

  const rows = await getPrisma().$queryRaw<ContactStatsRow[]>`
    SELECT
      c.id,
      c.name,
      c."pushName",
      c."phoneE164",
      c."waJid",
      c."botPausedUntil",
      c."createdAt",
      COALESCE(stats."appointmentsCount", 0)::int AS "appointmentsCount",
      COALESCE(stats."noShowCount", 0)::int AS "noShowCount",
      stats."lastAppointmentAt",
      stats."nextAppointmentAt"
    FROM contacts c
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) AS "appointmentsCount",
        COUNT(*) FILTER (WHERE a.status = 'NO_SHOW') AS "noShowCount",
        MAX(a."startsAt") FILTER (WHERE a."startsAt" < ${now}) AS "lastAppointmentAt",
        MIN(a."startsAt") FILTER (WHERE a.status = 'SCHEDULED' AND a."startsAt" >= ${now}) AS "nextAppointmentAt"
      FROM appointments a
      WHERE a."contactId" = c.id
    ) stats ON true
    WHERE c."tenantId" = ${tenantId}
      AND c."waJid" NOT LIKE ${`${ANON_WAJID_PREFIX}%`}
      ${searchClause}
      ${filterClause}
    ORDER BY (stats."nextAppointmentAt" IS NULL) ASC, stats."nextAppointmentAt" ASC, c."createdAt" DESC
    LIMIT ${limit + 1}
    OFFSET ${offset}
  `;

  const hasMore = rows.length > limit;
  return { rows: rows.slice(0, limit), hasMore };
}
