-- Onda 0, item 4: registro de auditoria APPEND-ONLY. So tabela nova (aditiva).
-- actorUserId e targetId NAO tem FK de proposito: ON DELETE SET NULL seria um UPDATE e o trigger o barraria;
-- e a auditoria deve sobreviver a exclusao do usuario. tenantId: CASCADE (DELETE e permitido).

CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "actorUserId" TEXT,
    "actorRole" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "summary" TEXT NOT NULL,
    "changes" JSONB,
    "ipTruncated" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_logs_tenantId_createdAt_idx" ON "audit_logs"("tenantId", "createdAt");
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_role_check" CHECK ("actorRole" IN ('OWNER', 'STAFF', 'PLATFORM_ADMIN', 'SYSTEM'));
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_summary_len_check" CHECK (char_length("summary") BETWEEN 1 AND 300);
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_action_len_check" CHECK (char_length("action") BETWEEN 1 AND 80);
-- "changes" pequeno: antes/depois de campos, nunca um dump de objeto.
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_changes_size_check" CHECK ("changes" IS NULL OR octet_length("changes"::text) <= 8192);

-- Append-only: UPDATE e proibido (DELETE segue valendo, para o CASCADE da empresa e a politica de retencao).
CREATE FUNCTION "audit_logs_block_update"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs e append-only: UPDATE nao permitido';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_logs_no_update"
  BEFORE UPDATE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "audit_logs_block_update"();
