---
name: qa-landing-2026-10-01
description: QA da landing (5f6c8ee) 2026-10-01: receita de cópia isolada do HEAD quando outros agentes mexem na árvore, achados e armadilhas
metadata:
  type: project
---

Veredito 5f6c8ee: REPROVADO só pela honestidade (demo dizia prazo 24h, real 2h = cancelMinLeadMin default 120); gates todos verdes.

Receita nova (árvore principal em mudança por Vega/Lyra): `git archive <sha> | tar -x -C C:/Projetos/iris-head`, copiar `.env`, `npm ci`, `prisma generate` ali (NÃO regenerar o client da árvore principal). Integração/E2E/build rodam nessa cópia. Motivo: schema.prisma modificado por outro agente regenera o Prisma Client compartilhado e o `innochat_test` não tem a coluna -> 320 falhas falsas ("column cancelAtPeriodEnd does not exist").

Armadilhas:
- Cada chamada Bash é um shell novo: `export TEST_DATABASE_URL` precisa estar no MESMO comando da vitest de integração (senão "DATABASE_URL resolved to an empty string" em 37 arquivos).
- E2E contra porta própria: passar `E2E_BASE_URL` em TODA execução (fallback é 3000 e o login cai no dev server); `AUTH_URL`/`NEXT_PUBLIC_APP_URL` no `next start`. `PlatformSettings.publicBaseUrl` do banco dev é `http://localhost:3700`: o spec cadastro SMTP fake só passa com servidor na 3700.
- `.landing-float` anima o celular: Playwright diz "element is not stable" no botão Rever; usar `click({force:true})`.
- Limpeza no Windows: rmdir falha com node.exe preso; usar script .ps1 (matar node com "iris-head" na linha de comando, NUNCA inline no -Command pois mata o próprio shell) + robocopy /MIR de pasta vazia.
- Fallback sem preços: desativar planos ativos, esperar 61 s, recarregar; restaurar só os ids que estavam ativos (seed: só Clínica ativa).
- Rodar toda a suíte E2E: 218 testes ~7,7 min; "Sino do admin" passou desta vez.
