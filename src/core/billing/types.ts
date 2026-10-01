/**
 * Tipos puros do domínio de cobrança (docs/arquitetura.md §7). Sem Prisma, sem I/O — só o que
 * `status.ts` precisa para calcular `effectiveStatus` e as datas de ciclo.
 */

export type SubscriptionStatus = "TRIALING" | "ACTIVE" | "PAST_DUE" | "SUSPENDED" | "CANCELED";

/**
 * Retrato mínimo de uma `Subscription` (prisma/schema.prisma) necessário para calcular o status
 * efetivo — não é o model do Prisma inteiro, só os campos relevantes.
 */
export type SubscriptionSnapshot = {
  status: SubscriptionStatus;
  trialEndsAt: Date | null;
  currentPeriodEnd: Date;
  /** `null` = nunca pagou (teste não convertido); ausente = desconhecido (trata como já pagante). */
  firstPaidAt?: Date | null;
  /** O dono agendou o cancelamento: ao chegar o fim do período/teste vira `CANCELED`, sem carência. */
  cancelAtPeriodEnd: boolean;
  /**
   * Fuso da empresa (`Tenant.timezone`), usado só para o vencimento de quem paga (23:59 do dia local).
   * Ausente = `America/Sao_Paulo`, o único fuso suportado na v1.
   */
  timezone?: string | null;
  /**
   * O admin suspendeu à mão (`Subscription.manualSuspendedAt`). Não é atraso: enquanto preenchida, o status
   * efetivo é `SUSPENDED` (até o cancelamento automático) e nunca `PAST_DUE`/`ACTIVE`, mesmo que o vencimento
   * gravado caia na carência. Ausente/nula = suspensão (se houver) é por atraso.
   */
  manualSuspendedAt?: Date | null;
};
