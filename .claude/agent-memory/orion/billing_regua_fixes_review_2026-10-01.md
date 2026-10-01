---
name: billing_regua_fixes_review_2026-10-01
description: Revisão do commit 587730f (correções dos 6 IMPORTANTES da régua) — LIBERADO, sem CRÍTICO; restam resposta "SIM" sem trava de 24h, callers de effectiveStatus sem manualSuspendedAt, extensão de trial não limpa a marca
metadata:
  type: project
---

LIBERADO, sem CRÍTICO. Migrations corretas (to_char MS bate com toISOString; DELETE só PAST_DUE/ACTIVE com cycleKey exato; aditivas, seguras com versão antiga). applyInvoicePayment: dupla baixa impossível (UPDATE condicional + paidByPaymentId; ids são string). Pix antigo cancelado após update do novo; corrida coberta por staleCancel.
Restos: (1) webhook platform-whatsapp: `confirmed = true` mesmo quando updateMany.count = 0, então "SIM" repetido ignora a trava de 24 h da autorresposta (amplificação 1:1, risco ao chip). (2) callers de effectiveStatus sem manualSuspendedAt no select (inicio/page, billing-banner-state, reminders/tick, whatsapp/service, service.ts:62) tratam manual como PAST_DUE. (3) reconhece "s" como SIM (confirma por resposta genérica). (4) extendTrialManually/outros caminhos não limpam manualSuspendedAt (só pago e reativação manual limpam).
Padrão: ao adicionar coluna que muda effectiveStatus, grepar TODOS os callers e seus `select`.
