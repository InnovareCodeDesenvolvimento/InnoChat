---
name: billing-f6-finance-and-notice-register
description: F6 da régua (2026-10-02) — overview financeiro, registro global de envios (destino completo + snapshot), reenvio manual por cycleKey ":resend:", paginação por página, retenção; armadilhas de teste e de ambiente
metadata:
  type: project
---

- **Registro de envios:** `BillingNotice.recipient/recipientKind/renderedSubject/renderedText` (migration aditiva) gravados pelo despachante em SENT, FAILED e (WhatsApp) SKIPPED. Snapshot > remontar: `getBillingNoticePreview` devolve o texto exato; sem snapshot remonta com `buildNoticeCopyContext` e marca `approximate: true`.
- **Retenção 12 meses:** `clearExpiredNoticePersonalData` é SQL cru em `src/lib/db` (updateMany do Prisma reescreveria `updatedAt` via `@updatedAt` e jogaria linhas antigas para o topo do registro). Ordenação/filtro de período do registro usam `updatedAt`.
- **`NOT` do SQL descarta NULL:** excluir `LEGACY_SENT` exige `OR [{skippedReason:null},{skippedReason:{not:"LEGACY_SENT"}}]` (`NOT_LEGACY_NOTICE`).
- **Reenvio manual:** novo aviso com `cycleKey = <original>:resend:<id>`; a unique `(cycleKey,step,channel)` dá a idempotência. O despachante usa `baseCycleKey()` em `isNoticeStillDue`/`skipReasonFor`, então reenviar nunca cobra quem pagou. `skipReasonFor` agora também acha a fatura pela própria `cycleKey` quando `invoiceId` é nulo.
- **Paginação por página** (`paging.ts`): `resolvePage` clampa a página; timeline junta duas tabelas pegando o prefixo `skip+pageSize` de cada uma.
- **Overview:** status EFETIVO calculado em memória a partir de um select estreito (fuso/carência são função pura); somas de mês no fuso de SP via `startOfLocalDay`. Teste compara por DIFERENÇA antes/depois porque o banco de teste é compartilhado.
- **Armadilhas de teste:** o tick gera a fatura do PRÓXIMO ciclo, então o aviso DUE_D1 referencia essa nova fatura (pagar `failed.invoiceId`, não a fixture). E-mail do financeiro não confirmado recebe 1/dia: o 2º aviso do mesmo tick cai no dono (`recipientKind OWNER`).
- **Armadilha de ambiente:** nesta sessão o shell/Write tool converteu `\n`/`\\n` dentro de scripts Python em quebras reais. Para scripts de edição, escreva o arquivo `.py` com a ferramenta Write e use `chr(10)`/`chr(13)` para CR/LF; `docs/contratos.md` é CRLF. Heredoc grande com aspas também quebra.
- **Lint:** `npm run lint` falha com ~790 erros que vêm de `.claude/worktrees/*/.next` (build de worktree antigo), não do código; lint de `src/` e `tests/` está limpo.
