-- Rollback manual da migration 20261004100100_regua_f1_backfill_legacy_sent.
-- Remove apenas as linhas LEGACY_SENT criadas pelo backfill (ids 'legacy_%'). Nao afeta avisos do motor novo.
-- Efeito: o motor novo (F2), se ja estiver no ar, pode reenviar avisos antigos. Remova a linha desta migration
-- de "_prisma_migrations" depois.
DELETE FROM "billing_notices" WHERE "id" LIKE 'legacy\_%' AND "skippedReason" = 'LEGACY_SENT';
