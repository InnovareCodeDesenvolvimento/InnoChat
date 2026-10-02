-- Rollback manual da migration 20261010100200_melhorias_03_2fa (desliga o 2FA de todos os usuarios).
-- Remova a linha desta migration de "_prisma_migrations" depois.
DROP TABLE IF EXISTS "two_factor_recovery_codes";
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_totp_enabled_needs_secret_check";
ALTER TABLE "users" DROP COLUMN IF EXISTS "totpEnabledAt", DROP COLUMN IF EXISTS "totpLastUsedStep",
  DROP COLUMN IF EXISTS "totpSecretEnc", DROP COLUMN IF EXISTS "twoFactorRequired";
