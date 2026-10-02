-- Rollback manual da migration 20261010100300_melhorias_04_auditoria (apaga a trilha de auditoria).
-- Remova a linha desta migration de "_prisma_migrations" depois.
DROP TABLE IF EXISTS "audit_logs";
DROP FUNCTION IF EXISTS "audit_logs_block_update"();
