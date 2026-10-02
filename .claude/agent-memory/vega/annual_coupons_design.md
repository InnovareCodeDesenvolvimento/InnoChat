---
name: annual-coupons-design
description: Melhoria 6 (plano anual + cupons), decisões que não se leem no código, armadilhas e lacunas assumidas (2026-10-02)
metadata:
  type: project
---

- **Ciclo vale o da FATURA, não o da assinatura:** `applyInvoicePayment` soma 12 ou 1 mês conforme `invoice.cycle`. Se o dono troca mensal→anual depois de a fatura sair, a paga ainda avança 1 mês. **Why:** troca vale só na próxima fatura (sem pro-rata). **How to apply:** qualquer lógica de período lê `invoice.cycle`.
- **Plano sem `annualPriceCents` cobra mensal** mesmo com `billingCycle=ANNUAL` na assinatura (`effectiveCycle`). A tela Assinatura mostra o ciclo EFETIVO (`charge.cycle`), senão diz "anual" para quem paga mensal.
- **Piso `MIN_CHARGE_CENTS`=100:** desconto limitado para o líquido nunca ficar abaixo de R$ 1,00 (MP não gera Pix de zero). Valor escolhido por mim, não confirmado na doc do MP.
- **Consumo de ciclo na mesma transação da fatura** (`createInvoiceForPeriodTracked` agora usa `$transaction`); só gasta se `discountCents > 0`. Cupom que não vale no plano/ciclo atual fica guardado sem gastar.
- **Resgate = adoção** (único por cupom+empresa); faturas seguintes não criam resgate. Resgate atômico em `src/lib/db/coupon-redeem.ts` (único SQL cru; `maxRedemptions` compara duas colunas, o Prisma não expressa). Há CHECK no banco (`coupons_redemptions_count_check`) como segundo cinto.
- **Cupom desativado depois da adoção continua descontando**; depois do 1º resgate, tipo/valor/duração/ciclo travam (`COUPON_LOCKED`) porque o valor é lido do Coupon ao vivo.
- **Lacunas assumidas:** (1) cadastro por Google não envia ciclo/cupom; (2) fatura anulada (VOID) e reaberta não devolve o ciclo de cupom gasto; (3) `TERMS_VERSION` NÃO foi bumpada apesar do texto novo sobre plano anual (decisão do Atlas/dono); (4) detalhe da empresa no Admin não mostra o ciclo nas faturas.
- **Ambiente:** o working tree tem CRLF em vários arquivos (service.ts, tick.ts, signup/service.ts); editar com Python normalizando `\r\n`->`\n` e voltando (helper no scratchpad), nunca `sed -i` por linha. Heredoc grande no bash quebra: usar a ferramenta Write. Harness temporário de medição (página fake em `(public)/medir-vega` + `next dev` com DATABASE_URL falsa) funciona para medir 1440/390 sem login; apagar antes de entregar.
- O commit dd1f0d6 (marketing) varreu uma versão antiga de `signup-billing.tsx` por pathspec largo; o working tree é a versão final.
