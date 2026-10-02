-- Rollback manual da migration 20261010100600_melhorias_07_lista_espera (apaga a lista de espera).
-- Remova a linha desta migration de "_prisma_migrations" depois.
DROP TABLE IF EXISTS "waitlist_entries";
