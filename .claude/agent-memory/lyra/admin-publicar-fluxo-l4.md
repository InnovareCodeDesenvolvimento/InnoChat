---
name: admin-publicar-fluxo-l4
description: Card "Fluxo do bot" no Admin (L-4) — actions injetáveis para pré-visualizar sem n8n, diálogo de confirmação digitada, âncoras, JSON inlinado no build.
metadata:
  type: project
---

`src/components/admin/bot-flow-card.tsx` (`BotFlowCard`, prop opcional `actions` injetável). Inserido em
`admin-configuracoes-client.tsx` antes do card do Google; os cards "n8n" e "Bot no n8n" ganharam `id="n8n-config"` / `id="bot-n8n"` para os links de erro.

- Diálogo de confirmação digitada: `TypedConfirmBody` só monta com o diálogo aberto, então o campo sempre nasce vazio; `open` fica no pai.
- Pré-visualizar sem n8n/banco: `next dev` quebra aqui com `next/font/google` (Turbopack). Usar rota temporária em `(public)` com actions falsas + `next build` + `next start` em `NEXT_DIST_DIR` próprio; apagar tudo depois.
- Playwright de fora do projeto não resolve o módulo (ESM/Windows): o script temporário tem que morar na raiz do repo.
- `pkill` não existe no Git Bash: achar o PID com `netstat -ano | grep :PORTA` e `taskkill //PID x //F //T`.
- `tsc --noEmit` falha com TS6053 por causa de `.next-<outro-agente>/types` no `include` do tsconfig (sujeira de outras instâncias); filtrar `grep -v TS6053` para ver erro real.
- O Turbopack inlina o `n8n/innochat-bot.json` num chunk SSR do standalone (não vira arquivo `.json`): conferir por texto único (`innochat/evolution/:token`).
