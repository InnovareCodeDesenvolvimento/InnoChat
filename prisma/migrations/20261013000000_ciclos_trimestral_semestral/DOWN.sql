-- Rollback manual da migration 20261013000000_ciclos_trimestral_semestral.
-- ATENCAO: assinaturas/faturas QUARTERLY/SEMIANNUAL precisam virar outro ciclo ANTES (o CHECK antigo as
-- recusaria), e cupons com varios ciclos perdem a lista (volta ao ANY/unico da coluna antiga, que NAO e
-- recalculada aqui: rode o UPDATE abaixo antes de dropar). Remova a linha desta migration de "_prisma_migrations".
UPDATE "coupons" SET "appliesToCycle" = CASE
  WHEN cardinality("appliesToCycles") = 1 AND "appliesToCycles"[1] IN ('MONTHLY', 'ANNUAL') THEN "appliesToCycles"[1]
  ELSE 'ANY'
END;
ALTER TABLE "coupons" DROP CONSTRAINT IF EXISTS "coupons_applies_to_cycles_check";
ALTER TABLE "coupons" DROP COLUMN IF EXISTS "appliesToCycles";
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_cycle_check";
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_cycle_check" CHECK ("cycle" IN ('MONTHLY', 'ANNUAL'));
ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "subscriptions_billing_cycle_check";
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_billing_cycle_check" CHECK ("billingCycle" IN ('MONTHLY', 'ANNUAL'));
ALTER TABLE "plans" DROP CONSTRAINT IF EXISTS "plans_semiannual_price_check";
ALTER TABLE "plans" DROP CONSTRAINT IF EXISTS "plans_quarterly_price_check";
ALTER TABLE "plans" DROP COLUMN IF EXISTS "semiannualPriceCents";
ALTER TABLE "plans" DROP COLUMN IF EXISTS "quarterlyPriceCents";
