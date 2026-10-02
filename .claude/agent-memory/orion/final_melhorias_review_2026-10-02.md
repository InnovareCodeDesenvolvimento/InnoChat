---
name: final-melhorias-review-2026-10-02
description: Revisão final do pacote de 8 melhorias (fdece65..1aeff4d): LIBERA, 0 CRÍTICO/0 ALTO, 3 MÉDIO; padrões novos
metadata:
  type: project
---

Relatório: docs/seguranca/revisao-final-melhorias.md. A-1, A-2, M-3, M-6, B-1/B-2/B-4 da Onda 1 confirmados corrigidos.

Padrões novos a checar em toda feature futura:
- Auditoria/histórico visível ao dono: linha com `tenantId` da empresa mostra TUDO ao dono, inclusive texto livre escrito pelo admin da plataforma (motivo da baixa manual). `platformOnly` em labels.ts só esconde o filtro, não as linhas.
- Tabela append-only (trigger só em UPDATE) + nome de cliente no `summary` = dado pessoal que a anonimização LGPD não alcança. Gravar id, não nome.
- Filtro por ator consultando User global derruba a máscara "Equipe InnoChat" (oráculo de identidade do admin).
- Dump cifrado só vale se o restore recusa arquivo sem a marca de cifra (downgrade para `.dump` forjado).
- Rate limit de captura por minuto não é teto de grupos: precisa de teto total de grupos OPEN do navegador.
- Cupom: a prévia foi unificada, mas `signUp` (adoptCouponInTx) ainda vaza motivo distinto.
- Renovação de sessão via `unstable_update` só dentro de AsyncLocalStorage (`runWithSessionRefresh`): padrão aprovado.
- `globalState` (Symbol.for em globalThis) é a forma aprovada de ter estado único entre bundles.

**Why:** evita reencontrar os mesmos furos. **How to apply:** rode este roteiro ao auditar telas de histórico, backup/restore e rotas de cupom.
