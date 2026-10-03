---
name: ciclos_4_review_2026-10-03
description: Revisão dos 4 ciclos de plano (596d750/e230df0) — LIBERA; setMonth vs addMonths, fallback silencioso para MONTHLY, coluna legada de cupom
metadata:
  type: project
---

Revisão em docs/seguranca/revisao-4-ciclos.md. Sem CRÍTICO. Preço sempre recalculado no servidor (priceInvoice/loadInvoiceCharge/effectiveCycle).

Padrões recorrentes: (1) applyInvoicePayment usa Date#setMonth enquanto tick/cancellation usam date-fns addMonths: estouro de fim de mês, pior com 3/6 meses. (2) effectiveCycle cai em MONTHLY sem avisar (changePlan não confere ciclo; updatePlan CYCLE_IN_USE é check-then-act sem transação). (3) coluna legada coupons.appliesToCycle não espelhada: só importa na janela de deploy com a v1.7.5.

**How to apply:** ao auditar cobrança nova, conferir toda aritmética de data contra addMonths e todo fallback silencioso de ciclo/plano.
