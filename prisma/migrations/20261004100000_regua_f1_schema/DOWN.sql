-- Rollback manual da migration 20261004100000_regua_f1_schema (o Prisma nao roda DOWN sozinho).
-- ATENCAO: apaga o historico da regua (billing_notices, billing_events) e as conexoes de WhatsApp da
-- plataforma. Antes, desligue PlatformSettings.platformWhatsappEnabled e desconecte a instancia na Evolution.
-- Depois de rodar, apague a linha desta migration de "_prisma_migrations" para o Prisma nao achar que
-- ela continua aplicada.
DROP TRIGGER IF EXISTS "billing_events_no_update" ON "billing_events";
DROP FUNCTION IF EXISTS "billing_events_block_update"();
DROP TABLE IF EXISTS "billing_notices";
DROP TABLE IF EXISTS "billing_events";
DROP TABLE IF EXISTS "platform_whatsapp_connections";
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_billingWhatsappE164_format_check";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "billingEmail",
  DROP COLUMN IF EXISTS "billingWhatsappE164",
  DROP COLUMN IF EXISTS "billingWhatsappOptOutAt";
ALTER TABLE "platform_settings" DROP COLUMN IF EXISTS "platformWhatsappEnabled";
