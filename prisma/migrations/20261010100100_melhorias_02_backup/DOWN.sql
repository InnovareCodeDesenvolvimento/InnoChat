-- Rollback manual da migration 20261010100100_melhorias_02_backup (apaga config e historico de backup).
-- Remova a linha desta migration de "_prisma_migrations" depois.
DROP TABLE IF EXISTS "backup_drive_oauth_nonces";
DROP TABLE IF EXISTS "backup_runs";
DROP TABLE IF EXISTS "backup_config";
