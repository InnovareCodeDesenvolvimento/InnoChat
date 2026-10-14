-- Onda 3: Modelagem de catálogo avançado
-- Cria enum PricingRuleKind
-- Cria tabelas service_addons, service_bundles, service_bundle_items, pricing_rules
-- Cria índices, foreign keys e constraints necessárias

-- 1) CreateEnum
CREATE TYPE "PricingRuleKind" AS ENUM ('WEEKDAY_OVERRIDE', 'HOUR_OVERRIDE', 'DURATION_OVERRIDE', 'TIER');

-- 2) CreateTable service_addons
CREATE TABLE "service_addons" (
    "id" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "priceCents" INTEGER NOT NULL DEFAULT 0,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "order" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_addons_pkey" PRIMARY KEY ("id")
);

-- CHECK constraint para valores sãos de preço e ordem
ALTER TABLE "service_addons" ADD CONSTRAINT "service_addons_price_cents_non_negative"
    CHECK ("priceCents" >= 0);
ALTER TABLE "service_addons" ADD CONSTRAINT "service_addons_order_non_negative"
    CHECK ("order" >= 0);

-- 3) CreateTable service_bundles
CREATE TABLE "service_bundles" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_bundles_pkey" PRIMARY KEY ("id")
);

-- CHECK constraint para preço de bundle
ALTER TABLE "service_bundles" ADD CONSTRAINT "service_bundles_price_cents_non_negative"
    CHECK ("priceCents" >= 0);

-- 4) CreateTable service_bundle_items
CREATE TABLE "service_bundle_items" (
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "quantity" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "service_bundle_items_pkey" PRIMARY KEY ("id")
);

-- CHECK constraints para ordem e quantidade positiva
ALTER TABLE "service_bundle_items" ADD CONSTRAINT "service_bundle_items_quantity_positive"
    CHECK ("quantity" >= 1);
ALTER TABLE "service_bundle_items" ADD CONSTRAINT "service_bundle_items_order_non_negative"
    CHECK ("order" >= 0);

-- 5) CreateTable pricing_rules
CREATE TABLE "pricing_rules" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "serviceId" TEXT,
    "kind" "PricingRuleKind" NOT NULL,
    "config" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pricing_rules_pkey" PRIMARY KEY ("id")
);

-- 6) CreateIndex
CREATE INDEX "service_addons_serviceId_order_idx" ON "service_addons"("serviceId", "order");

CREATE INDEX "service_bundles_tenantId_idx" ON "service_bundles"("tenantId");

CREATE INDEX "service_bundle_items_serviceId_idx" ON "service_bundle_items"("serviceId");

CREATE UNIQUE INDEX "service_bundle_items_bundleId_serviceId_key" ON "service_bundle_items"("bundleId", "serviceId");

CREATE INDEX "pricing_rules_tenantId_isActive_idx" ON "pricing_rules"("tenantId", "isActive");

CREATE INDEX "pricing_rules_serviceId_idx" ON "pricing_rules"("serviceId");

-- 7) AddForeignKey
ALTER TABLE "service_addons" ADD CONSTRAINT "service_addons_serviceId_fkey"
    FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "service_bundles" ADD CONSTRAINT "service_bundles_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "service_bundle_items" ADD CONSTRAINT "service_bundle_items_bundleId_fkey"
    FOREIGN KEY ("bundleId") REFERENCES "service_bundles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "service_bundle_items" ADD CONSTRAINT "service_bundle_items_serviceId_fkey"
    FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_serviceId_fkey"
    FOREIGN KEY ("serviceId") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;
