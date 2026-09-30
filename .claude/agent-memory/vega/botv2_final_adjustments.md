---
name: botv2-final-adjustments
description: Ajustes finais do bot v2 (2026-09-30): falso alarme do claim v1, now() do Postgres em coluna sem fuso, ReDoS do normalizeText, redação de segredos do snapshot, reseed do simulador
metadata:
  type: project
---

**Falso alarme "claim sem header devolve flow=2":** o painel estava certo. O cenário do simulador (`scenarios-v2-api.mjs`) chamava `claim(..., { flow: undefined })` e o helper tinha `{ flow = 2 }` — em JS, `undefined` dispara o VALOR PADRÃO, então o header nunca deixava de ir. Para "sem header" use `flow: null`. Lição: quando o simulador acusa o painel de ignorar um header, confira o helper antes de mexer no painel. Congelei o formato v1 em `tests/integration/bot-api-claim-v1-freeze.integration.test.ts`.

**`now()` do Postgres em coluna `timestamp` sem fuso (Prisma DateTime) grava hora LOCAL da sessão do banco**, não UTC. No banco desta máquina isso deslocava 3h (idleMin 220 em vez de 40). SQL cru de cenário deve usar `(now() at time zone 'utc')`. Era erro do cenário, não da API.

**ReDoS:** `/[.,!?;:\s]+$/` no `normalizeText` era quadrático (60 mil "!" + "a" = 4,5 s). Regex com `+$` sobre entrada do cliente é armadilha: use laço linear e corte a entrada (`capInput`, 4000). Teste de tempo < 50 ms em `parse-input.test.ts`.

**Redação de segredos (I4):** `redactFlowSecrets` (n8n-flow-hash.ts). Só redigir no que vai ao BANCO (`forStorage`) e ao download; o snapshot em memória continua íntegro porque `restore` (publish com verificação falha) o reescreve no n8n. Hash do snapshot armazenado é recalculado sobre os nós redigidos (rollback verifica contra o hash dos nós). Regex de header em texto exige aspas para não redigir a nota (sticky) "Authorization = Bearer <…>".

**Reseed:** `scenarios-v2.mjs` roda `seed.mjs` (spawn) ANTES de importar `v2-kit.mjs` (que lê `.seed.json` no import → imports dinâmicos). `BOTSIM_NO_RESEED=1` pula.

**Edição de JSON do n8n por script:** o arquivo tem `\n` escapado dentro de strings; python heredoc com `\\n`/`\'` se confunde. Achar posições com `str.find` em marcadores simples e cortar por índice; validar com `json.loads` e `build:flow --check`.
