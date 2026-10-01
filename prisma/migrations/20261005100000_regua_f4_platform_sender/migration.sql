-- F4 da régua: motivo novo de descarte do claim (remetente é número da plataforma). Aditiva.
ALTER TYPE "InboundIgnoreReason" ADD VALUE IF NOT EXISTS 'PLATFORM_SENDER';
