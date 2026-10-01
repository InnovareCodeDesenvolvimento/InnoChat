---
name: cancellation-design
description: Cancelamento pelo painel (2026-10-01) - agendado vs imediato, void/reabrir faturas, efeitos no tick, reativacao paga, armadilhas de teste
metadata:
  type: project
---

Cancelar: ACTIVE/TRIALING agenda (`cancelAtPeriodEnd`, fim do periodo/teste); PAST_DUE/SUSPENDED cancela na hora. `effectiveStatus` devolve CANCELED no vencimento sem carencia quando agendado (nao depende do tick). Efeitos (void faturas OPEN + desconectar numeros) rodam em `applyCancellationEffects` na transicao do tick para QUALQUER origem de CANCELED; varredura do tick so refaz a desconexao.

**Why:** o `@@unique(subscriptionId, periodStart)` faz fatura VOID bloquear a criacao da proxima; por isso desfazer reabre as anuladas desde `cancelRequestedAt` (via `updatedAt`). A varredura de auto-cura NAO pode anular faturas OPEN de assinatura CANCELED: pode ser a fatura de reativacao do dono.

**How to apply:** ao mexer em tick/fatura, lembrar que `applyInvoicePayment` trata CANCELED como "suspensa" (ciclo conta do pagamento) e zera os campos de cancelamento. `summary.invoicesVoided` do tick deve somar o que os efeitos anulam (teste de trial nao convertido depende disso). Teste de integracao: `createMockMercadoPagoGateway()` devolve `{ gateway }`, nao o gateway. Spec e2e precisa de `onboardingTourCompletedAt` no usuario senao o dialogo do tour polui `getByRole("dialog")`. E2E contra servidor ja rodando em :3000 usa Prisma client antigo apos migration: subir `next start` proprio em outra porta com NEXT_DIST_DIR (trustHost permite).

**Endurecimento (2026-10-01, revisao do Orion):** `persistCanceledTransition` (claim condicional status+cancelAtPeriodEnd+currentPeriodEnd, depois efeitos) e usado pelo tick e por `startReactivation` — status EFETIVO CANCELED com persistido ACTIVE nao pode criar fatura antes disso. Anular fatura = `voidOpenInvoices` + `cancelPixPayments` (fora da tx; `PUT /v1/payments/{id}` cancelled, so loga falha). Reabrir fatura VOID (undo/reativacao) zera Pix e usa idempotencyKey nova (a do invoice.id devolveria o pagamento cancelado). Aviso `PAYMENT_ON_VOID_INVOICE` vem de `Invoice.paidWhileVoidAt` (nao de ProviderEvent: sem indice). Fatura OPEN de CANCELED = reativacao; so recebe e-mail se `createdAt >= canceledAt`; tick anula apos dueAt+7d.

**Armadilhas de ambiente:** (1) python heredoc com `\t`/`\u2028` gravou caracteres reais (TAB, U+2028, NUL) no .ts — grep disse "Binary file matches"; escreva trechos com barra invertida via Edit/Write, ou `chr(92)`. (2) `node_modules/@prisma/client` apareceu vazio no meio da sessao (outro processo): restaurar com `npm pack @prisma/client@<versao do lock>` + copiar, depois `npx prisma generate` (o rename da query_engine .dll falha com o dev server segurando o arquivo, mas os .js/.d.ts sao gerados; apagar o .tmpNNN que sobra). (3) `import type { Prisma }` so via `@/lib/db/types`.
