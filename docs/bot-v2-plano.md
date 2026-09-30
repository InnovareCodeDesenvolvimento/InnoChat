# Bot v2: plano de construção

> Autora: Nova · 2026-09-30 · missão `cmuo2slkk059d01lf61dnj90z`
> Fonte do comportamento: `docs/bot-v2-especificacao.md` (a "spec"; § sem prefixo = seção da spec).
> Este documento é a fonte dos **contratos exatos** entre as tarefas (§3) e da **posse de arquivos**
> (§6). Nenhuma tarefa toca arquivo de outra; quem precisar pede ao Atlas.

---

## 0. Resumo

- **18 tarefas** (C-1, A-1/2, B-1/2/3, D-1, W-1, L-1..4, I-0..3, O-1, X-1) em 4 ondas. Na onda 0
  rodam 4 frentes ao mesmo tempo (C-1, A-1, A-2, I-0); na onda 1, até 6.
- O painel novo sobe **antes** e convive com o workflow v1. O v2 só entra no ar pelo botão
  "Publicar fluxo", que também faz o rollback.
- Duas mudanças de desenho em relação ao pedido original, com motivo:
  1. **Grade:** reaproveita `Tenant.slotGranularityMin` (15 ou 30, padrão 30), em vez de criar
     `slotStepMinutes`. O campo já é o passo da grade; dois campos com o mesmo significado
     divergiriam.
  2. **Migration:** são **duas pastas** em sequência, no mesmo commit do Cronos. `ALTER TYPE …
     ADD VALUE` não pode ser usado pela migração de dados na mesma transação ("unsafe use of new
     value"). A 1ª é o schema; a 2ª porta os textos.
- O motor (`src/core/bot/engine`) é TypeScript puro, compilado para dentro dos Code nodes
  `Interpretar` e `Montar mensagem` (spec §7.2). O roteamento continua visível no n8n.

---

## 1. Ondas e dependências

```
Onda 0 (agora)        Onda 1                         Onda 2                         Onda 3
─────────────         ──────                         ──────                         ──────
C-1 Cronos ───────┬─► B-1 Vega (agenda/catálogo) ─┬─► W-1 Vega (workflow v2) ─────┬─► I-3 Íris veredito
A-1 Vega (core) ──┼─► B-2 Vega (claim/handoff) ───┤                               ├─► O-1 Órion
A-2 Vega (motor) ─┼─► B-3 Vega (textos/regras) ───┼─► L-3 Lyra (Mensagens do bot) ├─► X-1 Alexandria
I-0 Íris (sim) ───┼─► D-1 Vega (Publicar fluxo) ──┼─► L-4 Lyra (admin Publicar)   └─► Deploy (§5)
I-1 Íris (cenários, a partir dos contratos)       │
                  ├─► L-1 Lyra (Configurações) ◄──┘ (merge depois de B-3)
                  └─► L-2 Lyra (sino) ◄──────────── (merge depois de B-2)
```

| Tarefa | Quem | Depende de (para **commitar**) | Pode começar |
|---|---|---|---|
| C-1 | Cronos | migration `User.sessionVersion` já commitada | assim que ela entrar |
| A-1 | Vega | — | agora |
| A-2 | Vega (2ª instância) | — | agora |
| I-0 | Íris | — | agora |
| I-1 | Íris | I-0 | agora (escreve contra os contratos; os cenários nascem vermelhos) |
| B-1 | Vega | C-1, A-1 | depois de A-1 |
| B-2 | Vega (2ª instância) | C-1, A-1 | depois de A-1 |
| B-3 | Vega (3ª instância) | C-1, A-1 | depois de A-1 |
| D-1 | Vega (4ª instância) | C-1 | depois de C-1 (trabalha com o JSON v1 atual) |
| L-1 | Lyra | B-3 (actions) | contra o contrato §3.5, assim que C-1 entrar |
| L-2 | Lyra | B-2 (kind no serviço) | contra o contrato §3.5 |
| W-1 | Vega | A-2, B-1, B-2 (para o simulador ficar verde) | estrutura logo depois de A-2 |
| L-3 | Lyra | A-1, A-2, B-3 | depois de A-2 |
| L-4 | Lyra | D-1 | depois de D-1 |
| I-2 | Íris | L-1..L-4 | E2E quando as telas entrarem |
| I-3 | Íris | W-1, B-*, D-1 | veredito final |
| O-1 | Órion | W-1, B-2, D-1 | revisão |
| X-1 | Alexandria | I-3 aprovado | docs |

A quantidade de instâncias da Vega é escolha do Atlas: A-1/A-2 e B-1/B-2/B-3/D-1 têm arquivos
disjuntos e podem rodar juntos, mas também podem ser feitos em sequência pela mesma Vega.

---

## 2. Regras de convivência (valem para todas as tarefas)

1. **Só toque nos arquivos da sua tarefa (§6).** Precisou de outro? Pare e peça ao Atlas.
2. **Commit por pathspec** (`git add <seus arquivos>`), nunca `git add -A`, nunca `git stash`.
   Outros agentes estão editando a mesma árvore.
3. **Validar isolado:** `npm test`, `npm run typecheck` e o simulador rodam num
   `git worktree add --detach <pasta> HEAD` com o seu commit, para não medir o WIP dos outros.
4. **Cada commit deixa `npm test` e `typecheck` verdes.** Contrato novo entra com valor padrão que
   não quebra quem ainda não o usa (ex.: `getMergedBotTexts(tenantId, flowVersion = 1)`).
5. **Tudo aditivo na API interna.** Campo existente não muda de nome, tipo ou significado. As
   exceções, que são correções de bug, estão listadas em §5.1.
6. **Lockfile:** se tocar em `package-lock.json`, regenere com `npx npm@10.9.9` (memória do
   projeto: o npm 11 quebra o `npm ci` da imagem node:22).
7. Cada tarefa termina com o handoff da skill `handoff-da-equipe`, dizendo o que foi **provado**
   (comando + resultado) e o que não foi.

---

## 3. Contratos exatos

### 3.1 Dados (C-1)

```prisma
// Tenant — acréscimos e mudança de padrão
slotGranularityMin              Int @default(30)   // era 15. Migration: UPDATE para 30 + CHECK IN (15, 30)
maxFutureAppointmentsPerContact Int @default(3)    // 0 = sem limite. CHECK 0..20
handoffResumeMinutes            Int @default(120)  // CHECK 30..1440
handoffRequests                 HandoffRequest[]

enum HandoffReason    { CLIENT_REQUEST  LEGACY_FLOW }
enum HandoffEndReason { CLIENT_MENU  TIMEOUT  PANEL_RESUME }

model HandoffRequest {
  id                 String            @id @default(cuid())
  tenantId           String
  whatsappInstanceId String
  contactId          String
  chatSessionId      String
  reason             HandoffReason
  offHours           Boolean           @default(false)
  requestedAt        DateTime          @default(now())
  answeredAt         DateTime?         // 1ª resposta fromMe da equipe
  endedAt            DateTime?
  endReason          HandoffEndReason?
  // relações com onDelete: Cascade para Tenant, WhatsappInstance, Contact, ChatSession (+ back-relations)
  @@index([tenantId, requestedAt])
  @@index([chatSessionId, endedAt])
  @@map("handoff_requests")
}
// SQL cru na migration (o Prisma não expressa índice parcial):
// CREATE UNIQUE INDEX "handoff_requests_one_open_per_session"
//   ON "handoff_requests"("chatSessionId") WHERE "endedAt" IS NULL;

// PlatformSettings — acréscimos
n8nBotFlowVersion           String?   // "2.0.0" (Config.flowVersion do JSON publicado)
n8nBotFlowHash              String?   // hash canônico do que foi publicado (§3.6)
n8nBotFlowPublishedAt       DateTime?
n8nBotFlowPublishedByUserId String?   // sem FK (auditoria simples)
n8nBotFlowPrevious          Json?     // { version, hash, nodes, connections } do vivo antes do último PUT
```

`BotTextKey` ganha **46 valores** (`ALTER TYPE "BotTextKey" ADD VALUE IF NOT EXISTS`, padrão da
`20260928000006`):

- mensagens (26): `MENU_PROMPT`, `MENU_HINT`, `FOOTER_HINT`, `CONTINUE_PROMPT`, `HELP`,
  `NO_SERVICES`, `NEXT_AVAILABLE`, `DATE_OUT_OF_RANGE`, `TIME_NOT_AVAILABLE`, `ITEM_UNAVAILABLE`,
  `APPOINTMENT_LIMIT`, `NAME_INVALID`, `NAME_TOO_LONG`, `CONFIRM_RESCHEDULE`, `CONFIRM_EDIT`,
  `POST_ACTION_MENU`, `APPOINTMENT_DETAIL`, `APPOINTMENT_LOCKED`, `CANCEL_KEPT`,
  `HUMAN_HANDOFF_OFF_HOURS`, `BOT_RESUMED`, `INVALID_BACK_TO_MENU`, `AMBIGUOUS_OPTION`,
  `RESUME_OFFER`, `THANKS_REPLY`, `TECH_ERROR`;
- rótulos (20): `LABEL_MENU_BOOK`, `LABEL_MENU_MY`, `LABEL_MENU_HUMAN`, `LABEL_ANY_PROFESSIONAL`,
  `LABEL_NEXT_AVAILABLE`, `LABEL_BY_DAY`, `LABEL_EDIT`, `LABEL_EDIT_SERVICE`,
  `LABEL_EDIT_PROFESSIONAL`, `LABEL_EDIT_DATETIME`, `LABEL_EDIT_NAME`, `LABEL_RESCHEDULE`,
  `LABEL_CANCEL_APPOINTMENT`, `LABEL_BOOK_ANOTHER`, `LABEL_FINISH`, `LABEL_CONTINUE`,
  `LABEL_START_OVER`, `LABEL_BACK`, `LABEL_OTHER_SERVICE`, `LABEL_PREVIOUS`.

Nenhum valor antigo sai do enum.

**Migração de textos** (2ª pasta, idempotente, `ON CONFLICT ("tenantId","key") DO NOTHING`, sem
apagar as linhas legadas):

| De (editado pela empresa) | Para | Regra |
|---|---|---|
| `MAIN_MENU` | `MENU_PROMPT` | Texto até a 1ª linha que começa com opção (`^\s*([0-9]+\|[0-9]️⃣)\s*[.)\-:–]?\s`), aparado. Vazio → não porta |
| `APPOINTMENT_ACTIONS` | `APPOINTMENT_DETAIL` | `'*{servico}* com {profissional}' \|\| E'\n' \|\| '{data_longa} às *{hora}*' \|\| E'\n\n' \|\|` cabeçalho extraído pela mesma regra. Vazio → não porta |
| `TOO_MANY_INVALID`, `LABEL_BACK_TO_MENU`, `LABEL_OTHER_TIME` | — | Não portadas: mudaram de significado (spec §8) |

Um `RAISE NOTICE` com a contagem de linhas portadas por chave fica no log do boot.

### 3.2 Motor (A-2 → W-1, L-3, B-*)

`src/core/bot/engine/` — **sem imports fora da pasta**, sem `Date.now()`/`new Date()` sem
argumento, sem `Intl` de fuso, sem APIs do Node. Alvo ES2020. `index.ts` exporta exatamente:

```ts
// types.ts
export type Vars = Record<string, string | number | null | undefined>;
export type Texts = Record<string, string>;
export type EngineClock = { today: string /* YYYY-MM-DD no fuso do tenant */; nowLocal: string /* HH:mm */ };
export type OptionV2 = { n: number; id: string; title: string; detail?: string | null; match?: string; aliases?: string[] };
export type LegacyOption = { n: number; id: string; label: string };
export type Period = "morning" | "afternoon" | "evening";
export type ParsedInput = {
  raw: string; norm: string;
  number: number | null;            // "2", "2️⃣", "2.", "2)", "#2", "opção 2", "nº 2", " 02 "
  date: string | null;              // YYYY-MM-DD (hoje, amanhã, depois de amanhã, seg..dom, "que vem"/"próxima", dd/mm, dd/mm/aa(aa), dd-mm, "dia 15", "15 de outubro")
  time: string | null;              // HH:mm (15h, 15 h, 15hs, 15:30, 15h30, 15.30, "3 da tarde", "meio dia")
  period: Period | null;            // manhã | tarde | noite
  yes: boolean; no: boolean;        // 👍 ✅ 👌 (qualquer tom) / ❌ 👎
};
export type Command = "MENU" | "BACK" | "EXIT" | "HUMAN" | "HELP" | "GREETING" | "THANKS";
export type Intent =
  | { kind: "media" }
  | { kind: "command"; command: Command }
  | { kind: "option"; option: OptionV2; via: "number" | "alias" | "text" }
  | { kind: "ambiguous"; candidates: OptionV2[] }
  | { kind: "date"; date: string; time: string | null }
  | { kind: "time"; time: string }
  | { kind: "period"; period: Period }
  | { kind: "name"; name: string }
  | { kind: "name_invalid"; reason: "TOO_LONG" | "INVALID" }
  | { kind: "invalid" };
export type Route =
  | "MEDIA" | "CMD_MENU" | "CMD_BACK" | "CMD_EXIT" | "CMD_HUMAN" | "CMD_HELP" | "CMD_CONTINUE"
  | "CMD_THANKS" | "REPROMPT" | "INVALID_1" | "INVALID_2" | "AMBIGUOUS" | "FRESH" | "RESUME" | "STATE";
export type Block = { key: string; vars?: Vars; options?: OptionV2[]; footer?: "MENU_HINT" | "FOOTER_HINT" };

// funções
export function normalizeText(raw: string): string;                                    // spec §2.4.2
export function parseInput(raw: string, clock: EngineClock): ParsedInput;              // spec §2.4.1 regras 7-8
export function validateName(raw: string): { ok: true; name: string } | { ok: false; reason: "TOO_LONG" | "INVALID" };
export function interpret(input: {
  state: string; text: string | null /* null = mídia */;
  options: (OptionV2 | LegacyOption)[]; clock: EngineClock;
}): Intent;                                                                            // ordem da spec §2.4.1 (regras 3-10)
export function routeFor(input: {
  intent: Intent; state: string; invalidCount: number;
  fresh: boolean /* nova, expirada ou voltando do humano */; resumable: boolean;
}): { route: Route; invalidCount: number; greet: boolean };
export function isResumable(previous: { state: string; context: unknown } | null): boolean;   // spec §2.7
export function mapLegacyOptions(options: LegacyOption[], state: string): OptionV2[];
export function pageSlice<T>(all: T[], page: number, size?: number /* 8 */): { items: T[]; hasMore: boolean; hasPrev: boolean };
export function buildOptions(input: {
  leading?: Omit<OptionV2, "n">[]; items: Omit<OptionV2, "n">[]; trailing?: Omit<OptionV2, "n">[];
  hasMore?: boolean; hasPrev?: boolean; labels: { more: string; prev: string };
}): OptionV2[];                                                                        // numera 1..n contínuo; MORE/PREV com ids "MORE"/"PREV"; lança se > 9
// Toda OptionV2 gravada no context leva também `label` (= title): permite que o Interpretar v1 leia
// a sessão se o fluxo for revertido (plano §5.3). Os ids dinâmicos são os mesmos da v1.
export function pushTrail(trail: string[] | undefined, state: string): string[];       // máx. 12, sem repetir o topo
export function popTrail(trail: string[] | undefined): { trail: string[]; target: string /* "MAIN_MENU" se vazio */ };
export function renderTemplateV2(template: string, vars: Vars): string;                // spec §5.2
export function renderMessage(blocks: Block[], texts: Texts): string;                  // blocos separados por 1 linha em branco
export function keycap(n: number): string;                                             // 1..9 → "1️⃣"; fora disso lança
export const STATIC_OPTION_IDS: Record<string, string[]>;   // ids fixos por estado (spec §2.4.1, tabela de aliases)
export const STATE_ALIASES: Record<string, Record<string, string[]>>;
export const RESERVED_NAME_WORDS: readonly string[];
```

Ids fixos das opções estáticas: `MAIN_MENU` = `BOOK`, `MY`, `HUMAN`; `CONFIRM` = `CONFIRM`,
`EDIT`; `CONFIRM_EDIT` = `SERVICE`, `PROFESSIONAL`, `DATETIME`, `NAME`; `CONFIRM_CANCEL` = `YES`,
`NO`; `RESUME_OFFER` = `CONTINUE`, `RESTART`; `APPOINTMENT_ACTION` = `RESCHEDULE`, `CANCEL`,
`BACK`, `HUMAN`; `POST_ACTION` = `BOOK`, `MY`, `FINISH`; `NO_AVAILABILITY` = `HUMAN`,
`OTHER_SERVICE`; `SELECT_DAY` = `NEXT` (primeiro livre) e `MORE`/`PREV`; `NEXT_SLOTS` = `BY_DAY`;
`LIMIT_REACHED` = ids dos agendamentos + `HUMAN`. Dados dinâmicos usam o id do painel.

### 3.3 Core do painel (A-1 → B-*, L-3)

```ts
// src/core/bot/format.ts (acréscimos; o que existe não muda)
export function formatDurationLabel(min: number): string;                       // 40→"40 min", 60→"1h", 90→"1h30", 125→"2h05"
export function formatLongDayLabel(date: Date, tz: string): string;             // "sexta-feira, 02/10"
export function formatDayLabelFromISO(iso: string, tz: string): string;         // "Sex 02/10" pelo meio-dia LOCAL (BUG-15)
export function formatRelativeDayLabel(iso: string, todayISO: string, tz: string): string; // "Hoje · Qua 30/09" | "Amanhã · Qui 01/10" | "Sex 02/10"
export function formatLeadLabel(min: number): string;                           // 120→"2 horas", 30→"30 minutos", 90→"1h30", 1440→"24 horas"
export function formatWhenLabel(at: Date, now: Date, tz: string): string;       // "hoje às 14:00" | "amanhã às 09:00" | "Seg 05/10 às 09:00"
export function firstNameForGreeting(name: string | null, pushName: string | null): string | null; // 1º nome com ≥2 letras

// src/core/bot/texts-v2.ts (novo; texts.ts da v1 fica congelado)
export const BOT_TEXT_KEYS_V2: readonly BotTextKeyV2[];    // chaves v1 não legadas + as 46 novas
export const LEGACY_V1_KEYS: readonly ["MAIN_MENU", "APPOINTMENT_ACTIONS", "TOO_MANY_INVALID", "LABEL_BACK_TO_MENU", "LABEL_OTHER_TIME"];
export const DEFAULT_BOT_TEXTS_V2: Record<BotTextKeyV2, string>;                  // spec §5.3, literal
export const BOT_TEXT_VARIABLES_V2: readonly string[];                           // 8 da v1 + 7 novas
export const BOT_TEXT_ALLOWED_VARS: Record<BotTextKeyV2, readonly string[]>;     // spec §5.3, tabela
export const BOT_TEXT_CATALOG: Record<BotTextKeyV2, {
  group: "conversa" | "agendamento" | "meus" | "atendente" | "rotulos";
  title: string; description: string;                                          // texto humano para a tela
}>;
export function findDisallowedVariables(key: BotTextKeyV2, text: string): string[];

// src/core/agenda (mesma assinatura; muda a semântica)
computeAvailableSlots(params)   // candidatos = múltiplos de slotGranularityMin desde a meia-noite LOCAL de dateISO
export function teamOpening(p: {
  timezone: string; workingHours: WorkingHourRule[] /* união dos profissionais ativos */;
  closedRanges: ClosedRange[] /* exceções da empresa */; now: Date; horizonDays?: number /* 14 */;
}): { openNow: boolean; nextOpenAt: Date | null };
```

### 3.4 API interna (B-1, B-2 → W-1, I-1)

Todas as rotas continuam em `/api/internal/v1`, com `Authorization: Bearer` e
`X-InnoChat-Instance`. **Novo header**: o workflow v2 envia `X-InnoChat-Flow: 2` em **todos** os
nós HTTP do painel. `flowVersionOf(req): 1 | 2` fica em `src/modules/bot-api/flow-version.ts`
(B-1, primeiro commit). Sem o header = 1.

**B-1: catálogo, disponibilidade, agendamentos**

```ts
// GET /catalog/services[?contactId]
{ options: { id: string; label: string; durationMin: number;            // existentes
             name: string; durationLabel: string; priceLabel: string | null }[],   // novos
  limit?: { max: number /* 0 = sem limite */; count: number; reached: boolean } }  // só com contactId
// Só serviços com ≥1 profissional ativo COM WorkingHour. contactId de outro tenant → 404.

// GET /catalog/services/{id}/professionals — mesmo formato; só profissionais com WorkingHour.
// `skip` = !askProfessional || (profissionais com expediente) <= 1. 404 se o serviço estiver inativo.

// GET /availability/days?serviceId&professionalId&from&limit
{ options: { id: string /* YYYY-MM-DD */; label: string /* "Qua 30/09", meio-dia local */;
             relativeLabel: string /* "Hoje · Qua 30/09" */ }[],
  hasMore: boolean,
  nextFrom: string | null,                  // CORREÇÃO BUG-05: dia SEGUINTE ao último mostrado
  lastBookableDate: { id: string; label: string } }

// GET /availability/slots?serviceId&professionalId&date&offset&limit[&period][&near]
{ options: { id: string /* ISO UTC */; label: string /* HH:mm */ }[], hasMore: boolean,
  exact?: boolean,                          // só com near: options[0] é exatamente near
  dateLabel: string, dateRelativeLabel: string, dateLongLabel: string,
  reason: null | "PAST" | "BEYOND_HORIZON" | "CLOSED" | "FULL",   // preenchido só com options vazio
  nextDay: { id: string; label: string; relativeLabel: string } | null }
// period=morning|afternoon|evening filtra (<12, 12–18, ≥18, hora local).
// near=HH:mm ordena por distância; limit padrão 3 nesse modo.

// GET /availability/next?serviceId&professionalId&limit=6   (NOVO)
{ options: { id: string /* ISO */; label: string /* "Hoje · 16:30" */; date: string /* YYYY-MM-DD */ }[] }

// GET /contacts/{contactId}/appointments — cada item ganha:
{ canChange: boolean;                 // startsAt - agora >= cancelMinLeadMin
  changeDeadlineLabel: string;        // formatLeadLabel(cancelMinLeadMin)
  durationLabel: string; priceLabel: string | null;
  dataLonga: string; relativeLabel: string }

// POST /appointments — corpo ganha
{ contactName?: string }   // validado com validateName do motor; inválido → 422 INVALID_NAME
// Gravado em Contact.name na mesma transação da reserva (também quando alreadyExisted).
// 422 LIMIT_REACHED { details: { max: number; count: number } }
//   — só quando X-InnoChat-Flow = 2 e max > 0; contagem sob SELECT … FOR UPDATE na linha do contato.
// summary ganha { duracao: string; preco: string | null; data_longa: string } (profissional = o real)

// POST /appointments/{id}/reschedule — summary idem; 409 SLOT_TAKEN:
//   alternatives: { date /* label, existente */; dateISO; dateRelativeLabel; options }
```

`src/lib/api-internal/respond.ts`: `LIMIT_REACHED` → 422.

**B-2: conversa**

```ts
// POST /messages/claim — com X-InnoChat-Flow: 2, a resposta "process" é:
type ClaimProcessResponseV2 = ClaimProcessResponse /* v1, inalterado */ & {
  flow: 2;
  contact: { id: string; name: string | null; pushName: string | null; firstName: string | null };
  session: { /* campos v1 */
    previous: { state: string; context: unknown; idleMin: number } | null;  // expirou há <= 24 h
    resumedFromHuman: null | "CLIENT_MENU" | "TIMEOUT" };                  // o bot acabou de voltar
  tenant: { /* campos v1 */
    today: string; nowLocal: string;          // relógio do painel no fuso do tenant (EngineClock)
    openNow: boolean; teamNextOpenLabel: string | null;
    handoffUntilLabel: string;                // formatWhenLabel(agora + handoffResumeMinutes)
    changeLeadLabel: string;                  // formatLeadLabel(cancelMinLeadMin)
    lastBookableDate: string;                 // YYYY-MM-DD
    slotGranularityMin: 15 | 30 };
  texts: Record<BotTextKeyV2, string>;        // getMergedBotTexts(tenantId, 2)
};
```

Regras novas do claim (valem **com ou sem** o header, porque dependem de dado que só a v2 cria,
exceto quando indicado):

1. `state=HUMAN`, `humanUntil > agora`, `HandoffRequest` aberto com `reason=CLIENT_REQUEST` e
   mensagem do cliente que normaliza para `menu` ou `0` → encerra o pedido (`CLIENT_MENU`), zera
   `humanUntil`, `state=MAIN_MENU`, `context={}` e devolve `process` com
   `resumedFromHuman="CLIENT_MENU"`. Outra mensagem → `ignore/HUMAN_MODE`, como hoje.
2. `state=HUMAN`, `humanUntil <= agora`, pedido aberto → encerra (`TIMEOUT`) e processa como
   sessão nova com `resumedFromHuman="TIMEOUT"`.
3. `fromMe` que não é eco, com pedido aberto → `answeredAt` (se nulo), `humanUntil = agora +
   handoffResumeMinutes` (v2; v1 segue em `humanPauseMin`), `ignore/HUMAN_TOOK_OVER`. **Não** grava `Contact.botPausedUntil`. Precisa ser
   avaliado **antes** do teste de `HUMAN_MODE` (hoje o `fromMe` em `HUMAN` cai em `HUMAN_MODE`).
4. `fromMe` sem pedido aberto → comportamento v1 inalterado.
5. Expirou (`sessionTimeoutMin`) e a última atividade foi há ≤ 24 h → `session.previous` com o
   estado e o contexto **anteriores** ao reset. Só com o header 2.

```ts
// PUT /sessions/{id} — corpo ganha
{ handoffReason?: "CLIENT_REQUEST" }
// handoff=true + handoffReason → state=HUMAN, humanUntil = agora + handoffResumeMinutes,
//   HandoffRequest(CLIENT_REQUEST, offHours = !teamOpening.openNow) — reaproveita o aberto (índice parcial).
// handoff=true sem handoffReason (fluxo v1) → como hoje (humanPauseMin) + HandoffRequest(LEGACY_FLOW).
// Resposta inalterada: { version }.

// POST /sessions/{id}/release — corpo ganha
{ notify?: boolean /* padrão true */ }
// Resposta: { released: true; notified: boolean }
// notified=true só se: lockToken bateu (a execução morreu segurando a trava) E lastInboundAt <= 5 min
//   E nenhum ChatMessage OUTBOUND deste contato/instância com o corpo do TECH_ERROR nos últimos 10 min
//   (o recentOutbound não serve: é podado em 2 min) E state != HUMAN E bot não pausado
//   E assinatura ativa. Envio: instância sandbox → outbox; senão evolution-client.sendText.
//   Texto: getMergedBotTexts(tenantId, 2).TECH_ERROR. Registra ChatMessage OUTBOUND e o hash de eco.
//   Falha no envio: loga e devolve notified=false (nunca 5xx por causa do aviso).
```

`ContactsService.resumeBot` (botão "Retomar bot") encerra o pedido aberto com `PANEL_RESUME`.

### 3.5 Server Actions e notificações (B-2, B-3, D-1 → Lyra)

```ts
// B-3 — src/modules/tenant/actions.ts (OWNER)
getBotRulesAction(tenantSlug: string): Promise<Result<BotRules>>;
updateBotRulesAction(tenantSlug: string, input: {
  maxFutureAppointmentsPerContact: number;   // inteiro 0..20 (0 = sem limite)
  slotGranularityMin: 15 | 30;
  handoffResumeMinutes: number;              // 30..1440, múltiplo de 15
}): Promise<Result<BotRules>>;
type BotRules = { maxFutureAppointmentsPerContact: number; slotGranularityMin: 15 | 30;
                  handoffResumeMinutes: number; humanPauseMin: number /* só leitura */ };
// Erro: INVALID_PAYLOAD com details { field }.

// B-3 — src/modules/bot-texts/bot-text-actions.ts (formas novas; nomes iguais)
listBotTextsAction(tenantSlug): Promise<Result<BotTextsView>>;
type BotTextsView = {
  flowVersion: 1 | 2;                        // major de PlatformSettings.n8nBotFlowVersion; nulo → 1
  items: { key: string; text: string; isDefault: boolean; legacy: boolean }[];
};
// flowVersion 1 → itens = BOT_TEXT_KEYS (v1), como hoje.
// flowVersion 2 → BOT_TEXT_KEYS_V2 com padrões v2 + legados EDITADOS com legacy=true (só leitura na UI).
upsertBotTextAction(tenantSlug, { key, text });   // v2: rejeita variável fora de BOT_TEXT_ALLOWED_VARS[key]
                                                  //   → INVALID_PAYLOAD { disallowedVariables: string[] }
// getMergedBotTexts(tenantId: string, flowVersion: 1 | 2 = 1) — o padrão mantém o claim v1 compilando.

// B-2 — notificações (src/modules/notifications)
type NotificationKind = /* existentes */ | "HANDOFF_REQUESTED";
// AppNotification ganha (opcional): handoff?: { contactId: string; contactName: string;
//   offHours: boolean; answered: boolean; ended: boolean }
// key "handoff:<HandoffRequest.id>"; severity "warning"; source "WHATSAPP";
// title "Cliente pediu atendente"; body "<nome> · fora do horário" (quando offHours);
// href `/${slug}/clientes?contato=${contactId}`; visível a OWNER e STAFF; janela de 30 dias.

// D-1 — src/modules/platform/publish-actions.ts (requirePlatformAdmin)
getBotFlowStatusAction(): Promise<Result<BotFlowStatus>>;
publishBotFlowAction(input: { confirm?: "PUBLICAR" | "SOBRESCREVER" }): Promise<Result<PublishResult>>;
rollbackBotFlowAction(input: { confirm: "VOLTAR" }): Promise<Result<PublishResult>>;
downloadLiveBotFlowAction(): Promise<Result<{ filename: string; json: string /* sanitizado */ }>>;
type BotFlowStatus = {
  buildVersion: string; buildHash: string;                    // do JSON empacotado no build
  publishedVersion: string | null; publishedHash: string | null; publishedAt: string | null;
  liveHash: string | null;                                    // null se o n8n não respondeu
  drift: boolean;                                             // publishedHash != null && liveHash != publishedHash
  firstPublish: boolean;                                      // publishedHash == null
  updateAvailable: boolean;                                   // buildHash != publishedHash
  canRollback: boolean; previousVersion: string | null;
  n8nReachable: boolean; error: string | null;
};
type PublishResult = { version: string; hash: string; publishedAt: string; rolledBack: boolean };
// Erros: N8N_NOT_CONFIGURED, N8N_NOT_SYNCED, CONFIRMATION_REQUIRED (1ª publicação sem "PUBLICAR"),
//   FLOW_DRIFT { liveHash, publishedHash } (sem "SOBRESCREVER"), WEBHOOK_PATH_CHANGED,
//   PUBLISH_VERIFY_FAILED (já voltou ao snapshot), NO_SNAPSHOT.
```

### 3.6 "Publicar fluxo" (D-1)

- Fonte: `import botFlow from "../../../n8n/innochat-bot.json"` (entra no bundle standalone).
- **Hash canônico:** SHA-256 de `JSON.stringify` com chaves ordenadas de
  `{ nodes: nodes.sort(byName).map(n => ({ name, type, typeVersion, parameters })), connections }`,
  onde `parameters` do `Config` tem os **valores** de `painelUrl`, `evolutionUrl`, `n8nApiUrl`
  trocados por `""`. Ignora `id`, `position`, `credentials`, `webhookId`, `notes`.
- **Merge:** `nodes`/`connections` do repositório; `webhookId` do `Webhook` e do `Esperar` copiados
  do vivo (por nome); `path` do Webhook diferente do vivo → `WEBHOOK_PATH_CHANGED`; `Config`
  recebe `painelUrl` e `evolutionUrl` como a sync faz (`setConfigAssignment`); credenciais
  religadas por `rebindHttpCredentials` com os ids gravados (sem girar nada); `settings` do vivo com
  `errorWorkflow = n8nWorkflowErrosId`.
- **Sequência:** GET vivo → hash → checa drift/confirmação → grava snapshot → PUT → GET de
  verificação (`webhookId` e `path` iguais, hash do vivo = hash do repositório) → grava versão,
  hash, data, autor. Verificação falhou → PUT do snapshot + `PUBLISH_VERIFY_FAILED`.
- Rollback = mesmo merge com o snapshot; depois grava o snapshot anterior como "atual".
- Reutiliza de `n8n-sync.ts` só o que já é exportado; se precisar de `setConfigAssignment` ou
  `rebindHttpCredentials`, **copie** para `n8n-flow-merge` (D-1 não edita `n8n-sync.ts`).

### 3.7 Workflow ↔ simulador (W-1, I-0)

**Tipos de nó permitidos** no `innochat-bot.json` (o simulador executa só estes): `webhook`,
`set`, `switch`, `if`, `code`, `httpRequest`, `wait`, `noOp`, `splitOut`, `stopAndError`,
`stickyNote`. **Operadores de condição:** `string.equals`, `boolean.true`, `number.equals` (a
Íris acrescenta `string.notEquals` e `number.gte` no I-0; nada além disso sem pedir). **Code
node:** só `$input`, `$`, `$json`, `$runIndex`, `$now`. **Set:** só `assignments` (a saída contém
só os campos atribuídos).

**HTTP do painel no v2:** `options.response.response = { fullResponse: true, neverError: true }`,
`options.timeout = 10000`, `onError: "continueRegularOutput"` (timeout vira item `{ error }`),
header `X-InnoChat-Flow: 2`, `retryOnFail` só em GET. Exceção: `Claim` **não** usa `fullResponse`
(o `innochat-erros` lê o corpo direto) e mantém `retryOnFail`.

**Saída do `Interpretar`** (entrada do Switch "Rota"):
```ts
{ route: Route; greet: boolean; invalidCount: number;
  claim: ClaimProcessResponseV2;          // como veio
  ctx: SessionContextV2;                  // spec §4, com v:2 e opções v1 já mapeadas
  intent: Intent }
```
**Saída de todo "Resultado X"/ramo** (entrada do `Montar mensagem`):
```ts
{ nextState: string; context: SessionContextV2; blocks: Block[];
  handoff: boolean; handoffReason?: "CLIENT_REQUEST"; invalidCount: number }
```
**`Montar mensagem`** → `{ messages: string[] }` + os campos de sessão; **`Salvar sessão`** envia
`{ lockToken, version, state, context, invalidCount, outbound: messages, handoff, handoffReason }`.

**Build:** `node scripts/n8n-build-flow.mjs` injeta o bundle (esbuild, IIFE global `InnoEngine`,
ES2020, sem minificar) entre `/* @engine:begin */` e `/* @engine:end */` nos nós `Interpretar` e
`Montar mensagem`; `--check` sai com código 1 se o bundle embutido estiver desatualizado.

---

## 4. Tarefas

Formato: **Arquivos** (exclusivos) · **Depende de** · **Faz** · **Pronto quando** (verificável).
Cenários `API-xx` e `CA-xx` são de `scripts/bot-sim/scenarios-v2.mjs` (I-1). "v1 verde" = rodar
`scenarios.mjs` + `scenarios-r2.mjs` com `BOTSIM_WORKFLOW=n8n/legacy/innochat-bot.v1.json`.

### C-1 · Cronos · Migrations do bot v2

- **Arquivos:** `prisma/schema.prisma`; `prisma/migrations/<T1>_bot_v2_schema/`;
  `prisma/migrations/<T2>_bot_v2_port_texts/`; `src/lib/db/types.ts` (exportar `HandoffReason`,
  `HandoffEndReason`); `src/lib/db/tenant-scope.ts` (acrescentar `HandoffRequest`);
  `tests/integration/bot-v2-migration.test.ts` (novo).
- **Depende de:** a migration `User.sessionVersion` (login Google) **commitada**. `<T1>` e `<T2>`
  com timestamp **maior** que o dela (hoje a última é `20261001000000_login_google`); se a dela
  entrar depois com timestamp maior, renomeie as suas antes do commit.
- **Faz:** §3.1 inteiro, incluindo o `UPDATE tenants SET "slotGranularityMin" = 30` antes do
  `CHECK`, o índice único parcial e a porta de textos. Antes de commitar, rode a consulta de
  contagem de chaves legadas editadas (`SELECT key, count(*) FROM bot_texts WHERE key IN (…) GROUP
  BY key`) no banco de desenvolvimento e relate no handoff.
- **Pronto quando:** `prisma validate` ok; `prisma migrate deploy` num banco vazio e num banco com
  o seed atual passa; teste de integração cobre: (a) tenant com `MAIN_MENU` "Oi!\n1. A\n2. B" →
  `MENU_PROMPT`="Oi!"; (b) `MAIN_MENU` começando com "1." → nada portado; (c) sem edição → nada;
  (d) rodar a porta 2× não duplica; (e) `CHECK` recusa `slotGranularityMin=60`; (f) 2º
  `HandoffRequest` aberto na mesma sessão → violação única. `npm test` e `typecheck` verdes.
  Cenário **CA-47** fica verde quando B-3 entrar.

### A-1 · Vega · Core do painel (formatos, textos v2, agenda)

- **Arquivos:** `src/core/bot/format.ts`; `src/core/bot/texts-v2.ts` (novo);
  `src/core/bot/__tests__/format-v2.test.ts`, `texts-v2.test.ts` (novos);
  `src/core/agenda/availability.ts`; `src/core/agenda/opening.ts` (novo);
  `src/core/agenda/index.ts`; `src/core/agenda/__tests__/*`.
- **Depende de:** nada. **É o primeiro commit da Vega** (B-* dependem dele).
- **Faz:** §3.3. `texts.ts` da v1 **não muda**. A grade ancorada mantém a assinatura de
  `computeAvailableSlots`; atualize os testes existentes que supunham grade relativa.
- **Pronto quando:** testes de tabela para cada função de §3.3, incluindo: grade 30 com serviço de
  45 min às 09:00 → próximo 10:00; grade 15 → :00/:15/:30/:45; janela começando 09:10 → 09:30;
  `formatDayLabelFromISO("2026-10-01","Pacific/Kiritimati")` = "Qui 01/10"; `teamOpening` com
  exceção de feriado e virada de semana; `DEFAULT_BOT_TEXTS_V2` idêntico à spec §5.3 (teste de
  *snapshot*); toda chave de `BOT_TEXT_KEYS_V2` tem padrão, catálogo e lista de variáveis;
  nenhuma variável de padrão fora de `BOT_TEXT_ALLOWED_VARS`. No simulador, com o workflow v1:
  **G2 e T1 verdes**, nenhum dos 36 verdes regride.

### A-2 · Vega · Motor puro

- **Arquivos:** `src/core/bot/engine/**` (novo: `types.ts`, `normalize.ts`, `parse-input.ts`,
  `interpret.ts`, `aliases.ts`, `name.ts`, `options.ts`, `trail.ts`, `legacy.ts`, `render.ts`,
  `route.ts`, `index.ts`, `__tests__/*`).
- **Depende de:** nada.
- **Faz:** §3.2 e as regras da spec §2.3–2.5, §3.1 (nome), §5.1–5.2.
- **Pronto quando:** testes de tabela verdes cobrindo, no nível de unidade, CA-01, 03, 06, 07, 08,
  09, 10, 11, 13, 18 (`buildOptions`/`pageSlice`), 38–41, BUG-13 (`routeFor` com `fresh`),
  `mapLegacyOptions` (CA-44); teste de guarda que falha se algum arquivo importar fora de
  `engine/`; teste que compila `index.ts` com esbuild em IIFE e o executa em `new Function` sem
  `require`/`process` (prova que roda no Code node). `npm test` e `typecheck` verdes.

### B-1 · Vega · API de catálogo, disponibilidade e agendamentos

- **Arquivos:** `src/modules/bot-api/booking-bot.ts`; `src/modules/bot-api/contacts-bot.ts`;
  `src/modules/bot-api/flow-version.ts` (novo, **1º commit**); `src/modules/agenda/appointments.ts`;
  `src/app/api/internal/v1/{catalog,availability,appointments,contacts}/**` (inclui o novo
  `availability/next/route.ts`); `src/lib/api-internal/schemas.ts`;
  `src/lib/api-internal/respond.ts`; `tests/integration/bot-api-v2-agenda.test.ts` (novo).
- **Depende de:** C-1, A-1 (A-2 para `validateName`: se ainda não entrou, importe de
  `@/core/bot/engine` assim que entrar; até lá, valide só tamanho e letras e deixe um TODO).
- **Faz:** §3.4 bloco B-1 e as correções BUG-05, 07, 08, 09, 15 no painel.
- **Pronto quando:** testes de integração verdes; no simulador, **API-01 a API-08 verdes**; com o
  workflow v1, **R2, K1, K2, T1 verdes** e nenhum dos 36 verdes regride (o limite não afeta o v1:
  sem header).

### B-2 · Vega · Claim v2, sessão, atendente, release e sino

- **Arquivos:** `src/modules/bot-api/claim.ts`; `src/modules/bot-api/session.ts`;
  `src/modules/bot-api/handoff.ts` (novo); `src/modules/agenda/team-hours-loader.ts` (novo);
  `src/app/api/internal/v1/{messages,sessions}/**`; `src/lib/api-internal/schemas-conversa.ts`
  (novo; importa o que precisar de `schemas.ts` só para leitura); `scripts/generate-openapi.mjs`;
  `docs/api-interna.openapi.json` (regenerar **depois** do commit de B-1);
  `src/modules/notifications/{types,service,format}.ts` e testes; `src/modules/contacts/contacts.ts`;
  `tests/integration/bot-api-v2-conversa.test.ts` (novo).
- **Depende de:** C-1, A-1 (B-3 para `getMergedBotTexts(…, 2)`; até lá, use
  `DEFAULT_BOT_TEXTS_V2` direto e troque no fim).
- **Faz:** §3.4 bloco B-2 e §3.5 notificações.
- **Pronto quando:** testes de integração do ciclo do atendente (pedir → "menu" → volta; pedir →
  vencer → volta; pedir → fromMe → estende; fromMe sem pedido → v1), do release com aviso (1 envio,
  2º em 10 min não envia, trava de outra execução não envia) e da notificação derivada; no
  simulador, **API-09 a API-12 verdes**; com o workflow v1, **W1 e W2 verdes** (o cliente recebe
  `TECH_ERROR` pelo release) e nenhum dos 36 verdes regride.

### B-3 · Vega · Textos por versão e regras da empresa

- **Arquivos:** `src/modules/bot-texts/**`; `src/modules/tenant/service.ts`;
  `src/modules/tenant/actions.ts`; `src/modules/tenant/actions.test.ts`.
- **Depende de:** C-1, A-1.
- **Faz:** §3.5 blocos B-3; `getMergedBotTexts(tenantId, flowVersion = 1)`.
- **Pronto quando:** testes: base v1 intacta com `flowVersion` 1 (CA-45 no nível de unidade); base
  v2 com edições; `upsert` recusa `{limite}` em `GREETING`; `updateBotRulesAction` recusa 45, 0,
  1500 e STAFF. No simulador, **API-13 verde** (claim v2 devolve `MENU_PROMPT` portado) e **CA-47**.

### D-1 · Vega · "Publicar fluxo"

- **Arquivos:** `src/modules/platform/n8n-publish.ts`, `n8n-flow-hash.ts`, `n8n-flow-merge.ts`,
  `publish-actions.ts` (novos); `src/modules/platform/__tests__/n8n-publish.test.ts`,
  `n8n-flow-hash.test.ts` (novos); `src/modules/platform/n8n-client.ts` (só se faltar método).
- **Depende de:** C-1. Desenvolve e testa com o JSON **v1** atual; nada nele depende do v2.
- **Faz:** §3.5 bloco D-1 e §3.6. Não altera `n8n-sync.ts` nem `actions.ts`.
- **Pronto quando:** testes com n8n falso (em memória) provam, um a um, os casos de CA-46: merge
  preserva `webhookId`/`path`/credenciais/`errorWorkflow`; 1ª publicação exige "PUBLICAR"; edição no
  vivo → `FLOW_DRIFT`; "SOBRESCREVER" publica; rollback restaura o mesmo hash; verificação
  divergente → volta sozinho; `path` diferente → `WEBHOOK_PATH_CHANGED`; download sai sem
  credenciais/`pinData`. `next build` inclui o JSON (conferir no `.next/standalone`).

### W-1 · Vega · Workflow v2

- **Arquivos:** `n8n/innochat-bot.json`; `n8n/legacy/innochat-bot.v1.json` (cópia fiel do atual,
  **1º commit**); `n8n/README.md`; `scripts/n8n-build-flow.mjs` (novo); `package.json` (só o script
  `"build:flow"`); `src/modules/bot-flow/workflow-structure.test.ts` (novo).
- **Depende de:** A-2 (motor). B-1 e B-2 para o simulador ficar verde.
- **Faz:** spec §7 e §3.7 deste plano. Mantém `Webhook`, `Config`, `Claim`, `Esperar`,
  `Salvar sessão` e `Enviar pela Evolution` com os mesmos nomes, e os `webhookId` do Webhook e do
  `Esperar`. `Config.flowVersion = "2.0.0"`. `settings.errorWorkflow` fica com o id atual (o
  Publicar troca). `innochat-erros.json` **não muda**.
- **Pronto quando:** `npm run build:flow -- --check` ok; teste de estrutura verde (nós e operadores
  permitidos, toda saída de Switch conectada, todo `$('Nome')` existe, sem `credentials`/`pinData`,
  `Config` com placeholders, `webhookId`s iguais às constantes, bundle atualizado); no simulador,
  **CA-01 a CA-44 verdes** (workflow padrão = v2) e **CA-45** (v1 verde) continua verde.

### L-1 · Lyra · Configurações: regras do atendimento pelo WhatsApp

- **Arquivos:** `src/app/(app)/[tenantSlug]/configuracoes/atendimento-card.tsx` (novo);
  `src/app/(app)/[tenantSlug]/configuracoes/page.tsx`.
- **Depende de:** B-3 (`getBotRulesAction`/`updateBotRulesAction`).
- **Faz:** card com "Agendamentos futuros por cliente" (0 = sem limite), "Grade de horários"
  (15 ou 30 min, com exemplo "09:00, 09:30, 10:00…") e "Bot volta a responder depois de" (tempo
  sem resposta da equipe). Só OWNER edita; STAFF vê. Mesmo padrão visual do `lembrete-card.tsx`.
- **Pronto quando:** salvar e recarregar mostra os valores; validação em linha; medido no navegador
  em 1440 e 390 nos 3 temas (skill `medir-antes-de-afirmar`); E2E da Íris (I-2) verde.

### L-2 · Lyra · Sino: "Cliente pediu atendente"

- **Arquivos:** `src/components/notifications/**`;
  `src/app/(app)/[tenantSlug]/clientes/{page.tsx,clientes-client.tsx}` (abrir o contato por
  `?contato=`).
- **Depende de:** B-2 (kind no serviço).
- **Faz:** ícone, cor (warning) e texto do kind `HANDOFF_REQUESTED`; selo "fora do horário";
  clique abre a ficha do contato (onde já existe "Retomar bot").
- **Pronto quando:** notificação aparece no sino e no toast depois de um "atendente" no simulador
  contra o painel local; clique abre a ficha; E2E verde.

### L-3 · Lyra · Mensagens do bot v2

- **Arquivos:** `src/app/(app)/[tenantSlug]/mensagens-bot/**`; `src/components/bot-texts/**` (novo).
- **Depende de:** A-1 (`BOT_TEXT_CATALOG`, `BOT_TEXT_ALLOWED_VARS`), A-2 (`renderMessage`), B-3.
- **Faz:** spec §8 (tela): abas Conversa / Agendamento / Meus agendamentos / Atendente e erros /
  Rótulos (recolhida); prévia com `*negrito*`, `_itálico_`, `~riscado~`, keycaps e opções de
  exemplo, gerada pelo **mesmo** `renderMessage` do motor; chips das variáveis permitidas da chave;
  seção recolhida "Textos antigos" com os legados editados (só leitura, com nota). Com
  `flowVersion` 1, a tela se comporta como hoje.
- **Pronto quando:** a prévia de `CONFIRM_SUMMARY` sem preço não mostra a linha "Valor"; variável
  não permitida mostra o erro do servidor; medido em 1440/390 nos 3 temas; E2E verde.

### L-4 · Lyra · Admin: "Publicar fluxo"

- **Arquivos:** `src/components/admin/bot-flow-card.tsx` (novo);
  `src/app/(platform)/admin/configuracoes/admin-configuracoes-client.tsx` (só a inserção do card).
- **Depende de:** D-1.
- **Faz:** versão do build × publicada × data; selo "fluxo novo disponível"; aviso de drift com
  "Baixar a versão do n8n" e "Sobrescrever mesmo assim" (digitar SOBRESCREVER); 1ª publicação
  pedindo PUBLICAR; "Voltar à versão anterior" (digitar VOLTAR); n8n inacessível mostra o erro.
- **Pronto quando:** cada estado de `BotFlowStatus` renderiza (com a action real apontada para um
  n8n falso ou com dados de exemplo); medido em 1440/390.

### I-0 · Íris · Simulador preparado para o v2

- **Arquivos:** `scripts/bot-sim/{engine.mjs,lib.mjs,seed.mjs,chat.mjs,README.md}`;
  `scripts/bot-sim/fake-evolution.mjs` (novo).
- **Depende de:** nada.
- **Faz:** `parseOptions` aceita `1️⃣ Título` além de `1. Título`; suporte a
  `onError: continueRegularOutput` e aos operadores `string.notEquals`/`number.gte`; caminho de
  erro lê a trava do nó `Claim` (não do `Interpretar`) e chama o release; injeção de falha por
  rota (`faults: [{ urlRe, status | "timeout" }]`) para CA-29 e por nó
  (`faults: [{ node: "Montar mensagem", crash: true }]`) para CA-31; `fake-evolution.mjs` (porta 3901)
  registra o que o **painel** envia (release com `TECH_ERROR`) e o seed grava essa URL em
  `PlatformSettings.evolutionApiUrl` do banco do simulador; seed: todas as grades em 15 ou 30
  (o `CHECK` recusa 60), tenant `limite` com 3 agendamentos futuros, tenant com `MAIN_MENU` editado.
- **Pronto quando:** com o workflow v1 e o painel atual, o resultado dos 61 cenários é o mesmo da
  auditoria (25 vermelhos, 36 verdes) — a infraestrutura nova não muda o veredito.

### I-1 · Íris · `scenarios-v2.mjs`

- **Arquivos:** `scripts/bot-sim/scenarios-v2.mjs` (novo).
- **Depende de:** I-0; escreve contra os contratos §3 **antes** do código existir (nascem vermelhos).
- **Faz:** um cenário por CA-01…CA-47 (id = o do critério) e os de API: API-01 days, API-02 slots,
  API-03 next, API-04 catálogo filtrado e com rótulos, API-05 limite (422 com header, nada sem),
  API-06 appointments `canChange`, API-07 `contactName`, API-08 grade 15/30, API-09 claim v2,
  API-10 ciclo do atendente, API-11 release com aviso, API-12 `HandoffRequest` criado com
  `offHours`, API-13 textos portados no claim. `BOTSIM_WORKFLOW` padrão = `n8n/innochat-bot.json`.
- **Pronto quando:** roda do começo ao fim sem exceção de infraestrutura; cada vermelho aponta a
  tarefa que o deixará verde (comentário no cenário).

### I-2 · Íris · E2E das telas

- **Arquivos:** `tests/e2e/bot-v2-*.spec.ts` (novos).
- **Depende de:** L-1..L-4.
- **Pronto quando:** E2E de Configurações (salvar/validar), sino (kind novo, clique abre contato),
  Mensagens do bot (abas, prévia, erro de variável) verdes.

### I-3 · Íris · Veredito

- **Depende de:** W-1, B-*, D-1, I-2.
- **Pronto quando:** `scenarios-v2.mjs` inteiro verde, CA-45 verde, E2E verdes → **APROVADO**; ou
  REPROVADO com cenário, transcrição e tarefa responsável.

### O-1 · Órion · Revisão

- **Depende de:** W-1, B-2, D-1 (pode começar por D-1 e B-2 assim que entrarem).
- **Escopo:** "Publicar fluxo" (autorização só admin da plataforma; confirmação digitada; o JSON
  baixado sem credencial nem segredo; `safeFetch`; o que o merge **nunca** pode sobrescrever:
  `webhookId`, `path`, credenciais; auditoria de quem publicou); claim v2 (ordem das regras de
  `fromMe`/`HUMAN`, eco, "menu" só com pedido do cliente, isolamento por instância); release com
  aviso (não vira canal para mandar mensagem arbitrária; limite de frequência; só com a trava da
  execução); `contactName`/`validateName` (sanitização; XSS armazenado); motor no Code node (sem
  `eval` de entrada do cliente, sem regex catastrófica em `parseInput`).
- **Pronto quando:** relatório por severidade; nenhum achado ALTA aberto.

### X-1 · Alexandria · Documentação

- **Arquivos:** `docs/contratos.md` (seção "Bot v2"); `docs/runbook.md` (Publicar, rollback, o que
  olhar nas 24 h); `docs/manual-do-cliente.md` (limite, grade, atendente, textos).
- **Depende de:** I-3 aprovado. Conferir cada caminho e script citado com `ls`/`grep` antes de
  entregar (memória do projeto).

---

## 5. Deploy, compatibilidade e rollback

### 5.1 O que muda para o fluxo v1 no deploy do painel (antes do Publicar)

Tudo abaixo é intencional e foi verificado contra o v1 atual (o v1 só lê `label`, `id`,
`options`, `hasMore`, `nextFrom`, `summary.*` e os textos v1):

| Mudança | Efeito no v1 |
|---|---|
| Grade 30 ancorada | Horários redondos (decisão do dono) |
| Filtro por expediente | Some a "Carla" sem horário (BUG-09 corrigido também no v1) |
| `nextFrom` = dia seguinte | "Ver mais datas" não repete dia (BUG-05) |
| Rótulo pelo meio-dia local | Fusos +12 corretos (BUG-15) |
| Campos novos nas respostas | Ignorados pelo v1 |
| `HandoffRequest LEGACY_FLOW` | Sino passa a avisar quando o cliente pede atendente |
| Release avisa com `TECH_ERROR` | Fim do silêncio em erro (BUG-04) |
| Limite de agendamentos | **Não** se aplica (só com `X-InnoChat-Flow: 2`): o v1 não saberia mostrar o 422 |
| Textos | Base v1 inalterada (`getMergedBotTexts(…, 1)`) |

### 5.2 Sequência

1. **Pré-voo:** I-3 APROVADO, O-1 sem ALTA, `npm run build:flow -- --check` ok.
2. **Deploy do painel** (Vulcano): a imagem nova sobe; as 2 migrations rodam no boot (memória: o
   container migra sozinho). Verificar: `/api/health`; log do boot com a contagem de textos
   portados; uma conversa real na instância sandbox ainda no **v1** responde normal.
3. **Ensaio no n8n real sem tocar produção** (Atlas via MCP): importar o `innochat-bot.json` como
   workflow `innochat-bot [rascunho]` com **outro** `path` e `webhookId`, apontar a instância
   sandbox para ele, rodar 5 roteiros (A, D, F, G, H da spec §5.4). Isso prova o que o simulador
   não prova: task runner do Code node, `onError`, credenciais, timeout real. Depois, desativar o
   rascunho e devolver a sandbox ao webhook de produção.
4. **Publicar fluxo** (admin): 1ª publicação com "PUBLICAR". O painel verifica `path`/`webhookId`.
5. **Observar 24 h:** `InboundEvent` com `HUMAN_TOOK_OVER` logo depois de mensagem do bot (eco),
   execuções com erro no n8n, `HandoffRequest` abertos, `notified=true` no release, reclamações.

### 5.3 Rollback

| Problema | Ação | Efeito |
|---|---|---|
| Fluxo v2 com defeito | Admin → "Voltar à versão anterior" | Volta o v1 exato (mesmo hash). Sessões em estados novos (`RESUME_OFFER`, `LIMIT_REACHED`…) são tratadas pelo `Interpretar` v1 como sessão nova (lista `KNOWN`) → menu. Nos estados comuns, as opções gravadas pela v2 também têm `label` (= `title`), então o número digitado continua funcionando. Painel continua novo, servindo o v1 como em §5.1 |
| Painel com defeito | **1º** "Voltar à versão anterior" do fluxo; **2º** imagem anterior do painel | As migrations são aditivas e ficam: colunas e tabela novas são ignoradas pela imagem antiga; os valores de enum novos não são lidos por ela |
| Só a grade 30 incomodou uma empresa | Configurações → Grade 15 | Imediato, sem deploy |
| Painel antigo com fluxo v2 no ar | Evitar (ordem acima). Se acontecer: o v2 recebe 404 em `/availability/next` e campos ausentes → `TECH_ERROR`/`ITEM_UNAVAILABLE`; nenhuma sessão corrompe. Corrigir voltando o fluxo |

---

## 6. Posse de arquivos (quem pode tocar o quê)

| Caminho | Dono |
|---|---|
| `prisma/schema.prisma`, `prisma/migrations/<T1>_*`, `<T2>_*`, `src/lib/db/types.ts`, `src/lib/db/tenant-scope.ts`, `tests/integration/bot-v2-migration.test.ts` | C-1 |
| `src/core/bot/format.ts`, `src/core/bot/texts-v2.ts`, `src/core/bot/__tests__/{format-v2,texts-v2}.test.ts`, `src/core/agenda/**` | A-1 |
| `src/core/bot/engine/**` | A-2 |
| `src/modules/bot-api/{booking-bot,contacts-bot,flow-version}.ts`, `src/modules/agenda/appointments.ts`, `src/app/api/internal/v1/{catalog,availability,appointments,contacts}/**`, `src/lib/api-internal/{schemas,respond}.ts`, `tests/integration/bot-api-v2-agenda.test.ts` | B-1 |
| `src/modules/bot-api/{claim,session,handoff}.ts`, `src/modules/agenda/team-hours-loader.ts`, `src/app/api/internal/v1/{messages,sessions}/**`, `src/lib/api-internal/schemas-conversa.ts`, `scripts/generate-openapi.mjs`, `docs/api-interna.openapi.json`, `src/modules/notifications/**`, `src/modules/contacts/contacts.ts`, `tests/integration/bot-api-v2-conversa.test.ts` | B-2 |
| `src/modules/bot-texts/**`, `src/modules/tenant/{service,actions,actions.test}.ts` | B-3 |
| `src/modules/platform/{n8n-publish,n8n-flow-hash,n8n-flow-merge,publish-actions}.ts`, seus testes, `src/modules/platform/n8n-client.ts` | D-1 |
| `n8n/innochat-bot.json`, `n8n/legacy/**`, `n8n/README.md`, `scripts/n8n-build-flow.mjs`, `package.json` (script), `src/modules/bot-flow/**` | W-1 |
| `src/app/(app)/[tenantSlug]/configuracoes/{page.tsx,atendimento-card.tsx}` | L-1 |
| `src/components/notifications/**`, `src/app/(app)/[tenantSlug]/clientes/**` | L-2 |
| `src/app/(app)/[tenantSlug]/mensagens-bot/**`, `src/components/bot-texts/**` | L-3 |
| `src/components/admin/bot-flow-card.tsx`, `src/app/(platform)/admin/configuracoes/admin-configuracoes-client.tsx` | L-4 |
| `scripts/bot-sim/**` | I-0, I-1 (a mesma Íris, em sequência) |
| `tests/e2e/bot-v2-*.spec.ts` | I-2 |
| `docs/contratos.md`, `docs/runbook.md`, `docs/manual-do-cliente.md` | X-1 |
| `docs/bot-v2-especificacao.md`, `docs/bot-v2-plano.md` | Nova (mudança de contrato passa por aqui) |
| **Ninguém toca:** `n8n/innochat-erros.json`, `src/modules/platform/n8n-sync.ts`, `src/modules/platform/actions.ts`, `src/core/bot/texts.ts`, `src/core/bot/evolution-normalize.ts`, `vitest.config.ts` | — |

---

## 7. Pendências e confirmações

Nenhuma bloqueia a construção.

- **Confirmação do dono (baixo risco):** a grade passa a 30 min para **todas** as empresas no
  deploy do painel, antes do Publicar (spec R5). É o que ele decidiu como padrão; só precisa saber
  que o efeito é imediato e que cada empresa pode voltar a 15 na tela.
- **Confirmação do dono (baixo risco):** o limite de 3 agendamentos só vale para reservas pelo
  WhatsApp; a equipe no painel não é barrada.
- **Atlas:** confirmar que a migration `User.sessionVersion` já está commitada antes de soltar o
  Cronos, e informar o timestamp dela.

---

## 8. Lista para delegar (copiar e colar)

| # | Para | Tarefa | Começa | Handoff esperado |
|---|---|---|---|---|
| 1 | Cronos | C-1 Migrations do bot v2 | quando a `sessionVersion` estiver commitada | timestamps usados, contagem de legados, testes |
| 2 | Vega | A-1 Core do painel | agora | assinaturas finais de §3.3, testes |
| 3 | Vega | A-2 Motor puro | agora | exports finais de §3.2, prova do IIFE |
| 4 | Íris | I-0 Simulador para o v2 | agora | 61 cenários com o mesmo veredito da auditoria |
| 5 | Íris | I-1 `scenarios-v2.mjs` | depois de I-0 | lista de vermelhos por tarefa |
| 6 | Vega | B-1 API agenda/catálogo | depois de A-1 e C-1 | API-01..08 verdes, v1 sem regressão |
| 7 | Vega | B-2 Claim v2, atendente, release, sino | depois de A-1 e C-1 | API-09..12, W1/W2 verdes no v1 |
| 8 | Vega | B-3 Textos e regras | depois de A-1 e C-1 | API-13, CA-47 |
| 9 | Vega | D-1 Publicar fluxo | depois de C-1 | casos de CA-46 em teste |
| 10 | Lyra | L-1 Configurações | contra o contrato; commit depois de B-3 | medidas + prints |
| 11 | Lyra | L-2 Sino | contra o contrato; commit depois de B-2 | medidas + prints |
| 12 | Vega | W-1 Workflow v2 | depois de A-2 (verde depois de B-1/B-2) | CA-01..44 verdes, `--check` ok |
| 13 | Lyra | L-3 Mensagens do bot | depois de A-2 e B-3 | medidas + prints |
| 14 | Lyra | L-4 Admin Publicar | depois de D-1 | estados renderizados |
| 15 | Íris | I-2 E2E + I-3 veredito | quando as telas e o W-1 entrarem | APROVADO/REPROVADO |
| 16 | Órion | O-1 Revisão | a partir de D-1/B-2 | achados por severidade |
| 17 | Alexandria | X-1 Docs | depois do APROVADO | docs conferidas |
| 18 | Vulcano + Atlas | Deploy §5.2 | depois de I-3 e O-1 | 24 h observadas |
