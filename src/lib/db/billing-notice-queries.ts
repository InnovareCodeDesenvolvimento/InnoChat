import { Prisma } from "@prisma/client";
import { getPrisma } from "./prisma";

/**
 * Claim do outbox da régua de cobrança (`BillingNotice`, docs/regua-de-cobranca.md §2.5). Vive aqui porque
 * só `src/lib/db/` pode usar SQL cru (`Prisma.sql`, ver `eslint.config.mjs`).
 *
 * `FOR UPDATE SKIP LOCKED` dentro de um único `UPDATE ... RETURNING`: dois despachantes simultâneos (tick
 * horário e envio imediato do "pagamento confirmado", por exemplo) nunca pegam a mesma linha, e quem chega
 * depois pula as linhas já travadas em vez de esperar.
 *
 * Instantes entram como texto ISO com `::timestamp`: as colunas são `timestamp(3)` em UTC e uma data JS
 * enviada direto seria tratada como `timestamptz` (e convertida pelo fuso da SESSÃO).
 */

export type ClaimedBillingNotice = {
  id: string;
  tenantId: string;
  subscriptionId: string;
  invoiceId: string | null;
  step: string;
  channel: string;
  cycleKey: string;
  attempts: number;
  notBefore: Date;
  expiresAt: Date;
  createdAt: Date;
};

export async function claimDueBillingNotices(args: {
  now: Date;
  limit: number;
  /** `SENDING` com `updatedAt` anterior a isto é considerado preso (processo morreu no envio) e volta à fila. */
  stuckBefore: Date;
  maxAttempts: number;
  /** Só estas linhas (envio imediato do pagamento confirmado). Omitido = a fila inteira. */
  onlyIds?: string[];
  /** Só este canal (cada canal tem o seu teto por rodada). */
  channel?: "EMAIL" | "WHATSAPP";
}): Promise<ClaimedBillingNotice[]> {
  const now = args.now.toISOString();
  const stuckBefore = args.stuckBefore.toISOString();
  const only = args.onlyIds && args.onlyIds.length > 0 ? Prisma.sql`AND "id" IN (${Prisma.join(args.onlyIds)})` : Prisma.empty;
  if (args.onlyIds && args.onlyIds.length === 0) return [];
  const channel = args.channel ? Prisma.sql`AND "channel" = ${args.channel}` : Prisma.empty;

  return getPrisma().$queryRaw<ClaimedBillingNotice[]>(Prisma.sql`
    UPDATE "billing_notices" AS n
       SET "status" = 'SENDING', "updatedAt" = ${now}::timestamp,
           -- Recuperar um SENDING preso conta como tentativa (o envio pode ter saido antes de o processo morrer):
           -- sem isso um aviso preso era reenviado para sempre, a cada recuperacao.
           "attempts" = CASE WHEN n."status" = 'SENDING' THEN n."attempts" + 1 ELSE n."attempts" END
      FROM (
        SELECT "id" FROM "billing_notices"
         WHERE (
                ("status" IN ('PENDING', 'FAILED')
                  AND "nextAttemptAt" <= ${now}::timestamp
                  AND "notBefore" <= ${now}::timestamp
                  AND "expiresAt" > ${now}::timestamp
                  AND "attempts" < ${args.maxAttempts})
             OR ("status" = 'SENDING' AND "updatedAt" < ${stuckBefore}::timestamp AND "attempts" < ${args.maxAttempts})
               )
           ${only}
           ${channel}
         ORDER BY "nextAttemptAt" ASC, "createdAt" ASC
         LIMIT ${args.limit}
         FOR UPDATE SKIP LOCKED
      ) AS c
     WHERE n."id" = c."id"
 RETURNING n."id", n."tenantId", n."subscriptionId", n."invoiceId", n."step", n."channel", n."cycleKey",
           n."attempts", n."notBefore", n."expiresAt", n."createdAt"
  `);
}

/**
 * Retenção de dado pessoal do registro de envios (F6): zera o destino COMPLETO e o snapshot do texto dos avisos com
 * última mudança anterior a `before`. Fica o `recipientMasked` (já mascarado). SQL cru de propósito: um `updateMany`
 * do Prisma reescreveria `updatedAt` (`@updatedAt`) e jogaria avisos antigos para o topo do registro do Admin.
 */
export async function clearExpiredNoticePersonalData(before: Date): Promise<number> {
  const cutoff = before.toISOString();
  return getPrisma().$executeRaw(Prisma.sql`
    UPDATE "billing_notices"
       SET "recipient" = NULL, "renderedSubject" = NULL, "renderedText" = NULL
     WHERE "updatedAt" < ${cutoff}::timestamp
       AND ("recipient" IS NOT NULL OR "renderedSubject" IS NOT NULL OR "renderedText" IS NOT NULL)
  `);
}
