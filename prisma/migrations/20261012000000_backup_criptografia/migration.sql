-- Backup cifrado: chave propria do backup (independente do AUTH_SECRET) e conferencia da copia. Aditiva.
-- A chave (32 bytes) fica cifrada com src/lib/crypto.ts; so a impressao digital (8 hex do sha256) volta para a tela.
-- "encryptionKeyShownAt" = quando a chave foi mostrada ao dono (a unica vez em que ela aparece inteira).

ALTER TABLE "backup_config" ADD COLUMN "encryptionKeyEnc" TEXT;
ALTER TABLE "backup_config" ADD COLUMN "encryptionKeyFingerprint" TEXT;
ALTER TABLE "backup_config" ADD COLUMN "encryptionKeyCreatedAt" TIMESTAMP(3);
ALTER TABLE "backup_config" ADD COLUMN "encryptionKeyShownAt" TIMESTAMP(3);

-- Cada execucao grava com qual chave a copia saiu (nulo = nao cifrada, como as antigas e o teste sem destino).
ALTER TABLE "backup_runs" ADD COLUMN "encryptionKeyFingerprint" TEXT;

ALTER TABLE "backup_config" ADD CONSTRAINT "backup_config_key_pair_check" CHECK (("encryptionKeyEnc" IS NULL) = ("encryptionKeyFingerprint" IS NULL));
ALTER TABLE "backup_config" ADD CONSTRAINT "backup_config_key_fingerprint_check" CHECK ("encryptionKeyFingerprint" IS NULL OR "encryptionKeyFingerprint" ~ '^[0-9a-f]{8}$');
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_key_fingerprint_check" CHECK ("encryptionKeyFingerprint" IS NULL OR "encryptionKeyFingerprint" ~ '^[0-9a-f]{8}$');

-- Novo valor de origem: VERIFY = "Conferir backup" (baixa a copia mais recente, decifra e le o indice; nao escreve em banco nenhum).
ALTER TABLE "backup_runs" DROP CONSTRAINT "backup_runs_trigger_check";
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_trigger_check" CHECK ("trigger" IN ('SCHEDULED', 'MANUAL', 'VERIFY'));
