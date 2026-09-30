# Bot de agendamento v2: especificação

> Autora: Nova (arquitetura) · v1 em 2026-09-30 (missão `cmuo1mm0m053t01lfk25viaap`) ·
> **v2 do documento em 2026-09-30 (missão `cmuo2slkk059d01lf61dnj90z`)**: incorpora a auditoria
> da Íris (`docs/qa/auditoria-bot-2026-09-30.md`), as decisões do dono (§12.4) e retira o modo
> interativo.
> Status: **aprovada pelo dono nos pontos P1–P5; pronta para construção.** O plano executável,
> com tarefas, arquivos exclusivos e contratos exatos, está em **`docs/bot-v2-plano.md`**.
> Nenhum código de produto foi alterado.

---

## 0. Contexto, hipóteses e o que não se reabre

**Decisões do dono que continuam valendo:**
- menu guiado, sem IA;
- o **roteamento** do menu fica nos nós do n8n e pode ser editado visualmente (Switch/IF/HTTP);
- a reserva é atômica no painel (`EXCLUDE` no Postgres);
- os textos são editáveis em "Mensagens do bot" (`BotText`);
- **só texto numerado** (P1, teste real de 2026-09-30: botões somem, lista dá 400 na Evolution 2.3.7).

**Hipóteses declaradas:**

| Tema | Hipótese | Efeito no desenho |
|---|---|---|
| Escala | Dezenas de empresas, até ~1.000 conversas/dia no total, um n8n e uma Evolution | Sem fila nem worker novo. O gargalo continua sendo a trava (lease) por contato |
| Maturidade | Produto em produção inicial (v1 no ar) | Toda mudança de API é **aditiva**. O fluxo v1 continua funcionando com o painel novo até o "Publicar fluxo" |
| Equipe | Cronos, Vega (4 frentes), Lyra, Íris, Órion em paralelo | Plano com arquivos exclusivos por tarefa (`docs/bot-v2-plano.md`) |

**Mudança de desenho em relação à v1 deste documento (e por quê):**

1. **O motor de interpretação e de renderização é TypeScript puro, testado, compilado para dentro
   dos Code nodes.** A primeira versão desta spec punha a leitura de datas e horas no painel
   (`hints` no claim), para tirar lógica frágil dos Code nodes sem teste. Com o motor em
   `src/core/bot/engine/` (sem dependências, testes de tabela no Vitest) e um script que injeta o
   *bundle* nos nós `Interpretar` e `Montar mensagem`, o mesmo código roda no CI, no simulador e
   no n8n. O claim fica menor (não precisa de `hints`) e o n8n continua decidindo sem uma chamada
   HTTP a mais. **As transições entre estados continuam visíveis no canvas** (Switch por estado e
   por opção), o que respeita a decisão do dono.
2. **Sem modo interativo.** Saem `optionId`, `promptSeq`, `STALE_BUTTON`, `LABEL_OPEN_LIST`,
   `Tenant.botInteractive`, `PlatformSettings.botInteractiveMode` e o tipo `OutMessage`. Resta uma
   nota de futuro (§6).
3. **A grade de horários reaproveita `Tenant.slotGranularityMin`**, que já é exatamente o passo
   da grade (hoje com padrão 15 e sem tela). Criar um `slotStepMinutes` ao lado deixaria dois
   campos com o mesmo significado. O campo passa a aceitar só 15 ou 30, com padrão 30, e a grade
   passa a ser ancorada no relógio (§3.5).

**Princípio que atravessa o documento:** o painel guarda as garantias e os dados (trava, reserva,
limite, prazo, pausa humana, textos, rótulos formatados no fuso) e **não decide o próximo passo**.
O n8n decide o passo. O motor puro só traduz "o que o cliente escreveu" em uma intenção e
"o que mostrar" em texto.

---

## 1. Diagnóstico da v1 (o que motiva a v2)

Leitura de código da Nova (D1–D16). A auditoria executada da Íris está na §11 e é a referência de
aceite.

| # | Problema |
|---|---|
| D1 | 3 respostas inválidas → `HUMAN` e **silêncio de 12 h** |
| D2 | Em `ASK_NAME`, "voltar", "ajuda", "atendente" viram **nome** |
| D3 | Nome inválido responde "Não entendi essa opção" |
| D4 | Sem "voltar", "ajuda" ou "atendente" como comando global |
| D5 | Casamento de texto compara com o rótulo **com preço** |
| D6 | Datas e horas digitadas não são entendidas |
| D7 | Confirmação só permite "Escolher outro horário" |
| D8 | Depois de confirmar, não oferece "agendar outro" |
| D9 | Paginação dá a volta sem avisar |
| D10 | Duração do serviço não aparece |
| D11 | Prazo mínimo só é descoberto depois de tentar |
| D12 | Handoff não diz quando o bot volta |
| D13 | Falha de HTTP deixa o cliente sem resposta |
| D14 | Sessão expirada descarta o agendamento pela metade |
| D15 | "obrigada", "ok", 👍 depois de agendar contam como inválidos |
| D16 | "Sincronizar n8n" reenvia o workflow que já está no n8n, não o do repositório |

---

## 2. Máquina de estados v2

### 2.1 Estados

Os nomes da v1 são **mantidos** (sessões em andamento continuam válidas na troca, §9). **(novo)**
marca estado novo.

| Estado | O que mostra | Saídas |
|---|---|---|
| `MAIN_MENU` | Saudação (1ª vez) + `MENU_PROMPT` + 3 opções | Agendar → `SELECT_SERVICE` (ou `LIMIT_REACHED`) · Meus agendamentos → `MY_APPOINTMENTS` · Falar com atendente → handoff |
| `RESUME_OFFER` **(novo)** | "Você estava agendando X. Continuar?" | Continuar → reentra no estado salvo · Começar de novo → `MAIN_MENU` |
| `SELECT_SERVICE` | Serviços agendáveis com duração e preço | → `SELECT_PROFESSIONAL` (ou `SELECT_DAY` se pulado) |
| `LIMIT_REACHED` **(novo)** | Cliente já tem o máximo de agendamentos futuros: lista os agendamentos + "Falar com atendente" | agendamento → `APPOINTMENT_ACTION` · atendente → handoff |
| `SELECT_PROFESSIONAL` | "Qualquer profissional" + profissionais **com expediente** | → `SELECT_DAY` |
| `SELECT_DAY` | "Primeiro horário livre" + até 7 dias com vaga + "Ver mais datas" / "Ver anteriores" | dia → `SELECT_TIME` · primeiro livre → `NEXT_SLOTS` · data digitada → `SELECT_TIME` do dia (ou sugestão) |
| `NEXT_SLOTS` **(novo)** | Próximos 6 horários livres em qualquer dia + "Escolher por dia" | horário → `ASK_NAME` ou `CONFIRM` · por dia → `SELECT_DAY` |
| `SELECT_TIME` | Até 8 horários + "Mais horários" / "Ver anteriores" | → `ASK_NAME` (sem nome) ou `CONFIRM` |
| `ASK_NAME` | Pede o nome (só se `contact.name` vazio, ou vindo de "corrigir nome") | → `CONFIRM`. **O nome só é gravado na reserva** (§3.7) |
| `CONFIRM` | Resumo + Confirmar / Corrigir dados | Confirmar → reserva → `POST_ACTION` · Corrigir → `CONFIRM_EDIT` |
| `CONFIRM_EDIT` **(novo)** | Serviço / Profissional / Data e horário / Nome | reentra no passo (§2.6) |
| `POST_ACTION` **(novo)** | "Posso ajudar em algo mais?" | Agendar outro · Meus agendamentos · Encerrar |
| `MY_APPOINTMENTS` | Próximos agendamentos (1 só → detalhe direto) | → `APPOINTMENT_ACTION` |
| `APPOINTMENT_ACTION` | Detalhe + Remarcar / Cancelar / Voltar. Dentro do prazo mínimo: `APPOINTMENT_LOCKED` + atendente / voltar | Remarcar → `SELECT_DAY` (`mode=RESCHEDULE`) · Cancelar → `CONFIRM_CANCEL` |
| `CONFIRM_CANCEL` | Sim, cancelar / Não, manter | Sim → cancela → `POST_ACTION` · Não → `CANCEL_KEPT` + `POST_ACTION` |
| `NO_AVAILABILITY` **(novo)** | Nada livre no horizonte do serviço (ou nenhum serviço agendável: `NO_SERVICES`) | atendente → handoff · Outro serviço → `SELECT_SERVICE` |
| `HUMAN` | Controlado pelo painel (§3.10) | "menu" do cliente ou fim da pausa → `MAIN_MENU` |

Encerrar a conversa = `MAIN_MENU` com `context = {}`. A próxima mensagem recebe a saudação.

### 2.2 Diagrama

```
                     ┌──────────── comandos globais (qualquer estado, §2.3) ────────────┐
                     │ menu/0 → MAIN_MENU · voltar → trail.pop() · ajuda → HELP + prompt │
                     │ atendente → handoff · sair → GOODBYE · oi → CONTINUE + prompt    │
                     └──────────────────────────────────────────────────────────────────┘
 claim(expired + previous) ─► RESUME_OFFER ─continuar─► (estado salvo, revalidado)
                                   └─começar de novo─► MAIN_MENU
 MAIN_MENU ─1─► [limite?] ─sim─► LIMIT_REACHED ─► APPOINTMENT_ACTION | handoff
     │              └─não─► SELECT_SERVICE ─► SELECT_PROFESSIONAL* ─► SELECT_DAY ─dia─► SELECT_TIME ─┐
     │                          ▲ (vazio)                                │ └primeiro livre► NEXT_SLOTS ┤
     │                     NO_AVAILABILITY ─atendente─► handoff          └data digitada► SELECT_TIME   │
     │                                                  ASK_NAME** ◄─────────────────────────────────┤
     │                     CONFIRM_EDIT ◄──corrigir── CONFIRM ◄──────────────────────────────────────┘
     │                                                  │confirmar
     │                                  POST /appointments (+contactName) ─201/200─► POST_ACTION
     │                                        ├─409 SLOT_TAKEN─► SELECT_TIME (alternativas, com a data)
     │                                        └─422 LIMIT_REACHED─► LIMIT_REACHED
     ├─2─► MY_APPOINTMENTS ─► APPOINTMENT_ACTION ─remarcar─► SELECT_DAY(RESCHEDULE) … CONFIRM ─► …/reschedule ─► POST_ACTION
     │                               ├─cancelar─► CONFIRM_CANCEL ─sim─► …/cancel ─► POST_ACTION
     │                               └─(dentro do prazo) ─► APPOINTMENT_LOCKED ─► handoff | voltar
     └─3─► handoff ─► HUMAN ─(cliente manda "menu" | 2 h sem resposta da equipe)─► MAIN_MENU
```
\* Pulado se o serviço tem 1 profissional com expediente ou `askProfessional=false`.
\*\* Só se `contact.name` vazio, ou por "corrigir nome".

### 2.3 Comandos globais

Valem em **qualquer** estado, incluindo `ASK_NAME`, e são avaliados **antes** do casamento com
as opções. O casamento exige a **mensagem inteira** normalizada (§2.4.2): "quero voltar amanhã"
não dispara "voltar".

| Comando | Sinônimos | Efeito | Conta como inválido? |
|---|---|---|---|
| **menu** | `menu`, `0`, `0️⃣`, `inicio`, `comecar`, `recomecar`, `menu principal` | `MAIN_MENU`, contexto zerado | não |
| **voltar** | `voltar`, `volta`, `anterior`, `retornar`, `#` | Reentra no estado anterior de `context.trail` (§2.5) | não |
| **sair** | `sair`, `encerrar`, `finalizar`, `tchau`, `fim` | `GOODBYE`, sessão encerrada | não |
| **atendente** | `atendente`, `humano`, `pessoa`, `equipe`, `suporte`, `falar com atendente`, `falar com alguem` | Handoff (§3.10) | não |
| **ajuda** | `ajuda`, `help`, `?`, `comandos`, `opcoes` | `HELP` + prompt atual, estado mantido | não |
| **saudação** | `oi`, `ola`, `bom dia`, `boa tarde`, `boa noite`, `e ai` | Em `MAIN_MENU`: menu. Em outro estado: `CONTINUE_PROMPT` + prompt atual | não |
| **cortesia** | `obrigado`, `obrigada`, `valeu`, `ok`, `blz`, `beleza`, `👍`, `🙏` | Em `POST_ACTION`/`MAIN_MENU`: `THANKS_REPLY` e encerra. Em outro estado: reenvia o prompt | não |

`0` é "menu" em todo lugar; número de opção nunca é `0`.

### 2.4 Entrada do cliente

#### 2.4.1 Ordem de avaliação (função `interpret` do motor, §7.2)

A primeira regra que casar vence:

1. Mídia (`message.type = media`) → `ONLY_TEXT` + prompt atual (não conta como inválido).
2. Sessão nova, expirada ou retomada do humano (§2.7, §3.10):
   - mensagem é `menu` ou `0` → saudação + menu, **sem** o texto "recomecei" (e descarta a retomada);
   - há `session.previous` retomável (inclusive para "oi"/saudação, CA-27) → saudação + `RESUME_OFFER`;
   - saudação sem retomada → saudação + menu;
   - senão, **a mensagem é avaliada contra o `MAIN_MENU`** (corrige BUG-13): "2", "meus
     agendamentos", "cancelar", "remarcar" levam direto a `MY_APPOINTMENTS`; "agendar",
     "marcar" levam a `SELECT_SERVICE`; nada casou → saudação + menu (sem contar inválido).
3. Comandos de navegação (menu, voltar, sair, atendente, ajuda, saudação).
4. **Aliases do estado atual** (tabela abaixo). Vêm antes da cortesia: "ok" em `CONFIRM` confirma.
5. Cortesia.
6. Estado `ASK_NAME` → validação de nome (§3.1). Inválido → `NAME_INVALID` ou `NAME_TOO_LONG`
   e conta como inválido.
7. Número (`2`, `2️⃣`, `2.`, `2)`, `#2`, `opção 2`, `nº 2`, ` 02 `) → opção `n`.
8. Datas e horas, conforme o estado:
   - `SELECT_DAY`/`NEXT_SLOTS` com data → horários daquele dia; com data + hora ("amanhã 15h")
     → busca pelo horário mais próximo naquele dia;
   - `SELECT_TIME` com hora → horário exato ou os 3 mais próximos (`TIME_NOT_AVAILABLE`);
     com período ("tarde") → filtra; com data → troca o dia.
9. Texto contra as opções (`match` + `aliases`, normalizados): igual → escolhe; todas as palavras
   digitadas contidas em **uma** opção → escolhe; mais de uma → `AMBIGUOUS_OPTION` com só as
   candidatas renumeradas (não conta como inválido).
10. Nada casou → inválido (§2.4.3).

**Aliases dos menus estáticos** (parte do motor, não do texto editável; ids fixos do contrato §7.2):

| Estado | Opção (id) | Aliases |
|---|---|---|
| `MAIN_MENU` | `BOOK` | `agendar`, `marcar`, `agendamento`, `horario`, `reservar`, `quero agendar`, `quero marcar` |
| | `MY` | `meus`, `meus agendamentos`, `ver`, `consultar`, `remarcar`, `cancelar`, `desmarcar` |
| | `HUMAN` | os de "atendente" |
| `CONFIRM` | `CONFIRM` | `sim`, `s`, `confirmar`, `confirmo`, `pode`, `pode ser`, `ok`, `isso`, `certo`, `👍`, `✅`, `👌` (qualquer tom de pele) |
| | `EDIT` | `corrigir`, `alterar`, `mudar`, `trocar`, `nao`, `n`, `❌` |
| `CONFIRM_CANCEL` | `YES` / `NO` | `sim`, `s`, `cancelar`, `pode cancelar`, `👍`, `✅` / `nao`, `n`, `manter`, `❌` |
| `RESUME_OFFER` | `CONTINUE` / `RESTART` | `continuar`, `sim`, `s`, `👍` / `recomecar`, `nao`, `n`, `novo` |
| `APPOINTMENT_ACTION` | `RESCHEDULE` / `CANCEL` | `remarcar`, `mudar`, `trocar` / `cancelar`, `desmarcar` |
| `POST_ACTION` | `BOOK` / `MY` / `FINISH` | `agendar outro`, `outro`, `agendar` / `meus agendamentos`, `meus` / `encerrar`, `nao`, `n` |
| paginação | `MORE` / `PREV` | `mais`, `ver mais`, `proximos` / `anteriores`, `ver anteriores` |

#### 2.4.2 Normalização (motor)

Minúsculas; sem acento (NFD); espaços colapsados; pontuação final `.,!?;:` removida; keycaps
`0️⃣`–`9️⃣` viram dígitos; modificadores de tom de pele (U+1F3FB–U+1F3FF) e seletores de variação
(U+FE0F) removidos. Emojis de sim/não são reconhecidos **antes** de remover símbolos.

#### 2.4.3 Entrada inválida: no máximo 2 tentativas (decisão P5)

- **1ª inválida** (`invalidCount` → 1): `INVALID_OPTION` + prompt atual, estado mantido.
- **2ª seguida** (`invalidCount` → 2): `INVALID_BACK_TO_MENU` + menu principal, `invalidCount` = 0.
- **Nunca** há handoff automático (corrige D1/BUG-02).
- Entrada válida, comando ou cortesia zera o `invalidCount`. Mídia e `AMBIGUOUS_OPTION` não contam.

### 2.5 "Voltar": trilha (`context.trail`)

Ao **entrar** num estado, o fluxo empilha o nome dele em `context.trail` (máximo 12, sem repetir o
topo). "voltar" desempilha e reentra no anterior, **buscando as opções de novo**. Trilha vazia →
`MAIN_MENU`. Ao voltar, as escolhas abaixo do estado reentrado são descartadas (voltar para
`SELECT_DAY` limpa `startsAt`). Funções puras do motor: `pushTrail`, `popTrail`, `clearBelow`.

### 2.6 Corrigir itens na confirmação

| Item | Reentra em | Mantém | Volta para `CONFIRM` quando |
|---|---|---|---|
| Serviço | `SELECT_SERVICE` | nome | Refaz profissional, dia e hora; ao escolher o horário, volta ao `CONFIRM` |
| Profissional (oculto se só 1) | `SELECT_PROFESSIONAL` | serviço, dia, hora | Mesmo `startsAt` livre com o novo profissional (`GET /availability/slots?date&near=`, `exact=true`) → **direto** ao `CONFIRM`. Senão, `SELECT_TIME` do mesmo dia com `SLOT_TAKEN`, ou `SELECT_DAY` se o dia lotou |
| Data e horário | `SELECT_DAY` | serviço, profissional | ao escolher o horário |
| Nome | `ASK_NAME` (`ctx.editing="name"`) | tudo | ao digitar um nome válido (fica em `ctx.name`, gravado na reserva) |

`ctx.returnTo = "CONFIRM"` marca a correção.

### 2.7 Expiração e retomada

- **Expiração:** no claim (`sessionTimeoutMin`, padrão 30).
- **Claim v2:** ao expirar, se a última atividade tiver até **24 h** (`RESUME_WINDOW_MIN = 1440`),
  devolve `session.previous = { state, context, idleMin }` além do contexto zerado. O painel não
  interpreta o conteúdo e não guarda nada novo: `previous` sai da própria linha antes do reset.
- **O n8n decide:** `previous.state` ∈ {`SELECT_PROFESSIONAL`, `SELECT_DAY`, `NEXT_SLOTS`,
  `SELECT_TIME`, `ASK_NAME`, `CONFIRM`, `CONFIRM_EDIT`} e `previous.context.serviceId` existe →
  `RESUME_OFFER`, guardando `previous` em `context.resume`. Senão → regra 2 da §2.4.1.
- **Continuar** reentra com as escolhas salvas, **revalidando**: `startsAt` ocupado → `SELECT_TIME`
  do dia com `SLOT_TAKEN`; dia lotado → `SELECT_DAY` com `NO_SLOTS_DAY`; serviço inativo (404) →
  `ITEM_UNAVAILABLE` + `SELECT_SERVICE`.
- **Retomada leve** (sem expirar): saudação no meio do fluxo → `CONTINUE_PROMPT` + prompt atual.
- Depois de `HUMAN`, a sessão recomeça do zero, sem oferta de retomada.

---

## 3. Fluxo completo: regras de cada caminho

### 3.1 Saudação e nome
- A saudação usa `{nome}` = `contact.firstName` do claim: o **primeiro nome** de `contact.name`,
  senão de `pushName`, **só se tiver pelo menos 2 letras** (`\p{L}`); senão vazio. Com vazio, o
  renderizador limpa a pontuação ("Olá, !" vira "Olá!") (corrige BUG-10).
- O nome é pedido **uma vez**, só se `contact.name` estiver vazio, e só no momento de reservar. O
  `pushName` **não** é gravado como nome.
- **Validação** (`validateName`, motor, usada também pelo painel): depois de remover controles,
  `<`, `>`, espaços duplicados e aparar: 2 a 60 caracteres, pelo menos 2 letras, sem ser só
  número, sem `@` ou URL, sem ser **palavra reservada** (comandos globais, aliases, cortesia,
  "sim", "não", "cancelar"...). Mais de 60 → `NAME_TOO_LONG`. Outros → `NAME_INVALID`
  (corrige BUG-03 e BUG-17).
- O nome vai para o painel **junto da reserva** (`contactName` no `POST /appointments`), nunca
  antes. Desistir no meio não grava lixo em `Contact.name`.

### 3.2 Serviço: preço, duração e só o que é agendável
- `GET /catalog/services` só devolve serviços com **pelo menos 1 profissional ativo com
  expediente** (corrige BUG-09). Cada opção ganha `name`, `durationLabel` ("1h", "40 min",
  "1h30") e `priceLabel` (ou `null`); `label` da v1 continua igual.
- Renderização: `1️⃣ Corte feminino — _1h · R$ 80,00_`. Sem preço: `— _1h_`.
- Nenhum serviço agendável → `NO_SERVICES` + atendente.
- Serviço único → pula `SELECT_SERVICE` e mostra o nome no cabeçalho seguinte.

### 3.3 Profissional: "qualquer um"
- Só profissionais ativos **com expediente** (`WorkingHour`) aparecem (corrige BUG-09).
- `Qualquer profissional — _primeiro horário livre_` é a 1ª opção quando há 2 ou mais.
- No `CONFIRM`, aparece como "Primeiro disponível". `BOOKED` mostra o **nome real** atribuído.

### 3.4 Dia
- Opções: `Primeiro horário livre`, até 7 dias com vaga, `Ver mais datas` (se houver) e
  `Ver anteriores` (a partir da 2ª página). Numeração **sempre de 1 em diante, sem pular**.
- Rótulo relativo: `Hoje · Qua 30/09`, `Amanhã · Qui 01/10`, `Sex 02/10` (`relativeLabel`).
- `nextFrom` da página seguinte é o dia **depois** do último mostrado (corrige BUG-05).
- Data digitada: com vaga → horários do dia; fechado ou lotado → `NO_SLOTS_DAY` com `{proximo}` e
  a lista de dias **a partir do próximo dia livre** (corrige BUG-14); passado ou além do horizonte
  → `DATE_OUT_OF_RANGE` com `{data}` = último dia permitido.
- Nenhum dia no horizonte → `NO_AVAILABILITY`.

### 3.5 Horário e grade
- **Grade redonda (decisão do dono):** `Tenant.slotGranularityMin` ∈ {15, 30}, padrão 30. Os
  candidatos são os múltiplos do passo **contados a partir da meia-noite local** (09:00, 09:30…),
  dentro das janelas livres. Um serviço de 45 min às 09:00 deixa livres 10:00, 10:30…, nunca
  09:45 ou 10:15 (corrige BUG-16). A regra vale para o painel e para o bot (é regra de agenda, em
  `src/core/agenda`).
- Até 8 horários + `Mais horários` / `Ver anteriores`; numeração recomeça em 1 em cada página;
  sem volta cíclica (corrige D9/BUG-06).
- Horário digitado: exato → segue; inexistente → `TIME_NOT_AVAILABLE` com os 3 mais próximos.
- Período: `manha` < 12h, `tarde` 12h–18h, `noite` ≥ 18h.

### 3.6 Primeiro horário livre (`NEXT_SLOTS`)
- `GET /availability/next` devolve os 6 próximos horários em qualquer dia (`Hoje · 16:30`).
- Opções: 6 horários + `Escolher por dia`.

### 3.7 Confirmação, reserva, limite e "agendar outro"
- `CONFIRM_SUMMARY` mostra serviço, profissional, data longa, hora, duração, valor e nome.
- Opções: `Confirmar` / `Corrigir dados`.
- `POST /appointments` leva `contactName` quando o nome foi digitado nesta conversa.
- Resultado:
  - **201/200** → `BOOKED` + `POST_ACTION` na **mesma mensagem**;
  - **409 `SLOT_TAKEN`** → `SLOT_TAKEN` com `{data}` do dia das alternativas (corrige BUG-07);
  - **422 `LIMIT_REACHED`** → `LIMIT_REACHED` (a garantia; o fluxo normalmente barra antes);
  - **422 `RULE_VIOLATION`** → `DATE_OUT_OF_RANGE` ou `NO_SLOTS_DAY`;
  - **403 `PLAN_BLOCKED`**, 5xx, timeout → `TECH_ERROR`.
- **Limite de agendamentos futuros (decisão do dono):** `Tenant.maxFutureAppointmentsPerContact`,
  padrão 3 (`0` = sem limite). Conta os `SCHEDULED` com `startsAt > agora` do contato. O fluxo
  consulta **antes** do funil (`GET /catalog/services?contactId=` devolve `limit.reached`) e mostra
  `LIMIT_REACHED` com os agendamentos existentes e "Falar com atendente". O painel **garante** na
  reserva (422, contagem sob `SELECT … FOR UPDATE` do contato). Vale só para reservas pelo
  WhatsApp; a equipe no painel não é barrada. Remarcar não conta.
- "Agendar outro" reaproveita o nome e passa pela mesma checagem de limite.

### 3.8 Meus agendamentos
- 1 agendamento → detalhe direto. Vários → até 8 por página, numeração contínua.
- Cada item traz `canChange` e `changeDeadlineLabel` (corrige D11/BUG-08):
  - `canChange=false` → `APPOINTMENT_LOCKED` com o `{prazo}` e opções `Falar com atendente` /
    `Voltar`. O cliente não percorre o funil para levar um "não" no fim;
  - o 409 `TOO_LATE` continua tratado (o prazo pode vencer entre a lista e a escolha) → `TOO_LATE`
    + atendente.
- **Remarcar**: `SELECT_DAY` → `SELECT_TIME` → `CONFIRM_RESCHEDULE` ("De … Para …") → `RESCHEDULED`.
- **Cancelar**: `CONFIRM_CANCEL` → `CANCELED`; "Não, manter" → `CANCEL_KEPT`. Ambos seguidos de
  `POST_ACTION`.
- Sem agendamentos → `NO_APPOINTMENTS` + `POST_ACTION`.
- 404 (agendamento sumiu) → `ITEM_UNAVAILABLE` + `MY_APPOINTMENTS` buscado de novo.

### 3.9 Sem disponibilidade
- Dia sem vaga → próximo dia livre (§3.4). Serviço sem vaga no horizonte → `NO_AVAILABILITY`
  (atendente / outro serviço).

### 3.10 Atendente (handoff): pausa, aviso, notificação e retomada (decisão do dono)

**Disparo:** "atendente", opção do menu, `APPOINTMENT_LOCKED`, `NO_AVAILABILITY`, `NO_SERVICES`,
`LIMIT_REACHED`, `TOO_LATE`.

**O que acontece:**
1. O n8n envia o texto e salva a sessão com `handoff: true` e `handoffReason: "CLIENT_REQUEST"`
   (`PUT /sessions`).
2. O painel, na mesma transação: `state = HUMAN`, `humanUntil = agora + Tenant.handoffResumeMinutes`
   (padrão **120**), e cria um `HandoffRequest` (um aberto por sessão; pedido repetido reaproveita o
   aberto). Marca `offHours` pela abertura da equipe.
3. **Sino:** o painel mostra a notificação `HANDOFF_REQUESTED` ("Maria pediu atendente", com
   "fora do horário" quando for o caso) para OWNER e STAFF, derivada de `HandoffRequest`.
4. **Enquanto `HUMAN`:** mensagens do cliente são ignoradas pelo bot (`HUMAN_MODE`), **exceto**
   `menu`/`0`, que encerram o pedido (`CLIENT_MENU`) e voltam o bot na mesma mensagem com
   `BOT_RESUMED` + menu.
5. **A equipe respondeu** (mensagem `fromMe` que não é eco do bot): o painel marca `answeredAt` e
   **estende** a pausa para `agora + handoffResumeMinutes` (padrão 120, o mesmo tempo da resposta pelo painel) a cada resposta da equipe. O
   "menu" do cliente continua valendo.
6. **Ninguém respondeu:** vencido o `humanUntil`, a próxima mensagem do cliente encerra o pedido
   (`TIMEOUT`) e o bot responde com `BOT_RESUMED` + menu. Não há mensagem ativa quando o prazo
   vence (exigiria um job; fora do escopo): o texto do handoff já avisa o horário.
7. **Retomar pelo painel** ("Retomar bot" no contato) encerra o pedido (`PANEL_RESUME`).

**Textos:** dentro do horário → `HUMAN_HANDOFF` com `{retorno}`; fora → `HUMAN_HANDOFF_OFF_HOURS`
com `{proximo}` e `{retorno}`. Ambos dizem "digite *menu* para voltar".

**Horário da equipe (decisão P4):** união dos `WorkingHour` dos profissionais ativos, no fuso do
tenant, menos as `ScheduleException` da empresa (`isOpenNow` / `nextOpening`, `src/core/agenda`).

**Diferença para o dono assumindo por conta própria:** se a empresa responde pelo celular sem o
cliente ter pedido, o comportamento da v1 continua: `HUMAN_TOOK_OVER`, `Contact.botPausedUntil`
por `handoffResumeMinutes` (no claim v1, sem o header de fluxo: `humanPauseMin`), e "menu" **não** é honrado (o cliente nunca recebeu esse aviso).

**Fluxo v1 durante a transição:** `PUT /sessions` com `handoff: true` **sem** `handoffReason`
cria `HandoffRequest` com `reason = LEGACY_FLOW` (o sino passa a funcionar já no deploy do painel),
mas mantém a pausa legada de `humanPauseMin` e não honra "menu".

### 3.11 Falha técnica (corrige D13/BUG-04)

Duas camadas:

1. **No fluxo:** todo nó HTTP de leitura/escrita do painel usa `fullResponse + neverError` e
   `onError: continueRegularOutput` (timeout vira item com `error`). O nó "Resultado X" seguinte
   classifica:
   - **404** (serviço, profissional ou agendamento sumiu) → `ITEM_UNAVAILABLE` e reentra no passo
     de escolha correspondente, buscado de novo;
   - **5xx, timeout, 403** → nó **"Falha técnica"**: `TECH_ERROR`, sessão salva **sem mudar estado
     nem contexto** (o cliente repete a escolha), envio normal.
2. **Rede de segurança (painel):** `POST /sessions/{id}/release` — chamado pelo `innochat-erros`
   quando a execução morre — passa a **avisar o cliente** quando a trava liberada ainda era a da
   execução que morreu (ou seja, morreu **antes** de salvar e enviar): envia `TECH_ERROR` pela
   Evolution (ou para o outbox, se a instância for sandbox), no máximo 1 vez a cada 10 min por
   sessão, e não envia se a sessão estiver em `HUMAN`, o bot pausado ou a assinatura suspensa. O
   `innochat-erros` **não muda**: continua lendo os nós `Claim` e `Config` e chamando o release.
   Isso também protege o fluxo v1 desde o deploy do painel.

---

## 4. Contexto da sessão v2 (`ChatSession.context`)

Opaco para o painel. Superconjunto do formato da v1.

```jsonc
{
  "v": 2,                       // ausente = sessão criada pela v1 (§9)
  "mode": "BOOK | RESCHEDULE",
  "serviceId": "svc_…", "serviceName": "Corte feminino", "durationLabel": "1h", "priceLabel": "R$ 80,00",
  "professionalId": "pro_… | null", "professionalName": "Ana | null",   // null = qualquer
  "date": "2026-10-01", "startsAt": "2026-10-01T17:30:00Z",
  "name": "Maria Souza | null",  // digitado nesta conversa; vai no POST /appointments
  "appointmentId": "ap_…", "previousLabel": "Qua 30/09 às 14:30",
  "returnTo": "CONFIRM | null", "editing": "name | null",
  "trail": ["MAIN_MENU", "SELECT_SERVICE", "SELECT_DAY"],
  "options": [{ "n": 1, "id": "svc_abc", "title": "Corte feminino", "detail": "1h · R$ 80,00",
                "match": "corte feminino", "aliases": [],
                "label": "Corte feminino" }],   // = title; só para o v1 ler a sessão num rollback do fluxo
  "page": 0, "pageStarts": ["2026-09-30"], "hasMore": true, "nextFrom": "2026-10-08", "offset": 8,
  "resume": { "state": "SELECT_TIME", "context": { … } } ,   // só em RESUME_OFFER
  "lastTextKey": "CHOOSE_TIME", "lastVars": { … }            // para "ajuda"/"oi" reenviarem o prompt
}
```

O motor aceita opções no formato da v1 (`{n,id,label}`), usando `label` como `match`, e traduz os
ids estáticos da v1 (`agendar`, `meus`, `atendente`, `confirmar`, `outro`, `cancelar`,
`remarcar`, `sim`, `nao`) para os ids v2 (`mapLegacyOptions`).

---

## 5. Textos v2

### 5.1 Convenções de formatação (WhatsApp)

- `*negrito*` em títulos e dados-chave; `_itálico_` em dicas; sem monoespaçado.
- Opções com **keycap** `1️⃣`–`9️⃣` (no máximo 9 por mensagem), numeradas pelo renderizador. **O
  texto editável nunca contém números de opção** (corrige BUG-11).
- Uma linha em branco entre blocos (prefixo, título, corpo, opções, rodapé).
- No máximo 1 emoji por mensagem fora dos keycaps.
- Linha de opção: `1️⃣ Título — _detalhe_`. Rodapé em itálico, sempre o último bloco.

### 5.2 Renderizador v2 (`renderTemplateV2`, motor; usado também na prévia da tela)

1. Substitui `{var}`. Ausente ou vazia vira **string vazia** (corrige BUG-12; na v1 ficava literal).
2. Remove a linha que ficou só com rótulo e sem valor (`*Valor:* ` sem preço).
3. Limpa pontuação órfã: `", !"` → `"!"`, `" ,"` → `","`, espaços duplos, 3+ quebras → 2.
4. Nos **valores** (nomes de serviço, profissional, cliente) remove `*`, `_`, `~` e `` ` ``.
5. Chaves legadas da v1 (`MAIN_MENU`, `APPOINTMENT_ACTIONS`, `TOO_MANY_INVALID`,
   `LABEL_BACK_TO_MENU`, `LABEL_OTHER_TIME`) não são usadas pela v2.

### 5.3 Textos padrão v2 (`DEFAULT_BOT_TEXTS_V2`, `src/core/bot/texts-v2.ts`)

Variáveis novas: `{duracao}`, `{data_longa}`, `{prazo}`, `{retorno}`, `{proximo}`, `{anterior}`,
`{limite}`. As da v1 continuam: `{nome}`, `{empresa}`, `{servico}`, `{profissional}`, `{data}`,
`{hora}`, `{preco}`, `{quando}`.

```ts
export const DEFAULT_BOT_TEXTS_V2 = {
  // ── Navegação ─────────────────────────────────────────────
  GREETING: "Olá, {nome}! 👋\nBoas-vindas à *{empresa}*.",
  MENU_PROMPT: "Como posso ajudar você hoje?",                                    // novo (substitui MAIN_MENU)
  MENU_HINT: "_Responda com o número ou o nome da opção._",                       // novo
  FOOTER_HINT: "_Digite *0* para o menu ou *voltar* para a etapa anterior._",     // novo (substitui LABEL_BACK_TO_MENU)
  CONTINUE_PROMPT: "Continuando de onde paramos:",                                 // novo
  HELP:                                                                            // novo
    "*Como funciona este atendimento*\n\n" +
    "• Responda com o *número* da opção ou com o nome dela\n" +
    "• *voltar* — etapa anterior\n" +
    "• *menu* — menu principal\n" +
    "• *atendente* — falar com um atendente\n" +
    "• *sair* — encerrar\n\n" +
    "Você também pode digitar datas (_amanhã_, _sexta_, _15/10_) e horários (_15h_, _15:30_).",

  // ── Agendamento ──────────────────────────────────────────
  CHOOSE_SERVICE: "*Qual serviço você deseja agendar?*",
  NO_SERVICES: "No momento não há serviços disponíveis para agendar por aqui. Quer falar com um atendente?",   // novo
  CHOOSE_PROFESSIONAL: "*Com quem você prefere ser atendido(a)?*\n_{servico}_",
  CHOOSE_DAY:
    "*Para qual dia?*\n_{servico} · {profissional}_\n\n" +
    "Escolha uma opção ou digite a data (ex.: _amanhã_, _sexta_, _15/10_).",
  NEXT_AVAILABLE: "*Próximos horários livres*\n_{servico} · {profissional}_",    // novo
  CHOOSE_TIME:
    "*Horários livres em {data}*\n_{servico} · {profissional}_\n\n" +
    "Escolha uma opção ou digite o horário (ex.: _15h_, _15:30_, _tarde_).",
  NO_SLOTS_DAY: "Não temos horários livres em *{data}*.\nO próximo dia com vaga é *{proximo}*. Veja as datas disponíveis:",
  DATE_OUT_OF_RANGE: "Consigo agendar de hoje até *{data}*. Escolha uma data dentro desse período:",   // novo
  TIME_NOT_AVAILABLE: "Às *{hora}* não temos vaga em {data}. Os horários mais próximos são:",        // novo
  NO_AVAILABILITY:
    "No momento não há horários livres para *{servico}* nos próximos dias. 😕\n" +
    "Quer falar com um atendente ou escolher outro serviço?",
  ITEM_UNAVAILABLE: "Essa opção não está mais disponível. Vamos escolher de novo:",   // novo (BUG-04)
  APPOINTMENT_LIMIT:                                                              // novo (limite)
    "Você já tem *{limite}* agendamentos marcados, o máximo por aqui.\n" +
    "Para marcar outro, remarque ou cancele um deles, ou fale com um atendente:",
  ASK_NAME: "Para finalizar, *qual é o seu nome?*\n_Digite como prefere ser chamado(a)._",
  NAME_INVALID: "Não consegui registrar esse nome. Digite apenas o seu nome, por favor.",           // novo
  NAME_TOO_LONG: "Esse nome ficou um pouco longo. Pode abreviar? _(até 60 letras)_",                // novo (BUG-17)
  CONFIRM_SUMMARY:
    "*Confira os dados do agendamento*\n\n" +
    "*Serviço:* {servico}\n" +
    "*Profissional:* {profissional}\n" +
    "*Data:* {data_longa}\n" +
    "*Horário:* {hora} _(duração de {duracao})_\n" +
    "*Valor:* {preco}\n" +
    "*Nome:* {nome}\n\n" +
    "Está tudo certo?",
  CONFIRM_RESCHEDULE:                                                             // novo
    "*Confira a remarcação*\n\n" +
    "*Serviço:* {servico} com {profissional}\n" +
    "*De:* ~{anterior}~\n" +
    "*Para:* {data_longa} às {hora}\n\n" +
    "Posso confirmar?",
  CONFIRM_EDIT: "*O que você quer corrigir?*",                                     // novo
  BOOKED:
    "✅ *Agendamento confirmado!*\n\n" +
    "*{servico}* com {profissional}\n" +
    "{data_longa} às *{hora}*\n\n" +
    "_Precisa remarcar ou cancelar? Mande *menu* e escolha Meus agendamentos (até {prazo} antes do horário)._",
  SLOT_TAKEN: "Poxa, o horário das *{hora}* acabou de ser reservado por outra pessoa. 😕\nHorários livres em *{data}*:",
  POST_ACTION_MENU: "Posso ajudar em algo mais?",                                  // novo

  // ── Meus agendamentos ───────────────────────────────────
  MY_APPOINTMENTS: "*Seus próximos agendamentos*\nEscolha um para ver as opções:",
  NO_APPOINTMENTS: "Você não tem agendamentos futuros por aqui.",
  APPOINTMENT_DETAIL:                                                             // novo (substitui APPOINTMENT_ACTIONS)
    "*{servico}* com {profissional}\n{data_longa} às *{hora}*\n\nO que você deseja fazer?",
  APPOINTMENT_LOCKED:                                                             // novo
    "*{servico}* com {profissional}\n{data_longa} às *{hora}*\n\n" +
    "Alterações pelo WhatsApp são aceitas até *{prazo}* antes do horário. Para este agendamento, fale com um atendente.",
  CONFIRM_CANCEL: "Tem certeza de que deseja *cancelar* {servico} com {profissional} em *{data}* às *{hora}*?",
  CANCELED: "Pronto: o agendamento de *{servico}* em {data} às {hora} foi *cancelado*.",
  CANCEL_KEPT: "Tudo certo: seu agendamento continua marcado.",                   // novo (UX-6)
  RESCHEDULED: "✅ *Agendamento remarcado!*\n\n*{servico}* com {profissional}\n{data_longa} às *{hora}*",
  TOO_LATE:
    "Este agendamento não pode mais ser alterado por aqui: mudanças são aceitas até *{prazo}* antes do horário.\n" +
    "Um atendente pode ajudar você.",

  // ── Atendente e controle da conversa ───────────────────
  HUMAN_HANDOFF:
    "Certo! Já avisei a nossa equipe e um atendente vai continuar esta conversa por aqui.\n\n" +
    "_Se ninguém responder até {retorno}, eu volto a atender. Para voltar ao menu agora, digite *menu*._",
  HUMAN_HANDOFF_OFF_HOURS:                                                        // novo
    "Certo! Deixei sua mensagem com a nossa equipe.\n" +
    "Estamos fora do horário de atendimento agora; retornamos *{proximo}*.\n\n" +
    "_Enquanto isso, se quiser agendar por aqui, digite *menu*._",
  BOT_RESUMED: "Certo, o atendimento automático está de volta.",                   // novo
  INVALID_OPTION: "Não entendi sua resposta. Escolha uma das opções abaixo respondendo com o *número*:",
  INVALID_BACK_TO_MENU:                                                           // novo (substitui TOO_MANY_INVALID)
    "Acho que não estou conseguindo entender. Vamos recomeçar pelo menu; se preferir, escolha *Falar com atendente*.",
  AMBIGUOUS_OPTION: "Encontrei mais de uma opção parecida. Qual delas você quis dizer?",   // novo
  ONLY_TEXT: "Por aqui eu entendo apenas mensagens de texto. Responda digitando uma das opções:",
  SESSION_EXPIRED: "Como faz um tempinho desde a nossa última conversa, recomecei o atendimento.",
  RESUME_OFFER: "Que bom ter você de volta! Você estava agendando *{servico}*.\nQuer continuar de onde parou?",   // novo
  THANKS_REPLY: "Por nada, {nome}! Quando precisar, é só mandar uma mensagem. 👋",   // novo
  GOODBYE: "Atendimento encerrado. Obrigado pelo contato, {nome}! 👋\n_Quando precisar, é só mandar uma mensagem._",
  TECH_ERROR: "Tive um problema técnico para concluir isso agora. Tente de novo em instantes ou digite *atendente*.",   // novo
  // REMINDER: enviado pelo tick de lembretes, fora do fluxo. Não muda.

  // ── Atendimento humano (equipe age pelo painel; STAFF_* só saem se `notifyClientOnStaffChanges`) ──
  STAFF_BOOKED:                                                                 // novo (atendimento humano)
    "Olá, {nome}! ✅ Seu horário foi agendado pela equipe da *{empresa}*: *{servico}* com {profissional}, {quando} às *{hora}*. Para remarcar ou cancelar, responda *menu*.",
  STAFF_RESCHEDULED:                                                                 // novo (atendimento humano)
    "Olá, {nome}! 🔄 Seu horário foi remarcado pela equipe da *{empresa}*: *{servico}* com {profissional}, {quando} às *{hora}*. Para remarcar ou cancelar, responda *menu*.",
  STAFF_CANCELED:                                                                 // novo (atendimento humano)
    "Olá, {nome}. Seu agendamento de *{servico}* com {profissional}, {quando} às {hora}, foi *cancelado* pela equipe da *{empresa}*. Para marcar um novo horário, responda *menu*.",
  HANDOFF_CLOSED:                                                                 // novo (atendimento humano)
    "Atendimento encerrado pela equipe da *{empresa}*. Obrigado pelo contato, {nome}! 👋\n_Para agendar ou ver seus horários, é só responder *menu*._",
};
```

**Rótulos de opção** (sem variáveis):

| Chave | Padrão | Nota |
|---|---|---|
| `LABEL_MENU_BOOK` (novo) | Agendar horário | |
| `LABEL_MENU_MY` (novo) | Meus agendamentos | |
| `LABEL_MENU_HUMAN` (novo) | **Falar com atendente** | decisão P2 |
| `LABEL_ANY_PROFESSIONAL` (novo) | Qualquer profissional | detalhe fixo: _primeiro horário livre_ |
| `LABEL_NEXT_AVAILABLE` (novo) | Primeiro horário livre | |
| `LABEL_BY_DAY` (novo) | Escolher por dia | |
| `LABEL_CONFIRM` | Confirmar | existente |
| `LABEL_EDIT` (novo) | Corrigir dados | |
| `LABEL_EDIT_SERVICE` / `_PROFESSIONAL` / `_DATETIME` / `_NAME` (novos) | Serviço / Profissional / Data e horário / Nome | |
| `LABEL_RESCHEDULE` (novo) | Remarcar | |
| `LABEL_CANCEL_APPOINTMENT` (novo) | Cancelar agendamento | |
| `LABEL_CANCEL_YES` / `LABEL_CANCEL_NO` | Sim, cancelar / Não, manter | existentes |
| `LABEL_BOOK_ANOTHER` (novo) | Agendar outro | |
| `LABEL_FINISH` (novo) | Encerrar atendimento | |
| `LABEL_CONTINUE` / `LABEL_START_OVER` (novos) | Continuar / Começar de novo | |
| `LABEL_BACK` (novo) | Voltar | |
| `LABEL_OTHER_SERVICE` (novo) | Outro serviço | |
| `LABEL_PREVIOUS` (novo) | Ver anteriores | paginação (BUG-06) |
| `LABEL_MORE_DAYS` / `LABEL_MORE_TIMES` / `LABEL_MORE` | Ver mais datas / Mais horários / Ver mais | existentes |

**Variáveis permitidas por chave** (`BOT_TEXT_ALLOWED_VARS`; o editor recusa variável fora da
lista da chave, corrige BUG-12): `nome`, `empresa` em todas as mensagens; além disso:

| Chaves | Variáveis extras |
|---|---|
| `CHOOSE_PROFESSIONAL`, `NEXT_AVAILABLE`, `CHOOSE_DAY`, `NO_AVAILABILITY`, `RESUME_OFFER` | `servico`, `profissional` |
| `CHOOSE_TIME`, `NO_SLOTS_DAY`, `DATE_OUT_OF_RANGE`, `TIME_NOT_AVAILABLE`, `SLOT_TAKEN` | `servico`, `profissional`, `data`, `hora`, `proximo` |
| `CONFIRM_SUMMARY`, `CONFIRM_RESCHEDULE`, `BOOKED`, `RESCHEDULED`, `APPOINTMENT_DETAIL`, `APPOINTMENT_LOCKED`, `CONFIRM_CANCEL`, `CANCELED`, `TOO_LATE` | `servico`, `profissional`, `data`, `data_longa`, `hora`, `duracao`, `preco`, `prazo`, `anterior` |
| `HUMAN_HANDOFF`, `HUMAN_HANDOFF_OFF_HOURS` | `retorno`, `proximo` |
| `APPOINTMENT_LIMIT` | `limite` |
| `REMINDER` | `servico`, `profissional`, `hora`, `quando` (inalterado) |
| `LABEL_*` | nenhuma |

### 5.4 Conversas renderizadas

Premissas: hoje é **quarta, 30/09/2026**, 10:12. Studio Bela, prazo de alteração 2 h, retomada do
atendente 2 h, equipe seg–sáb 09:00–19:00, grade de 30 min, limite 3. Cliente Maria. `›` = cliente.

#### A. Cliente novo, agendamento completo

```
› oi

Olá, Maria! 👋
Boas-vindas à *Studio Bela*.

Como posso ajudar você hoje?

1️⃣ Agendar horário
2️⃣ Meus agendamentos
3️⃣ Falar com atendente

_Responda com o número ou o nome da opção._

› quero agendar

*Qual serviço você deseja agendar?*

1️⃣ Corte feminino — _1h · R$ 80,00_
2️⃣ Escova — _40 min · R$ 50,00_
3️⃣ Manicure — _45 min · R$ 35,00_

_Digite *0* para o menu ou *voltar* para a etapa anterior._

› escova

*Com quem você prefere ser atendido(a)?*
_Escova_

1️⃣ Qualquer profissional — _primeiro horário livre_
2️⃣ Ana
3️⃣ Júlia

_Digite *0* para o menu ou *voltar* para a etapa anterior._

› ana

*Para qual dia?*
_Escova · Ana_

Escolha uma opção ou digite a data (ex.: _amanhã_, _sexta_, _15/10_).

1️⃣ Primeiro horário livre
2️⃣ Hoje · Qua 30/09
3️⃣ Amanhã · Qui 01/10
4️⃣ Sex 02/10
5️⃣ Sáb 03/10
6️⃣ Seg 05/10
7️⃣ Ter 06/10
8️⃣ Qua 07/10
9️⃣ Ver mais datas

_Digite *0* para o menu ou *voltar* para a etapa anterior._

› sexta à tarde

*Horários livres em Sex 02/10*
_Escova · Ana_

Escolha uma opção ou digite o horário (ex.: _15h_, _15:30_, _tarde_).

1️⃣ 13:00
2️⃣ 14:00
3️⃣ 15:30
4️⃣ 17:00

_Digite *0* para o menu ou *voltar* para a etapa anterior._

› 15h

Às *15:00* não temos vaga em Sex 02/10. Os horários mais próximos são:

1️⃣ 14:00
2️⃣ 15:30
3️⃣ 17:00

_Digite *0* para o menu ou *voltar* para a etapa anterior._

› 2

Para finalizar, *qual é o seu nome?*
_Digite como prefere ser chamado(a)._

› Maria Souza

*Confira os dados do agendamento*

*Serviço:* Escova
*Profissional:* Ana
*Data:* sexta-feira, 02/10
*Horário:* 15:30 _(duração de 40 min)_
*Valor:* R$ 50,00
*Nome:* Maria Souza

Está tudo certo?

1️⃣ Confirmar
2️⃣ Corrigir dados

_Digite *0* para o menu ou *voltar* para a etapa anterior._

› sim

✅ *Agendamento confirmado!*

*Escova* com Ana
sexta-feira, 02/10 às *15:30*

_Precisa remarcar ou cancelar? Mande *menu* e escolha Meus agendamentos (até 2 horas antes do horário)._

Posso ajudar em algo mais?

1️⃣ Agendar outro
2️⃣ Meus agendamentos
3️⃣ Encerrar atendimento

› obrigada

Por nada, Maria! Quando precisar, é só mandar uma mensagem. 👋
```

#### B. Horário tomado por concorrência (alternativas de outro dia)

```
(CONFIRM de Corte feminino, Qualquer profissional, hoje 18:00; outra pessoa reserva antes)
› 1

Poxa, o horário das *18:00* acabou de ser reservado por outra pessoa. 😕
Horários livres em *Amanhã · Qui 01/10*:

1️⃣ 09:00
2️⃣ 10:00
3️⃣ 11:30

_Digite *0* para o menu ou *voltar* para a etapa anterior._
```

#### C. Corrigir o profissional na confirmação

```
› corrigir

*O que você quer corrigir?*

1️⃣ Serviço
2️⃣ Profissional
3️⃣ Data e horário
4️⃣ Nome

› 2  → (lista de profissionais) › júlia   (Júlia livre no mesmo horário → volta direto)

*Confira os dados do agendamento*
…
*Profissional:* Júlia
```

#### D. Limite de agendamentos

```
(Maria já tem 3 agendamentos futuros)
› 1

Você já tem *3* agendamentos marcados, o máximo por aqui.
Para marcar outro, remarque ou cancele um deles, ou fale com um atendente:

1️⃣ Amanhã · Qui 01/10 · 10:00 — Escova (Ana)
2️⃣ Seg 05/10 · 14:00 — Manicure (Júlia)
3️⃣ Qua 07/10 · 09:00 — Corte feminino (Ana)
4️⃣ Falar com atendente

_Digite *0* para o menu ou *voltar* para a etapa anterior._
```

#### E. Cancelar dentro do prazo mínimo

```
› 2

*Seus próximos agendamentos*
Escolha um para ver as opções:

1️⃣ Hoje · Qua 30/09 · 11:30 — Manicure (Ana)
2️⃣ Seg 05/10 · 10:00 — Escova (Júlia)

› 1                        (faltam 78 min; prazo de 2 h → canChange=false)

*Manicure* com Ana
quarta-feira, 30/09 às *11:30*

Alterações pelo WhatsApp são aceitas até *2 horas* antes do horário. Para este agendamento, fale com um atendente.

1️⃣ Falar com atendente
2️⃣ Voltar
```

#### F. Atendente, dentro e fora do horário, e volta pelo "menu"

```
(quarta, 10:15)
› atendente

Certo! Já avisei a nossa equipe e um atendente vai continuar esta conversa por aqui.

_Se ninguém responder até hoje às 12:15, eu volto a atender. Para voltar ao menu agora, digite *menu*._

   (no painel: sino "Maria pediu atendente")
› alguém aí?               (ignorado: HUMAN_MODE)
› menu

Certo, o atendimento automático está de volta.

Como posso ajudar você hoje?
1️⃣ Agendar horário
…

(domingo, 22:40)
› atendente

Certo! Deixei sua mensagem com a nossa equipe.
Estamos fora do horário de atendimento agora; retornamos *amanhã às 09:00*.

_Enquanto isso, se quiser agendar por aqui, digite *menu*._
```

#### G. Duas respostas inválidas

```
(em SELECT_TIME)
› asdf

Não entendi sua resposta. Escolha uma das opções abaixo respondendo com o *número*:

*Horários livres em Sex 02/10*
…

› 27

Acho que não estou conseguindo entender. Vamos recomeçar pelo menu; se preferir, escolha *Falar com atendente*.

Como posso ajudar você hoje?

1️⃣ Agendar horário
2️⃣ Meus agendamentos
3️⃣ Falar com atendente

_Responda com o número ou o nome da opção._
```

#### H. Sessão expirada, com retomada; e resposta ao lembrete

```
(parou em SELECT_TIME às 10:20; volta às 14:05)
› oi

Olá, Maria! 👋
Boas-vindas à *Studio Bela*.

Que bom ter você de volta! Você estava agendando *Escova*.
Quer continuar de onde parou?

1️⃣ Continuar
2️⃣ Começar de novo

(dia seguinte, respondendo ao lembrete)
› cancelar                 (sessão expirada; "cancelar" é alias de Meus agendamentos → processado)

*Seus próximos agendamentos*
…
```

---

## 6. Botões e listas: futuro

Fora da v2 (decisão P1, teste real de 2026-09-30 na Evolution 2.3.7: botões com 201 e sem
entrega; lista com 400 `this.isZero is not a function`; enquete chega, mas não serve ao fluxo).
O card de teste em Admin → Saúde continua para reavaliar em versões futuras da Evolution ou numa
migração para a API oficial (Cloud API).

Se voltar a ser considerado, os três pontos que a primeira versão desta spec levantou continuam
válidos e precisam de fixture real antes de qualquer código: (1) texto numerado sempre como base
e *fallback*; (2) `fromMe` de mensagem interativa tratado **sempre** como eco, senão o hash não
bate e o claim pausa o bot por 12 h; (3) flag global desligado + opt-in por empresa. Nenhum campo,
chave de texto ou contrato da v2 depende disso.

---

## 7. Workflow v2 e motor

### 7.1 Estrutura do workflow (n8n)

```
Webhook → Config → Filtrar evento → Claim(X-InnoChat-Flow: 2) → Roteia claim
   Roteia claim: process → Interpretar · busy → Tentar de novo?/Esperar · ignore → Ignorar
   Interpretar (Code, motor) → Switch "Rota" ($json.route)
       MEDIA | CMD_MENU | CMD_BACK | CMD_EXIT | CMD_HUMAN | CMD_HELP | CMD_CONTINUE | CMD_THANKS |
       INVALID_1 | INVALID_2 | AMBIGUOUS | FRESH | RESUME | STATE
   STATE → Switch "Responder passo" (state) → por estado: Switch por opção/intenção → Set (contextPatch)
       → HTTP de escrita quando houver (reserva, remarcar, cancelar) → IF de resultado (2xx/404/409/422/5xx)
   → Switch "Entrar no passo" (goto) → HTTP de leitura → "Resultado X" (Code pequeno: 2xx/404/5xx)
       → { nextState, contextPatch, textKey, vars, options, prefixKeys, handoff, handoffReason }
   → Montar mensagem (Code, motor) → Salvar sessão → Resultado da gravação
       → Sandbox? → Enviar para sandbox | Preparar envio → Separar mensagens → Enviar pela Evolution
   Falha técnica (Set) → Montar mensagem (TECH_ERROR, estado e contexto preservados)
```

Regras:
- **Nomes que não mudam** (dependências externas): `Webhook` (com o **mesmo** `webhookId`
  `b12d5bcf-…` e `path` `innochat/evolution/:token`), `Config` (atribuições `token`, `painelUrl`,
  `evolutionUrl`, mais a nova `flowVersion`), `Claim` (saída = corpo do claim; o `innochat-erros`
  lê `session.id` e `session.lockToken` daqui), `Esperar` (mesmo `webhookId` `73c95f8e-…`),
  `Salvar sessão`, `Enviar pela Evolution`.
- **Ramo não monta texto**: só `textKey` + `vars` + `options`. Quem monta é `Montar mensagem`.
- As decisões de roteamento (Switch/IF) ficam visíveis. O que é código fica em 2 nós grandes
  gerados (`Interpretar`, `Montar mensagem`) e em nós "Resultado X" pequenos.
- Restrições para rodar no simulador (`scripts/bot-sim/engine.mjs`): só os tipos de nó e
  operadores listados no plano (§3.7 do plano).

### 7.2 Motor puro compilado para os Code nodes

- Fonte: `src/core/bot/engine/` (TypeScript, **sem imports fora da pasta**, sem Node/Intl de
  fuso: o relógio do tenant chega pelo claim em `tenant.today`/`tenant.nowLocal`).
- `scripts/n8n-build-flow.mjs` compila o motor com esbuild (IIFE `InnoEngine`, ES2020, sem
  minificar) e injeta entre os marcadores `/* @engine:begin */` e `/* @engine:end */` no `jsCode`
  dos nós `Interpretar` e `Montar mensagem`. O resto do `jsCode` é cola escrita à mão.
- Teste de estrutura no CI reprova JSON com *bundle* desatualizado, credenciais, `pinData`,
  `Config` sem placeholder, `webhookId` diferente ou saída de Switch desconectada.
- Editar o trecho gerado direto no n8n é detectado como **drift** pelo "Publicar fluxo" (§9).
- API do motor (tipos exatos no plano §3.2): `normalizeText`, `parseInput`, `interpret`,
  `validateName`, `buildPage`, `pushTrail`/`popTrail`, `mapLegacyOptions`, `renderTemplateV2`,
  `renderMessage`, `keycap`.

---

## 8. Painel: contratos e dados (resumo)

Contratos **exatos** (tipos, códigos de erro, exemplos) no plano, §3. Tudo aditivo.

| Endpoint / função | Mudança |
|---|---|
| `POST /messages/claim` | Header `X-InnoChat-Flow: 2` → textos base v2, `contact.firstName`, `session.previous`, `session.resumedFromHuman`, `tenant.today/nowLocal/openNow/teamNextOpenLabel/handoffUntilLabel/changeLeadLabel/lastBookableDate`. Em `HUMAN` com pedido do cliente, "menu" encerra o pedido e processa. `fromMe` da equipe durante o pedido estende a pausa |
| `PUT /sessions/{id}` | Campo opcional `handoffReason: "CLIENT_REQUEST"` → pausa de `handoffResumeMinutes` + `HandoffRequest`. Sem ele, comportamento v1 + `HandoffRequest LEGACY_FLOW` |
| `POST /sessions/{id}/release` | Avisa o cliente com `TECH_ERROR` quando a execução morreu antes de salvar (§3.11) |
| `GET /catalog/services` | Filtra por expediente; `name`, `durationLabel`, `priceLabel`; `?contactId` → `limit` |
| `GET /catalog/services/{id}/professionals` | Filtra por expediente |
| `GET /availability/days` | `relativeLabel`, `nextFrom` corrigido, `lastBookableDate`, rótulo por meio-dia local |
| `GET /availability/slots` | `period`, `near`; `exact`, `reason`, `nextDay`, `dateLabel`, `dateLongLabel` |
| **`GET /availability/next`** | Novo: próximos N horários em qualquer dia |
| `GET /contacts/{id}/appointments` | `canChange`, `changeDeadlineLabel`, `durationLabel`, `priceLabel`, `dataLonga`, `relativeLabel` |
| `POST /appointments` | `contactName` opcional; 422 `LIMIT_REACHED`; `summary` com `duracao`, `preco`, `data_longa` |
| `POST /appointments/{id}/reschedule` | `summary` idem; alternativas do 409 com `dateLabel` |
| Notificações | kind `HANDOFF_REQUESTED` |
| Configurações da empresa | `maxFutureAppointmentsPerContact`, `slotGranularityMin` (15/30), `handoffResumeMinutes` |
| Admin | status/publicar/voltar/baixar do fluxo |

**Dados (Cronos), duas migrations em sequência** (a segunda precisa dos valores de enum já
confirmados; `ALTER TYPE … ADD VALUE` não pode ser usado na mesma transação):
1. `bot_v2_schema`: 46 valores novos em `BotTextKey`; `Tenant.maxFutureAppointmentsPerContact`
   (3), `Tenant.handoffResumeMinutes` (120); `slotGranularityMin` padrão 30, valores atualizados
   para 30 e `CHECK IN (15,30)`; tabela `handoff_requests` com enums `HandoffReason` e
   `HandoffEndReason` e índice único parcial "um aberto por sessão"; `PlatformSettings.n8nBotFlow*`.
2. `bot_v2_port_texts`: porta as edições das empresas (decisão P3): `MAIN_MENU` → `MENU_PROMPT`
   (cabeçalho antes da 1ª linha numerada) e `APPOINTMENT_ACTIONS` → `APPOINTMENT_DETAIL`
   (cabeçalho fixo + a pergunta da empresa). Não sobrescreve, não apaga as linhas legadas.

`TOO_MANY_INVALID`, `LABEL_BACK_TO_MENU` e `LABEL_OTHER_TIME` **não são portadas**: mudaram de
**significado**, não de lugar ("vou chamar um atendente" contradiz a regra de voltar ao menu;
"0. Menu principal" traz numeração; "outro horário" não existe mais). A tela mostra o texto antigo
como legado.

**Textos por versão de fluxo:** `getMergedBotTexts(tenantId, flowVersion)` usa a base v2 quando o
claim recebe `X-InnoChat-Flow: 2`. O fluxo v1 continua recebendo a base v1 (sem `{data_longa}`
literal).

**Tela "Mensagens do bot" (Lyra):** abas **Conversa**, **Agendamento**, **Meus agendamentos**,
**Atendente e erros** e **Rótulos** (recolhida); prévia com a formatação do WhatsApp (`*negrito*`,
`_itálico_`, `~riscado~`, keycaps) usando o **mesmo** `renderMessage` do motor; variáveis
permitidas por chave; aviso de texto portado. Antes da publicação do fluxo v2, a tela continua v1.

---

## 9. Troca, compatibilidade e rollback (resumo; detalhe no plano §5)

| Situação | Tratamento |
|---|---|
| Painel novo + fluxo v1 | Tudo aditivo. v1 recebe textos v1, rótulos antigos, e ganha de brinde: grade redonda, filtro por expediente, rótulos corretos no fuso +12, sino de atendente, `TECH_ERROR` no release |
| Sessão da v1 lida pela v2 | Estados com os mesmos nomes; `mapLegacyOptions`; sem `ctx.v` → `trail` vazio |
| Execução v1 em andamento no Publicar | Termina na v1; lease + `version` protegem a próxima |
| Rollback do fluxo | "Voltar à versão anterior" (snapshot em `n8nBotFlowPrevious`) |
| Rollback do painel | **Primeiro** voltar o fluxo; depois a imagem. As migrations são aditivas e ficam |
| Ordem | Painel (migrations no boot) → verificação → Publicar fluxo. Nunca o contrário |

"Publicar fluxo" (desenho da v1 deste documento, mantido): o painel importa `n8n/innochat-bot.json`
estaticamente no build; faz o merge com o workflow vivo (copia `webhookId` do Webhook e do
`Esperar`, aplica o `Config`, religa credenciais pelos ids gravados, troca
`settings.errorWorkflow` pelo id gravado do `innochat-erros`); detecta edição manual por hash
canônico; guarda snapshot; publica com `PUT`; verifica `path`/`webhookId` depois e volta sozinho
se divergirem. Sem publicação automática no boot nesta versão.

---

## 10. Critérios de aceite

Executados no simulador (`scripts/bot-sim/scenarios-v2.mjs`, relógio e fuso do tenant do seed) e,
os marcados com (E2E), no navegador. O id do cenário no simulador é o próprio `CA-xx`.

**Comandos e entrada**
- **CA-01** Em qualquer estado, incluindo `ASK_NAME`, "Menu", "MENU", "menú", "0" e "0️⃣" levam a `MAIN_MENU` com contexto zerado.
- **CA-02** "voltar" em `SELECT_TIME` reapresenta `SELECT_DAY` com dias buscados de novo e `startsAt` limpo. Com o profissional pulado, "voltar" em `SELECT_DAY` leva a `SELECT_SERVICE`.
- **CA-03** "ajuda" em `SELECT_DAY` envia `HELP` + o mesmo prompt, sem mudar estado nem `invalidCount`.
- **CA-04** "Atendente" em qualquer estado grava `HUMAN`, cria 1 `HandoffRequest` aberto e as mensagens seguintes (exceto "menu") são ignoradas.
- **CA-05** "sair" envia `GOODBYE`; a mensagem seguinte recebe `GREETING` + menu.
- **CA-06** "escova", "ESCOVA", "Escóva" escolhem Escova. "corte", com 2 cortes, gera `AMBIGUOUS_OPTION` só com os 2, numerados 1 e 2.
- **CA-07** "2️⃣", "opção 2", "2.", "2)", "#2" e " 02 " equivalem a "2".
- **CA-08** Em `SELECT_DAY` (hoje é quarta do seed): "amanhã", "sexta", "02/10", "2/10" levam ao dia certo; "quarta" = hoje; "quarta que vem" = +7.
- **CA-09** Em `SELECT_TIME`: "15h", "15:00", "15h00", "3 da tarde" escolhem 15:00 se existir; senão `TIME_NOT_AVAILABLE` com os 3 mais próximos. "tarde" filtra 12:00–17:59.
- **CA-10** Em `ASK_NAME`: "voltar" navega e não grava; "1", "a", "oi", "sim", "cancelar", "😀😀", ".." geram `NAME_INVALID`; 61 caracteres → `NAME_TOO_LONG`; "Maria Souza" leva ao `CONFIRM` **sem** gravar `Contact.name` até a reserva.
- **CA-11** 1ª inválida → `INVALID_OPTION` + prompt. 2ª seguida → `INVALID_BACK_TO_MENU` + menu, `invalidCount=0`, **nenhum** `HandoffRequest`.
- **CA-12** Mídia → `ONLY_TEXT` + prompt, sem somar ao `invalidCount`.
- **CA-13** Em `CONFIRM`: "sim", "s", "ok", "confirmo", "isso", "pode ser", "Confirmar!", "👍", "👍🏽", "✅" confirmam; "não", "n", "nao", "❌" abrem `CONFIRM_EDIT`. "obrigada" depois de `BOOKED` → `THANKS_REPLY` e encerra.

**Fluxo**
- **CA-14** Serviços mostram duração e preço; serviço sem preço não mostra "R$" e a linha "Valor" some do `CONFIRM`.
- **CA-15** Com 2+ profissionais, "Qualquer profissional" é a 1ª opção; `BOOKED` mostra o nome real.
- **CA-16** "Primeiro horário livre" mostra até 6 horários em ordem, respeitando `minLeadTimeMin`.
- **CA-17** Data com a empresa fechada → `NO_SLOTS_DAY` com `{proximo}` e lista a partir dele (o dia vazio **não** aparece). Além do horizonte → `DATE_OUT_OF_RANGE`.
- **CA-18** Paginação (serviços, dias, horários, agendamentos): numeração 1..n sem pular; "Ver mais" só se houver próxima; "Ver anteriores" a partir da 2ª; nenhum item repetido entre páginas; sem volta cíclica.
- **CA-19** `CONFIRM` com os 7 campos. "Corrigir → Profissional" com o mesmo horário livre volta direto; ocupado → `SELECT_TIME` do dia.
- **CA-20** "Corrigir → Nome" atualiza o resumo; o nome é gravado na reserva; "Agendar outro" não pede o nome de novo.
- **CA-21** Duas sessões confirmam o mesmo horário: uma `BOOKED`, outra `SLOT_TAKEN` com `{data}` do dia das alternativas; exatamente 1 `Appointment`.
- **CA-22** Depois de `BOOKED`: Agendar outro / Meus agendamentos / Encerrar.
- **CA-23** Meus agendamentos: 1 item → detalhe direto; 0 → `NO_APPOINTMENTS` + `POST_ACTION`.
- **CA-24** Agendamento dentro do prazo → `APPOINTMENT_LOCKED` com `{prazo}`, sem remarcar/cancelar. `TOO_LATE` forçado → texto `TOO_LATE` + atendente.
- **CA-25** Remarcar → `CONFIRM_RESCHEDULE` com "De" riscado → `RESCHEDULED`, sem criar outro agendamento.
- **CA-26** Handoff dentro do horário → `HUMAN_HANDOFF` com `{retorno}` = agora + `handoffResumeMinutes`; fora → `HUMAN_HANDOFF_OFF_HOURS` com `{proximo}`. O sino da empresa mostra `HANDOFF_REQUESTED` (E2E).
- **CA-27** Sessão parada em `SELECT_TIME` há 40 min → `GREETING` + `RESUME_OFFER`; "Continuar" rebusca os horários. Parada há mais de 25 h → saudação + menu, sem oferta.
- **CA-28** "oi" no meio do fluxo → `CONTINUE_PROMPT` + prompt atual.
- **CA-29** Painel respondendo 500 em `GET /availability/slots` → `TECH_ERROR`, sessão salva no mesmo estado, trava liberada; repetir a escolha com o painel de volta funciona.
- **CA-30** Serviço desativado com a lista aberta → `ITEM_UNAVAILABLE` + lista de serviços nova; profissional desativada → idem na lista de profissionais.
- **CA-31** Execução que morre antes de salvar (erro forçado no fluxo) → o cliente recebe `TECH_ERROR` via release (fake Evolution); uma 2ª falha em menos de 10 min não repete o aviso.

**Atendente, limite e grade (decisões do dono)**
- **CA-32** Em `HUMAN` por pedido do cliente, "menu" encerra o pedido (`CLIENT_MENU`) e responde `BOT_RESUMED` + menu na mesma mensagem.
- **CA-33** Sem resposta da equipe, após `handoffResumeMinutes` a próxima mensagem encerra o pedido (`TIMEOUT`) e o bot responde.
- **CA-34** `fromMe` da equipe durante o pedido marca `answeredAt` e estende `humanUntil` para `handoffResumeMinutes`; "menu" do cliente continua funcionando. `fromMe` sem pedido do cliente mantém o comportamento v1 (menu não honrado).
- **CA-35** Cliente com 3 agendamentos futuros escolhe "Agendar" → `LIMIT_REACHED` com os 3 + atendente. `POST /appointments` direto com 3 existentes → 422 `LIMIT_REACHED`. Com `maxFutureAppointmentsPerContact=0`, sem limite. Remarcar não é barrado.
- **CA-36** Grade 30: depois de uma Escova (45 min) às 09:00, o próximo horário é 10:00; nenhum horário fora de :00/:30. Grade 15: :00/:15/:30/:45.
- **CA-37** Serviço sem profissional com expediente e profissional sem expediente não aparecem; empresa sem serviço agendável → `NO_SERVICES` + atendente.

**Formatação**
- **CA-38** Nenhuma mensagem contém `{` + letras + `}` (bases v1 e v2).
- **CA-39** Nenhuma mensagem tem 2 linhas em branco seguidas, nem ", !", nem "Olá, !" (pushName vazio, ".", "~").
- **CA-40** Serviço `Corte *VIP*_2` aparece como `Corte VIP2` sem quebrar o negrito.
- **CA-41** Toda mensagem com opções termina com `FOOTER_HINT` (ou `MENU_HINT` no menu) e usa keycaps.
- **CA-42** Fuso UTC+14 (`kiribati`): o rótulo do dia na lista, no resumo e na confirmação é o mesmo dia local.
- **CA-43** Texto do menu editado pela empresa: a numeração continua gerada e a ação do "2" é sempre "Meus agendamentos".

**Compatibilidade e publicação**
- **CA-44** Sessão gravada pela v1 em `CONFIRM` (ids `confirmar`/`outro`) responde certo "1" e "2" depois da troca.
- **CA-45** Com o painel novo e o **workflow v1** (`BOTSIM_WORKFLOW=n8n/legacy/innochat-bot.v1.json`), os cenários verdes da auditoria continuam verdes e nenhum texto tem variável literal.
- **CA-46** Publicar: `webhookId` e `path` iguais; credenciais ligadas; `errorWorkflow` = id gravado. Editar um nó à mão → bloqueio de drift; "Sobrescrever" publica; "Voltar à versão anterior" restaura o mesmo hash (teste unitário com n8n falso + ensaio no n8n real).
- **CA-47** Empresa que tinha `MAIN_MENU` editado: `MENU_PROMPT` = cabeçalho dela depois da migration; `BotText` legado intacto.

---

## 11. Bugs da auditoria da Íris: como a v2 resolve cada um

Fonte: `docs/qa/auditoria-bot-2026-09-30.md` (commit `4757b84`). "Cenário v1" = id em
`scripts/bot-sim/scenarios*.mjs`; "CA" = critério da §10, cenário homônimo em `scenarios-v2.mjs`.

| Bug | Sev. | Como a v2 resolve | Onde | Cenário v1 → CA |
|---|---|---|---|---|
| BUG-01 "sim/ok/👍" não confirmam; 3 erros chamam atendente | Crítico | Aliases por estado **antes** da cortesia; normalização de emoji e tom de pele; sem handoff automático | §2.4.1, §2.4.2 | D5, C1, D6 → CA-13, CA-11 |
| BUG-02 handoff cala 12 h sem aviso e sem volta | Alto | Handoff só a pedido; aviso com `{retorno}` e "digite menu"; sino; volta por "menu" ou em 2 h; resposta da equipe estende | §3.10 | D3, O1 → CA-04, CA-26, CA-32–34 |
| BUG-03 nome aceita qualquer texto | Alto | Comandos antes do nome; `validateName` com palavras reservadas e sanitização; gravado só na reserva | §3.1, §2.4.1 | F1, F2, C3 → CA-10, CA-01 |
| BUG-04 erro/404 deixa o cliente mudo | Alto | `neverError` + "Resultado X" classifica; 404 → `ITEM_UNAVAILABLE`; 5xx/timeout → `TECH_ERROR`; release avisa o cliente | §3.11 | W1, W2 → CA-29, CA-30, CA-31 |
| BUG-05 "Ver mais datas" repete o último dia | Médio | `nextFrom` = dia seguinte ao último mostrado | §3.4 | R2, R4 → CA-18 |
| BUG-06 paginação pula número, é cíclica, sem voltar | Médio | `buildPage` do motor: 1..n contínuo, "Ver mais" só se houver, "Ver anteriores" | §3.4, §3.5 | R1, R4, N2 → CA-18 |
| BUG-07 SLOT_TAKEN com horários de outro dia sem o dia | Médio | Texto com `{data}`; alternativas com `dateLabel` | §3.7, §5.3 | S1 → CA-21 |
| BUG-08 fora do prazo só é recusado no fim | Médio | `canChange` na lista → `APPOINTMENT_LOCKED` + atendente; `TOO_LATE` com atendente | §3.8 | N3 → CA-24 |
| BUG-09 profissional/serviço sem expediente oferecidos | Médio | Filtro por `WorkingHour` no catálogo; `NO_SERVICES` e `NO_AVAILABILITY` com atendente | §3.2, §3.3 | K1, K2 → CA-37 |
| BUG-10 "Olá, !" com pushName vazio/lixo | Médio | `contact.firstName` (só com letras) + limpeza de pontuação | §3.1, §5.2 | V2 → CA-39 |
| BUG-11 editar o menu desacopla número e ação | Médio | Texto editável é só cabeçalho (`MENU_PROMPT`); numeração gerada; porte da edição | §5.1, §8 | X1 → CA-43, CA-47 |
| BUG-12 variável literal | Médio | Renderizador v2 esvazia; variáveis permitidas por chave no editor | §5.2, §5.3 | X2 → CA-38 |
| BUG-13 sessão expirada descarta a mensagem | Médio/baixo | Mensagem avaliada contra o menu na sessão nova; "menu" não diz "recomecei" | §2.4.1 regra 2 | P1 → CA-27 e cenário "lembrete" em CA-27 |
| BUG-14 NO_SLOTS_DAY mantém o dia vazio | Baixo | Lista rebuscada a partir do próximo dia livre | §3.4 | J1 → CA-17 |
| BUG-15 rótulo +1 dia em UTC+12 ou mais | Baixo | Rótulo por meio-dia **local** (`formatDayLabelFromISO`) | §8 | T1 → CA-42 |
| BUG-16 grade escorrega depois de serviço não múltiplo | Baixo/médio | Grade ancorada no relógio, 15 ou 30 (decisão do dono) | §3.5 | G2 → CA-36 |
| BUG-17 nome > 60 responde "Não entendi" | Baixo | `NAME_TOO_LONG`, não conta como opção errada do menu | §3.1 | C3 → CA-10 |

**Riscos da auditoria que não eram bugs:**

| Risco | Tratamento na v2 |
|---|---|
| Sem limite de agendamentos por cliente (N2, S5) | Limite por empresa, padrão 3 (§3.7, CA-35) |
| Eco do bot com diferença mínima vira "dono assumiu" | Mantido o hash exato; `Salvar sessão` recebe exatamente o texto enviado. Monitorar `HUMAN_TOOK_OVER` logo após mensagem do bot (runbook). Sem mudança de desenho |
| Salvar antes de enviar; falha de envio sem retry | **Dívida consciente**: não muda na v2 (retry no envio arrisca mensagem duplicada). Registrado no runbook |
| Descarte silencioso (ocupado, STALE, retry do claim) | Mantido. Fora do escopo; o `TECH_ERROR` do release não cobre (não há trava da execução) |
| Idempotência contato+serviço+início devolve agendamento de outra profissional | Mantido (raro). O `BOOKED` mostra o profissional real do agendamento devolvido |

**UX da auditoria:** 1 → §2.4.3 e textos por situação; 2 → §2.5; 3 → cabeçalhos com contexto
(§5.3); 4 → "Primeiro disponível"; 5 → `CONFIRM_RESCHEDULE`; 6 → `CANCEL_KEPT`, `CANCELED`,
`BOOKED` com prazo; 7 → §2.4.1 regra 2; 8 → `TOO_LATE` com atendente; 9 → textos distintos
(`NO_SERVICES`, `NO_AVAILABILITY`, `ITEM_UNAVAILABLE`, `TECH_ERROR`); 10 → aliases e parse; 11 →
1º nome (a saudação repete a cada sessão nova: mantido); 12 → formatação v2 e `POST_ACTION` no
lugar do menu inteiro; 13 → filtro por expediente (categorias ficam fora); 14 → §3.10; 15 → `0`
só no rodapé, "voltar" explícito.

---

## 12. Riscos, dívidas e decisões

### 12.1 Riscos

| # | Risco | Mitigação |
|---|---|---|
| R1 | O *bundle* do motor no Code node diverge do fonte | Teste de estrutura compara com um build novo; o simulador roda o JSON real |
| R2 | Publicar sobrescreve edição feita no n8n | Drift por hash + "Baixar a versão do n8n" (§9) |
| R3 | `webhookId`/`path` mudar derruba todas as instâncias | Merge copia do vivo; aborta se o `path` mudar; verificação pós-publicação com rollback automático |
| R4 | Padrões novos com o fluxo antigo geram `{variavel}` literal | Textos por versão de fluxo; CA-45 |
| R5 | Mudar a grade para 30 no deploy muda a agenda de todas as empresas antes do Publicar | Aceito: é regra de agenda, decidida pelo dono; comunicado no manual. Reversível pela tela (15) |
| R6 | "menu" do cliente devolve o bot no meio de uma conversa com o atendente | Aceito e intencional (decisão do dono); o texto do handoff avisa |
| R7 | O relógio do n8n diverge do painel | O motor não usa relógio próprio: `today`/`nowLocal` vêm do claim |
| R8 | `TECH_ERROR` do release duplicar uma resposta já enviada | Só dispara com a trava ainda da execução que morreu (antes de salvar); limite de 1 a cada 10 min |
| R9 | Keycaps aparecem como "1⃣" em aparelhos muito antigos | Aceito; o renderizador tem uma constante para trocar por `*1* ·` |
| R10 | Horário da equipe pela união dos profissionais pode não refletir a recepção | Aceito (P4) |

### 12.2 Dívidas conscientes
- Base de textos v1 convive com a v2 por um release.
- Snapshot de rollback guarda uma versão só.
- Publicação manual, sem auto-publicar no boot.
- Sem mensagem ativa quando a pausa do atendente vence.
- `HandoffRequest` sem purga automática (volume baixo; entra no `maintenance/tick` depois).
- Salvar antes de enviar, sem retry de envio.

### 12.3 Pendências do dono
Nenhuma bloqueante. Ver o plano §7 para as confirmações de baixo risco.

### 12.4 Decisões do dono (2026-09-30)

- **P1:** teste real na Evolution 2.3.7: botões com 201 e sem entrega; lista com 400 (`TypeError:
  this.isZero is not a function`); enquete chega, mas não serve ao fluxo. **Bot v2 só em texto
  numerado.** O card de teste em Admin → Saúde fica para reavaliar.
- **P2:** textos aprovados com o tom proposto, **mantendo "Falar com atendente"**.
- **P3:** textos que a empresa editou e mudaram de lugar são **portados** para a chave nova.
- **P4:** horário de retorno da equipe = derivado dos horários dos profissionais.
- **P5:** 2 respostas inválidas seguidas → volta ao menu, sem transferir.
- **Atendente:** pausa, aviso ("digite *menu*"), notificação no sino; volta com *menu* ou depois de
  2 h sem resposta da equipe. Substitui o silêncio de 12 h.
- **Limite:** no máximo 3 agendamentos futuros por cliente, ajustável por empresa. Acima disso,
  mostra os existentes e oferece remarcar, cancelar ou atendente.
- **Grade redonda:** 15 ou 30 min por empresa, padrão 30.
- **Paginação (Atlas, 2026-09-30):** o limite é de 9 opções (keycaps 1️⃣ a 9️⃣).
  - **`SELECT_TIME`:** páginas de **7 horários**, mais "Mais" e "Anteriores" quando houver.
  - **`SELECT_DAY`:**
    - 1ª página: "Primeiro horário livre" + **6 dias** + "Ver mais datas";
    - páginas seguintes: 6 dias + "Mais" + "Anteriores".
  
  - **Serviços, profissionais e Meus agendamentos** (listas que a API entrega inteiras, paginadas
    em memória pela cola do fluxo, `pageOf`): se a lista **cabe em 9** opções, **não pagina**. Se não
    cabe, a 1ª página tem **8 itens + "Ver mais"**, as do meio **7 + "Ver mais" + "Ver anteriores"** e a
    última traz **o que sobrar + "Ver anteriores"**. Respeita o teto de 9 keycaps; o "7/6" acima é
    o das páginas do meio (dias e horários, que vêm da API).

  Isso substitui o "até 8" das §3.4 e §3.5.
- **Esclarecimentos para os critérios (Atlas, 2026-09-30):**
  - **CA-41:** o rodapé "Digite *0* para o menu ou *voltar*…" vale para as **telas de escolha** (serviço, profissional, dia, horário, meus agendamentos, ação do agendamento, confirmação). Não vale para `POST_ACTION`, `RESUME_OFFER` e `APPOINTMENT_LOCKED`, que seguem os exemplos da §5.4.
  - **CA-03:** vale a §2.4.3: um comando **zera** o `invalidCount`.
  - **CA-30:** o 404 de item indisponível pode vir de qualquer endpoint da etapa (profissionais, dias ou horários). O fluxo trata os três igualmente com `ITEM_UNAVAILABLE`.
