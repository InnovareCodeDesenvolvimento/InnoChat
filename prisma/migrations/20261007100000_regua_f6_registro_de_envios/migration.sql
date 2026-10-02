-- F6 da regua: registro global de envios do Admin (docs/regua-de-cobranca.md, F6). So ADD COLUMN nulo e CREATE INDEX.
--
-- billing_notices.recipient         destino COMPLETO (e-mail ou telefone E.164), so avisos novos. Dado pessoal: o admin da
--                                   plataforma e o controlador; fica so no banco (nunca em log). A manutencao zera apos 12 meses.
-- billing_notices.recipientKind     OWNER | BILLING_EMAIL | BILLING_WHATSAPP (para quem a regra de destinatario mandou)
-- billing_notices.renderedSubject   assunto do e-mail como foi enviado (snapshot auditavel)
-- billing_notices.renderedText      texto puro do e-mail / texto do WhatsApp como foi enviado. Zerado junto com `recipient`.
--
-- Avisos antigos ficam com tudo nulo (a tela mostra o `recipientMasked` com "registro anterior").

ALTER TABLE "billing_notices" ADD COLUMN "recipient" TEXT;
ALTER TABLE "billing_notices" ADD COLUMN "recipientKind" TEXT;
ALTER TABLE "billing_notices" ADD COLUMN "renderedSubject" TEXT;
ALTER TABLE "billing_notices" ADD COLUMN "renderedText" TEXT;

ALTER TABLE "billing_notices" ADD CONSTRAINT "billing_notices_recipient_kind_check"
  CHECK ("recipientKind" IS NULL OR "recipientKind" IN ('OWNER', 'BILLING_EMAIL', 'BILLING_WHATSAPP'));

-- Registro global: ordenado por ultima mudanca, com filtro de periodo.
CREATE INDEX "billing_notices_updatedAt_id_idx" ON "billing_notices"("updatedAt", "id");
