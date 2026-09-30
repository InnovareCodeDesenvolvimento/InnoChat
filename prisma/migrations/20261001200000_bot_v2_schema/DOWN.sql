-- Rollback manual da bot_v2_schema (o Prisma não roda DOWN). Rode ANTES o DOWN da bot_v2_port_texts.
DROP TABLE IF EXISTS "handoff_requests";
DROP TYPE IF EXISTS "HandoffReason";
DROP TYPE IF EXISTS "HandoffEndReason";
ALTER TABLE "tenants"
  DROP CONSTRAINT IF EXISTS "tenants_slotGranularityMin_check",
  DROP CONSTRAINT IF EXISTS "tenants_maxFutureAppointmentsPerContact_check",
  DROP CONSTRAINT IF EXISTS "tenants_handoffResumeMinutes_check",
  DROP COLUMN IF EXISTS "maxFutureAppointmentsPerContact",
  DROP COLUMN IF EXISTS "handoffResumeMinutes",
  ALTER COLUMN "slotGranularityMin" SET DEFAULT 15;
ALTER TABLE "platform_settings"
  DROP COLUMN IF EXISTS "n8nBotFlowVersion",
  DROP COLUMN IF EXISTS "n8nBotFlowHash",
  DROP COLUMN IF EXISTS "n8nBotFlowPublishedAt",
  DROP COLUMN IF EXISTS "n8nBotFlowPublishedByUserId",
  DROP COLUMN IF EXISTS "n8nBotFlowPrevious";
-- NÃO revertido: (1) os 46 valores novos de "BotTextKey" (Postgres não remove valor de enum; são
-- inofensivos sem linhas que os usem); (2) o UPDATE de slotGranularityMin para 30 (o valor antigo
-- de cada empresa não foi guardado; a UI da v1 nunca o editou, então era 15 para todas).
