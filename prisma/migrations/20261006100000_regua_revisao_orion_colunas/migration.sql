-- Revisao do Orion a regua de cobranca (2026-10-01): colunas ADITIVAS (todas nulas, sem default, sem reescrever tabela).
--
-- subscriptions.manualSuspendedAt     suspensao feita a mao pelo admin (nao e atraso; a regua nao cobra)
-- tenants.billingWhatsappConfirmedAt  posse do numero de cobranca confirmada (assinante respondeu SIM)
-- invoices.paidByPaymentId            qual pagamento do MP baixou a fatura ("manual" = baixa do admin)
-- invoices.duplicatePaymentAt         segundo pagamento numa fatura ja PAID (sino do admin: estorno manual)

ALTER TABLE "subscriptions" ADD COLUMN "manualSuspendedAt" TIMESTAMP(3);
ALTER TABLE "tenants" ADD COLUMN "billingWhatsappConfirmedAt" TIMESTAMP(3);
ALTER TABLE "invoices" ADD COLUMN "paidByPaymentId" TEXT;
ALTER TABLE "invoices" ADD COLUMN "duplicatePaymentAt" TIMESTAMP(3);

CREATE INDEX "invoices_duplicatePaymentAt_idx" ON "invoices"("duplicatePaymentAt");

-- Backfill da suspensao manual: quem hoje esta SUSPENDED/PAST_DUE e tem um MANUAL_SUSPEND cujo
-- `metadata.currentPeriodEnd` ainda e o `currentPeriodEnd` da assinatura (nenhum pagamento depois dele).
-- Idempotente (so preenche quando ainda nulo). Suspensoes manuais ANTERIORES ao evento (sem linha em
-- billing_events) nao tem como ser identificadas: o admin precisa suspender de novo (ver o handoff).
UPDATE "subscriptions" s
   SET "manualSuspendedAt" = e."createdAt"
  FROM (
    SELECT DISTINCT ON ("subscriptionId") "subscriptionId", "createdAt", "metadata"
      FROM "billing_events"
     WHERE "type" = 'MANUAL_SUSPEND'
     ORDER BY "subscriptionId", "createdAt" DESC
  ) e
 WHERE e."subscriptionId" = s."id"
   AND s."manualSuspendedAt" IS NULL
   AND s."status" IN ('SUSPENDED', 'PAST_DUE')
   AND e."metadata"->>'currentPeriodEnd' = to_char(s."currentPeriodEnd", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
