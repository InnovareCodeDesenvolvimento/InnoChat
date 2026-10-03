---
name: ciclos-4-schema
description: Migration 20261013000000 (4 ciclos + Coupon.appliesToCycles[]) - decisoes e armadilha do CHECK com array contendo NULL
metadata:
  type: project
---

- Plan.quarterlyPriceCents/semiannualPriceCents (nulo = nao oferecido), CHECKs de ciclo ampliados (drop+add, mesmo nome), Coupon.appliesToCycles TEXT[] (vazio = todos). Coluna antiga appliesToCycle mantida (default ANY) ate a versao v1.7.5 sair de linha; dropar so numa migration futura (contract).
- ARMADILHA: `arr <@ ARRAY[...]` com elemento NULL da NULL e o CHECK passa; somar `array_position(arr, NULL) IS NULL`.
- couponCyclesRemaining = FABRICAS restantes (faturas), nao meses.
- Teste de backfill nao da para fazer sobre linhas antigas (testes criam cupons novos); testa-se a expressao CASE.
