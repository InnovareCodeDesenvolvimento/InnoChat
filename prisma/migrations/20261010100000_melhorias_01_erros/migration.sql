-- Onda 0, item 1: monitor de erros proprio (error_groups / error_events). So tabelas novas (aditiva).
-- Retencao: a manutencao apaga error_events com mais de 30 dias (indice em occurredAt).

CREATE TABLE "error_groups" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "route" TEXT,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "count" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "firstVersion" TEXT,
    "lastVersion" TEXT,
    "alertedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,

    CONSTRAINT "error_groups_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "error_events" (
    "id" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" TEXT,
    "route" TEXT,
    "stack" TEXT,
    "userId" TEXT,
    "tenantId" TEXT,
    "context" JSONB,

    CONSTRAINT "error_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "error_groups_fingerprint_key" ON "error_groups"("fingerprint");
CREATE INDEX "error_groups_lastSeenAt_idx" ON "error_groups"("lastSeenAt");
CREATE INDEX "error_groups_status_lastSeenAt_idx" ON "error_groups"("status", "lastSeenAt");
CREATE INDEX "error_events_groupId_occurredAt_idx" ON "error_events"("groupId", "occurredAt");
CREATE INDEX "error_events_occurredAt_idx" ON "error_events"("occurredAt");

ALTER TABLE "error_events" ADD CONSTRAINT "error_events_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "error_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Conjuntos fechados e limites de tamanho (o monitor nao pode virar um deposito de texto).
ALTER TABLE "error_groups" ADD CONSTRAINT "error_groups_status_check" CHECK ("status" IN ('OPEN', 'RESOLVED', 'IGNORED'));
ALTER TABLE "error_groups" ADD CONSTRAINT "error_groups_source_check" CHECK ("source" IN ('SERVER', 'CLIENT'));
ALTER TABLE "error_groups" ADD CONSTRAINT "error_groups_message_len_check" CHECK (char_length("message") <= 300);
ALTER TABLE "error_groups" ADD CONSTRAINT "error_groups_type_len_check" CHECK (char_length("type") <= 120);
ALTER TABLE "error_groups" ADD CONSTRAINT "error_groups_count_check" CHECK ("count" >= 1);
ALTER TABLE "error_events" ADD CONSTRAINT "error_events_stack_len_check" CHECK ("stack" IS NULL OR octet_length("stack") <= 8000);
ALTER TABLE "error_events" ADD CONSTRAINT "error_events_context_size_check" CHECK ("context" IS NULL OR octet_length("context"::text) <= 4096);
