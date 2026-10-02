-- Monitor de cobranca (F7). So ADD COLUMN nulo (aditiva).
--
-- platform_settings.lastBillingDownAlertAt  instante do ultimo e-mail "cobranca parada" enviado ao admin da plataforma.
--                                           A reserva atomica (UPDATE ... WHERE nulo OU mais antigo que 6 h) garante no maximo
--                                           1 e-mail a cada 6 h mesmo com varios disparos simultaneos.

ALTER TABLE "platform_settings" ADD COLUMN "lastBillingDownAlertAt" TIMESTAMP(3);
