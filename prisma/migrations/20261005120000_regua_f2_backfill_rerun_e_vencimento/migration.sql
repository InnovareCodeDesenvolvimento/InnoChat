-- F2 da regua de cobranca: migration de DADOS (sem mudar o schema), aditiva e idempotente.
--
-- 1) Repete o backfill LEGACY_SENT da F1 (20261004100100) para fechar a janela entre o deploy da F1 e o do motor
--    novo: avisos que o envio antigo do tick mandou nesse intervalo (marcas *SentAt e outbox transitorio em
--    provider_events) ganham a linha SKIPPED/LEGACY_SENT, e o motor novo nao os reenvia. Mesmos ids
--    deterministicos e ON CONFLICT DO NOTHING: repetir nao muda nada e nunca sobrescreve um aviso que o motor
--    novo ja gravou.
--
-- 2) Corrige o vencimento das faturas JA ABERTAS de ciclos regulares. O tick gravava `dueAt = periodEnd` (o fim
--    do periodo NOVO, um mes depois), mas quem manda no status e o `currentPeriodEnd`, que e o INICIO do periodo da
--    fatura (`periodStart`). Com a regua e o banner baseados no vencimento, a fatura precisa vencer em
--    `periodStart`. Nao toca fatura de teste, de reativacao (vencimento proprio), paga ou anulada.

-- 1) Backfill LEGACY_SENT (copia fiel da F1).
DO $$
BEGIN
  -- Lembrete de vespera (DUE_D1 / TRIAL_T1).
  INSERT INTO "billing_notices"
    ("id", "tenantId", "subscriptionId", "invoiceId", "step", "channel", "cycleKey", "status", "skippedReason",
     "notBefore", "expiresAt", "nextAttemptAt", "createdAt", "updatedAt")
  SELECT
    'legacy_' || md5(k."cycleKey" || '|' || k."step" || '|EMAIL'),
    s."tenantId", i."subscriptionId", CASE WHEN i."isTrialConversion" THEN NULL ELSE i."id" END,
    k."step", 'EMAIL', k."cycleKey", 'SKIPPED', 'LEGACY_SENT',
    i."dueReminderEmailSentAt", i."dueReminderEmailSentAt", i."dueReminderEmailSentAt", i."dueReminderEmailSentAt", NOW()
  FROM "invoices" i
  JOIN "subscriptions" s ON s."id" = i."subscriptionId"
  CROSS JOIN LATERAL (
    SELECT CASE WHEN i."isTrialConversion" THEN 'TRIAL_T1' ELSE 'DUE_D1' END AS "step",
           CASE WHEN i."isTrialConversion" THEN i."subscriptionId" || ':trial' ELSE i."id" END AS "cycleKey"
  ) k
  WHERE i."dueReminderEmailSentAt" IS NOT NULL
  ON CONFLICT ("cycleKey", "step", "channel") DO NOTHING;

  -- "Vence hoje" (DUE_D0 / TRIAL_T0).
  INSERT INTO "billing_notices"
    ("id", "tenantId", "subscriptionId", "invoiceId", "step", "channel", "cycleKey", "status", "skippedReason",
     "notBefore", "expiresAt", "nextAttemptAt", "createdAt", "updatedAt")
  SELECT
    'legacy_' || md5(k."cycleKey" || '|' || k."step" || '|EMAIL'),
    s."tenantId", i."subscriptionId", CASE WHEN i."isTrialConversion" THEN NULL ELSE i."id" END,
    k."step", 'EMAIL', k."cycleKey", 'SKIPPED', 'LEGACY_SENT',
    i."dueTodayEmailSentAt", i."dueTodayEmailSentAt", i."dueTodayEmailSentAt", i."dueTodayEmailSentAt", NOW()
  FROM "invoices" i
  JOIN "subscriptions" s ON s."id" = i."subscriptionId"
  CROSS JOIN LATERAL (
    SELECT CASE WHEN i."isTrialConversion" THEN 'TRIAL_T0' ELSE 'DUE_D0' END AS "step",
           CASE WHEN i."isTrialConversion" THEN i."subscriptionId" || ':trial' ELSE i."id" END AS "cycleKey"
  ) k
  WHERE i."dueTodayEmailSentAt" IS NOT NULL
  ON CONFLICT ("cycleKey", "step", "channel") DO NOTHING;

  -- Conta suspensa (SUSPENDED), so de quem continua SUSPENDED.
  INSERT INTO "billing_notices"
    ("id", "tenantId", "subscriptionId", "invoiceId", "step", "channel", "cycleKey", "status", "skippedReason",
     "notBefore", "expiresAt", "nextAttemptAt", "createdAt", "updatedAt")
  SELECT
    'legacy_' || md5(k."cycleKey" || '|SUSPENDED|EMAIL'),
    s."tenantId", s."id", NULL, 'SUSPENDED', 'EMAIL', k."cycleKey", 'SKIPPED', 'LEGACY_SENT',
    s."suspendedEmailSentAt", s."suspendedEmailSentAt", s."suspendedEmailSentAt", s."suspendedEmailSentAt", NOW()
  FROM "subscriptions" s
  CROSS JOIN LATERAL (
    SELECT s."id" || ':' || to_char(s."currentPeriodEnd", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "cycleKey"
  ) k
  WHERE s."status" = 'SUSPENDED' AND s."suspendedEmailSentAt" IS NOT NULL
  ON CONFLICT ("cycleKey", "step", "channel") DO NOTHING;

  -- Fatura gerada: marcas do outbox antigo (instante exato do envio).
  INSERT INTO "billing_notices"
    ("id", "tenantId", "subscriptionId", "invoiceId", "step", "channel", "cycleKey", "status", "skippedReason",
     "notBefore", "expiresAt", "nextAttemptAt", "createdAt", "updatedAt")
  SELECT
    'legacy_' || md5(i."id" || '|INVOICE_CREATED|EMAIL'),
    s."tenantId", i."subscriptionId", i."id", 'INVOICE_CREATED', 'EMAIL', i."id", 'SKIPPED', 'LEGACY_SENT',
    pe."processedAt", pe."processedAt", pe."processedAt", pe."processedAt", NOW()
  FROM "provider_events" pe
  JOIN "invoices" i ON i."id" = substring(pe."providerEventId" from '^invoice_generated:(.+)$')
  JOIN "subscriptions" s ON s."id" = i."subscriptionId"
  WHERE pe."provider" = 'billing-email' AND pe."processedAt" IS NOT NULL
  ON CONFLICT ("cycleKey", "step", "channel") DO NOTHING;

  -- Fatura gerada: toda fatura existente sem envio pendente no outbox antigo.
  INSERT INTO "billing_notices"
    ("id", "tenantId", "subscriptionId", "invoiceId", "step", "channel", "cycleKey", "status", "skippedReason",
     "notBefore", "expiresAt", "nextAttemptAt", "createdAt", "updatedAt")
  SELECT
    'legacy_' || md5(i."id" || '|INVOICE_CREATED|EMAIL'),
    s."tenantId", i."subscriptionId", i."id", 'INVOICE_CREATED', 'EMAIL', i."id", 'SKIPPED', 'LEGACY_SENT',
    i."createdAt", i."createdAt", i."createdAt", i."createdAt", NOW()
  FROM "invoices" i
  JOIN "subscriptions" s ON s."id" = i."subscriptionId"
  WHERE NOT EXISTS (
    SELECT 1 FROM "provider_events" pe
    WHERE pe."provider" = 'billing-email'
      AND pe."providerEventId" = 'invoice_generated:' || i."id"
      AND pe."processedAt" IS NULL
  )
  ON CONFLICT ("cycleKey", "step", "channel") DO NOTHING;

  -- Cancelamento automatico (AUTO_CANCELED).
  INSERT INTO "billing_notices"
    ("id", "tenantId", "subscriptionId", "invoiceId", "step", "channel", "cycleKey", "status", "skippedReason",
     "notBefore", "expiresAt", "nextAttemptAt", "createdAt", "updatedAt")
  SELECT
    'legacy_' || md5(k."cycleKey" || '|AUTO_CANCELED|EMAIL'),
    s."tenantId", s."id", NULL, 'AUTO_CANCELED', 'EMAIL', k."cycleKey", 'SKIPPED', 'LEGACY_SENT',
    pe."processedAt", pe."processedAt", pe."processedAt", pe."processedAt", NOW()
  FROM "provider_events" pe
  JOIN "subscriptions" s ON s."id" = substring(pe."providerEventId" from '^auto_cancel:([^:]+):[0-9]+$')
  CROSS JOIN LATERAL (
    SELECT s."id" || ':' || to_char(s."currentPeriodEnd", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "cycleKey"
  ) k
  WHERE pe."provider" = 'billing-email'
    AND pe."processedAt" IS NOT NULL
    AND s."status" = 'CANCELED'
    AND s."canceledAt" IS NOT NULL
    AND (floor(extract(epoch FROM s."canceledAt") * 1000))::bigint = substring(pe."providerEventId" from '^auto_cancel:[^:]+:([0-9]+)$')::bigint
  ON CONFLICT ("cycleKey", "step", "channel") DO NOTHING;
END
$$;

-- 2) Vencimento das faturas regulares abertas: dueAt = periodStart (so quando ainda estava igual a periodEnd).
UPDATE "invoices"
   SET "dueAt" = "periodStart"
 WHERE "status" = 'OPEN'
   AND "isTrialConversion" = false
   AND "dueAt" = "periodEnd"
   AND "periodStart" < "periodEnd";
