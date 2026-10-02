-- Rollback manual da migration 20261010100400_melhorias_05_meta_pixel.
-- Remova a linha desta migration de "_prisma_migrations" depois.
ALTER TABLE "platform_settings" DROP CONSTRAINT IF EXISTS "platform_settings_meta_pixel_id_check";
ALTER TABLE "platform_settings" DROP COLUMN IF EXISTS "metaCapiTokenEnc", DROP COLUMN IF EXISTS "metaEnabled",
  DROP COLUMN IF EXISTS "metaPixelId", DROP COLUMN IF EXISTS "metaTestEventCode";
