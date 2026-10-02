---
name: audit-log-design
description: Registro de auditoria (Melhoria 4): onde se grava, o que nunca entra, escopo por empresa e pendência de retenção
metadata:
  type: project
---

`recordAudit` (src/modules/audit/record.ts) é chamado DEPOIS do sucesso, na camada da Server Action/rota; nunca lança (try/catch + `logger.error("audit.record_failed")`). Não usei transação conjunta: nenhuma ação precisou, e um erro de INSERT dentro de `tx` aborta a transação inteira no Postgres.

**Segredos:** `sanitizeChanges` redige por NOME de campo (`enc$|senha|passw|token|secret|segredo|credential|apikey|privatekey|hash$|accesskey|key$|chave`). O melhor é nem passar o valor: nas ações da plataforma o chamador passa `{de:null,para:null}` só para marcar "mudou". CPF/CNPJ e contato de cobrança guardam só "final NN" / informado-vazio.

**Escopo:** `AuditLog` fica fora de TENANT_SCOPED_MODELS. `listTenantAudit` fixa `tenantId` do guard (OWNER); o Admin lê tudo. Para a empresa, PLATFORM_ADMIN aparece como "Equipe InnoChat" e o IP não vai. Suspender/reativar/estender teste gravam com `tenantId` da empresa (o dono vê); plano, cupom, configurações e backup ficam com `tenantId` nulo.

**Why:** pedido do dono (plano-melhorias item 4). **Retenção NÃO decidida**: nada apaga; `AUDIT_RETENTION_DAYS = null` em queries.ts é o ponto único.

**How to apply:** ação nova que mexe em dado de negócio => ler o "antes", `diffChanges`, `recordAudit`, rótulo em labels.ts (teste confere que toda ação tem rótulo e área). Teste unitário de action que mocka o guard sem `membership` quebra com `memberActor`: mocke `@/modules/audit/record` (ver tenant/actions.test.ts).
