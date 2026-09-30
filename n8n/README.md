# Workflows n8n do InnoChat

| Arquivo | Workflow | ID no n8n do dono | Estado |
|---|---|---|---|
| `innochat-bot.json` | `innochat-bot` **v2** (`Config.flowVersion = 2.0.0`): chatbot de agendamento (menu numerado, sem IA), com o motor de `src/core/bot/engine/` embutido. É o que o **Publicar fluxo** do Admin sobe | `levHnMSXf1dOR3gS` | **inativo** |
| `legacy/innochat-bot.v1.json` | O `innochat-bot` **v1**, cópia fiel do que estava no repositório antes da v2. Só consulta e diff (o rollback em produção é o snapshot do Publicar fluxo) | — | — |
| `innochat-erros.json` | `innochat-erros`: error workflow do bot, libera a trava da sessão | `GZSwTNgvVt4LYnwW` | **inativo** |
| `innochat-cron.json` | `innochat-cron`: de hora em hora chama `POST /billing/tick` ("Fase 7" em `docs/contratos.md`); diariamente às 03:15 chama `POST /maintenance/tick` (LGPD, "Segurança"). Ambos idempotentes | `dPMhT4MqGglCpFSw` | **inativo** |

Contrato: `docs/arquitetura.md` §6.6/§6.7, `docs/api-interna.openapi.json` e as seções "API interna do bot — Fase 4" e "Fase 4b" em `docs/contratos.md`.
Estes arquivos são o export (`get_workflow_details`) e servem de histórico e diff do fluxo.
Depois de toda alteração no n8n, exporte de novo para cá. **Atenção com o `innochat-bot.json`:** os trechos `/* @engine:begin */…/* @engine:end */` e `/* @glue:begin */…/* @glue:end */` dos Code nodes são gerados por `npm run build:flow` (motor + cola). Ao exportar do n8n, mantenha os marcadores; depois rode `npm run build:flow` e confira com `npm run build:flow -- --check`.

## Importar

1. No n8n: *Workflows → Import from File*. Importe **primeiro** `innochat-erros.json` e depois `innochat-bot.json`.
2. Se o ID do `innochat-erros` mudar na importação, abra *innochat-bot → Settings → Error Workflow* e selecione `innochat-erros`.
3. Preencha os placeholders e as credenciais (abaixo). Só ative os dois workflows quando o painel estiver no ar.

## Placeholders

| Onde | Campo | Valor atual | Preencher com |
|---|---|---|---|
| `innochat-bot` → nó **Config** | `painelUrl` | `https://PAINEL_A_DEFINIR/api/internal/v1` | `https://<painel>/api/internal/v1` |
| `innochat-bot` → nó **Config** | `evolutionUrl` | `https://EVOLUTION_A_DEFINIR` | URL base da Evolution, sem barra no fim |
| `innochat-bot` → nó **Config** | `n8nApiUrl` | `https://N8N_A_DEFINIR/api/v1` | `https://<n8n>/api/v1`. **Hoje nenhum nó do bot lê este campo**: ele existe para a sincronização do painel ter onde escrever |
| `innochat-erros` → nó **Config erros** | `n8nApiUrl` | `https://N8N_A_DEFINIR/api/v1` | `https://<n8n>/api/v1`. **É este que o workflow de erro usa** |
| `innochat-cron` → nó **Config cron** | `painelUrl` | `https://PAINEL_A_DEFINIR/api/internal/v1` | igual ao `painelUrl` do bot |

O fuso não é mais configurado no n8n. O claim devolve `tenant.timezone`, e `/availability/days` é chamado sem `from`, então o painel usa "hoje" no fuso do tenant.

**Contrato com a sincronização painel → n8n (não renomear):**
- Nós `Config` e `Claim` (o `innochat-erros` procura esses dois nomes no runData).
- Campos do `Config`: `painelUrl`, `evolutionUrl`, `n8nApiUrl`, `token`, `event` e `payload`.
- Nomes das três credenciais abaixo.
- No `innochat-cron`: o nó `Config cron`, o campo `painelUrl`, os nós HTTP `Chamar billing/tick` e `Chamar maintenance/tick` e os gatilhos `De hora em hora` e `Diariamente 03:15`. O IF `Manutenção diária?` referencia o nome do gatilho diário.

O campo `token` do nó **Config** **não é segredo**: é o `webhookToken` lido do path da URL (`:token`).
O validador do n8n acusa o nome como "credencial", mas é falso positivo.

## Credenciais (tipo *Header Auth*, criar à mão e selecionar nos nós)

Os nomes abaixo são **exatos**: a sincronização do painel liga as credenciais por eles.

| Nome (exato) | Header | Valor | Workflow | Nós HTTP que usam |
|---|---|---|---|---|
| `InnoChat Painel (Bearer)` | `Authorization` | `Bearer <INTERNAL_API_SECRET>` (gerado no admin da plataforma) | `innochat-bot` | `Claim`, `Registrar conexão`, `Buscar serviços`, `Buscar profissionais`, `Buscar dias`, `Buscar próximos horários`, `Buscar horários`, `Buscar agendamentos`, `Reservar horário`, `Remarcar agendamento`, `Cancelar agendamento`, `Salvar sessão`, `Enviar para sandbox` (13 nós; todos mandam `X-InnoChat-Flow: 2`) |
| `InnoChat Painel (Bearer)` | idem | idem | `innochat-erros` | `Liberar trava` |
| `InnoChat Painel (Bearer)` | idem | idem | `innochat-cron` | `Chamar billing/tick`, `Chamar maintenance/tick`. Vão **sem** `X-InnoChat-Instance`, porque os ticks não são escopados a uma instância |
| `Evolution API (apikey)` | `apikey` | chave da Evolution | `innochat-bot` | `Enviar pela Evolution` |
| `n8n API (X-N8N-API-KEY)` | `X-N8N-API-KEY` | API key do n8n (*Settings → n8n API*) | `innochat-erros` | `Buscar execução com falha` |

São 18 nós HTTP no total: 14 no bot, 2 no workflow de erro e 2 no cron. Todos usam *Authentication: Generic → Header Auth* (`httpHeaderAuth`).

Os workflows foram criados sem credencial nenhuma. Os nós HTTP ficam com a autenticação *Header Auth* selecionada, mas vazia, até alguém escolher a credencial.

## URL do webhook (para o painel)

O nó `Webhook` escuta `POST /webhook/innochat/evolution/:token`. No admin da plataforma, configure
`n8nWebhookBaseUrl = https://<n8n>/webhook/innochat/evolution`, e o painel acrescenta `/<webhookToken>`.
Confira a URL de produção exibida no nó depois de ativar, porque algumas versões do n8n prefixam o `webhookId` em paths dinâmicos.

## Configuração (LGPD)

- `innochat-bot`: não salva execuções bem-sucedidas; salva as com erro; não salva execuções manuais. Timeout de 120 s.
- A retenção de 7 dias das execuções com erro é **da instância**, não do workflow: `EXECUTIONS_DATA_PRUNE=true` e `EXECUTIONS_DATA_MAX_AGE=168`.
- `innochat-erros` também não salva sucesso. Ele busca a execução com falha, que contém telefone e texto, então salvar o sucesso dele vazaria esse dado.

## Mapa dos nós (`innochat-bot`, v2)

O fluxo v2 troca o "Interpretar genérico" por um **motor TypeScript** (`src/core/bot/engine/`, testado no Vitest) que roda dentro de dois Code nodes. As decisões de rota continuam em Switch/IF, visíveis no canvas.

```
Webhook → Config → Filtrar evento ─ conexão ─► Registrar conexão (POST /connection-events)
                                  └ mensagem ─► Claim (POST /messages/claim, X-InnoChat-Flow: 2)
Claim → Roteia claim ─ ignorar ─► Ignorar (claim)
                     ├ ocupado ─► Tentar de novo? ($runIndex < 6) ─► Esperar (retryAfterMs) ─► Claim
                     │                                             └► Desistir (ocupado)
                     └ processar ─► Interpretar (Code, motor) ─► Rota (Switch por $json.route)
Rota:
  MEDIA, CMD_HELP, CMD_CONTINUE, REPROMPT, INVALID_1, AMBIGUOUS ─► Repetir passo (reenvia o prompt atual, com o aviso da rota)
  CMD_MENU, FRESH, INVALID_2 ─► Mostrar menu          CMD_BACK ─► Voltar (trilha)
  CMD_EXIT, CMD_THANKS ─► Encerrar conversa            RESUME ─► Oferecer retomada
  CMD_HUMAN ─► Equipe aberta? ─ aberta ► Pedir atendente (no horário) / fechada ► Pedir atendente (fora do horário)
  STATE ─► Responder passo (Switch por estado) ─► um Switch por estado ("Serviço: opção", "Dia: intenção", "Horário: intenção"...)
                                                   ─► ramo pequeno (Code) que devolve só PARA ONDE IR e o REMENDO do contexto
Ramos que desviam ─► Preparar passo (junta o contexto e monta a consulta) ─► Ir para (Switch por $json.goto)
Ir para:
  SELECT_SERVICE ► Buscar serviços (GET /catalog/services?contactId) ► Resultado serviços
  SELECT_PROFESSIONAL ► Buscar profissionais (GET /catalog/services/{id}/professionals) ► Resultado profissionais
  SELECT_DAY ► Buscar dias (GET /availability/days) ► Resultado dias
  NEXT_SLOTS ► Buscar próximos horários (GET /availability/next) ► Resultado próximos horários
  SELECT_TIME ► Buscar horários (GET /availability/slots) ► Resultado horários
  MY_APPOINTMENTS, LIMIT_REACHED ► Buscar agendamentos (GET /contacts/{id}/appointments) ► Resultado agendamentos
  NAME_OR_CONFIRM ► Já tem nome? ─ sim ► Mostrar confirmação / não ► Pedir nome
  ASK_NAME, CONFIRM, CONFIRM_EDIT, APPOINTMENT_ACTION, POST_ACTION, NO_AVAILABILITY, MAIN_MENU ► Pedir nome / Mostrar … / Mostrar menu
  MENSAGEM ► Montar mensagem        FALHA ► Falha técnica ► Montar mensagem (TECH_ERROR; estado e contexto ficam como estavam)
Todos os "Resultado …" voltam para Preparar passo → Ir para (podem desviar: 404 → ITEM_UNAVAILABLE, 409 → SLOT_TAKEN...).
Escritas: Confirmação: opção ─ Preparar reserva ► Reservar horário (POST /appointments) ► Resultado reserva
                             ├ Preparar remarcação ► Remarcar agendamento (POST /appointments/{id}/reschedule) ► Resultado remarcação
                             └ Corrigir dados / Escolher outra data
          Cancelamento: opção ─ sim ► Preparar cancelamento ► Cancelar agendamento (POST /appointments/{id}/cancel) ► Resultado cancelamento
                              └ não ► Manter agendamento
Montar mensagem → Salvar sessão (PUT /sessions/{id}) → Resultado da gravação
   ─ 200 ► Sandbox? ─ sim ► Enviar para sandbox (POST /sandbox/outbox)
                    └ não ► Preparar envio ► Separar mensagens ► Enviar pela Evolution (sendText, batch 1)
   ─ 409 ► Descartar (LOCK_LOST)   (não envia)
   ─ outro ► Falha ao salvar sessão (erro → innochat-erros libera a trava e o painel avisa o cliente)
```

**Código dentro do fluxo:**
- `Interpretar` e `Montar mensagem` levam o motor entre `/* @engine:begin */` e `/* @engine:end */` (bundle IIFE `InnoEngine`).
- Os outros Code nodes levam uma cola pequena entre `/* @glue:begin */` e `/* @glue:end */` (formatar dia, montar blocos, `go`/`done`).
- **Não edite esses trechos no n8n nem no JSON**: o `Publicar fluxo` acusa a edição manual como *drift*, e o `npm run build:flow` reescreve tudo. O resto de cada nó é escrito à mão e pode ser editado.
- Depois de mexer em `src/core/bot/engine/**` (ou na cola), rode `npm run build:flow`. O CI roda `npm run build:flow -- --check` (o teste `src/modules/bot-flow/workflow-structure.test.ts` faz o mesmo).

**Contrato entre os nós:**
- `Interpretar` devolve `{ route, greet, invalidCount, prefix, fresh, state, kind, optionId, option, date, time, period, name, reason, back, intent, ctx, claim }`. `ctx` já é o contexto v2 (uma sessão gravada pela v1 é normalizada).
- Um ramo que desvia devolve `{ goto, patch, ctx, prefix, ... }`: `patch` é o remendo do contexto (`null` apaga a chave). `Preparar passo` devolve o mesmo com `ctx` novo e `q` (a consulta).
- Um ramo final devolve `{ nextState, context, blocks, invalidCount, handoff, handoffReason }` e vai para `Montar mensagem`.
- `blocks` são `{ key, vars, options, trailing, hasMore, hasPrev, moreKey, footer }`: o ramo **não monta texto**. `Montar mensagem` numera as opções (1..9), renderiza com `renderMessage` do motor e grava `context.options`, `lastTextKey`, `lastVars`, `lastFooter` e `trail`.
- Paginação: horários 7 por página; dias "Primeiro horário livre" + 6 (+ "Ver mais"); serviços e agendamentos 7; profissionais 6; limite atingido 6 + atendente. Máximo de 9 opções por mensagem.

**Remarcar:** reaproveita `SELECT_DAY → SELECT_TIME → CONFIRM` com `context.mode = RESCHEDULE`, sem perguntar o nome e sem trocar serviço nem profissional. O resumo usa `CONFIRM_RESCHEDULE` ("De" riscado). 409 `SLOT_TAKEN` oferece as alternativas do dia; outro 409 (`TOO_LATE`) mostra o texto com atendente/voltar.

**Falhas do painel:** todo nó de consulta/escrita usa resposta completa + *Never error* e `onError: continueRegularOutput` (timeout vira item `{ error }`). O "Resultado …" classifica: 404 → `ITEM_UNAVAILABLE` e refaz a lista; 5xx, timeout ou 403 → **Falha técnica** (`TECH_ERROR`, sessão salva como estava).

**Voltar ao v1:** `n8n/legacy/innochat-bot.v1.json` é o fluxo anterior, para consulta. O caminho de volta em produção é o "Voltar à versão anterior" do Admin → Configurações → Fluxo do bot (snapshot).

## `innochat-cron`

```
De hora em hora (minuto 5) ─┐
Diariamente 03:15 ──────────┴► Config cron ► Manutenção diária? ($('Diariamente 03:15').isExecuted)
  ─ sim ► Chamar maintenance/tick (POST /maintenance/tick, LGPD) ► Resultado da manutenção
            ─ 2xx ► Manutenção ok
            ├ 5xx ► Tentar de novo? (manutenção 5xx) ($runIndex < 2) ─ sim ► Esperar (manutenção 5xx) 5 s ► Chamar maintenance/tick
            │                                                         └ não ► Falha na manutenção
            └ outro (4xx) ► Falha na manutenção
  ─ não ► Chamar billing/tick (POST /billing/tick) ► Resultado do tick
            ─ 2xx ► Tick ok
            ├ 5xx ► Tentar de novo? (5xx) ($runIndex < 2) ─ sim ► Esperar (5xx) 5 s ► Chamar billing/tick
            │                                             └ não ► Falha no tick
            └ outro (4xx) ► Falha no tick
```

- Os dois gatilhos reaproveitam o **mesmo** nó `Config cron`, com um só `painelUrl` escrito pela sincronização. Os dois nós HTTP (`Chamar billing/tick` e `Chamar maintenance/tick`) usam a credencial `InnoChat Painel (Bearer)`, **sem** `X-InnoChat-Instance`.
- `maintenance/tick` purga `InboundEvent` com mais de 30 dias e anonimiza os contatos de tenants cancelados há mais de 90 dias, em lotes de 500 ("Segurança" em `docs/contratos.md`). A resposta é `{ inboundEventsPurged, contactsAnonymized }`.
- As duas chamadas são idempotentes. Timeout e falha de rede são re-tentados pelo *Retry on fail* do próprio nó (3×). Um 5xx tem mais 2 tentativas pelo laço, e um 4xx falha direto. Timeout de 60 s por chamada e de 300 s por execução.
- Settings: não salva sucesso, salva erro, e o `errorWorkflow` aponta para o `innochat-erros`.
  - Isso não quebra a extração de trava: sem nó `Claim` na execução, `Extrair trava` devolve `[]` e o workflow de erro termina sem chamar `release`.
  - Efeito colateral: a cada falha do cron, o workflow de erro faz uma chamada à API do n8n à toa.

## Política de retry

- `Claim` e os GETs do painel (`Buscar …`): *Retry on fail* (2× no v2), cobrindo 5xx e timeout. Se ainda assim falhar, o "Resultado …" manda para a **Falha técnica**.
- Escritas (`Salvar sessão`, `Registrar conexão`, `Reservar horário`, `Remarcar agendamento`, `Cancelar agendamento`, `Enviar para sandbox`): sem retry, *Never error* + resposta completa. **409 nunca é re-tentado.** Um 5xx numa reserva/remarcação/cancelamento vira **Falha técnica** (a reserva é idempotente pela chave do evento e pelo trio contato+serviço+início). Falha ao salvar a sessão lança erro: o `innochat-erros` libera a trava e o painel avisa o cliente (`TECH_ERROR`).
- Envio pela Evolution: sem retry, porque o envio não é idempotente.
