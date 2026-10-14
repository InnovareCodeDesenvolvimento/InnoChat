-- Rollback da migration 20261014135331_support_sessions

-- Restaura a funcao original de bloqueio total de UPDATE em audit_logs
CREATE OR REPLACE FUNCTION "audit_logs_block_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs e append-only: UPDATE nao permitido';
END;
$$ LANGUAGE plpgsql;

-- Remove FK e coluna em audit_logs
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_supportSessionId_fkey";
DROP INDEX IF EXISTS "audit_logs_supportSessionId_idx";
ALTER TABLE "audit_logs" DROP COLUMN IF EXISTS "supportSessionId";

-- Remove tabela support_sessions e enums
DROP TABLE IF EXISTS "support_sessions";
DROP TYPE IF EXISTS "SupportSessionCloseReason";
