-- Onda 2 do Restore pelo Admin: Lock de concorrência do restore (modelo RestoreLock).
-- Singleton (id = 1) com CHECK constraint para garantir que só exista 1 registro.
-- Inicializa a linha default com status IDLE no INSERT ON CONFLICT DO NOTHING.

-- CreateEnum
CREATE TYPE "RestoreLockStatus" AS ENUM ('IDLE', 'RESTORING');

-- CreateTable
CREATE TABLE "restore_locks" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "status" "RestoreLockStatus" NOT NULL DEFAULT 'IDLE',
    "lockedBy" TEXT,
    "lockedAt" TIMESTAMP(3),
    "safetyDumpPath" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restore_locks_pkey" PRIMARY KEY ("id")
);

-- Singleton check: id precisa ser 1
ALTER TABLE "restore_locks" ADD CONSTRAINT "restore_locks_singleton_check" CHECK ("id" = 1);

-- Garante que o registro singleton exista desde o deploy da migration
INSERT INTO "restore_locks" ("id", "status", "updatedAt") VALUES (1, 'IDLE', NOW()) ON CONFLICT ("id") DO NOTHING;
