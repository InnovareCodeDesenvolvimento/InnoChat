-- Evidencia de entrega do e-mail da regua. So ADD COLUMN nulo (aditiva).
--
-- billing_notices.providerResponse  resposta curta do servidor SMTP no envio (ex.: "250 2.0.0 OK ... - gsmtp"), ja sem enderecos de
--                                   e-mail e com no maximo 200 caracteres. Junto de providerMessageId (ja existente) mostra ao admin
--                                   que o servidor ACEITOU a mensagem. Avisos anteriores ficam nulos.

ALTER TABLE "billing_notices" ADD COLUMN "providerResponse" TEXT;
