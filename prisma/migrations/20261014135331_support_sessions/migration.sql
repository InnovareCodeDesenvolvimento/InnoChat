-- Suporte: motor de impersonacao do admin (Onda 1).
-- Cria a tabela support_sessions com seus enums, indices e FKs,
-- e adiciona a coluna supportSessionId na tabela audit_logs (com ON DELETE SET NULL).

-- CreateEnum
CREATE TYPE "SupportSessionCloseReason" AS ENUM ('EXITED', 'EXPIRED', 'REVOKED');

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "supportSessionId" TEXT;

-- CreateTable
CREATE TABLE "support_sessions" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closeReason" "SupportSessionCloseReason",

    CONSTRAINT "support_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "support_sessions_tenantId_closedAt_idx" ON "support_sessions"("tenantId", "closedAt");

-- CreateIndex
CREATE INDEX "support_sessions_adminUserId_closedAt_idx" ON "support_sessions"("adminUserId", "closedAt");

-- CreateIndex
CREATE INDEX "audit_logs_supportSessionId_idx" ON "audit_logs"("supportSessionId");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_supportSessionId_fkey" FOREIGN KEY ("supportSessionId") REFERENCES "support_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_adminUserId_fkey" FOREIGN KEY ("adminUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Constraints adicionais de integridade por desenho (Cronos)
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_reason_len_check" CHECK (char_length(trim("reason")) BETWEEN 1 AND 500);
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_dates_check" CHECK ("expiresAt" > "startedAt" AND ("closedAt" IS NULL OR "closedAt" >= "startedAt"));
ALTER TABLE "support_sessions" ADD CONSTRAINT "support_sessions_close_reason_check" CHECK (("closedAt" IS NULL AND "closeReason" IS NULL) OR ("closedAt" IS NOT NULL AND "closeReason" IS NOT NULL));

-- Atualiza a funcao do trigger audit_logs_no_update para permitir ON DELETE SET NULL da FK de suporte
CREATE OR REPLACE FUNCTION "audit_logs_block_update"() RETURNS trigger AS $$
BEGIN
  IF OLD."supportSessionId" IS NOT NULL AND NEW."supportSessionId" IS NULL AND
     OLD."id" = NEW."id" AND
     OLD."tenantId" IS NOT DISTINCT FROM NEW."tenantId" AND
     OLD."actorUserId" IS NOT DISTINCT FROM NEW."actorUserId" AND
     OLD."actorRole" = NEW."actorRole" AND
     OLD."action" = NEW."action" AND
     OLD."targetType" IS NOT DISTINCT FROM NEW."targetType" AND
     OLD."targetId" IS NOT DISTINCT FROM NEW."targetId" AND
     OLD."summary" = NEW."summary" AND
     OLD."changes" IS NOT DISTINCT FROM NEW."changes" AND
     OLD."ipTruncated" IS NOT DISTINCT FROM NEW."ipTruncated" AND
     OLD."createdAt" = NEW."createdAt" THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_logs e append-only: UPDATE nao permitido';
END;
$$ LANGUAGE plpgsql;
