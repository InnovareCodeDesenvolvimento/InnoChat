---
name: onda1-melhorias-review-2026-10-02
description: Revisão Onda 1 (monitor de erros, 2FA, backup, Pixel/CAPI, cupons): 0 CRÍTICO, 2 ALTO; padrões recorrentes
metadata:
  type: project
---

Relatório completo: docs/seguranca/revisao-onda1-melhorias.md. Veredito BLOQUEIA até A-1 e A-2.

Padrões recorrentes a checar em toda feature nova:
- Gate de segurança só no layout (2FA do admin/owner) não protege Server Action: o guard (`requirePlatformAdmin`/`requireTenantMember`) precisa aplicar a mesma regra.
- Componente de terceiro (Pixel) montado em página com token/PII na query string: a URL inteira vai ao terceiro. Conferir toda página com `MetaTracking`.
- Rota pública que grava no banco: o teto de retenção deve cobrir o GRUPO, não só as ocorrências; orçamentos separados para entrada pública e para erro real do servidor.
- Mensagens de erro distintas em rota pública (cupom vencido vs inexistente) viram oráculo de enumeração.
- `ProviderEvent` sem limpeza guarda dado pessoal (meta-signup: IP, UA, fbp/fbc) para sempre.
- SQL cru: padrão seguro da casa é `toISOString()` + `::timestamp`; `Date` direto contra coluna `timestamp(3)` é o risco (contact-queries.ts botPausedUntil).
- Login com Google não passa pela 2FA (decisão do dono pendente).

**Why:** evita reencontrar os mesmos furos nas próximas ondas.
**How to apply:** rode este roteiro ao auditar qualquer feature com tela de admin, terceiros no HTML público ou rota pública de escrita.
