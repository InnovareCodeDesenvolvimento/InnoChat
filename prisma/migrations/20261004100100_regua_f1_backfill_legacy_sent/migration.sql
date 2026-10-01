-- Migration de DADOS (sem mudar o schema), aditiva e idempotente: LEGACY_SENT.
--
-- No dia em que o motor novo (F2) entrar, ele nao pode reenviar o que o motor antigo ja mandou. Esta
-- migration grava, em `billing_notices`, uma linha SKIPPED/LEGACY_SENT por aviso de e-mail ja enviado,
-- na mesma chave (cycleKey, step, channel) que o planejador vai usar; o unique impede o duplicado.
-- Re-executar nao muda nada (ON CONFLICT DO NOTHING; ids deterministicos).
--
-- Chaves de ciclo (ver o comentario do model BillingNotice no schema.prisma):
--   fatura: id da fatura | teste: '<subscriptionId>:trial'
--   suspensao/cancelamento: '<subscriptionId>:<currentPeriodEnd em ISO UTC>' (to_char abaixo = toISOString do JS)
--
-- Origem das marcas antigas:
--   invoices.dueReminderEmailSentAt  -> DUE_D1   (fatura de teste: TRIAL_T1)
--   invoices.dueTodayEmailSentAt     -> DUE_D0   (fatura de teste: TRIAL_T0)
--   subscriptions.suspendedEmailSentAt (so SUSPENDED) -> SUSPENDED
--   provider_events 'billing-email' invoice_generated:<invoiceId> (processedAt preenchido) -> INVOICE_CREATED
--   provider_events 'billing-email' auto_cancel:<subscriptionId>:<canceledAtMs> (processedAt preenchido,
--     assinatura ainda CANCELED com o mesmo canceledAt) -> AUTO_CANCELED
-- Alem disso, TODA fatura existente ganha INVOICE_CREATED/LEGACY_SENT: o e-mail de "fatura gerada" so
-- ganhou marca na v1.3.2; faturas mais antigas ja foram avisadas na criacao e o motor novo as reenviaria
-- ("Sua fatura chegou" duplicado) no dia do deploy. Excecao: fatura com envio de "fatura gerada" ainda
-- PENDENTE no outbox antigo (processedAt nulo) nao e marcada, para o motor novo entregar.
-- Custo assumido (mesmo da migration 20261003110000): quem nunca recebeu o aviso por falha antiga de SMTP
-- nao o recebe agora. `createdAt` da linha = instante da marca antiga (ordem correta na linha do tempo).
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
