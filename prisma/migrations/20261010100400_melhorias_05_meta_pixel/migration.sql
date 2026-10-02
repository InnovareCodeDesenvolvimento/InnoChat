-- Onda 0, item 5: Pixel do Meta + API de Conversoes em platform_settings. So colunas nulas/default (aditiva).
-- metaCapiTokenEnc e cifrado pela aplicacao (enc:v1:). metaEnabled nasce false: nada dispara ate o admin ligar.

ALTER TABLE "platform_settings" ADD COLUMN     "metaCapiTokenEnc" TEXT,
ADD COLUMN     "metaEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "metaPixelId" TEXT,
ADD COLUMN     "metaTestEventCode" TEXT;

-- Pixel ID do Meta: so digitos (15-16 na pratica; folga de 5 a 20).
ALTER TABLE "platform_settings" ADD CONSTRAINT "platform_settings_meta_pixel_id_check"
  CHECK ("metaPixelId" IS NULL OR "metaPixelId" ~ '^[0-9]{5,20}$');
