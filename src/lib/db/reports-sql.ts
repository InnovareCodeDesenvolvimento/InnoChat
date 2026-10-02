import { Prisma } from "@prisma/client";
import { getPrisma } from "./prisma";
import type { ReportGroupRow } from "@/core/reports/aggregate";

/**
 * Relatório de faturamento e comissão (Melhoria 8): UMA consulta agregada no banco, agrupada por
 * (profissional, serviço). Sem N+1 e sem trazer agendamento por agendamento para a memória.
 *
 * Regras (espelham src/core/reports/commission.ts):
 * - conta só COMPLETED no faturamento/comissão e NO_SHOW nas faltas; SCHEDULED/CANCELED ficam de fora;
 * - o valor vem da foto gravada ao concluir (`priceCentsSnapshot`/`commissionCentsSnapshot`); sem foto
 *   (concluído antes da Melhoria 8), cai no preço atual do serviço e na comissão atual
 *   (% do serviço do profissional, senão % do profissional, senão 0) e conta em `estimatedCount`;
 * - o `tenantId` é SEMPRE o primeiro filtro, vindo do servidor (nunca de parâmetro do cliente).
 * Arredondamento: ROUND(numeric) do Postgres arredonda meio centavo para cima, como `commissionCentsFor`.
 */

type RawRow = {
  professionalId: string;
  professionalName: string;
  serviceId: string;
  serviceName: string;
  completed: bigint;
  noShow: bigint;
  revenueCents: bigint | null;
  commissionCents: bigint | null;
  estimatedCount: bigint;
  withoutPriceCount: bigint;
};

export async function queryReportGroups(params: { tenantId: string; from: Date; toExclusive: Date }): Promise<ReportGroupRow[]> {
  const rows = await getPrisma().$queryRaw<RawRow[]>(Prisma.sql`
    SELECT
      a."professionalId" AS "professionalId",
      p."name" AS "professionalName",
      a."serviceId" AS "serviceId",
      s."name" AS "serviceName",
      COUNT(*) FILTER (WHERE a."status" = 'COMPLETED') AS "completed",
      COUNT(*) FILTER (WHERE a."status" = 'NO_SHOW') AS "noShow",
      SUM(COALESCE(a."priceCentsSnapshot", s."priceCents", 0)) FILTER (WHERE a."status" = 'COMPLETED') AS "revenueCents",
      SUM(
        COALESCE(
          a."commissionCentsSnapshot",
          ROUND(COALESCE(a."priceCentsSnapshot", s."priceCents", 0) * COALESCE(ps."commissionPct", p."commissionPct", 0) / 100)
        )
      ) FILTER (WHERE a."status" = 'COMPLETED') AS "commissionCents",
      COUNT(*) FILTER (WHERE a."status" = 'COMPLETED' AND a."priceCentsSnapshot" IS NULL) AS "estimatedCount",
      COUNT(*) FILTER (WHERE a."status" = 'COMPLETED' AND COALESCE(a."priceCentsSnapshot", s."priceCents", 0) = 0) AS "withoutPriceCount"
    FROM "appointments" a
    JOIN "services" s ON s."id" = a."serviceId" AND s."tenantId" = a."tenantId"
    JOIN "professionals" p ON p."id" = a."professionalId" AND p."tenantId" = a."tenantId"
    LEFT JOIN "professional_services" ps ON ps."professionalId" = a."professionalId" AND ps."serviceId" = a."serviceId"
    WHERE a."tenantId" = ${params.tenantId}
      AND a."startsAt" >= ${params.from}
      AND a."startsAt" < ${params.toExclusive}
      AND a."status" IN ('COMPLETED', 'NO_SHOW')
    GROUP BY a."professionalId", p."name", a."serviceId", s."name"
  `);

  return rows.map((r) => ({
    professionalId: r.professionalId,
    professionalName: r.professionalName,
    serviceId: r.serviceId,
    serviceName: r.serviceName,
    completed: Number(r.completed),
    noShow: Number(r.noShow),
    revenueCents: Number(r.revenueCents ?? 0),
    commissionCents: Number(r.commissionCents ?? 0),
    estimatedCount: Number(r.estimatedCount),
    withoutPriceCount: Number(r.withoutPriceCount),
  }));
}
