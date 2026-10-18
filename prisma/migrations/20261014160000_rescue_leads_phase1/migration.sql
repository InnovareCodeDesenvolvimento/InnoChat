-- Resgate de Leads — Meta Ads / Abandono de Funil (Fase 1).
-- Cria o enum RescueLeadStatus, a tabela rescue_leads com seus índices e FKs,
-- adiciona lastSeenAt em users,
-- adiciona purpose em platform_whatsapp_connections e substitui índices parciais de role por (purpose, role),
-- adiciona flags de resgate em platform_settings.

-- 1) CreateEnum
CREATE TYPE "RescueLeadStatus" AS ENUM (
    'PENDING',
    'MESSAGE_1_SENDING',
    'MESSAGE_1_SENT',
    'MESSAGE_2_SENDING',
    'MESSAGE_2_SENT',
    'RESPONDED',
    'CONVERTED',
    'OPTED_OUT',
    'EXPIRED',
    'SKIPPED'
);

-- 2) AlterTable users: lastSeenAt
ALTER TABLE "users" ADD COLUMN "lastSeenAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "users_lastSeenAt_idx" ON "users"("lastSeenAt");

-- 3) AlterTable platform_settings: flags de resgate
ALTER TABLE "platform_settings"
    ADD COLUMN "rescueWhatsappEnabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "rescueQuietHoursStart" INTEGER NOT NULL DEFAULT 20,
    ADD COLUMN "rescueQuietHoursEnd" INTEGER NOT NULL DEFAULT 8;

-- CHECK constraints para quiet hours (0..23)
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_rescue_quiet_hours_check"
    CHECK (
        "rescueQuietHoursStart" >= 0 AND "rescueQuietHoursStart" <= 23 AND
        "rescueQuietHoursEnd" >= 0 AND "rescueQuietHoursEnd" <= 23
    );

-- 4) AlterTable platform_whatsapp_connections: purpose
ALTER TABLE "platform_whatsapp_connections"
    ADD COLUMN "purpose" TEXT NOT NULL DEFAULT 'BILLING';

-- CHECK constraint para propósito fechado
ALTER TABLE "platform_whatsapp_connections" ADD CONSTRAINT "platform_whatsapp_connections_purpose_check"
    CHECK ("purpose" IN ('BILLING', 'RESCUE'));

-- Refaz índices parciais únicos considerando o purpose.
-- Antigos: no máximo 1 ACTIVE e 1 PENDING globais.
-- Novos: no máximo 1 ACTIVE por purpose e no máximo 1 PENDING por purpose.
DROP INDEX IF EXISTS "platform_whatsapp_connections_one_active";
DROP INDEX IF EXISTS "platform_whatsapp_connections_one_pending";

CREATE UNIQUE INDEX "platform_whatsapp_connections_one_active"
    ON "platform_whatsapp_connections" ("purpose") WHERE "role" = 'ACTIVE';

CREATE UNIQUE INDEX "platform_whatsapp_connections_one_pending"
    ON "platform_whatsapp_connections" ("purpose") WHERE "role" = 'PENDING';

CREATE INDEX "platform_whatsapp_connections_purpose_role_idx"
    ON "platform_whatsapp_connections"("purpose", "role");

-- 5) CreateTable rescue_leads
CREATE TABLE "rescue_leads" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "status" "RescueLeadStatus" NOT NULL DEFAULT 'PENDING',
    "step1ScheduledAt" TIMESTAMP(3) NOT NULL,
    "step1SentAt" TIMESTAMP(3),
    "step2ScheduledAt" TIMESTAMP(3),
    "step2SentAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "optedOutAt" TIMESTAMP(3),
    "convertedAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "platformConnectionId" TEXT,
    "senderPhoneE164" TEXT,
    "providerMessageId1" TEXT,
    "providerMessageId2" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rescue_leads_pkey" PRIMARY KEY ("id")
);

-- Índices e Unicidade
CREATE UNIQUE INDEX "rescue_leads_userId_key" ON "rescue_leads"("userId");
CREATE INDEX "rescue_leads_status_nextRunAt_idx" ON "rescue_leads"("status", "nextRunAt");
CREATE INDEX "rescue_leads_phoneE164_idx" ON "rescue_leads"("phoneE164");
CREATE INDEX "rescue_leads_tenantId_idx" ON "rescue_leads"("tenantId");

-- Constraints de integridade por desenho (Cronos)
ALTER TABLE "rescue_leads" ADD CONSTRAINT "rescue_leads_phoneE164_format_check"
    CHECK ("phoneE164" ~ '^[0-9]{12,13}$');
ALTER TABLE "rescue_leads" ADD CONSTRAINT "rescue_leads_attempts_check"
    CHECK ("attempts" >= 0);

-- Foreign Keys
ALTER TABLE "rescue_leads" ADD CONSTRAINT "rescue_leads_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rescue_leads" ADD CONSTRAINT "rescue_leads_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "rescue_leads" ADD CONSTRAINT "rescue_leads_platformConnectionId_fkey"
    FOREIGN KEY ("platformConnectionId") REFERENCES "platform_whatsapp_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
