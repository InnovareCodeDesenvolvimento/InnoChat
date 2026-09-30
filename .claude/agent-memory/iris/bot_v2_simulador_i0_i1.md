---
name: bot-v2-simulador-i0-i1
description: I-0/I-1 do bot v2 (2026-09-30): como o simulador ficou, o que vale como baseline e as armadilhas de ambiente/edição
metadata:
  type: project
---

`scripts/bot-sim/scenarios-v2.mjs` (+ `-a`, `-b`, `-api`, `v2-kit.mjs`) tem CA-01..47 e API-01..13 escritos contra o plano §3 **antes** do código; vermelho = tarefa ainda não entregue. Cada `check(cond, msg, task)` carrega a tarefa (B-1, B-2, B-3, C-1, W-1) e o resumo agrupa por tarefa (`out/vermelhos-v2.md`).

**Baseline dos 61 cenários da auditoria = 37 verdes / 24 vermelhos** no commit af3f854 (a auditoria original dizia 25; é `baseline-v1.json`, usado pelo CA-45). Identidade conferida antes e depois da I-0.

Áreas frágeis para priorizar quando o v2 entrar: CA-21 (concorrência, dois `Promise.all` no mesmo horário), CA-31/API-11 (release avisa só com a trava da execução que morreu, 1x/10 min), CA-35 (limite só com header `X-InnoChat-Flow: 2`), CA-36 (grade ancorada na meia-noite local), CA-42 (rótulo por meio-dia local em UTC+14), CA-27 (`session.previous` só até 24 h), CA-44 (sessão da v1 lida pelo v2), CA-45 (fluxo v1 + painel novo).

Armadilhas:
- Cenários que criam agendamento devem usar o **primeiro horário livre** do dia (`time:0` / `freeSlot`), nunca um horário fixo, para não colidir entre execuções (EXCLUDE no Postgres).
- O cenário X2 da auditoria grava de propósito `{servico}` em `CHOOSE_DAY`; o CA-45 ignora a seção X2 ao procurar variável literal.
- Prisma Client do checkout compartilhado pode ser de outro schema: o seed e os cenários do v2 usam SQL cru (`sql()`, `setTenant()`) para colunas/enum novos, e `trySetTenant` devolve o motivo em vez de lançar.
- **Edição de arquivo**: `node -e '...'` e heredoc do Bash com `\n`/`\r` dentro de regex ou template quebram (viram quebra de linha real). Use a ferramenta Edit/Write, ou `String.fromCharCode(10)`.
- Remover worktree com `node_modules` de junctions: apagar as junctions com `cmd /c rmdir` antes; `git worktree remove` falha com "Filename too long" (`.next`): usar `rmdir /s /q "\\?\<caminho>"`.
- `JSON.stringify(undefined)` devolve undefined: em mensagem de verificação use o helper `J()` do kit.
- Sem o v2, `BOTSIM_V1_PHRASES=1` roda os cenários contra o v1 só para achar erro de JS nos próprios cenários (não é veredito).
