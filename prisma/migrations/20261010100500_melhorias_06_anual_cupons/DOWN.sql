-- Rollback manual da migration 20261010100500_melhorias_06_anual_cupons.
-- ATENCAO: se ja existe assinatura ANUAL ou fatura com desconto, o rollback perde essa informacao
-- (as colunas somem). Remova a linha desta migration de "_prisma_migrations" depois.
DROP TABLE IF EXISTS "coupon_redemptions";
DROP TABLE IF EXISTS "coupon_plans";
ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "subscriptions_couponId_fkey";
DROP INDEX IF EXISTS "subscriptions_couponId_idx";
DROP TABLE IF EXISTS "coupons";
ALTER TABLE "subscriptions" DROP CONSTRAINT IF EXISTS "subscriptions_billing_cycle_check",
  DROP CONSTRAINT IF EXISTS "subscriptions_coupon_cycles_check",
  DROP CONSTRAINT IF EXISTS "subscriptions_coupon_cycles_needs_coupon_check";
ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "billingCycle", DROP COLUMN IF EXISTS "couponCyclesRemaining",
  DROP COLUMN IF EXISTS "couponId";
ALTER TABLE "invoices" DROP CONSTRAINT IF EXISTS "invoices_cycle_check", DROP CONSTRAINT IF EXISTS "invoices_discount_check";
ALTER TABLE "invoices" DROP COLUMN IF EXISTS "couponCode", DROP COLUMN IF EXISTS "cycle", DROP COLUMN IF EXISTS "discountCents";
ALTER TABLE "plans" DROP CONSTRAINT IF EXISTS "plans_annual_price_check";
ALTER TABLE "plans" DROP COLUMN IF EXISTS "annualPriceCents";
