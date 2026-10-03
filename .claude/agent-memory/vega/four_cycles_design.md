---
name: four-cycles-design
description: 4 ciclos (mensal/trimestral/semestral/anual) 2026-10-03: decisões, trava de apagar preço, e a armadilha de script Prisma solto que bate no banco de DEV
metadata:
  type: project
---

- Fonte única em `src/core/billing/pricing.ts` (`CYCLE_INFO`, `priceFor`, `effectiveCycle`, `cycleSavings`, `suggestCyclePrices`, `normalizeCouponCycles`). Nunca decidir mês/rótulo por `if (cycle === "ANNUAL")`; use `asBillingCycle` ao ler coluna.
- `PlanPrices` exige os 3 campos (`number|null`): select Prisma que esquece um campo vira erro de TS (de propósito). Use `PLAN_PRICES_SELECT`.
- Cupom: só `appliesToCycles` (lista); `appliesToCycle` fica no default. Duração conta FATURAS.
- `updatePlan` recusa apagar preço de ciclo com assinatura não cancelada (`CYCLE_IN_USE`, atual ou `pendingPlanId`).
- Armadilha (erro meu, 2026-10-03): script `node` solto com `new PrismaClient()` usa o `DATABASE_URL` do `.env` = banco de DEV, não o de E2E. Rodar SEMPRE via `e2edb.mjs run` / `withdb.mjs` e conferir o banco antes de gravar. Alterei o plano "clinica" do dev e restaurei os 3 preços para null (original presumido, o mesmo das outras duas).
- E2E: `playwright.config` com `testDir` do projeto precisa estar DENTRO do projeto (config no scratchpad não acha `@playwright/test`). Prévia de cupom no cadastro tem 20/10min por IP: reiniciar o servidor entre specs. Toast/streaming duplica nós: escopar em `getByRole("main")`.
- Dicas de formulário devem ser testadas no estado inicial (nenhum ciclo marcado = "todos").
