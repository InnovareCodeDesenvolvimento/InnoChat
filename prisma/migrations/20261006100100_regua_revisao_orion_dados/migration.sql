-- Migration de DADOS (sem mudar o schema), idempotente: LEGACY_SENT de SUSPENDED de quem nao esta mais suspenso.
--
-- O backfill da F1/F2 gravou SKIPPED/LEGACY_SENT em (cycleKey, 'SUSPENDED', 'EMAIL') para quem estava SUSPENDED
-- com o e-mail antigo ja enviado. Com a carencia nova de 3 dias, parte dessas contas voltou a PAST_DUE no deploy.
-- Como a chave de ciclo e a mesma (`<subscriptionId>:<currentPeriodEnd>`), a suspensao REAL que ainda vai acontecer
-- neste ciclo nunca receberia o e-mail. Apaga so as linhas LEGACY_SENT/SUSPENDED cujo ciclo e o ATUAL de uma
-- assinatura que hoje NAO esta suspensa (PAST_DUE ou ACTIVE). Quem continua SUSPENDED (ja avisado de verdade)
-- fica com a marca. Re-executar nao apaga nada alem do que ja foi apagado.
DELETE FROM "billing_notices" n
 USING "subscriptions" s
 WHERE n."subscriptionId" = s."id"
   AND n."step" = 'SUSPENDED'
   AND n."skippedReason" = 'LEGACY_SENT'
   AND s."status" IN ('PAST_DUE', 'ACTIVE')
   AND n."cycleKey" = s."id" || ':' || to_char(s."currentPeriodEnd", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
