---
name: botv2_review_2026-09-30
description: Revisão O-1 do bot v2 (2026-09-30) — sem CRÍTICO; ReDoS quadrático em normalizeText, migration de textos vs imagem antiga, snapshot n8n sem redação
metadata:
  type: project
---

Achados principais (sem CRÍTICO):
- `src/core/bot/engine/normalize.ts` `replace(/[.,!?;:\s]+$/g,"")` é quadrático (60k "!" + "a" = 4,5 s medido). Roda no Code node do n8n e no claim (isMenuCommand). Padrão: regex `X+$` sem âncora inicial em texto do cliente.
- Migration `20261001200100` insere BotText com chaves novas; a imagem ANTIGA lê `botText.findMany()` sem filtro e o Prisma quebra em enum desconhecido (janela de deploy/rollback). O código novo filtra por chave.
- Snapshot `n8nBotFlowPrevious` guarda nós do n8n vivo sem redação (segredo colado à mão iria para o banco); download só tira credentials/pinData.
- release/handoff/TIMEOUT não são gated pelo header `X-InnoChat-Flow`: v1 também ganha TECH_ERROR proativo e HandoffRequest.
- CSV injection (memória csv_injection_pushname) agora ESTÁ corrigido (contacts.ts ~377).
Confirmado OK: limite de agendamentos serializa por `tx.contact.update` (lock de linha, READ COMMITTED), publish só requirePlatformAdmin, safeFetch no cliente n8n, host do painel vem de publicBaseUrl.
