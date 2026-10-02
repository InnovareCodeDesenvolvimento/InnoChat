-- Rollback manual da migration 20261010100000_melhorias_01_erros (apaga os erros registrados).
-- Remova a linha desta migration de "_prisma_migrations" depois.
DROP TABLE IF EXISTS "error_events";
DROP TABLE IF EXISTS "error_groups";
