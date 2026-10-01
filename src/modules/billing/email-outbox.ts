import { getPrisma } from "@/lib/db/prisma";
import { isUniqueViolation } from "@/lib/db/prisma-errors";

/**
 * Marca de "e-mail de cobrança de envio ÚNICO" para avisos que não têm coluna própria no schema
 * (fatura gerada e cancelamento automático). Sem migration: reaproveita `ProviderEvent`
 * (`provider = "billing-email"`, `providerEventId = "<tipo>:<chave>"`, unique), o mesmo padrão da
 * auditoria de baixa manual (`admin-service.ts`).
 *
 * Ciclo: `claimOnceEmail` cria a linha (só quem a cria envia: dois ticks nunca mandam duas vezes) →
 * envia → `markOnceEmailSent` grava `processedAt`. Se o envio falha, a linha fica com
 * `processedAt = null` e `listPendingOnceEmails` a devolve na próxima rodada. É uma solução
 * transitória: a F1 (outbox `BillingNotice`) substitui isto.
 */
export const ONCE_EMAIL_PROVIDER = "billing-email";
export type OnceEmailKind = "invoice_generated" | "auto_cancel";

/** Depois deste prazo sem sucesso o aviso deixa de fazer sentido e a linha é encerrada sem reenviar. */
export const ONCE_EMAIL_GIVE_UP_DAYS = 7;

export function onceEmailId(kind: OnceEmailKind, key: string): string {
  return `${kind}:${key}`;
}

/** `true` se esta chamada criou a marca (e portanto deve enviar); `false` se já existia. */
export async function claimOnceEmail(kind: OnceEmailKind, key: string): Promise<boolean> {
  try {
    await getPrisma().providerEvent.create({
      data: { provider: ONCE_EMAIL_PROVIDER, providerEventId: onceEmailId(kind, key), payload: { kind } },
    });
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

export async function markOnceEmailSent(kind: OnceEmailKind, key: string, at: Date = new Date()): Promise<void> {
  await getPrisma().providerEvent.updateMany({
    where: { provider: ONCE_EMAIL_PROVIDER, providerEventId: onceEmailId(kind, key), processedAt: null },
    data: { processedAt: at },
  });
}

export async function listPendingOnceEmails(kind: OnceEmailKind, limit = 50): Promise<{ key: string; createdAt: Date }[]> {
  const rows = await getPrisma().providerEvent.findMany({
    where: { provider: ONCE_EMAIL_PROVIDER, processedAt: null, providerEventId: { startsWith: `${kind}:` } },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { providerEventId: true, createdAt: true },
  });
  return rows.map((row) => ({ key: row.providerEventId.slice(kind.length + 1), createdAt: row.createdAt }));
}
