-- Rollback manual da migration 20261010100700_melhorias_08_comissoes (perde as comissoes cadastradas).
-- Remova a linha desta migration de "_prisma_migrations" depois.
ALTER TABLE "professionals" DROP CONSTRAINT IF EXISTS "professionals_commission_pct_check";
ALTER TABLE "professional_services" DROP CONSTRAINT IF EXISTS "professional_services_commission_pct_check";
ALTER TABLE "professionals" DROP COLUMN IF EXISTS "commissionPct";
ALTER TABLE "professional_services" DROP COLUMN IF EXISTS "commissionPct";
