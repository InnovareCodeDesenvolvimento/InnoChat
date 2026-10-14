-- Rollback manual para 20261014180000_catalog_advanced_addons_bundles_pricing

DROP TABLE IF EXISTS "pricing_rules";
DROP TABLE IF EXISTS "service_bundle_items";
DROP TABLE IF EXISTS "service_bundles";
DROP TABLE IF EXISTS "service_addons";
DROP TYPE IF EXISTS "PricingRuleKind";
