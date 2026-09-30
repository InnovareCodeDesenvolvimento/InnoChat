---
name: publish-flow-d1-design
description: Decisões e armadilhas do "Publicar fluxo" (D-1): hash canônico, snapshot em {} no lugar de JsonNull, verificação, JSON no bundle
metadata:
  type: project
---

- Arquivos: `src/modules/platform/{n8n-flow-hash,n8n-flow-merge,n8n-publish,publish-actions}.ts`. Orquestrador puro `createFlowPublisher({store, context, build})` (n8n e store por injeção → teste unitário com n8n em memória); ligação com Prisma/n8n real no fim de `n8n-publish.ts`.
- Limpar `n8nBotFlowPrevious` grava `{}`, não `Prisma.JsonNull`: ESLint proíbe `@prisma/client` fora de `src/lib/db/` e `lib/db/types.ts` só reexporta TIPOS. `isSnapshot` trata `{}`/NULL como "sem snapshot".
- Publicar idêntico ao vivo é no-op (regravar sobrescreveria o snapshot e mataria o "voltar"). Rollback é de 1 versão: depois dele `previous` = vazio.
- Trava é em memória do processo (1 container). Se o painel escalar para várias réplicas, trocar por lease no banco (ver [[chatsession_lease_atomic_update]]).
- O JSON importado (`n8n/innochat-bot.json`) só entra no bundle quando alguma página/rota alcança `publish-actions` — antes da tela da L-4 o `.next/standalone` não o contém (tree-shaking por alcance). Conferir depois da L-4.
- Hash do vivo depende de o n8n devolver `parameters` sem normalizar; se o n8n real acrescentar defaults, a verificação vai dar PUBLISH_VERIFY_FAILED → ver no ensaio real.
