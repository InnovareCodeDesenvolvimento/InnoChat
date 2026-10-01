---
name: billing-f0-email-marks-lock
description: F0 da régua (2026-10-01) — marca *SentAt só com sent===true, outbox transitório em ProviderEvent, lock advisory de transação, armadilhas
metadata:
  type: project
---

- `sendBillingMail` (service.ts) devolve boolean; NUNCA grave `*SentAt` sem `true`. `sendSubscriptionSuspendedEmail`/`sendInvoiceGeneratedEmail` agora retornam boolean.
- Suspensão: o e-mail saiu do loop de transição (o `continue` por status igual impedia retry) e virou varredura `sendPendingSuspensionEmails` (SUSPENDED + `suspendedEmailSentAt` nulo, teto 7 dias desde a suspensão).
- Envio único sem migration (fatura gerada, cancelamento automático): `email-outbox.ts` usa `ProviderEvent(provider="billing-email")` com claim por unique + `processedAt`. É transitório até o `BillingNotice` da F1.
- Lock do tick: `withAdvisoryLock` (src/lib/db/advisory-lock.ts) usa `pg_try_advisory_xact_lock` dentro de `$transaction` com timeout 15 min. Sessão não serve com pool do Prisma. SQL cru só em src/lib/db.
- Sino do Admin: `BILLING_EMAIL_FAILING` derivado de `lastBillingTickResult.emailsFailed` (sem tabela); id estável por dia.
- Armadilha de teste: tick global também gera "fatura gerada" para qualquer ACTIVE vencendo; filtrar e-mails por assunto/destinatário.
- Armadilha de ambiente: templates.ts é CRLF; heredoc bash com `\n` em python quebrou string literal. Use Edit/arquivo .py.
- Aviso CSV: com status CANCELED o painel só mostra Assinatura, então o e-mail de auto-cancelamento manda reativar para exportar o CSV.
