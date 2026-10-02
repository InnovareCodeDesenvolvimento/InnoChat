-- Melhoria 8 (relatorios): fotografia do preco e da comissao no momento da conclusao do atendimento.
-- Aditiva: so colunas nulas, sem backfill. Atendimentos antigos ficam NULOS e o relatorio os calcula pelo
-- preco/comissao atuais, marcando como estimado.
ALTER TABLE "appointments" ADD COLUMN     "priceCentsSnapshot" INTEGER,
ADD COLUMN     "commissionPctSnapshot" DECIMAL(5,2),
ADD COLUMN     "commissionCentsSnapshot" INTEGER;

ALTER TABLE "appointments" ADD CONSTRAINT "appointments_snapshot_nonneg_check"
  CHECK (("priceCentsSnapshot" IS NULL OR "priceCentsSnapshot" >= 0)
     AND ("commissionCentsSnapshot" IS NULL OR "commissionCentsSnapshot" >= 0)
     AND ("commissionPctSnapshot" IS NULL OR ("commissionPctSnapshot" >= 0 AND "commissionPctSnapshot" <= 100)));
