-- Rollback manual (o Prisma não roda DOWN).
ALTER TABLE "chat_messages" DROP CONSTRAINT IF EXISTS "chat_messages_authorUserId_fkey";
ALTER TABLE "chat_messages" DROP COLUMN IF EXISTS "authorUserId";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "notifyClientOnStaffChanges";
-- Apaga textos editados das chaves novas (o Postgres não remove valor de enum; ficam inofensivos).
DELETE FROM "bot_texts" WHERE "key"::text IN ('STAFF_BOOKED','STAFF_RESCHEDULED','STAFF_CANCELED','HANDOFF_CLOSED');
-- NÃO revertido: os 4 valores novos de "BotTextKey".
