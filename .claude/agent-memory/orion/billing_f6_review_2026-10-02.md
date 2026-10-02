---
name: billing-f6-review-2026-10-02
description: Revisão do commit 8a41a28 (F6 Financeiro/Envios/CSV/reenvio) — LIBERADO sem CRÍTICO; reenvio de FAILED em retry duplica envio; retenção do recipient não segue a anonimização de 90 dias
metadata:
  type: project
---

Commit 8a41a28 (F6): acesso OK (toda action + rota CSV com requirePlatformAdmin; layout admin dá notFound), CSV com csvCell/neutralizeFormula cobrindo `= + - @ \t \r` e espaços, teto 20k/12 meses, SQL cru parametrizado (Prisma.sql), backfill idempotente (NOT EXISTS + id determinístico), sem dangerouslySetInnerHTML.

Achados:
- IMPORTANTE: `isResendable` (notice-register.ts) aceita FAILED mesmo com tentativas restantes; o claim ainda pega FAILED com attempts<max -> cliente recebe 2 mensagens (original em retry + reenvio). Corrigir: só reenviar FAILED esgotado/expirado, ou pular se já há SENT na mesma chave base.
- IMPORTANTE: retenção de `recipient`/`renderedText` é 365 dias por updatedAt, mas contatos de empresa CANCELED são anonimizados em 90 dias (CANCELED_RETENTION_DAYS) — destino/texto sobrevivem. Limpar também no ciclo de anonimização.
- SUGESTÃO: quem reenviou só fica em log (sem BillingEvent actor ADMIN); UPDATE de retenção varre todo o histórico antigo a cada tick (sem índice parcial); getFinanceOverview carrega todas as assinaturas vivas.

**Why:** padrão recorrente — ação manual do admin reaproveita o despachante mas não considera o retry automático em curso.
**How to apply:** ao auditar ações manuais sobre filas com retry, procurar a corrida entre o estado "falhou" e o retry automático; ao auditar dado pessoal novo, cruzar com a rotina de anonimização por cancelamento.
