---
name: billing-f6-orion-fixes
description: Correções da revisão do Órion à F6 (2026-10-02) — reenvio só de FAILED esgotado + bloqueio por chave base, retenção seguindo cancelamento de 90 dias, período do registro por sentAt
metadata:
  type: project
---

- **Reenvio duplicava:** `FAILED` com `attempts < NOTICE_MAX_ATTEMPTS` e `expiresAt > now` ainda é pego pelo claim. Causa raiz: `isResendable` olhava só o status. Agora `isResendableState(n, now)` exige esgotado/vencido, e `loadBlockingNotices` barra se há SENT/PENDING/SENDING na mesma `(tenantId, step, channel, baseCycleKey)` (inclui `<base>:resend:*`). `canResend` na lista é calculado em lote (1 query por página). O reenvio já criado do mesmo original continua voltando como `alreadyQueued`.
- **Como evitar:** testes de reenvio precisam forçar `attempts: 5` no FAILED (um tick de teste deixa `attempts` baixo e o aviso ainda "vivo").
- **Retenção:** `clearNoticePersonalDataOfCanceledTenants` (UPDATE ... FROM subscriptions, SQL cru em `src/lib/db`) roda no tick de manutenção com o mesmo `cancellationCutoff` dos contatos; try/catch próprio.
- **Período do registro:** filtra `OR[{sentAt in range},{sentAt null, updatedAt in range}]` = o instante exibido. Sem índice novo em `sentAt` (documentado no código). Efeito em teste: aviso enviado por tick com `now` simulado aparece no dia simulado, não em "hoje".
- **Auditoria:** `BillingEvent` `NOTICE_RESENT` (actor ADMIN, metadata `originalNoticeId`/`noticeId`); frase "Aviso reenviado pelo admin" em `billingEventLabel`.
- **Ambiente:** `notice-register.ts` e `tick.ts` são CRLF; editar com script Python lendo bytes e normalizando.
