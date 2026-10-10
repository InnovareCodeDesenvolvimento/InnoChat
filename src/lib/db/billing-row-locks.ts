import { Prisma } from "@prisma/client";

/**
 * Travas de linha (`SELECT ... FOR UPDATE`) para "ler, decidir e gravar" de plano e assinatura sem corrida.
 * Vivem aqui porque só `src/lib/db/` pode usar SQL cru. Rodam no cliente da TRANSAÇÃO do chamador: a trava
 * vale até o COMMIT/ROLLBACK, então não existe caminho de erro que a deixe presa.
 *
 * Ordem combinada (evita deadlock): primeiro a linha da assinatura, depois a do plano. O Admin só trava o plano.
 */
type Db = Pick<Prisma.TransactionClient, "$queryRaw">;

/** Trava a linha do plano. Quem pega depois espera o COMMIT de quem pegou antes e já lê o valor novo. */
export async function lockPlanRow(db: Db, planId: string): Promise<void> {
  await db.$queryRaw(Prisma.sql`SELECT "id" FROM "plans" WHERE "id" = ${planId} FOR UPDATE`);
}

/** Trava a linha da assinatura da empresa (troca de plano e troca de ciclo não rodam juntas). */
export async function lockSubscriptionRow(db: Db, tenantId: string): Promise<void> {
  await db.$queryRaw(Prisma.sql`SELECT "id" FROM "subscriptions" WHERE "tenantId" = ${tenantId} FOR UPDATE`);
}

/**
 * Trava a linha da assinatura pelo id (quem só conhece a fatura, como a baixa de pagamento). Mesma ordem combinada:
 * assinatura primeiro, depois fatura. Sem isto, a baixa (fatura, depois assinatura) e a reprecificação do teste ou o
 * cancelamento (assinatura, depois fatura) podiam travar uma na outra.
 */
export async function lockSubscriptionRowById(db: Db, subscriptionId: string): Promise<void> {
  await db.$queryRaw(Prisma.sql`SELECT "id" FROM "subscriptions" WHERE "id" = ${subscriptionId} FOR UPDATE`);
}
