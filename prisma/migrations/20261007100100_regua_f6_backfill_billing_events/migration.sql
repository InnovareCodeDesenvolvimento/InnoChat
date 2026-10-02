-- F6 da regua: carga inicial APROXIMADA de billing_events (docs/regua-de-cobranca.md §3.2). Churn e recuperacao so
-- existiam para o futuro; esta carga deriva o passado de dados que ja estao no banco e marca tudo com
-- metadata.backfill = true. So INSERT (a tabela e append-only), idempotente por NOT EXISTS.
--
-- Limites assumidos: o status de ORIGEM do pagamento nao e conhecido (fromStatus nulo: nunca conta como "recuperado") e
-- a origem do cancelamento e deduzida (cancelAtPeriodEnd = dono; nunca pagou = teste nao convertido; senao automatico).

-- Cancelamentos.
INSERT INTO "billing_events" ("id", "tenantId", "subscriptionId", "type", "toStatus", "actorType", "metadata", "createdAt")
SELECT
  'bf_cancel_' || md5(s."id"),
  s."tenantId", s."id", 'CANCELED', 'CANCELED', 'SYSTEM',
  jsonb_build_object(
    'backfill', true,
    'cancelSource',
      CASE WHEN s."cancelAtPeriodEnd" OR s."cancelRequestedAt" IS NOT NULL THEN 'OWNER'
           WHEN s."firstPaidAt" IS NULL THEN 'TRIAL_NOT_CONVERTED'
           ELSE 'AUTO_SUSPENDED' END
  ),
  s."canceledAt"
FROM "subscriptions" s
WHERE s."status" = 'CANCELED'
  AND s."canceledAt" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "billing_events" e WHERE e."subscriptionId" = s."id" AND e."type" = 'CANCELED');

-- Pagamentos confirmados.
INSERT INTO "billing_events" ("id", "tenantId", "subscriptionId", "invoiceId", "type", "toStatus", "actorType", "metadata", "createdAt")
SELECT
  'bf_pay_' || md5(i."id"),
  s."tenantId", i."subscriptionId", i."id", 'PAYMENT_CONFIRMED', 'ACTIVE', 'SYSTEM',
  jsonb_build_object('backfill', true, 'amountCents', i."amountCents", 'paidAt', to_char(i."paidAt", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  i."paidAt"
FROM "invoices" i
JOIN "subscriptions" s ON s."id" = i."subscriptionId"
WHERE i."status" = 'PAID'
  AND i."paidAt" IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "billing_events" e WHERE e."invoiceId" = i."id" AND e."type" = 'PAYMENT_CONFIRMED');
