-- Migration de DADOS (sem mudar o schema), aditiva e idempotente.
--
-- A varredura da regua de cobranca (F0) envia "conta suspensa" a toda assinatura SUSPENDED com
-- "suspendedEmailSentAt" nulo. Isso pegaria suspensoes MANUAIS do admin ja existentes (feitas antes
-- de `suspendCompanyManually` gravar a marca), que podem ter outro motivo que nao atraso.
--
-- O banco NAO distingue suspensao manual de automatica: a manual so grava status, currentPeriodEnd
-- (2 dias atras) e trialEndsAt nulo, sem ProviderEvent, log de admin ou campo proprio; e a
-- automatica de uma conta ACTIVE termina com os mesmos valores. Por isso a trava e por JANELA:
-- toda SUSPENDED sem marca no momento da migration e marcada como "ja avisada".
-- Custo assumido: quem foi suspenso por atraso nos ultimos dias e nunca recebeu o e-mail (so por
-- estar sem destinatario ou SMTP fora) perde este aviso. Suspensoes novas nao sao afetadas.
UPDATE "subscriptions"
SET "suspendedEmailSentAt" = NOW()
WHERE "status" = 'SUSPENDED' AND "suspendedEmailSentAt" IS NULL;
