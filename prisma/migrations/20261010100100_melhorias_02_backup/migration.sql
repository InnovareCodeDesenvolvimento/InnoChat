-- Onda 0, item 2: backup automatico (espelha o Parque das Feiras). So tabelas novas (aditiva).
-- backup_config e singleton (id = 1): a linha nasce aqui, DESLIGADA e sem destino; assim o primeiro GET
-- do painel nao depende de uma escrita. Segredos (*Enc) sao cifrados pela aplicacao (src/lib/crypto.ts).

CREATE TABLE "backup_config" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "hourLocal" INTEGER NOT NULL DEFAULT 3,
    "retentionDays" INTEGER NOT NULL DEFAULT 14,
    "alertAfterHours" INTEGER NOT NULL DEFAULT 36,
    "destination" TEXT,
    "driveMode" TEXT NOT NULL DEFAULT 'SERVICE_ACCOUNT',
    "s3Endpoint" TEXT,
    "s3Bucket" TEXT,
    "s3Region" TEXT,
    "s3Prefix" TEXT,
    "s3AccessKey" TEXT,
    "s3SecretKeyEnc" TEXT,
    "driveFolderId" TEXT,
    "driveClientEmail" TEXT,
    "driveServiceAccountEnc" TEXT,
    "driveOauthClientId" TEXT,
    "driveOauthClientSecretEnc" TEXT,
    "driveOauthRefreshTokenEnc" TEXT,
    "driveOauthEmail" TEXT,
    "driveOauthFolderId" TEXT,
    "driveOauthConnectedAt" TIMESTAMP(3),
    "driveOauthConnectedById" TEXT,
    "runningSince" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "lastLateAlertAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "backup_config_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "backup_runs" (
    "id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "trigger" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "destination" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "sizeBytes" BIGINT,
    "tablesWithData" INTEGER,
    "objectKey" TEXT,
    "errorCode" TEXT,
    "errorDetail" TEXT,
    "createdById" TEXT,

    CONSTRAINT "backup_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "backup_drive_oauth_nonces" (
    "id" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backup_drive_oauth_nonces_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "backup_runs_startedAt_idx" ON "backup_runs"("startedAt");
CREATE UNIQUE INDEX "backup_drive_oauth_nonces_nonce_key" ON "backup_drive_oauth_nonces"("nonce");
CREATE INDEX "backup_drive_oauth_nonces_expiresAt_idx" ON "backup_drive_oauth_nonces"("expiresAt");

ALTER TABLE "backup_config" ADD CONSTRAINT "backup_config_singleton_check" CHECK ("id" = 1);
ALTER TABLE "backup_config" ADD CONSTRAINT "backup_config_hour_check" CHECK ("hourLocal" BETWEEN 0 AND 23);
ALTER TABLE "backup_config" ADD CONSTRAINT "backup_config_retention_check" CHECK ("retentionDays" BETWEEN 1 AND 3650);
ALTER TABLE "backup_config" ADD CONSTRAINT "backup_config_alert_after_check" CHECK ("alertAfterHours" BETWEEN 1 AND 720);
ALTER TABLE "backup_config" ADD CONSTRAINT "backup_config_destination_check" CHECK ("destination" IS NULL OR "destination" IN ('S3', 'DRIVE'));
ALTER TABLE "backup_config" ADD CONSTRAINT "backup_config_drive_mode_check" CHECK ("driveMode" IN ('SERVICE_ACCOUNT', 'OAUTH'));
-- Automatico ligado exige destino escolhido (o painel ja barra; aqui e a rede de seguranca).
ALTER TABLE "backup_config" ADD CONSTRAINT "backup_config_enabled_needs_destination_check" CHECK ("enabled" = false OR "destination" IS NOT NULL);
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_status_check" CHECK ("status" IN ('RUNNING', 'SUCCESS', 'FAILED'));
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_trigger_check" CHECK ("trigger" IN ('SCHEDULED', 'MANUAL'));
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_destination_check" CHECK ("destination" IS NULL OR "destination" IN ('S3', 'DRIVE'));
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_size_check" CHECK ("sizeBytes" IS NULL OR "sizeBytes" >= 0);

INSERT INTO "backup_config" ("id", "updatedAt") VALUES (1, NOW()) ON CONFLICT ("id") DO NOTHING;
