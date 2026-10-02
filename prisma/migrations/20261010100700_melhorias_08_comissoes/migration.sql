-- Onda 0, item 8: comissao percentual por profissional e override por servico do profissional.
-- So colunas nulas (aditiva). NULO em professionals = sem comissao cadastrada; NULO em professional_services
-- = vale a do profissional. Nenhum indice novo: relatorios usam appointments(tenantId, startsAt) ja existente.

ALTER TABLE "professional_services" ADD COLUMN     "commissionPct" DECIMAL(5,2);
ALTER TABLE "professionals" ADD COLUMN     "commissionPct" DECIMAL(5,2);

ALTER TABLE "professionals" ADD CONSTRAINT "professionals_commission_pct_check"
  CHECK ("commissionPct" IS NULL OR ("commissionPct" >= 0 AND "commissionPct" <= 100));
ALTER TABLE "professional_services" ADD CONSTRAINT "professional_services_commission_pct_check"
  CHECK ("commissionPct" IS NULL OR ("commissionPct" >= 0 AND "commissionPct" <= 100));
