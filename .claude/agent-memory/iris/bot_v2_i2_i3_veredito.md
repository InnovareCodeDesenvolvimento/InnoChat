---
name: bot-v2-i2-i3-veredito
description: I-2/I-3 do bot v2 (2026-09-30): como rodar o E2E contra build de produção com banco/porta próprios, specs novas e armadilhas
metadata:
  type: project
---

Veredito I-3 no HEAD afff735: APROVADO (unit 937, integração 433, E2E 176x2 + instalação 4, simulador v2 59/59, baseline v1 sem regressão).

Receita usada (sem tocar no dev):
- `git worktree` NÃO serve para build: Turbopack recusa `node_modules` como junction ("points out of the filesystem root"). Build na pasta principal com `NEXT_DIST_DIR=.next-iris` (já no .gitignore como `/.next-*/`); apagar com `cmd //c rmdir /s /q "\\?\..."` e `git checkout -- tsconfig.json`.
- Banco próprio: `BOTSIM_DB=innochat_iris_e2e node scripts/bot-sim/create-db.mjs` + `withdb.mjs npx prisma migrate deploy` + `withdb.mjs npm run db:seed`. `seed.mjs` do simulador só aceita nome `innochat_test|botsim` -> `BOTSIM_ALLOW_ANY_DB=1`.
- `playwright.iris.config.ts` temporário na raiz (`...base, webServer: undefined, baseURL` da porta, `outputDir` fora do repo) + `E2E_BASE_URL`. `next start` avisa que `output: standalone` prefere `node .next/standalone/server.js` (o E2E não exercita o standalone).
- Reiniciar o servidor ANTES de cada rodada (rate limit de login em memória; 3 logins por rodada só no global-setup).

Armadilhas achadas:
- Banco recém-semeado: o dono de seed não tem `onboardingTourCompletedAt`; o overlay do tour intercepta cliques (fase2-ui "celular", agendamento-finalizar). Corrigido em `global-setup.ts`.
- `themes.spec.ts` REESCREVE os PNG versionados em `docs/design/screens/qa/` a cada rodada: `git checkout -- docs/design/screens/qa` depois.
- Toast do sino só nasce se o pedido for criado DEPOIS da lista inicial do sino (ela define o `since` do polling): aguardar a resposta da lista antes de criar o HandoffRequest; senão o item entra na lista sem toast (comportamento correto, corrida do teste).
- Áreas admin respondem 404 (não redirect) para quem não é admin da plataforma.
- `python -` / heredoc python no Bash trava neste ambiente; usar `node -e` com `</dev/null`. `sed` com regex contendo `\n` quebra arquivo (usar Edit).
- Variável fora de contexto na tela "Mensagens do bot": a tela bloqueia antes de enviar; a recusa do servidor só é alcançável em integração (`bot-texts-v2.integration.test.ts`).

Specs novas: `bot-v2-configuracoes`, `bot-v2-sino-atendente`, `bot-v2-mensagens`, `bot-v2-admin-fluxo` (n8n falso COM ESTADO: GET/PUT do workflow), `agendamento-finalizar`; helper `setPublishedFlowVersion` em `fixtures/db.ts`.
