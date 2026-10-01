---
name: billing-f0-review-fixes
description: Correções da revisão do Órion à F0 (2026-10-01) — orçamento de 10 min no tick, try/catch por item, suspensão manual com marca, espera de 10 min no reenvio, migration de janela
metadata:
  type: project
---

- Trava de 15 min só é segura se o trabalho nunca passar dela: SMTP com timeouts 15 s (`SMTP_TIMEOUT_MS`), orçamento `TICK_BUDGET_MS` (10 min, relógio de parede, `options.budgetMs` para teste) e tetos `EMAIL_BATCH_LIMIT` (200). P2028 vira `lockTimedOut: true` (200), nunca 500. `skippedByLock`/`deadlineReached` saem no corpo 200.
- Todo laço de envio tem try/catch POR ITEM (`emailsFailed += 1`); montar o e-mail (`billingUrlFor`/`loadEmailContext`) fica dentro do try de `sendInvoiceGeneratedEmail`/`sendSubscriptionSuspendedEmail`.
- Corte de idade da suspensão vai na CONSULTA, não no `continue`: com `take`, linhas velhas ocupariam as vagas das novas.
- Suspensão manual grava `suspendedEmailSentAt: now`. O banco NÃO distingue manual de automática (sem ProviderEvent/log/campo), então a migration `20261003110000` marca TODA SUSPENDED sem marca (janela). Custo: quem foi suspenso por atraso nos últimos dias e nunca recebeu perde esse e-mail.
- Reenvio de marcas `billing-email` só após 10 min (`ONCE_EMAIL_RETRY_WAIT_MINUTES`, comparado com o `now` do tick): em teste, rodar a rodada seguinte com `addMinutes(new Date(), 11)`.
- `persistCanceledTransition(..., { announce:false })` na reativação; anúncio de auto-cancel só DEPOIS de `applyCancellationEffects`.
- Log `email.send.failed` agora só tem `errorName`/`errorCode` (sem assunto nem message).
- Armadilha: heredoc bash grande com apóstrofo/aspas quebra; escrever scripts python com a ferramenta Write e aplicar com helper que preserva CRLF.
