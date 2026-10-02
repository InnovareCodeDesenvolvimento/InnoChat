---
name: billing-f7-monitor-design
description: F7 monitor de cobrança (2026-10-02) — veredito puro, gatilhos do e-mail ao admin, e armadilhas de teste
metadata:
  type: project
---

`GET /api/health/billing` usa `evaluateBillingHealth` (puro, `src/core/billing/billing-health.ts`) alimentado por `loadBillingHealth` (`src/modules/billing/health.ts`). Mesmo veredito vai ao sino, à Saúde (`billingMonitor`) e ao e-mail.

- Down só por: tick >180 min, aviso de EMAIL preso (nextAttemptAt <now-2h, PENDING ou FAILED retentável) ou e-mail falhando em sequência (FAILED attempts>=3 sem nenhum SENT nas últimas 3 h). WhatsApp preso/caído = degraded. **Why:** o teto diário/ritmo do WhatsApp pode deixar aviso vencido na fila sem ser defeito.
- Retentável FAILED também é "preso": falha não volta a PENDING, fica FAILED com nextAttemptAt (o claim pega PENDING e FAILED).
- E-mail ao admin: reserva atômica `updateMany` em `PlatformSettings.lastBillingDownAlertAt` (1 a cada 6 h); falha de envio devolve a reserva para retentar em 30 min. Gatilhos independentes do tick: a própria rota (void, sem await) e `runMaintenanceTick`. Tudo ainda depende do painel/SMTP/n8n; a garantia real é o UptimeRobot.
- Armadilhas: `vi.spyOn(prisma.platformSettings, "findUnique")` quebra o delegate para os testes seguintes (restoreAllMocks deixa "not a function") — mockar o módulo `@/modules/billing/health` com flag hoisted. Heredoc grande com aspas quebrou de novo: usar Write para arquivos de teste.
- Texto de ajuda não pode conter "n8n", "API", "cron" (FORBIDDEN_HELP_TERMS, regex por limite de letra pega até "/api/").
