-- AlterTable
ALTER TABLE "platform_settings" ADD COLUMN     "platformWhatsappEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "billingEmail" TEXT,
ADD COLUMN     "billingWhatsappE164" TEXT,
ADD COLUMN     "billingWhatsappOptOutAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "billing_notices" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "step" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "cycleKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "skippedReason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "notBefore" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "lastErrorCode" TEXT,
    "sentAt" TIMESTAMP(3),
    "recipientMasked" TEXT,
    "providerMessageId" TEXT,
    "platformConnectionId" TEXT,
    "senderPhoneE164" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_notices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_events" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "type" TEXT NOT NULL,
    "fromStatus" "SubscriptionStatus",
    "toStatus" "SubscriptionStatus",
    "actorType" TEXT NOT NULL DEFAULT 'SYSTEM',
    "actorUserId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_whatsapp_connections" (
    "id" TEXT NOT NULL,
    "instanceName" TEXT NOT NULL,
    "webhookTokenHash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QRCODE',
    "role" TEXT NOT NULL DEFAULT 'PENDING',
    "phoneE164" TEXT,
    "connectedAt" TIMESTAMP(3),
    "disconnectedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "retiredReason" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_whatsapp_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "billing_notices_status_nextAttemptAt_idx" ON "billing_notices"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "billing_notices_tenantId_createdAt_idx" ON "billing_notices"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "billing_notices_cycleKey_step_channel_key" ON "billing_notices"("cycleKey", "step", "channel");

-- CreateIndex
CREATE INDEX "billing_events_tenantId_createdAt_idx" ON "billing_events"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "billing_events_type_createdAt_idx" ON "billing_events"("type", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "platform_whatsapp_connections_instanceName_key" ON "platform_whatsapp_connections"("instanceName");

-- CreateIndex
CREATE UNIQUE INDEX "platform_whatsapp_connections_webhookTokenHash_key" ON "platform_whatsapp_connections"("webhookTokenHash");

-- CreateIndex
CREATE INDEX "platform_whatsapp_connections_role_idx" ON "platform_whatsapp_connections"("role");

-- CreateIndex
CREATE INDEX "platform_whatsapp_connections_phoneE164_idx" ON "platform_whatsapp_connections"("phoneE164");

-- AddForeignKey
ALTER TABLE "billing_notices" ADD CONSTRAINT "billing_notices_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_notices" ADD CONSTRAINT "billing_notices_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_notices" ADD CONSTRAINT "billing_notices_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_notices" ADD CONSTRAINT "billing_notices_platformConnectionId_fkey" FOREIGN KEY ("platformConnectionId") REFERENCES "platform_whatsapp_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Escrito a mao (o Prisma nao expressa CHECK, indice parcial nem trigger).
-- Tudo aditivo: tabelas novas (vazias) e CHECKs em colunas novas (todas nulas).
-- ---------------------------------------------------------------------------

-- Tenant: WhatsApp de cobranca = so digitos com DDI (BR: 12 ou 13).
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_billingWhatsappE164_format_check"
  CHECK ("billingWhatsappE164" IS NULL OR "billingWhatsappE164" ~ '^[0-9]{12,13}$');

-- BillingNotice: conjuntos fechados (channel/status) e coerencia do motivo de descarte.
-- `step` fica sem CHECK de proposito: a regua ganha etapas.
ALTER TABLE "billing_notices" ADD CONSTRAINT "billing_notices_channel_check"
  CHECK ("channel" IN ('EMAIL', 'WHATSAPP'));
ALTER TABLE "billing_notices" ADD CONSTRAINT "billing_notices_status_check"
  CHECK ("status" IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED'));
ALTER TABLE "billing_notices" ADD CONSTRAINT "billing_notices_skipped_reason_check"
  CHECK (("status" = 'SKIPPED') = ("skippedReason" IS NOT NULL));
ALTER TABLE "billing_notices" ADD CONSTRAINT "billing_notices_attempts_check"
  CHECK ("attempts" >= 0);

-- BillingEvent: quem agiu.
ALTER TABLE "billing_events" ADD CONSTRAINT "billing_events_actor_type_check"
  CHECK ("actorType" IN ('SYSTEM', 'OWNER', 'ADMIN'));

-- BillingEvent e append-only: UPDATE e proibido (DELETE continua valendo, para o
-- ON DELETE CASCADE da empresa e para a politica de retencao).
CREATE FUNCTION "billing_events_block_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'billing_events e append-only: UPDATE nao permitido';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "billing_events_no_update"
  BEFORE UPDATE ON "billing_events"
  FOR EACH ROW EXECUTE FUNCTION "billing_events_block_update"();

-- PlatformWhatsappConnection: conjuntos fechados e coerencia de cada papel.
ALTER TABLE "platform_whatsapp_connections" ADD CONSTRAINT "platform_whatsapp_connections_role_check"
  CHECK ("role" IN ('PENDING', 'ACTIVE', 'RETIRED'));
ALTER TABLE "platform_whatsapp_connections" ADD CONSTRAINT "platform_whatsapp_connections_status_check"
  CHECK ("status" IN ('QRCODE', 'CONNECTED', 'DISCONNECTED'));
-- Quem envia tem numero e data de ativacao; quem saiu tem data de saida.
ALTER TABLE "platform_whatsapp_connections" ADD CONSTRAINT "platform_whatsapp_connections_active_shape_check"
  CHECK ("role" <> 'ACTIVE' OR ("phoneE164" IS NOT NULL AND "activatedAt" IS NOT NULL));
ALTER TABLE "platform_whatsapp_connections" ADD CONSTRAINT "platform_whatsapp_connections_retired_shape_check"
  CHECK ("role" <> 'RETIRED' OR "retiredAt" IS NOT NULL);

-- No maximo 1 conexao ACTIVE e no maximo 1 PENDING (indice unico parcial sobre uma
-- expressao constante: a 2a linha do mesmo papel colide).
CREATE UNIQUE INDEX "platform_whatsapp_connections_one_active"
  ON "platform_whatsapp_connections" ((true)) WHERE "role" = 'ACTIVE';
CREATE UNIQUE INDEX "platform_whatsapp_connections_one_pending"
  ON "platform_whatsapp_connections" ((true)) WHERE "role" = 'PENDING';
