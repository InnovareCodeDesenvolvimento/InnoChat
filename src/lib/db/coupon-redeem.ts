import { Prisma } from "@prisma/client";

/**
 * Resgate atômico de cupom (item 6). Vive aqui porque só `src/lib/db/` pode usar SQL cru, e porque
 * "contador < limite" compara duas colunas da MESMA linha, o que o `updateMany` do Prisma não expressa.
 *
 * Um único `UPDATE ... WHERE` confere tudo (ativo, janela de validade, limite de usos) e soma 1 em
 * `redemptionsCount`: duas empresas disputando o último uso nunca passam as duas, porque o Postgres
 * serializa a linha e a segunda reavalia o `WHERE` já com o contador novo. Devolve `true` se ganhou o uso.
 *
 * Roda no cliente da transação do chamador (`db`), para o uso desfazer junto se o resto do cadastro/ação falhar.
 * Instantes entram como texto ISO com `::timestamp` (colunas `timestamp(3)` em UTC).
 */
export async function claimCouponRedemption(db: Pick<Prisma.TransactionClient, "$executeRaw">, couponId: string, now: Date): Promise<boolean> {
  const at = now.toISOString();
  const affected = await db.$executeRaw(Prisma.sql`
    UPDATE "coupons"
       SET "redemptionsCount" = "redemptionsCount" + 1, "updatedAt" = ${at}::timestamp
     WHERE "id" = ${couponId}
       AND "active" = true
       AND ("validFrom" IS NULL OR "validFrom" <= ${at}::timestamp)
       AND ("validUntil" IS NULL OR "validUntil" >= ${at}::timestamp)
       AND ("maxRedemptions" IS NULL OR "redemptionsCount" < "maxRedemptions")
  `);
  return affected === 1;
}
