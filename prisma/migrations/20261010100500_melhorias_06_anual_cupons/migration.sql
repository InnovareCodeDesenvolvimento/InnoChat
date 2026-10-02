-- Onda 0, item 6: plano anual + cupons. Aditiva: colunas nulas ou com default (MONTHLY / 0) e tabelas novas.
-- Toda assinatura e fatura existente vira MONTHLY por default; a versao atual nao le as colunas novas.
-- invoices.amountCents continua sendo o valor LIQUIDO a cobrar; discountCents e o desconto ja abatido.

ALTER TABLE "invoices" ADD COLUMN     "couponCode" TEXT,
ADD COLUMN     "cycle" TEXT NOT NULL DEFAULT 'MONTHLY',
ADD COLUMN     "discountCents" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "plans" ADD COLUMN     "annualPriceCents" INTEGER;

ALTER TABLE "subscriptions" ADD COLUMN     "billingCycle" TEXT NOT NULL DEFAULT 'MONTHLY',
ADD COLUMN     "couponCyclesRemaining" INTEGER,
ADD COLUMN     "couponId" TEXT;

CREATE TABLE "coupons" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL,
    "value" INTEGER NOT NULL,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "maxRedemptions" INTEGER,
    "redemptionsCount" INTEGER NOT NULL DEFAULT 0,
    "duration" TEXT NOT NULL DEFAULT 'ONCE',
    "durationCycles" INTEGER,
    "appliesToCycle" TEXT NOT NULL DEFAULT 'ANY',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "coupon_plans" (
    "couponId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,

    CONSTRAINT "coupon_plans_pkey" PRIMARY KEY ("couponId","planId")
);

CREATE TABLE "coupon_redemptions" (
    "id" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_redemptions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "coupons_code_key" ON "coupons"("code");
CREATE INDEX "coupon_plans_planId_idx" ON "coupon_plans"("planId");
CREATE INDEX "coupon_redemptions_tenantId_idx" ON "coupon_redemptions"("tenantId");
CREATE INDEX "coupon_redemptions_invoiceId_idx" ON "coupon_redemptions"("invoiceId");
CREATE UNIQUE INDEX "coupon_redemptions_couponId_tenantId_key" ON "coupon_redemptions"("couponId", "tenantId");
CREATE INDEX "subscriptions_couponId_idx" ON "subscriptions"("couponId");

ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "coupon_plans" ADD CONSTRAINT "coupon_plans_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "coupon_plans" ADD CONSTRAINT "coupon_plans_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "coupons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Plano / assinatura / fatura.
ALTER TABLE "plans" ADD CONSTRAINT "plans_annual_price_check" CHECK ("annualPriceCents" IS NULL OR "annualPriceCents" > 0);
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_billing_cycle_check" CHECK ("billingCycle" IN ('MONTHLY', 'ANNUAL'));
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_coupon_cycles_check" CHECK ("couponCyclesRemaining" IS NULL OR "couponCyclesRemaining" >= 0);
-- Sem cupom, sem contador de ciclos.
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_coupon_cycles_needs_coupon_check" CHECK ("couponCyclesRemaining" IS NULL OR "couponId" IS NOT NULL);
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_cycle_check" CHECK ("cycle" IN ('MONTHLY', 'ANNUAL'));
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_discount_check" CHECK ("discountCents" >= 0);

-- Cupom: codigo sempre MAIUSCULO (unicidade sem diferenciar caixa e no proprio banco) e conjuntos fechados.
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_code_format_check" CHECK ("code" = upper("code") AND "code" ~ '^[A-Z0-9_-]{3,32}$');
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_kind_check" CHECK ("kind" IN ('PERCENT', 'AMOUNT'));
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_value_check" CHECK (
  ("kind" = 'PERCENT' AND "value" BETWEEN 1 AND 100) OR ("kind" = 'AMOUNT' AND "value" > 0)
);
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_duration_check" CHECK ("duration" IN ('ONCE', 'N_CYCLES', 'FOREVER'));
-- N_CYCLES exige N >= 1; os outros nao carregam N.
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_duration_cycles_check" CHECK (
  ("duration" = 'N_CYCLES' AND "durationCycles" IS NOT NULL AND "durationCycles" >= 1)
  OR ("duration" <> 'N_CYCLES' AND "durationCycles" IS NULL)
);
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_applies_to_cycle_check" CHECK ("appliesToCycle" IN ('ANY', 'MONTHLY', 'ANNUAL'));
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_validity_check" CHECK ("validFrom" IS NULL OR "validUntil" IS NULL OR "validUntil" > "validFrom");
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_max_redemptions_check" CHECK ("maxRedemptions" IS NULL OR "maxRedemptions" >= 1);
-- O teto de usos e garantido pelo banco, nao so pela aplicacao.
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_redemptions_count_check" CHECK (
  "redemptionsCount" >= 0 AND ("maxRedemptions" IS NULL OR "redemptionsCount" <= "maxRedemptions")
);
ALTER TABLE "coupon_redemptions" ADD CONSTRAINT "coupon_redemptions_discount_check" CHECK ("discountCents" >= 0);
