-- Planos com 4 ciclos (mensal, trimestral, semestral, anual) e cupom com lista de ciclos validos.
-- Aditiva: so colunas novas, CHECKs ampliados (dados existentes continuam validos) e backfill.

-- Precos por plano. NULO = ciclo nao oferecido. O mensal segue em "priceCents"; o anual, em "annualPriceCents".
ALTER TABLE "plans" ADD COLUMN "quarterlyPriceCents" INTEGER;
ALTER TABLE "plans" ADD COLUMN "semiannualPriceCents" INTEGER;
ALTER TABLE "plans" ADD CONSTRAINT "plans_quarterly_price_check" CHECK ("quarterlyPriceCents" IS NULL OR "quarterlyPriceCents" > 0);
ALTER TABLE "plans" ADD CONSTRAINT "plans_semiannual_price_check" CHECK ("semiannualPriceCents" IS NULL OR "semiannualPriceCents" > 0);

-- Ciclo da assinatura e da fatura: conjunto fechado ampliado (mesmo nome de constraint).
ALTER TABLE "subscriptions" DROP CONSTRAINT "subscriptions_billing_cycle_check";
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_billing_cycle_check" CHECK ("billingCycle" IN ('MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'));
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_cycle_check";
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_cycle_check" CHECK ("cycle" IN ('MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL'));

-- Cupom: lista de ciclos validos. Vazio = todos. A coluna antiga "appliesToCycle" fica (a versao anterior
-- ainda le); mantem DEFAULT 'ANY' e o CHECK, entao insert novo que nao a informe nao falha.
ALTER TABLE "coupons" ADD COLUMN "appliesToCycles" TEXT[] NOT NULL DEFAULT '{}';
UPDATE "coupons" SET "appliesToCycles" = CASE "appliesToCycle"
  WHEN 'MONTHLY' THEN ARRAY['MONTHLY']
  WHEN 'ANNUAL' THEN ARRAY['ANNUAL']
  ELSE ARRAY[]::TEXT[]
END;
-- Cada elemento no conjunto dos 4 (array vazio passa: <@ de vazio e verdadeiro). Sem NULL dentro: o
-- elemento NULL tornaria o <@ nulo e o CHECK passaria, entao array_position barra explicitamente.
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_applies_to_cycles_check" CHECK (
  "appliesToCycles" <@ ARRAY['MONTHLY', 'QUARTERLY', 'SEMIANNUAL', 'ANNUAL']::TEXT[]
  AND array_position("appliesToCycles", NULL) IS NULL
);
