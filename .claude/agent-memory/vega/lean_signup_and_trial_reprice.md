---
name: lean-signup-and-trial-reprice
description: Cadastro enxuto (2026-10-10) e reprecificação da fatura do teste — decisões, ordem de locks e armadilhas de teste que custaram rodada
metadata:
  type: project
---

Entrega: cadastro sem CPF/slug/segmento/ciclo/cupom no formulário, WhatsApp obrigatório com DDD real, honeypot, e-mail descartável, sessão aberta na hora, documento pedido ao pagar, F2 (`trial-reprice.ts`). Contrato final no topo de `docs/plano-cadastro-sem-friccao.md` ("Ajustes de contrato (Vega)").

**Decisões não óbvias**
- Fatura do teste reprecificada = ANULAR + CRIAR (nunca editar): Pix velho pago depois cai em `paidWhileVoidAt`. `periodStart` da nova = instante da troca (chave única `subscriptionId+periodStart`).
- Ciclo de cupom gasto na fatura velha volta pelo `CouponRedemption.invoiceId` (não por `subscription.couponId`, que já foi limpo no ONCE).
- Aviso "Sua fatura chegou" da nova fatura nasce `SKIPPED/STATUS_CHANGED` só se a velha foi avisada (`suppressInvoiceCreatedNotice`); sem documento fica pendente e sai com o Pix.
- `DunningInput.hasDocument` esconde o INVOICE_CREATED do teste; `needsDocument` do texto = sem documento E sem Pix vigente (fixtures com Pix pré-gravado e documento nulo continuam mandando o Pix).
- Ordem de locks: assinatura primeiro, fatura depois. `applyInvoicePayment` agora trava a assinatura (`lockSubscriptionRowById`) antes de baixar, senão deadlock com reprecificação/cancelamento.
- `normalizeBrPhoneStrict` (DDD real) só no cadastro; `normalizeBrPhoneToE164` frouxo segue nos contatos.
- Slug: até 3 tentativas em colisão; corte do prefixo não pode terminar em hífen (`aaa--2` inválido queimava as 50 tentativas).

**Armadilhas de teste/ambiente (bug + causa raiz)**
- Teste que espera `rejects` e o código passa a aceitar vaza tenant/usuário/plano no banco de teste e derruba OUTROS arquivos (platform-notifications, afterAll de plano por FK). Causa: criar plano de menor `sortOrder` no meio do arquivo muda o plano padrão do cadastro. Use `sortOrder` alto para plano auxiliar; limpar vazamento com script via `vega_r_testdb.mjs` conferindo `innochat_test`.
- Arquivos de teste e vários `src` estão em CRLF: edição multi-linha com `\n` falha em silêncio. Helper: ler, trocar `\r\n` por `\n`, aplicar, voltar. Script via heredoc grande quebra; escrever o `.mjs` com Write.
- `\\d` em template literal passado por `node -e`/heredoc do Bash perde a barra; use Edit/Write.
- Tenant criado pelo slug do input não existe mais: testes que achavam e-mail por `${tenantSlug}@example.com` precisam guardar o input.
- Link: [[plan_price_data_migration_never_overwrite_edit]] (outro caso de migração sem sobrescrever), [[tick_global_pollutes_test_db]] (nunca tick global com relógio adiantado).
- Re-verificação 2026-10-10: Íris/Atlas rodando testes no mesmo innochat_test geram falhas fantasma (plano padrão, tick global); vazamento de tenant 'recusa'/'sem-anual' limpo via vega_clean_leaks. Rodar de novo isolado antes de culpar o código.
