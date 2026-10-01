import { getPrisma } from "@/lib/db/prisma";
import { effectiveStatus } from "@/core/billing";

/**
 * Refinamento de UX (achado da Íris): quando a assinatura está `SUSPENDED`/`CANCELED`, o
 * servidor já bloqueia toda escrita (`assertTenantCanWrite`, docs/arquitetura.md §7.4) — isto
 * aqui é só para desabilitar visualmente os botões de escrita nas telas de Serviços,
 * Profissionais e Agenda, com uma dica explicando o motivo. Nunca é a fonte de verdade da
 * regra, só a comunicação dela.
 */
export async function isTenantWriteBlocked(tenantId: string): Promise<boolean> {
  const subscription = await getPrisma().subscription.findUnique({
    where: { tenantId },
    select: { status: true, trialEndsAt: true, currentPeriodEnd: true, cancelAtPeriodEnd: true },
  });
  if (!subscription) return false;
  const status = effectiveStatus(subscription, new Date());
  return status === "SUSPENDED" || status === "CANCELED";
}

export const WRITE_BLOCKED_HINT = "Assinatura suspensa — ação bloqueada até o pagamento. Veja Assinatura.";
