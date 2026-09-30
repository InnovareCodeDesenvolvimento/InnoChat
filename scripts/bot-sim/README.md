# Simulador do bot (regressão do fluxo de agendamento)

Roda o **JS exato dos Code nodes** de `n8n/innochat-bot.json`, seguindo as conexões do workflow, e chama a
**API interna real** do painel (`/api/internal/v1/*`) contra um Postgres real. A Evolution do **workflow** é falsa: o
`sendText` só captura o texto que o bot enviaria. Serve para reproduzir conversas de WhatsApp de ponta a ponta
sem WhatsApp, sem n8n e sem mexer no banco de desenvolvimento.

| Arquivo | Papel |
|---|---|
| `engine.mjs` | Mini-executor do workflow: expressões `={{ }}`, Switch/IF/Code/HTTP/Wait/SplitOut, `$('Nó').first()`, `$runIndex`, `onError: continueRegularOutput`, operadores `string.notEquals`/`number.gte`, **injeção de falhas**, fluxo de erro (lê a trava do nó `Claim` e chama o release, como o `innochat-erros`) |
| `chat.mjs` | Cliente de WhatsApp falso (payload `messages.upsert` da Evolution: texto, áudio, imagem, figurinha, vazio, `fromMe`) |
| `lib.mjs` | Helpers: `Convo`, `parseOptions` (`1. x` e `1️⃣ x`), `api()`/`api2()` (API interna crua; `api2` já leva `X-InnoChat-Flow: 2`), `db()`, `sql()`/`setTenant()` (SQL cru, independe do Prisma Client conhecer o v2), datas no fuso do tenant |
| `fake-evolution.mjs` | **Evolution falsa do painel** (porta 3901): registra o que o *painel* envia (o `TECH_ERROR` do release, CA-31). O seed grava a URL em `PlatformSettings.evolutionApiUrl` |
| `seed.mjs` | Cria os tenants `botsim-*` (idempotente) e grava `.seed.json` (não versionado) |
| `scenarios.mjs`, `scenarios-r2.mjs` | Os 61 cenários da **auditoria** do bot v1. Cada `check()` descreve o comportamento esperado; falha = bug/regressão |
| `baseline-v1.json` | Veredito dos 61 cenários com o painel do commit `af3f854` e o workflow v1 (37 verdes, 24 vermelhos). É a referência do CA-45 |
| `scenarios-v2.mjs` (+ `-a`, `-b`, `-api`, `v2-kit.mjs`) | Cenários do **bot v2**: `CA-01..CA-47` (spec §10) e `API-01..API-13` (plano §3.4). Resumo dos vermelhos por tarefa |
| `fixtures/innochat-bot.v1.json` | Cópia do workflow v1 (commit `af3f854`) para o CA-44 (gravar uma sessão "como a v1" e lê-la com o v2) |
| `play.mjs` | Conversa manual: `node scripts/bot-sim/play.mjs bela 5511900000001 oi 1 1 "@audio"` |
| `withdb.mjs`, `create-db.mjs` | Apontam `DATABASE_URL` para o banco **dedicado** `innochat_botsim` (derivado do `.env`, nada é impresso) |

## Por que um banco dedicado

`innochat_test` é compartilhado com `npm run test:integration`, que **sobrescreve `PlatformSettings.internalApiSecretHash`**
(o segredo da API interna) a qualquer momento: o simulador tomaria 401 no meio da rodada. Por isso o simulador usa
`innochat_botsim` (`BOTSIM_DB=outro_nome` troca). O `seed.mjs` recusa rodar em banco que não seja `innochat_test`/`innochat_botsim`.

## Como rodar

Pré-requisito: `.env` com `DATABASE_URL` (Postgres local) e o Prisma Client gerado para o schema do commit
(`npx prisma generate`). Rode tudo na raiz do repositório (ou do worktree usado no build).

```bash
# 1. banco dedicado + migrations (uma vez; de novo quando entrarem migrations novas)
node scripts/bot-sim/create-db.mjs
node scripts/bot-sim/withdb.mjs npx prisma migrate deploy

# 2. tenants de teste (rode de novo para "zerar" os agendamentos das rodadas anteriores)
node scripts/bot-sim/withdb.mjs node scripts/bot-sim/seed.mjs

# 3. painel em build de produção na porta 3900 (NÃO use o `next dev` da 3000)
#    `next build` sobrescreve `.next`: se houver `next dev` rodando nesta pasta, faça o build num
#    `git worktree add --detach <pasta> HEAD` (copie o .env para lá e ligue/copie node_modules).
node scripts/bot-sim/withdb.mjs npx next build
node scripts/bot-sim/withdb.mjs npx next start -p 3900

# 4a. auditoria do v1 (61 cenários; grava scripts/bot-sim/out/transcripts.md)
node scripts/bot-sim/withdb.mjs node scripts/bot-sim/scenarios.mjs            # todos
node scripts/bot-sim/withdb.mjs node scripts/bot-sim/scenarios.mjs "^(C1|D5)$" # filtro por id (regex)

# 4b. bot v2 (CA-xx e API-xx; grava out/transcripts-v2.md e out/vermelhos-v2.md)
node scripts/bot-sim/withdb.mjs node scripts/bot-sim/scenarios-v2.mjs
node scripts/bot-sim/withdb.mjs node scripts/bot-sim/scenarios-v2.mjs "^(CA-0[1-9]|API-01)$"
```

Variáveis: `BOTSIM_PANEL` (padrão `http://localhost:3900`), `BOTSIM_WORKFLOW` (JSON do workflow a executar; `scenarios-v2.mjs`
usa `n8n/innochat-bot.json` por padrão, o v2 depois da W-1), `BOTSIM_DB`, `BOTSIM_EVOLUTION_PORT` (padrão 3901),
`BOTSIM_SKIP_CA45=1` (pula o CA-45, que roda os 61 cenários da auditoria de novo com o fluxo v1).
Encerre o `next start` ao terminar (só o seu processo). A Evolution falsa sobe **dentro** do processo dos cenários se a
porta estiver livre (ou use a que já roda: `node scripts/bot-sim/fake-evolution.mjs`).

### `scenarios-v2.mjs`: como ler o resultado

- Escritos contra os contratos do plano (§3) **antes** do código: vermelho = ainda não implementado (ou bug).
- Cada verificação carrega a **tarefa que a deixa verde** (`B-1` agenda/catálogo/agendamentos, `B-2` conversa/atendente/release,
  `B-3` textos por versão, `C-1` migrations, `W-1` workflow + motor). O resumo final agrupa os vermelhos por tarefa e grava
  `out/vermelhos-v2.md`.
- `EXT`: critério coberto fora do simulador (CA-46 = teste unitário com n8n falso da D-1 + ensaio; o sino do CA-26 = E2E da I-2).
- Código de saída: `0` tudo verde · `1` há vermelhos · `2` infraestrutura (painel fora do ar, seed antigo).
- `BOTSIM_V1_PHRASES=1`: modo de fumaça que só serve para exercitar o código dos cenários contra o fluxo v1 (fala outro texto). **Não é veredito.**

### Injeção de falhas (engine)

```js
await chat.say("1", { faults: [
  { urlRe: /availability\/slots/, status: 500 },        // o painel "responde" 500 (o nó HTTP vê a resposta; retryOnFail repete)
  { urlRe: /availability\/slots/, status: "timeout" },  // o nó HTTP estoura o timeout (com onError=continueRegularOutput vira item { error })
  { node: "Montar mensagem", crash: true },              // o nó lança erro: a execução morre e o simulador chama o release como o innochat-erros
] });
```
Opcionais: `method: "GET"`, `times: N`. `result.res.release` traz a resposta do release quando a execução morreu.

Armadilhas encontradas ao montar isto (Windows):
- Turbopack recusa `node_modules` como junction/symlink ("points out of the filesystem root"): use `next build --webpack` nesse caso.
- Se o Prisma Client compartilhado em `node_modules/.prisma` foi gerado por OUTRO branch (coluna que o schema do commit não tem, ex.: `googleAuthEnabled`),
  o seed falha com `P2022`. Gere um client próprio no worktree (`prisma generate` com o `@prisma/client` copiado, não linkado).
- `withdb.mjs` só usa `shell` para comandos que não sejam `node`, então argumentos com `|`/`(` funcionam em `node ... scenarios.mjs "^(A|B)$"`.
- O seed **não** usa colunas do v2 (roda antes e depois da C-1); o que é novo (`maxFutureAppointmentsPerContact`, `MENU_PROMPT`...) os cenários ajustam por SQL cru.
- Migrations do v2 (C-1) precisam ter sido aplicadas em `innochat_botsim` (`withdb.mjs npx prisma migrate deploy`) **e** o painel precisa ter sido
  construído com o Prisma Client do mesmo schema.

## O que o simulador NÃO reproduz

Timeout de 10 s dos nós HTTP (só por falha injetada), credenciais/Header Auth, `Retry on fail` real (só repete 5xx), execução paralela de webhooks
dentro do n8n (a concorrência é testada com `Promise.all`, cada execução com sua trava real no banco), o envio real pela
Evolution (eco `fromMe` do próprio bot, falha de envio) e o relógio (o painel usa `new Date()`: virada de meia-noite é
coberta indiretamente pelos fusos extremos `tokyo`, `honolulu` e `kiribati`, que já estão em "outro dia" em relação ao UTC; os cenários
calculam as datas esperadas a partir do relógio de hoje, então nenhum cenário assume um dia da semana fixo).

## Tenants do seed (`.seed.json`)

Grades em 15 ou 30 (o `CHECK` do v2 recusa 60).

| Tenant | Para quê |
|---|---|
| `bela` | America/Sao_Paulo, grade 30; 13 serviços ativos + 1 inativo; Ana seg-sáb 9-18, Bruno ter-sex 10-16, Carla **sem expediente**, Dani inativa; serviço sem profissional; serviço só da Carla; "Sobrancelha" sem preço |
| `tokyo`, `honolulu`, `kiribati` | +9, -10, +14 (virada de dia; CA-42) |
| `vazio` | sem serviços (NO_SERVICES) |
| `semagenda` | tem serviço, mas o único profissional não tem expediente (NO_SERVICES, CA-37) |
| `solo` | Manaus, grade 15, `askProfessional=false`, 2 profissionais |
| `dupla` | 2 serviços (Corte 1h R$ 50, Barba 30 min sem preço), Ana e Júlia todos os dias 9-18: concorrência, corrigir profissional, remarcar, prazo |
| `grade` | 1 serviço de 45 min, 1 profissional 9-18; o CA-36 troca a grade 30↔15 por SQL |
| `limite` | cliente **fixo** (`contactPhone`) com 3 agendamentos futuros (limite padrão 3) |
| `especial` | serviço "Corte *VIP*_2" e "Corte infantil" (CA-06, CA-40) |
| `equipe` | expediente da equipe gravado na hora pelo cenário (aberto agora / fechado agora: CA-26, API-12) |
| `menuedit`, `menuport` | `MAIN_MENU` legado editado pela empresa (CA-43 grava o `MENU_PROMPT`; CA-47/API-13 rodam a migration de porte sobre este) |
