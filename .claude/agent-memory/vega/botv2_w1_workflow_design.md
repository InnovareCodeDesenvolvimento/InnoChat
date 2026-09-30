---
name: botv2-w1-workflow-design
description: Workflow v2 do bot (n8n/innochat-bot.json): desenho (hub Preparar passo → Ir para), glue/engine injetados pelo build, decisões, furos do motor A-2 e armadilhas do ambiente de teste
metadata:
  type: project
---

W-1 entregue em 2026-09-30 (sem commit; Atlas commita). O JSON tem ~109 nós; foi GERADO por um script de autoria que NÃO está no repositório (ficou no scratchpad da sessão). Daqui em diante o JSON é a fonte: edite os Code nodes nele (fora dos marcadores) e rode `npm run build:flow`.

**Desenho (o que o JSON não explica sozinho):**
- Interpretar (motor) → Switch `Rota` → `Responder passo` (por estado) → um Switch por estado → ramo Code pequeno que devolve `{goto, patch, ctx, prefix}`. TODO desvio passa por `Preparar passo` (junta ctx+patch e monta a query `q`) e pelo Switch `Ir para` (por `goto`). `MENSAGEM`→Montar mensagem, `FALHA`→Falha técnica.
- Ramos NÃO montam texto nem numeram opções: mandam `blocks` com `options` sem `n` (e `titleKey` para rótulos editáveis). `Montar mensagem` numera com `buildOptions` e grava `ctx.options/lastTextKey/lastVars/lastFooter/trail`. É por isso que os Code nodes de ramo não precisam do motor (só a "cola" `@glue`, injetada pelo build script).
- `$('Preparar passo').first()` nos Resultados depende de "última execução do nó" (default do n8n em Code node). Freio anti-laço: `$runIndex > 30` no Preparar passo → FALHA.
- Título de lista trocado (`heading`): SLOT_TAKEN, NO_SLOTS_DAY, DATE_OUT_OF_RANGE, TIME_NOT_AVAILABLE substituem o cabeçalho; ITEM_UNAVAILABLE é PREFIXO (o teste CA-30 exige ITEM_UNAVAILABLE + cabeçalho da lista).
- Profissional específico escolhido é conferido relendo `/catalog/services/{id}/professionals` (verify): a API de dias/horários devolve 200 para profissional desativada, então só a lista revela. Serviço desativado dá 404 nos profissionais.
- DATE_OUT_OF_RANGE usa `lastBookableDate.label` do `/availability/days` (o do claim veio 1 dia diferente: 30/10 vs 29/10).
- Sessão da v1 (sem `ctx.v`) é normalizada no Interpretar (serviceLabel→serviceName etc.); opções v1 `{n,id,label}` o motor já aceita.

- Paginação em memória (serviços, profissionais, agendamentos, limite) = `pageOf` da cola: cabe tudo (<=9) sem paginar; senão 1ª página 8 + Ver mais, do meio 7 + mais + anteriores, última o que sobrar + anteriores. Horários (API): 7 por página; dias: 6 (+ Primeiro livre na 1ª). Decisão do Atlas para horários/dias; para as outras listas segui a spec (até 8) respeitando o teto de 9 keycaps.

**Furo do motor A-2 achado aqui:** `routeFor` devolve FRESH para "oi" mesmo com retomada, mas spec §5.4 H e CA-27 pedem GREETING + RESUME_OFFER para "oi" (só "menu"/"0" descartam). Contornei no Interpretar (override GREETING+resumable→RESUME) sem mexer em `engine/**`; o certo é corrigir `route.ts`.

**Limitação conhecida:** texto digitado só casa com as opções da página visível (serviços/agendamentos paginados 7 por vez), igual à v1. Melhoria possível: guardar as demais em `ctx.hidden` com n=0.

**Ambiente de teste (armadilhas):**
- Cada chamada do Bash tool é um shell novo: `export` não persiste. Use um script (`run-sim.sh`) que exporta BOTSIM_* e chama withdb.
- O simulador precisa de banco/porta/Evolution falsa PRÓPRIOS quando outra Íris/agente roda em paralelo: worktree em HEAD + cópia de scripts/bot-sim (o trabalho da Íris é não commitado), `BOTSIM_DB`, `BOTSIM_EVOLUTION_PORT` (o seed grava a URL da Evolution falsa no banco), `next build --webpack` com junction de node_modules, `NEXT_DIST_DIR`.
- Reseed entre rodadas: CA-19 deixa agendamento da Júlia ocupado e a rodada seguinte falha por isso (dado sujo, não bug).
- Heredoc bash com `'` quebra o comando inteiro: gravar arquivos grandes com Write.
