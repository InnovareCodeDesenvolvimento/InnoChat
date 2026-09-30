-- Bot v2 (docs/bot-v2-plano.md §3.1). ADITIVA e compatível com o código antigo: só colunas com
-- default, tabela nova e valores novos de enum. O uso dos valores novos fica na migration
-- seguinte (ADD VALUE não pode ser usado na mesma transação).

-- CreateEnum
CREATE TYPE "HandoffReason" AS ENUM ('CLIENT_REQUEST', 'LEGACY_FLOW');
-- CreateEnum
CREATE TYPE "HandoffEndReason" AS ENUM ('CLIENT_MENU', 'TIMEOUT', 'PANEL_RESUME');
-- AlterEnum
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'MENU_PROMPT';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'MENU_HINT';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'FOOTER_HINT';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'CONTINUE_PROMPT';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'HELP';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'NO_SERVICES';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'NEXT_AVAILABLE';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'DATE_OUT_OF_RANGE';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'TIME_NOT_AVAILABLE';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'ITEM_UNAVAILABLE';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'APPOINTMENT_LIMIT';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'NAME_INVALID';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'NAME_TOO_LONG';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'CONFIRM_RESCHEDULE';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'CONFIRM_EDIT';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'POST_ACTION_MENU';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'APPOINTMENT_DETAIL';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'APPOINTMENT_LOCKED';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'CANCEL_KEPT';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'HUMAN_HANDOFF_OFF_HOURS';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'BOT_RESUMED';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'INVALID_BACK_TO_MENU';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'AMBIGUOUS_OPTION';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'RESUME_OFFER';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'THANKS_REPLY';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'TECH_ERROR';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'LABEL_MENU_BOOK';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'LABEL_MENU_MY';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'LABEL_MENU_HUMAN';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'LABEL_ANY_PROFESSIONAL';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'LABEL_NEXT_AVAILABLE';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'LABEL_BY_DAY';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'LABEL_EDIT';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'LABEL_EDIT_SERVICE';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'LABEL_EDIT_PROFESSIONAL';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'LABEL_EDIT_DATETIME';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'LABEL_EDIT_NAME';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'LABEL_RESCHEDULE';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'LABEL_CANCEL_APPOINTMENT';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'LABEL_BOOK_ANOTHER';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'LABEL_FINISH';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'LABEL_CONTINUE';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'LABEL_START_OVER';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'LABEL_BACK';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'LABEL_OTHER_SERVICE';
ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS 'LABEL_PREVIOUS';
-- AlterTable
ALTER TABLE "platform_settings" ADD COLUMN     "n8nBotFlowHash" TEXT,
ADD COLUMN     "n8nBotFlowPrevious" JSONB,
ADD COLUMN     "n8nBotFlowPublishedAt" TIMESTAMP(3),
ADD COLUMN     "n8nBotFlowPublishedByUserId" TEXT,
ADD COLUMN     "n8nBotFlowVersion" TEXT;
-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "handoffResumeMinutes" INTEGER NOT NULL DEFAULT 120,
ADD COLUMN     "maxFutureAppointmentsPerContact" INTEGER NOT NULL DEFAULT 3,
ALTER COLUMN "slotGranularityMin" SET DEFAULT 30;
-- CreateTable
CREATE TABLE "handoff_requests" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "whatsappInstanceId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "chatSessionId" TEXT NOT NULL,
    "reason" "HandoffReason" NOT NULL,
    "offHours" BOOLEAN NOT NULL DEFAULT false,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endReason" "HandoffEndReason",
    CONSTRAINT "handoff_requests_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "handoff_requests_tenantId_requestedAt_idx" ON "handoff_requests"("tenantId", "requestedAt");
-- CreateIndex
CREATE INDEX "handoff_requests_chatSessionId_endedAt_idx" ON "handoff_requests"("chatSessionId", "endedAt");
-- AddForeignKey
ALTER TABLE "handoff_requests" ADD CONSTRAINT "handoff_requests_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "handoff_requests" ADD CONSTRAINT "handoff_requests_whatsappInstanceId_fkey" FOREIGN KEY ("whatsappInstanceId") REFERENCES "whatsapp_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "handoff_requests" ADD CONSTRAINT "handoff_requests_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "handoff_requests" ADD CONSTRAINT "handoff_requests_chatSessionId_fkey" FOREIGN KEY ("chatSessionId") REFERENCES "chat_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Grade de horários: 15 -> 30 para TODAS as empresas (decisão do dono, spec R5), depois o CHECK.
UPDATE "tenants" SET "slotGranularityMin" = 30 WHERE "slotGranularityMin" <> 30;

ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_slotGranularityMin_check" CHECK ("slotGranularityMin" IN (15, 30)),
  ADD CONSTRAINT "tenants_maxFutureAppointmentsPerContact_check" CHECK ("maxFutureAppointmentsPerContact" BETWEEN 0 AND 20),
  ADD CONSTRAINT "tenants_handoffResumeMinutes_check" CHECK ("handoffResumeMinutes" BETWEEN 30 AND 1440);

-- No máximo UM pedido de atendimento humano aberto por sessão (índice parcial: o Prisma não expressa).
CREATE UNIQUE INDEX "handoff_requests_one_open_per_session"
  ON "handoff_requests"("chatSessionId") WHERE "endedAt" IS NULL;
