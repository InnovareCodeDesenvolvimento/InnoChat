-- Rollback manual da migration 20261014160000_rescue_leads_phase1.
-- O Prisma não roda DOWN sozinho.

-- 1) Remove tabela rescue_leads e dependências
DROP TABLE IF EXISTS "rescue_leads";

-- 2) Remove enum RescueLeadStatus
DROP TYPE IF EXISTS "RescueLeadStatus";

-- 3) Restaura índices e constraints de platform_whatsapp_connections
DROP INDEX IF EXISTS "platform_whatsapp_connections_purpose_role_idx";
DROP INDEX IF EXISTS "platform_whatsapp_connections_one_active";
DROP INDEX IF EXISTS "platform_whatsapp_connections_one_pending";

-- Recria os índices parciais únicos antigos (sem purpose)
CREATE UNIQUE INDEX "platform_whatsapp_connections_one_active"
    ON "platform_whatsapp_connections" ((true)) WHERE "role" = 'ACTIVE';

CREATE UNIQUE INDEX "platform_whatsapp_connections_one_pending"
    ON "platform_whatsapp_connections" ((true)) WHERE "role" = 'PENDING';

ALTER TABLE "platform_whatsapp_connections" DROP CONSTRAINT IF EXISTS "platform_whatsapp_connections_purpose_check";
ALTER TABLE "platform_whatsapp_connections" DROP COLUMN IF EXISTS "purpose";

-- 4) Remove flags de resgate de platform_settings
ALTER TABLE "platform_settings" DROP CONSTRAINT IF EXISTS "platform_settings_rescue_quiet_hours_check";
ALTER TABLE "platform_settings"
    DROP COLUMN IF EXISTS "rescueWhatsappEnabled",
    DROP COLUMN IF EXISTS "rescueQuietHoursStart",
    DROP COLUMN IF EXISTS "rescueQuietHoursEnd";

-- 5) Remove lastSeenAt de users
DROP INDEX IF EXISTS "users_lastSeenAt_idx";
ALTER TABLE "users" DROP COLUMN IF EXISTS "lastSeenAt";
