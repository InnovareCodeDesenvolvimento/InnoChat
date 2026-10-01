---
name: billing_f0_review_2026-10-01
description: Revisão do commit 153530e (F0 cobrança) — sem CRÍTICO; trava xact de 15 min vs nodemailer sem timeout, varredura de suspensão pega suspensão manual do admin, exceção fora de sendBillingMail aborta o tick
metadata:
  type: project
---

Achados (sem CRÍTICO): (1) `withAdvisoryLock` timeout 15 min do Prisma: se o trabalho passar, o Prisma faz rollback, solta a trava com `fn` ainda rodando (2º tick entra) e o tick rejeita perdendo o resumo; `sendMail` (nodemailer) sem connection/socket timeout explícito e laços seriais sem teto. (2) `sendPendingSuspensionEmails` varre todo SUSPENDED com marca nula: `suspendCompanyManually` (admin-service) nunca grava marca, então suspensão manual passa a mandar e-mail "atraso/teste terminou" (texto errado). (3) `billingUrlFor`/`loadEmailContext` ficam FORA do try de `sendBillingMail`: exceção aborta o tick inteiro (suspensão, void, desconexão). (4) `announceAutoCancel` roda antes de `applyCancellationEffects` e fora da trava (startReactivation) → pode corrida com `retryPendingOnceEmails` (2 e-mails). (5) Crash entre `created` e `claimOnceEmail` = nunca avisa fatura gerada.
Garantia real é at-least-once (marca após envio). Trava: tx só faz 1 SELECT, `fn` usa pool normal (sem tx), sem xid/snapshot → não segura vacuum nem lock de linha; custo é 1 conexão do pool (default Prisma = 2*CPU+1, sem connection_limit).
ProviderEvent billing-email guarda só ids internos + kind (sem PII); sino só leva contagem. Log do mailer grava assunto com nome da empresa e errorMessage do transporte (pode conter o destinatário).
