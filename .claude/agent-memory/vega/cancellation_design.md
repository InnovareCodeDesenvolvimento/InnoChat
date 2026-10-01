---
name: cancellation-design
description: Cancelamento pelo painel (2026-10-01) - agendado vs imediato, void/reabrir faturas, efeitos no tick, reativacao paga, armadilhas de teste
metadata:
  type: project
---

Cancelar: ACTIVE/TRIALING agenda (`cancelAtPeriodEnd`, fim do periodo/teste); PAST_DUE/SUSPENDED cancela na hora. `effectiveStatus` devolve CANCELED no vencimento sem carencia quando agendado (nao depende do tick). Efeitos (void faturas OPEN + desconectar numeros) rodam em `applyCancellationEffects` na transicao do tick para QUALQUER origem de CANCELED; varredura do tick so refaz a desconexao.

**Why:** o `@@unique(subscriptionId, periodStart)` faz fatura VOID bloquear a criacao da proxima; por isso desfazer reabre as anuladas desde `cancelRequestedAt` (via `updatedAt`). A varredura de auto-cura NAO pode anular faturas OPEN de assinatura CANCELED: pode ser a fatura de reativacao do dono.

**How to apply:** ao mexer em tick/fatura, lembrar que `applyInvoicePayment` trata CANCELED como "suspensa" (ciclo conta do pagamento) e zera os campos de cancelamento. `summary.invoicesVoided` do tick deve somar o que os efeitos anulam (teste de trial nao convertido depende disso). Teste de integracao: `createMockMercadoPagoGateway()` devolve `{ gateway }`, nao o gateway. Spec e2e precisa de `onboardingTourCompletedAt` no usuario senao o dialogo do tour polui `getByRole("dialog")`. E2E contra servidor ja rodando em :3000 usa Prisma client antigo apos migration: subir `next start` proprio em outra porta com NEXT_DIST_DIR (trustHost permite).
