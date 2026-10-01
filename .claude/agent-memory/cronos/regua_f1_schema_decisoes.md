---
name: regua-f1-schema-decisoes
description: F1 da régua de cobrança (migrations 20261004100000/100100) — BillingNotice, BillingEvent, PlatformWhatsappConnection, cycleKey, backfill LEGACY_SENT e armadilhas
metadata:
  type: project
---

- Duas migrations: `..100000_regua_f1_schema` (diff do Prisma + CHECKs, trigger e 2 únicos parciais à mão) e `..100100_regua_f1_backfill_legacy_sent` (um `DO $$` idempotente, ids `legacy_<md5>`, ON CONFLICT DO NOTHING; testado reexecutando o SQL do disco).
- `migrate diff` depois de aplicar dá "empty migration": CHECK, trigger e índice parcial NÃO geram drift no Prisma 6.
- `cycleKey` de suspensão/cancelamento = `<subId>:<currentPeriodEnd ISO UTC>` (não o "início da suspensão" do plano): este depende da carência, que muda de 1 para 3 dias na F2 e mudaria a chave no dia do deploy. `to_char(..., 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` = `toISOString()` do JS (colunas são UTC).
- Backfill vai além do plano de propósito: TODA fatura existente ganha `INVOICE_CREATED/LEGACY_SENT`, porque o e-mail de "fatura gerada" só ganhou marca na v1.3.2 (F0); sem isso o motor novo reenviaria a faturas antigas abertas. Exceção: fatura com envio pendente (`processedAt` nulo) no outbox antigo.
- Fatura de teste (`isTrialConversion`) mapeia `dueReminder/dueToday` para `TRIAL_T1/TRIAL_T0` com cycleKey `<subId>:trial`.
- Telefone do dono NÃO existe em lugar nenhum do banco: o cadastro valida `phone` e descarta (`signup/actions.ts`). Só há `WhatsappInstance.phoneE164` e `TrialClaim.phoneE164` (ambos o número do BOT da empresa, risco de loop). Por isso `billingWhatsappE164` nasce nulo para todos e D5 "ativo para todos" só vale para quem informar número.
- `BillingNotice.tenantId/subscriptionId` obrigatórios: o `ADMIN_TEST` do plano (§2.4) não cabe sem tenant. Decisão fica com a Vega (não gravar ou tornar nulo).
- `BillingNotice`/`BillingEvent`/`PlatformWhatsappConnection` NÃO entram em `TENANT_SCOPED_MODELS` (leitura cross-tenant por desenho); filtrar por tenantId à mão nas telas da empresa.
- Sem índice em `platformConnectionId`, `invoiceId`, `subscriptionId` (FKs só para delete raro; tabelas pequenas). Reavaliar se a contagem "avisos por número" no histórico ficar lenta.
- Teste de integração limpa `legacy_%` no afterAll porque o backfill roda global no banco de teste. Flake pré-existente e sem relação: `bot-api-v2-agenda` "API-03 ... rótulo relativo ao dia" falha conforme a hora do dia.
