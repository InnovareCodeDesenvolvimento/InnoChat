-- Atendimento humano: a equipe responde e agenda pelo painel. Migration ADITIVA (segura com a
-- versão antiga no ar): só valores de enum, colunas novas com default/nulas e uma FK nula.

-- Textos editáveis dos avisos ao cliente. IF NOT EXISTS = reexecução idempotente.
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'STAFF_BOOKED';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'STAFF_RESCHEDULED';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'STAFF_CANCELED';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'HANDOFF_CLOSED';

-- A empresa pode desligar o aviso ao cliente quando a equipe mexe na agenda (padrão: avisa).
ALTER TABLE "tenants" ADD COLUMN "notifyClientOnStaffChanges" BOOLEAN NOT NULL DEFAULT true;

-- Autor da mensagem enviada pelo painel. Nulo = bot/cliente. SetNull preserva o histórico.
ALTER TABLE "chat_messages" ADD COLUMN "authorUserId" TEXT;
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_authorUserId_fkey"
  FOREIGN KEY ("authorUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
