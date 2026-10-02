-- Onda 0, item 3: 2FA por TOTP. Colunas novas (nulas ou com default) em users + tabela de codigos de
-- recuperacao (so o hash). Aditiva; a versao atual ignora as colunas.

ALTER TABLE "users" ADD COLUMN     "totpEnabledAt" TIMESTAMP(3),
ADD COLUMN     "totpLastUsedStep" INTEGER,
ADD COLUMN     "totpSecretEnc" TEXT,
ADD COLUMN     "twoFactorRequired" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "two_factor_recovery_codes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "two_factor_recovery_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "two_factor_recovery_codes_userId_codeHash_key" ON "two_factor_recovery_codes"("userId", "codeHash");

ALTER TABLE "two_factor_recovery_codes" ADD CONSTRAINT "two_factor_recovery_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2FA ligada exige segredo guardado.
ALTER TABLE "users" ADD CONSTRAINT "users_totp_enabled_needs_secret_check" CHECK ("totpEnabledAt" IS NULL OR "totpSecretEnc" IS NOT NULL);
