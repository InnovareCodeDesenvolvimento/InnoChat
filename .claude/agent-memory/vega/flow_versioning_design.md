---
name: flow-versioning-design
description: Versão do fluxo n8n do bot vem de n8n/flow-versions.json; hash de conteúdo sem flowVersion trava build:flow e teste; armadilhas
metadata:
  type: project
---

Fonte única: `n8n/flow-versions.json` (mais nova primeiro). `build:flow` grava a versão no `Config.flowVersion` e falha se `canonicalContentHash` (hash sem flowVersion, em n8n-flow-hash.ts) não bate com o hash da entrada mais recente. O script carrega o TS do painel via esbuild (stdin + data: URL), sem duplicar regra.

**Why:** hash completo inclui o flowVersion, então usá-lo na trava seria circular; o hash completo continua sendo o do Publicar fluxo (drift). Em prod a lista de espera foi publicada como 2.0.0: o status calcula `onlyVersionLabelDiffers` (conteúdo vivo == build, só o rótulo muda) e publicar funciona sem confirmação.

**How to apply:** mudou fluxo/motor/cola, suba a versão (entrada no topo + hash que o build:flow imprime). Majors: manter 2 (decide catálogo em bot-texts/service.ts).

Armadilhas: `git checkout -- n8n/innochat-bot.json` ao testar a trava desfaz também o bump (rodar build:flow de novo); heredoc bash com muitos heredocs/aspas falhou em silêncio, usar Write; edição multi-linha em arquivo CRLF via script python (edit.py no scratchpad).
