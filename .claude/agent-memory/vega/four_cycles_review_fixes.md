---
name: four-cycles-review-fixes
description: Correções da revisão do Órion aos 4 ciclos (2026-10-03): addMonths no pagamento, recusa de plano sem o ciclo, travas de linha, confirmLowPrice
metadata:
  type: project
---

- I-1 causa raiz: `Date#setMonth` estoura fim de mês (31/08 + 6 = 03/03) e o próximo periodStart desliza. Sempre `addMonths` do date-fns; não há mais setMonth em src/.
- I-2: `changePlan` recusa com `CYCLE_NOT_AVAILABLE_ON_PLAN` se o plano novo não oferece o ciclo EFETIVO atual (quem já caiu no mensal por outro caminho não fica presa). `changeBillingCycle` valida contra `pendingPlanId ?? planId`. A tela de Assinatura lista os ciclos do plano da PRÓXIMA fatura.
- Travas: `src/lib/db/billing-row-locks.ts` (`lockSubscriptionRow` depois `lockPlanRow`; Admin só trava o plano). `updatePlan`, `changePlan`, `changeBillingCycle` rodam em `$transaction`; eventos (`recordBillingEvent`) ficam FORA da transação.
- S-2: `isLowCyclePrice` (core/billing/pricing.ts), erro `LOW_CYCLE_PRICE_UNCONFIRMED`; só pede se o salvamento muda aquele preço ou o mensal. `confirmLowPrice` é tirado do `data` antes do `plan.update`.
- Armadilha de E2E: com dois Dialogs abertos o Radix põe o de baixo em aria-hidden, então `expect(dialog).toBeHidden()` passa na hora; espere o efeito (poll no banco).
- Armadilha de teste: `platform-notifications.integration` falha no innochat_test quando sobra tenant `botsim-solo` cancelado (dado de outro teste); não é regressão de cobrança.
