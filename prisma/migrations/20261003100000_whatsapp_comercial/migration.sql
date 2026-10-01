-- WhatsApp comercial da empresa (botão "Tirar dúvidas" da landing). Migration ADITIVA (coluna
-- nula; segura com a versão antiga no ar). O valor é cadastrável no Admin -> Configurações.
ALTER TABLE "platform_settings" ADD COLUMN "salesWhatsappE164" TEXT;

-- Pedido explícito do dono (2026-10-01): já nascer com 84 3113-2584 para o botão funcionar no
-- deploy. Cria a linha singleton se ainda não existir e só preenche se o valor estiver nulo; nunca sobrescreve o que o admin cadastrou/limpou depois
-- (a migration roda uma única vez).
INSERT INTO "platform_settings" ("id", "salesWhatsappE164", "updatedAt")
VALUES (1, '558431132584', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO UPDATE SET "salesWhatsappE164" = '558431132584'
WHERE "platform_settings"."salesWhatsappE164" IS NULL;
