import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { getPrisma } from "./prisma";

/**
 * Gravação atômica do monitor de erros (Melhoria 1). SQL cru só aqui (regra do projeto): o upsert por `fingerprint`
 * precisa de `ON CONFLICT` com regras de status que o `upsert` do Prisma não expressa numa instrução só.
 *
 * Regras (uma instrução, sem corrida entre duas ocorrências simultâneas):
 * - grupo novo: nasce OPEN, `count = 1`, `alertedAt` nulo (o alerta ainda não saiu);
 * - repetição: `count + 1`, `lastSeenAt`, rota e versão da última ocorrência;
 * - RESOLVED que repete REABRE (volta a OPEN, zera resolvedAt/resolvedByUserId e `alertedAt`, para a regressão avisar de novo);
 * - IGNORED só conta: o status e o resto ficam como estão.
 */

export type UpsertErrorGroupInput = {
  fingerprint: string;
  message: string;
  type: string;
  source: "SERVER" | "CLIENT";
  route: string | null;
  version: string | null;
  now: Date;
};

export type UpsertErrorGroupResult = {
  id: string;
  status: string;
  alertedAt: Date | null;
  inserted: boolean;
  /** Estava RESOLVED e voltou a OPEN nesta ocorrência. */
  reopened: boolean;
  count: number;
};

type Row = { id: string; status: string; alertedAt: Date | null; inserted: boolean; prevStatus: string | null; count: number };

/**
 * As colunas são `timestamp(3)` SEM fuso. No SQL cru o Prisma manda a data como timestamptz e o Postgres converteria pelo
 * fuso da SESSÃO (se não for UTC, a hora gravada sai deslocada). Fixa o instante em UTC explicitamente.
 */
const utc = (date: Date) => Prisma.sql`(${date}::timestamptz AT TIME ZONE 'UTC')`;

export async function upsertErrorGroup(input: UpsertErrorGroupInput): Promise<UpsertErrorGroupResult> {
  const id = randomUUID();
  const rows = await getPrisma().$queryRaw<Row[]>(Prisma.sql`
    WITH prev AS (SELECT status FROM error_groups WHERE fingerprint = ${input.fingerprint})
    INSERT INTO error_groups
      (id, fingerprint, message, type, source, route, "firstSeenAt", "lastSeenAt", "count", status, "firstVersion", "lastVersion")
    VALUES
      (${id}, ${input.fingerprint}, ${input.message}, ${input.type}, ${input.source}, ${input.route},
       ${utc(input.now)}, ${utc(input.now)}, 1, 'OPEN', ${input.version}, ${input.version})
    ON CONFLICT (fingerprint) DO UPDATE SET
      "lastSeenAt" = EXCLUDED."lastSeenAt",
      "count" = error_groups."count" + 1,
      route = COALESCE(EXCLUDED.route, error_groups.route),
      "lastVersion" = COALESCE(EXCLUDED."lastVersion", error_groups."lastVersion"),
      status = CASE WHEN error_groups.status = 'RESOLVED' THEN 'OPEN' ELSE error_groups.status END,
      "resolvedAt" = CASE WHEN error_groups.status = 'RESOLVED' THEN NULL ELSE error_groups."resolvedAt" END,
      "resolvedByUserId" = CASE WHEN error_groups.status = 'RESOLVED' THEN NULL ELSE error_groups."resolvedByUserId" END,
      "alertedAt" = CASE WHEN error_groups.status = 'RESOLVED' THEN NULL ELSE error_groups."alertedAt" END
    RETURNING id, status, "alertedAt", (xmax = 0) AS inserted, (SELECT status FROM prev) AS "prevStatus", "count"
  `);
  const row = rows[0];
  if (!row) throw new Error("error_groups upsert não devolveu linha");
  return {
    id: row.id,
    status: row.status,
    alertedAt: row.alertedAt,
    inserted: row.inserted,
    reopened: row.prevStatus === "RESOLVED",
    count: Number(row.count),
  };
}
