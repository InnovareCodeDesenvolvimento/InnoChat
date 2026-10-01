-- Cancelamento da assinatura pelo painel (OWNER). Migration ADITIVA (segura com a versão antiga
-- no ar): só colunas novas, com default ou nulas.
ALTER TABLE "subscriptions" ADD COLUMN "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "subscriptions" ADD COLUMN "cancelRequestedAt" TIMESTAMP(3);
ALTER TABLE "subscriptions" ADD COLUMN "cancelReason" TEXT;
