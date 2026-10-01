-- Pagamento confirmado em fatura ANULADA (cancelamento): marca para o aviso do admin decidir o
-- estorno. Migration ADITIVA (segura com a versão antiga no ar): coluna nula + índice.
ALTER TABLE "invoices" ADD COLUMN "paidWhileVoidAt" TIMESTAMP(3);
CREATE INDEX "invoices_paidWhileVoidAt_idx" ON "invoices"("paidWhileVoidAt");
