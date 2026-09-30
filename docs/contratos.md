# Contratos — Fase 1 (fundação)

Esqueleto das Server Actions / rotas previstas para a Fase 1. Detalhamento
completo (Server Actions do domínio, API interna do bot) fica para as Fases
2–4, conforme docs/arquitetura.md §13. Aqui só o que a fundação já expõe ou
precisa expor para Lyra integrar login/onboarding básico.

Convenção: Server Actions devolvem `Result<T>` —
`{ ok: true, data: T } | { ok: false, error: { code, message } }` — nunca
lançam para erro esperado (validação, regra de negócio). Erros inesperados
(bug, banco fora do ar) propagam e viram a tela de erro do Next.

---

## Autenticação (`src/lib/auth.ts`, Auth.js v5)

- `POST /api/auth/callback/credentials` (gerado pelo Auth.js) — login por
  e-mail/senha. Consumido pelo formulário de login via `signIn("credentials", …)`
  do lado do cliente ou por uma Server Action fina que chama `signIn`.
- `GET/POST /api/auth/*` — demais rotas padrão do Auth.js (sessão, CSRF).
- Sessão: JWT, `session.user.id` disponível em Server Components via `auth()`.

**Resolvido** (schema do Cronos já disponível ao final desta rodada):
`verifyCredentials` (`src/modules/auth/service.ts`) usa `getPrisma().user`
direto (model global, não tenant-scoped — arquitetura.md §5) e compila contra
o schema real. **Sem `PrismaAdapter`**: `prisma/schema.prisma` não tem
`Account`/`Session`/`VerificationToken` (os models que o adapter padrão do
Auth.js exige) — não há provider OAuth na v1 e a sessão é JWT, então o
adapter não fazia falta. Se um provider OAuth entrar pós-v1, revisitar
`src/lib/auth.ts` e adicionar os models que faltarem no schema.

O model `User` não tem campo de nome de exibição — `AuthorizedUser.name`
fica `null` até essa necessidade aparecer (provavelmente por
`Membership`/`Tenant`, não por `User`).

## Guardas de autorização (`src/lib/auth/guards.ts`)

Toda Server Action chama uma destas ANTES de tocar o banco — nunca confiam em nada vindo do
client sobre quem é o usuário ou a que tenant ele pertence:

- `requireSessionUser(): Promise<{ id: string }>` — exige sessão Auth.js válida. Lança
  `DomainError("UNAUTHENTICATED", …)` senão.
- `requirePlatformAdmin(): Promise<{ id: string }>` — relê `isPlatformAdmin` do banco a partir
  do id da sessão (nunca confia em um campo do client). Lança `DomainError("FORBIDDEN", …)`.
- `requireTenantMember(slug, roles?): Promise<{ tenant, membership, user }>` — resolve o tenant
  **pelo slug da URL**, nunca por um id vindo do client, e confirma `Membership` do usuário da
  sessão nele. Empresa inexistente OU sem membership → o mesmo `DomainError("NOT_FOUND", …)`
  (nunca `FORBIDDEN`, para não confirmar a existência da empresa para quem não é membro — mesma
  lógica do §6.1 da API interna). Se `roles` for passado (ex.: `["OWNER"]`) e o papel do usuário
  não estiver na lista, `DomainError("FORBIDDEN", …)`.

`DomainError` (`src/lib/errors.ts`) representa toda condição ESPERADA (validação, regra de
negócio, permissão). `runAction()` (`src/lib/result.ts`) executa o corpo de uma Server Action e
converte `DomainError`/`ZodError` em `Result` de falha — qualquer outro erro (bug, banco fora do
ar) propaga e vira a tela de erro do Next. Toda Server Action abaixo segue este formato:
`{ ok: true, data: T } | { ok: false, error: { code, message, details? } }`.

## Admin da plataforma (`src/modules/platform/actions.ts`) — Fase 1

Guardadas por `requirePlatformAdmin()`. `PlatformSettings` é singleton (`id = 1`), sempre
`upsert`. Segredos NUNCA voltam em texto puro — só mascarados (`"••••1234"`, últimos 4
caracteres) ou como booleano `configured`. Ao salvar, campo de texto/segredo vazio ou ausente =
"manter o valor atual" (nunca apaga um segredo sem querer).

- `getPlatformSettingsAction(): Result<PlatformSettingsView>`
  ```ts
  type PlatformSettingsView = {
    publicBaseUrl: string | null; // só leitura — ver "Configuração pela plataforma" abaixo
    evolutionApiUrl: string | null;
    evolutionApiKeyMasked: string | null;
    n8nWebhookBaseUrl: string | null;
    n8nBaseUrl: string | null;
    n8nApiKeyMasked: string | null;
    internalApiSecretConfigured: boolean; // nunca o hash, nunca o segredo
    mercadoPagoReady: boolean; // par do ambiente ATIVO com access token e webhook secret salvos (checklist)
    smtpHost: string | null; smtpPort: number | null; smtpSecure: boolean | null;
    smtpUser: string | null; smtpPasswordMasked: string | null; smtpFrom: string | null;
    termsVersion: string | null;
    updatedAt: string | null; updatedByUserId: string | null;
  };
  ```
- `updatePlatformSettingsAction(input): Result<PlatformSettingsView>` — `input` aceita
  `evolutionApiUrl?`, `evolutionApiKey?`, `n8nWebhookBaseUrl?`, `n8nBaseUrl?`, `n8nApiKey?`,
  `smtpHost?`, `smtpPort?`,
  `smtpSecure?`, `smtpUser?`, `smtpPassword?`, `smtpFrom?`, `termsVersion?` — todos opcionais,
  `""` = manter. Na primeira chamada, grava `publicBaseUrl` sozinho a partir da requisição (ver
  "Configuração pela plataforma"). Erros: `INVALID_PAYLOAD` (zod), `FORBIDDEN`.
- `regenerateInternalApiSecretAction(): Result<{ secret: string }>` — gera e devolve o segredo
  da API interna do n8n **em texto puro, uma única vez**; persiste só o hash SHA-256
  (`internalApiSecretHash`). A tela precisa mostrar isso ao dono nesta resposta e nunca mais
  poder buscá-lo de volta (`getPlatformSettingsAction` só devolve `internalApiSecretConfigured`).

### Segredos cifrados em repouso (2026-09-29)

`evolutionApiKey`, `n8nApiKey`, `smtpPassword` e os segredos do Mercado Pago ficam cifrados no
banco (`enc:v1:<base64>`, AES-256-GCM, `src/lib/crypto.ts`, formato `iv | tag | ciphertext`
idêntico ao Parque das Feiras). Chave = scrypt do `AUTH_SECRET` com salt fixo do InnoChat.
**Trocar o `AUTH_SECRET` invalida todos os segredos salvos** (viram "ausentes" — fail-closed —
e precisam ser recadastrados). Migração preguiçosa (`src/modules/platform/secrets.ts`,
`loadPlatformSettingsRow`): valor legado em texto puro é aceito na leitura e cifrado na primeira
leitura/gravação (compare-and-set, seguro sob concorrência). O par legado do MP
(`mercadoPagoAccessToken`/`mercadoPagoWebhookSecret`, colunas mantidas mas zeradas) vai, cifrado,
para o par de PRODUÇÃO. Toda leitura de segredo no servidor passa por
`loadPlatformSettingsRow`/`getPlatformSecrets`/`getActiveMercadoPagoCredentials` — nunca
`findUnique` direto pedindo colunas de segredo.

### Mercado Pago — par de produção e par de teste (`src/modules/platform/mercadopago-config.ts`)

Modelo do Parque das Feiras: `PlatformSettings.mpEnvironment` (`PRODUCTION` | `SANDBOX`, padrão
`PRODUCTION`) escolhe o par ativo; `mpEnabled` (padrão `true`, "cobrança liberada") bloqueia só
COBRANÇA NOVA (`getMercadoPagoGateway({ forNewCharge: true })` → `MERCADOPAGO_DISABLED`; webhook e
conciliação seguem). Cada par: Public Key em claro (`mpProdPublicKey`/`mpTestPublicKey`), Access
Token e Webhook Secret cifrados (`mp{Prod,Test}{AccessToken,WebhookSecret}Enc`).
Fail-closed: segredo que não decifra = ausente → sem Pix (`MERCADOPAGO_NOT_CONFIGURED`), webhook
rejeitado (401).

Server Actions (todas `requirePlatformAdmin`; **nunca devolvem valor de segredo**). Todas as de
escrita/leitura devolvem `Result<MercadoPagoConfigView>`:

```ts
type MercadoPagoEnvView = { publicKey: string | null; accessTokenSaved: boolean; webhookSecretSaved: boolean };
type MercadoPagoConfigView = {
  environment: "PRODUCTION" | "SANDBOX";
  enabled: boolean;
  production: MercadoPagoEnvView;
  sandbox: MercadoPagoEnvView;
};
```

- `getMercadoPagoConfigAction()`
- `saveMercadoPagoCredentialsAction({ env, publicKey?, accessToken?, webhookSecret? })` — campo
  vazio/ausente = manter; segredos até 500 caracteres, public key até 300.
- `removeMercadoPagoSecretAction({ env, field: "accessToken" | "webhookSecret" })`
- `setMercadoPagoEnvironmentAction({ environment })`
- `setMercadoPagoEnabledAction({ enabled })`
- `testMercadoPagoConnectionAction({ env, accessToken? })` → `Result<{ ok, detalhe }>`; token em
  branco usa o salvo daquele ambiente (`MISSING_SECRET` se não houver).

`saved` = existe E decifra. Erros: `INVALID_PAYLOAD` (zod), `MISSING_SECRET`, `FORBIDDEN`.
`updatePlatformSettingsAction` **não** aceita mais campos do Mercado Pago.

## Tema do tenant (`src/modules/tenant/actions.ts`) — Fase 1/2

- `updateTenantThemeAction(tenantSlug, input): Result<{ theme: string }>` — `input: { theme:
  "INDIGO_CLINICO" | "AMBAR_ESTUDIO" | "VERDE_SLATE" }`. Restrito a `OWNER`
  (`requireTenantMember(slug, ["OWNER"])`). Erros: `NOT_FOUND` (empresa/membership), `FORBIDDEN`
  (não é OWNER), `INVALID_PAYLOAD`.

## Catálogo e agenda (Fase 2)

Todas guardadas por `requireTenantMember(tenantSlug)` (qualquer papel, sem restrição adicional
nesta fase). **TODO explícito**: limite de profissionais/números por plano (`maxProfessionals`,
`maxWhatsappNumbers` do `Plan`, mais os `*Override` do `Tenant`) ainda NÃO é verificado em
`createProfessionalAction` — cobrança/planos é Fase 7 (docs/arquitetura.md §13); quem implementar
a Fase 7 precisa adicionar essa checagem antes de liberar o cadastro público.

### `src/modules/agenda/catalog-actions.ts`

- `listServicesAction(tenantSlug): Result<Service[]>`
- `createServiceAction(tenantSlug, input): Result<Service>` — `input: { name, durationMin,
  bufferAfterMin?, priceCents?, active?, sortOrder? }`.
- `updateServiceAction(tenantSlug, serviceId, input): Result<Service>` — `input` parcial do
  schema acima. Erro: `NOT_FOUND`.
- `deleteServiceAction(tenantSlug, serviceId): Result<{ id }>` — bloqueia com
  `HAS_APPOINTMENTS` se o serviço tem QUALQUER agendamento (o schema faz `onDelete: Cascade`
  para `Appointment` — perderia histórico); a tela deve oferecer "desativar" (`active: false`,
  via `updateServiceAction`) como alternativa.
- `listProfessionalsAction(tenantSlug): Result<Professional[]>` — inclui `professionalServices`
  (`serviceId[]`) e `workingHours`.
- `createProfessionalAction(tenantSlug, input): Result<Professional>` — `input: { name, active?,
  sortOrder? }`.
- `updateProfessionalAction(tenantSlug, professionalId, input): Result<Professional>`.
- `deleteProfessionalAction(tenantSlug, professionalId): Result<{ id }>` — mesma cautela de
  `deleteServiceAction`: `HAS_APPOINTMENTS` se tiver qualquer agendamento.
- `setProfessionalServicesAction(tenantSlug, professionalId, input): Result<Professional>` —
  `input: { serviceIds: string[] }`; substitui TODOS os serviços que o profissional realiza.
  Erro: `INVALID_SERVICE_IDS` se algum id não for desta empresa.
- `setProfessionalWorkingHoursAction(tenantSlug, professionalId, input): Result<WorkingHour[]>`
  — `input: { hours: { weekday: 0-6, startTime: "HH:mm", endTime: "HH:mm" }[] }`; substitui TODO
  o expediente do profissional (replace-all). Erro: `INVALID_WORKING_HOUR`.
- `listScheduleExceptionsAction(tenantSlug, range?): Result<ScheduleException[]>` — `range?: {
  from: string; to: string }` (ISO).
- `createScheduleExceptionAction(tenantSlug, input): Result<ScheduleException>` — `input: {
  professionalId: string | null, type: "BLOCK" | "HOLIDAY", startsAt, endsAt, reason? }`.
  `professionalId: null` = bloqueio da empresa inteira. Erros: `INVALID_RANGE`, `NOT_FOUND`
  (profissional).
- `deleteScheduleExceptionAction(tenantSlug, exceptionId): Result<{ id }>`.

### `src/modules/agenda/appointment-actions.ts`

- `listAppointmentsAction(tenantSlug, input): Result<Appointment[]>` — `input: { from, to,
  professionalId?, limit? }` (datas ISO). Erros: `INVALID_RANGE` (to ≤ from),
  `RANGE_TOO_LARGE` (> 95 dias). `limit` máx. 500, padrão 100 — sempre paginado, nunca "todos os
  registros".
- `createAppointmentAction(tenantSlug, input): Result<{ appointment, alreadyExisted: boolean }>`
  — `input: { contactId?, contactName?, contactPhoneE164?, serviceId, professionalId: string |
  null, startsAt, idempotencyKey? }`. `professionalId: null` = "qualquer profissional" apto e
  livre (o painel escolhe). Sem `contactId`, cria/reaproveita um contato "de painel"
  (`contactName` obrigatório nesse caso) — CRUD completo de clientes é de outro módulo (Fase 8).
  **Idempotente**: mesma `idempotencyKey`, OU mesmo contato+serviço+início já `SCHEDULED`, →
  `200`-equivalente com `alreadyExisted: true` e o agendamento existente (nunca duplica).
  Erros: `NOT_FOUND` (serviço/profissional/contato/nenhum profissional apto),
  `RULE_VIOLATION` com `details.rule ∈ OUTSIDE_HOURS | LEAD_TIME | HORIZON | INACTIVE`,
  `SLOT_TAKEN` com `details.alternatives` (até 6 horários livres do mesmo profissional/dia) —
  coberto tanto por uma verificação prévia quanto pela constraint `EXCLUDE` do banco como última
  linha de defesa contra corrida (provado em `tests/integration/agenda.integration.test.ts` com
  20 requisições paralelas: exatamente 1 sucesso, 19 `SLOT_TAKEN`).
- `cancelAppointmentAction(tenantSlug, appointmentId, input?): Result<Appointment>` — `input?: {
  note? }`. Idempotente (cancelar um já cancelado devolve `200` sem erro). Erros: `NOT_FOUND`,
  `TOO_LATE` (dentro de `Tenant.cancelMinLeadMin`).
- `rescheduleAppointmentAction(tenantSlug, appointmentId, input): Result<Appointment>` —
  `input: { startsAt }`. Erros: `NOT_FOUND`, `INVALID_STATE` (não está `SCHEDULED`), `TOO_LATE`,
  `RULE_VIOLATION`, `SLOT_TAKEN`.

- **Encerramento do atendimento** (2026-09-29) — `completeAppointmentAction`, `markNoShowAppointmentAction`, `reopenAppointmentAction`: todas `(input: { tenantSlug, appointmentId }) → Result<AppointmentView>`. `AppointmentView` = a linha do agendamento (mesmo formato que cancelar/remarcar devolvem), com `status`, `startsAt`/`endsAt` (Date; a UI mostra "Concluir"/"Cliente faltou" só quando `status === "SCHEDULED"` e `startsAt <= agora`) e `updatedAt`. OWNER e STAFF; `assertTenantCanWrite` (conta suspensa → `TENANT_SUSPENDED`).
  - `complete`/`markNoShow`: só de `SCHEDULED` **e** só depois do início. Erros: `APPOINTMENT_NOT_STARTED` (atendimento futuro; mensagem legível), `INVALID_STATE` (cancelado, ou já no outro encerramento), `NOT_FOUND` (inclusive agendamento de outra empresa), `INVALID_PAYLOAD`. Repetir a mesma ação é idempotente (sem 2º evento).
  - `reopen`: `COMPLETED`/`NO_SHOW` → `SCHEDULED` com evento `REOPENED`. Erros: `INVALID_STATE` (cancelado), `SLOT_TAKEN` (outro agendamento do mesmo profissional ocupou o horário — a constraint EXCLUDE recusa), `NOT_FOUND`. Já `SCHEDULED` = idempotente.
  - Grava `AppointmentEvent` (`COMPLETED`/`NO_SHOW`/`REOPENED`, `authorType: USER`, `authorId` = membro) na MESMA transação de um `updateMany` condicional (status + início no WHERE) — sem corrida com cancelamento/remarcação. Notificações: `APPOINTMENT_COMPLETED` / `APPOINTMENT_NO_SHOW` (kinds já existentes); `REOPENED` não notifica. A "taxa de faltas" do Início (`noShowRatePercent`) já lia `NO_SHOW`: passa a refletir o dado real.
  - Migration aditiva `20260930300000_appointment_event_reopened` (`ALTER TYPE ... ADD VALUE 'REOPENED'`).

### `src/core/agenda` (funções puras, sem I/O — docs/arquitetura.md §5, §10)

Usadas pelos módulos acima e reaproveitáveis pela API interna do bot (Fase 4):

- `computeDayWindows(dateISO, timezone, workingHours, closedRanges): TimeWindow[]`
- `computeAvailableSlots({ dateISO, timezone, workingHours, closedRanges, busy,
  serviceDurationMin, slotGranularityMin, minLeadTimeMin, now, professionalEligible? }):
  Date[]` — `professionalEligible: false` (profissional não faz o serviço) sempre `[]`.
- `computeAvailableDays({ …, maxHorizonDays, fromDateISO, limit }): { days: string[]; hasMore:
  boolean }`
- `checkBookingWindow({ start, end, timezone, workingHours, closedRanges, minLeadTimeMin,
  maxHorizonDays, now }): "OUTSIDE_HOURS" | "LEAD_TIME" | "HORIZON" | null`
- `isRangeFreeOfBusy(start, end, busy): boolean`

Testes em `src/core/agenda/__tests__/availability.test.ts`: virada de dia (fuso cruza a data
UTC), horário de verão (troca de offset em `America/New_York`), bloqueio parcial no meio do
expediente, serviço que não cabe no fim do expediente, profissional que não faz o serviço.

### `src/modules/agenda/availability-actions.ts` — disponibilidade para o widget de agendamento manual

Substitui, por Server Action, a rota `GET /api/agenda/slots?…` cogitada em
docs/arquitetura.md §6.10 (Server Actions já servem Client Components — não precisa virar rota
HTTP separada). `professionalId: null` = "qualquer profissional" apto (união dos livres).

- `listAvailableSlotsAction(tenantSlug, { serviceId, professionalId, date }): Result<{ slots:
  string[] }>` — `date: "YYYY-MM-DD"`, `slots` são instantes ISO UTC, já ordenados.
- `listAvailableDaysAction(tenantSlug, { serviceId, professionalId, from, limit? }): Result<{
  days: string[]; hasMore: boolean }>` — `from`/`days` em `"YYYY-MM-DD"`, `limit` padrão 7,
  máx. 30 (sempre paginado).

## API interna do bot (n8n → painel) — Fase 4

Implementada. Contrato completo em docs/arquitetura.md §6.1–6.9; OpenAPI gerado dos schemas zod
(`src/lib/api-internal/schemas.ts`) em `docs/api-interna.openapi.json` — rodar
`npm run generate:openapi` sempre que um schema mudar (não roda automaticamente no build).

Base: `https://<painel>/api/internal/v1`. `Authorization: Bearer <INTERNAL_API_SECRET>` +
`X-InnoChat-Instance: <webhookToken>` em TODA requisição (`resolveInternalRequest`,
`src/modules/bot-api/internal-auth.ts`) — resolve o tenant SEMPRE pela instância, nunca pelo
corpo. Erro único `{ "error": { "code", "message", "details"? } }`
(`src/lib/api-internal/respond.ts`, que reaproveita os MESMOS códigos de `DomainError` que
`src/modules/agenda/*` já lança desde a Fase 2 — não há vocabulário de erro paralelo).

Rotas (`src/app/api/internal/v1/**`):

- `POST /messages/claim` (`src/modules/bot-api/claim.ts`) — normaliza o payload da Evolution
  (`src/core/bot/evolution-normalize.ts`, função pura), deduplica por `InboundEvent`
  (`whatsappInstanceId, providerMessageId`), adquire a trava da sessão (lease de 20s via `UPDATE
  ... WHERE lockToken IS NULL OR lockedUntil < now()` — atômico no Postgres, sem `SELECT FOR
  UPDATE`), resolve `@lid` (`remoteJidAlt`/`senderPn`, com fallback a `Contact.lid` já
  conhecido), avalia bloqueio por contato/modo humano, eco `fromMe`
  (hash sha256 em `ChatSession.recentOutbound`, janela de 2 min), assinatura
  (`isTenantBotAllowed`, stub — ver PENDÊNCIAS), STALE (>5 min) e expiração de sessão
  (`Tenant.sessionTimeoutMin`). **Nunca 5xx para payload irreconhecível** — testado com fixture
  `garbage.json`.
- `PUT /sessions/{id}` / `POST /sessions/{id}/release` (`src/modules/bot-api/session.ts`) — grava
  e libera a trava (`409 LOCK_LOST` se `lockToken`/`version` não baterem ou a trava venceu);
  `release` é sempre idempotente.
- `GET /catalog/services`, `GET /catalog/services/{serviceId}/professionals`, `GET
  /availability/days`, `GET /availability/slots` (`src/modules/bot-api/booking-bot.ts`) —
  reaproveitam `src/core/agenda` e `src/modules/agenda/availability-loader.ts` (Fase 2) sem
  alteração de lógica, só mudam a FORMA da resposta para `{ options: [{id,label}] }` já
  numerável, com rótulos formatados no fuso/locale do tenant (`src/core/bot/format.ts`). O
  sentinel `{ id: "any", label: "Qualquer profissional" }` em `/catalog/.../professionals`
  significa "profissionalId: null" — quem monta o workflow (Fase 5) precisa traduzir essa opção
  para `professionalId: null` antes de chamar os endpoints seguintes (nunca envie a string
  `"any"` adiante).
- `PATCH /contacts/{contactId}`, `GET /contacts/{contactId}/appointments` — nome 2–60
  caracteres (`INVALID_NAME`); "meus agendamentos" com rótulo `"Ter 30/09 14:30 — Corte
  feminino (Ana)"` **e** (Fase 4b) `serviceId`, `professionalId`, `servico`, `profissional`,
  `data`, `hora` (mesmos formatos de `core/bot/format.ts`) e `startsAt` (ISO) em cada opção —
  aditivo, `label` continua igual.
- `POST /appointments`, `POST /appointments/{id}/cancel`, `POST /appointments/{id}/reschedule`
  (`src/modules/bot-api/booking-bot.ts`) — reaproveitam `createAppointmentManual`/
  `cancelAppointment`/`rescheduleAppointment` de `src/modules/agenda/appointments.ts` (Fase 2,
  ganharam parâmetros opcionais `source`/`whatsappInstanceId`/`authorType` — comportamento
  antigo preservado por padrão). Idempotência e a concorrência de 20 reservas paralelas (1×201 +
  19×409) são as MESMAS garantias da Fase 2 (constraint `EXCLUDE`), só testadas de novo pelo
  caminho do bot em `tests/integration/bot-api.integration.test.ts`. `SLOT_TAKEN` devolve
  `{ alternatives: { date, options } }` — busca no mesmo dia e, se vazio, nos próximos dias
  dentro do horizonte (nunca vazio se existir QUALQUER horário possível).
- `POST /connection-events` — sempre `200`; aplica `open|close|connecting` →
  `CONNECTED|DISCONNECTED|QRCODE` na `WhatsappInstance` já resolvida pelo token. **Não há
  adaptador de chamadas de volta para a Evolution** (isso é Fase 3, ver PENDÊNCIAS) — este
  endpoint só consome o webhook.
- `POST /sandbox/outbox` (+ `GET`, extensão fora de §6.8 — ver PENDÊNCIAS) — só instância
  `sandbox=true` (`403 FORBIDDEN` senão); guardado em memória do processo, TTL 24h (dívida
  registrada em `src/modules/bot-api/sandbox-outbox.ts`).

`BotText` (`src/modules/bot-texts/service.ts`): `getMergedBotTexts(tenantId)` mescla
`DEFAULT_BOT_TEXTS` (pt-BR, `src/core/bot/texts.ts`) com as edições do tenant — usado pelo
`claim`. CRUD como Server Actions (`src/modules/bot-texts/bot-text-actions.ts`,
`listBotTextsAction`/`upsertBotTextAction`/`resetBotTextAction`/`previewBotTextAction`),
guardadas por `requireTenantMember`, **sem tela** nesta fase (para a Lyra construir "Mensagens
do bot" depois). `upsertBotTextAction` valida que só existem variáveis conhecidas
(`{nome} {empresa} {servico} {profissional} {data} {hora} {preco}`) — `INVALID_PAYLOAD` senão.

`fixtures/evolution/*.json`: 9 payloads baseados na documentação pública da Evolution v2 (texto,
extendedTextMessage, `@lid` com/sem alternativa, grupo, mídia, `fromMe`, `connection.update`,
lixo) — **nenhum capturado do servidor real** (Fase 0 ainda não rodou). Ver
`fixtures/evolution/README.md` para o que muda quando os reais chegarem.

## Fase 4b — API interna do bot: buracos de contrato encontrados ao montar o `innochat-bot` no n8n

O workflow real (`n8n/innochat-bot.json`, mapa em `n8n/README.md`) expôs 3 buracos no contrato
da Fase 4 — corrigidos de forma ADITIVA (nada do que o workflow já usa mudou de forma):

1. **`GET /contacts/{contactId}/appointments` agora devolve dados estruturados por opção**, não
   só `{id,label}`. Antes, o nó "Ação escolhida" do n8n extraía `data`/`hora`/`servico`/
   `profissional` do `label` por regex para montar `CONFIRM_CANCEL` — frágil (dependia do
   formato exato do rótulo) e não dava para remarcar (faltava `serviceId`/`professionalId`).
   Cada item agora é `{ id, label, serviceId, professionalId, servico, profissional, data, hora,
   startsAt }` (`data`/`hora` no fuso do tenant, mesmos formatos de `core/bot/format.ts`;
   `startsAt` ISO em UTC). Implementado em `listMyAppointmentOptions`
   (`src/modules/bot-api/booking-bot.ts`).
2. **`tenant.timezone` na resposta `process` do `POST /messages/claim`** — antes só `{ name,
   askProfessional }`; agora `{ name, askProfessional, timezone }`. O placeholder `timezone` do
   nó Config do n8n (`n8n/README.md`) pode ser eliminado a favor deste campo, que nunca fica
   desincronizado do tenant real.
   `GET /availability/days` já aceita `from` **omitido** (novo — antes era obrigatório): nesse
   caso o padrão é "hoje no fuso do tenant", resolvido no backend (`listAvailabilityDayOptions`)
   sem o chamador precisar saber o fuso.
3. **Rótulos estruturais editáveis** — "Confirmar", "Escolher outro horário", "Sim, cancelar",
   "Não, manter", "Ver mais datas", "Mais horários", "Ver mais" e o rodapé "0. Menu principal"
   (hoje hardcoded no Code node "Montar mensagem" do n8n) ganharam chaves `BotText` novas, com
   os MESMOS valores como padrão, devolvidas no mesmo `texts` do claim:
   `LABEL_CONFIRM`, `LABEL_OTHER_TIME`, `LABEL_CANCEL_YES`, `LABEL_CANCEL_NO`,
   `LABEL_MORE_DAYS`, `LABEL_MORE_TIMES`, `LABEL_MORE`, `LABEL_BACK_TO_MENU`
   (`BOT_TEXT_KEYS`/`DEFAULT_BOT_TEXTS` em `src/core/bot/texts.ts`; migration
   `prisma/migrations/20260928000006_bot_text_structural_labels`, `ALTER TYPE ... ADD VALUE`
   aplicada em `innochat` e `innochat_test`). Passam pelo MESMO CRUD/preview de `BotText`
   (`listBotTextsAction`/`upsertBotTextAction`/`resetBotTextAction`/`previewBotTextAction`) sem
   tratamento especial — são texto livre sem `{variavel}` (não fazem parte de
   `BOT_TEXT_VARIABLES`, então `{algo}` neles cai em `INVALID_PAYLOAD` como qualquer variável
   desconhecida). **Descrição humana de cada chave nova, para a tela "Mensagens do bot" (Lyra):**
   - `LABEL_CONFIRM` — botão/opção "Confirmar" na tela de confirmar agendamento.
   - `LABEL_OTHER_TIME` — botão/opção "Escolher outro horário" na tela de confirmar agendamento.
   - `LABEL_CANCEL_YES` — botão/opção "Sim, cancelar" na confirmação de cancelamento.
   - `LABEL_CANCEL_NO` — botão/opção "Não, manter" na confirmação de cancelamento.
   - `LABEL_MORE_DAYS` — opção de paginação "Ver mais datas" na lista de dias disponíveis.
   - `LABEL_MORE_TIMES` — opção de paginação "Mais horários" na lista de horários disponíveis.
   - `LABEL_MORE` — opção de paginação genérica "Ver mais" (menus com mais de 9 itens).
   - `LABEL_BACK_TO_MENU` — rodapé "0. Menu principal" que aparece nas telas do bot.

   A implementação do lado do n8n (trocar o hardcode de `MENUS`/footer/paginação no Code node
   "Montar mensagem" por `texts.LABEL_*`) **não foi feita nesta rodada** — é trabalho no
   workflow, fora do escopo de backend; o contrato já está pronto para consumir.

## Rotas HTTP do navegador previstas (Fase 2+)

- `GET /api/whatsapp/instances/{id}/state` cogitada em docs/arquitetura.md §6.10 — **não virou
  rota HTTP**: implementada como Server Action (`getQrCodeAction`/`refreshConnectionStatusAction`,
  ver "WhatsApp (Fase 3)" abaixo), mesmo raciocínio de `listAvailableSlotsAction` (Fase 2):
  Server Actions já servem Client Components, sem precisar de uma rota HTTP separada.
- `GET /api/agenda/slots?…` (Fase 2 — na prática coberto por `listAvailableSlotsAction`, ver
  seção "Catálogo e agenda" acima; não virou rota HTTP separada)

Implementadas na Fase 7 (ver seção "Cobrança e cadastro público" mais abaixo):

- `POST /api/webhooks/mercadopago`
- `POST /api/internal/v1/billing/tick`

---

## WhatsApp (Fase 3) — conexão por QR code

Implementado. Contrato completo em docs/arquitetura.md §4, §7.3 regra 4, §8 "Configuração pela
plataforma". Modelos (`WhatsappInstance`, `TrialClaim`) já existiam (Cronos, Fase 1/schema
inicial) — esta fase implementa o adaptador Evolution, a lógica de negócio e as Server Actions;
sem tela (a Lyra consome o contrato abaixo).

### `src/modules/whatsapp/evolution-client.ts` — adaptador Evolution API v2

Interface isolada (`EvolutionClient`) e mockável — nenhum outro módulo importa `fetch` para a
Evolution direto, tudo passa por aqui (mesmo padrão de `MercadoPagoGateway`,
`src/modules/billing/mercadopago.ts`). Timeout de 15s, até 3 tentativas com retry **só** em 5xx e
falha de rede/timeout (nunca em 4xx). O corpo de erro da Evolution NUNCA entra em log nem na
mensagem da exceção (pode ecoar PII do payload) — só status + path + um `correlationId`.

- `createInstance(instanceName)` — `POST /instance/create` (`integration: "WHATSAPP-BAILEYS"`,
  `qrcode: true`, `groupsIgnore: true`, `readMessages: false`, `alwaysOnline: false`). NÃO
  configura webhook (passo separado, abaixo) — permite compensar (apagar) a instância se o
  passo do webhook falhar, sem confundir "criou mas sem webhook útil" com "criou certo".
- `setWebhook(instanceName, webhookUrl)` — `POST /webhook/set/{instance}`, sempre explícito
  depois do `createInstance` (docs/arquitetura.md §4): `{ webhook: { enabled: true, url,
  byEvents: false, base64: false, events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE"] } }`.
- `connect(instanceName)` — `GET /instance/connect/{instance}` → `{ qrCodeDataUrl: string | null,
  pairingCode: string | null }`. `qrCodeDataUrl` sempre em formato `data:image/png;base64,...`
  (aceita base64 cru ou data URL completa da Evolution, normaliza para o mesmo formato). `null`
  quando a instância já está conectada (não há QR).
- `connectionState(instanceName)` — `GET /instance/connectionState/{instance}` → string bruta
  (`"open" | "connecting" | "close" | ...`); mapeamento para o enum do domínio é
  `mapEvolutionState` (`src/core/whatsapp/connection-event.ts`).
- `fetchOwnerJid(instanceName)` — `GET /instance/fetchInstances?instanceName=` → JID do dono
  (`ownerJid`/`owner`/`instance.owner`, conforme a versão) ou `null`.
- `logout(instanceName)` — `DELETE /instance/logout/{instance}` (mantém a instância, só encerra
  a sessão — permite reconectar com um QR novo).
- `deleteInstance(instanceName)` — `DELETE /instance/delete/{instance}` (remove de vez; usado no
  "Remover" da tela e na compensação de um `create` que falhou no meio).

`getEvolutionClient()` resolve `baseUrl`/`apiKey` de `PlatformSettings` (§8 — nada em env var);
lança `DomainError("EVOLUTION_NOT_CONFIGURED", …)` se faltar.

⚠️ **HONESTIDADE SOBRE O QUE FOI VERIFICADO**: implementado a partir da documentação pública da
Evolution API v2 e do adaptador validado AO VIVO no InnoAtendente (2026-09-04,
`C:\Projetos\Web\InnoAtendente\src\adapters\whatsapp\evolution\index.ts`). **Sem servidor
Evolution real do InnoChat conectado nesta rodada** — todo formato de resposta está marcado com
`SUPOSIÇÃO:` no código, e os testes unitários (`evolution-client.test.ts`) usam fixtures **não
capturadas de um servidor real**. Confirmar contra um servidor de verdade antes de confiar
cegamente em produção (mesma pendência que a Fase 0 da arquitetura já registra para o resto do
sistema).

### `src/core/whatsapp/*` — normalização pura (sem I/O)

- `phone.ts#normalizePhoneFromJid(jid)` — `"5511999999999@s.whatsapp.net"` → `"+5511999999999"`,
  com a MESMA correção do 9º dígito brasileiro validada ao vivo no InnoAtendente (2026-09-05):
  reconstitui o 9 que falta em `subscriber` de 8 dígitos, só para `+55`. `null` para JID vazio.
- `instance-name.ts#buildInstanceName(tenantSlug, randomSuffix)` — `innochat-<slug≤20>-<curto>`
  (prefixo `innochat-` obrigatório: Evolution compartilhada com o InnoAtendente). Recebe o
  sufixo aleatório já gerado pelo chamador (I/O de `crypto` fica na camada de serviço) — função
  pura, testável sem mockar `crypto`.
- `connection-event.ts`:
  - `mapEvolutionState(state)` — `"open"→CONNECTED`, `"connecting"→QRCODE`,
    `"close"/"closed"→DISCONNECTED`, resto → `null`.
  - `resolveNextConnectionStatus(currentStatus, mapped)` — só regride para `DISCONNECTED`
    quando o status LOCAL já era `CONNECTED` (queda real, §4 passo 5). Uma instância que nunca
    conectou fica em `close` o tempo todo esperando o QR ser escaneado — isso NÃO é "queda", e
    regredir confundiria a tela. Usada pelo POLLING (`service.ts`); o webhook
    (`connection-events.ts`) aplica o status bruto direto, sem essa heurística — um evento da
    Evolution é fidedigno, uma consulta pode pegar um instante intermediário.
  - `parseConnectionEvent(rawBody)` — normaliza o webhook `connection.update`/`CONNECTION_UPDATE`
    para `{ state, ownerJid }`. **Ignora o campo `instance` do corpo de propósito**: quem chama
    já resolveu a instância pelo `webhookToken` do path (`X-InnoChat-Instance`) — exigir esse
    campo aqui duplicaria uma verificação que já existe, e um payload real sem ele (ou atrás de
    `byEvents:true`) não pode virar um falso negativo. Nunca lança; payload irreconhecível → `null`.

### `src/modules/whatsapp/connection.ts` — TrialClaim compartilhado

`applyConnectedNumber({ tenantId, instanceId, instanceName, phoneE164, evolution? })` —
**compartilhado** pelo polling do dashboard (`getQrCode`/`refreshConnectionStatus`) E pelo
webhook (`POST /connection-events`), para a regra de "um trial por número" nunca ficar
desalinhada entre os dois caminhos que podem detectar uma conexão (docs/arquitetura.md §7.3
regra 4, lição "estender função de domínio compartilhada, não forkar").

- Só age quando `effectiveStatusForTenant(tenantId) === "TRIALING"`. Fora do trial, só aplica
  `status: CONNECTED` + `phoneE164` + `lastConnectedAt`, sem tocar `TrialClaim`.
- Em trial: busca `TrialClaim(phoneE164)`.
  - Não existe → cria `TrialClaim(phoneE164, tenantId)` (corrida entre dois caminhos detectando
    a mesma conexão ao mesmo tempo — webhook E polling — é absorvida pela constraint
    `@unique(phoneE164)`, mesmo padrão de `isUniqueViolation` do `claim` da Fase 4).
  - Existe e é da MESMA empresa (reconectando) → segue normalmente.
  - Existe e é de OUTRA empresa → **bloqueia**: marca a instância local `DISCONNECTED` (sem
    telefone), chama `evolution.logout(instanceName)` (melhor esforço — falha só loga, nunca
    impede o bloqueio local) e devolve `{ blocked: true, reason: "TRIAL_PHONE_ALREADY_USED" }`.

### `src/modules/whatsapp/service.ts` — camada de serviço

- `listWhatsappInstances(tenantId)` — só `deletedAt: null`, ordenado por `createdAt`.
- `createWhatsappInstance({ tenantId, tenantSlug, label, evolution? })` — ordem deliberada
  (mission "sem instância órfã: compense ou marque para limpeza"):
  1. `assertCanAddWhatsappNumber(tenantId)` (`src/modules/billing/plan-limits.ts`, Fase 7) —
     falha ANTES de qualquer chamada externa.
  2. `n8nWebhookBaseUrl`/URL pública configuradas (`PUBLIC_URL_UNKNOWN`/`N8N_NOT_CONFIGURADO`
     unificados em `N8N_NOT_CONFIGURED`, mensagem "configure o n8n na área de administração") —
     nunca cria uma instância sem webhook por falta de configuração da plataforma (§8).
  3. `evolution.createInstance(instanceName)`.
  4. `evolution.setWebhook(instanceName, webhookUrl)` — falhou → compensa (`deleteInstance`) e
     relança; nada é gravado localmente.
  5. Grava `WhatsappInstance` local (`status: QRCODE`) — falhou (infra) → compensa a Evolution
     também: nunca deixa uma instância órfã lá enquanto o painel não sabe que ela existe.
  A compensação é melhor esforço: se o `deleteInstance` de limpeza também falhar, loga
  `whatsapp.create.compensation_failed` para o admin limpar manualmente (dívida consciente —
  não há fila de retry nesta rodada).
- `getQrCode(tenantId, instanceId, { evolution? })` — o QR expira e o cliente consulta a cada
  ~3s (docs/arquitetura.md §4): **nunca cacheamos o QR localmente**, sempre `connectionState` +,
  se ainda não conectado, um `connect()` fresco a cada chamada. Se `connectionState` disser
  `open`, busca o dono (`fetchOwnerJid`) e aplica via `applyConnectedNumber` — bloqueado por
  `TrialClaim` vira `{ status: "DISCONNECTED", blockedReason: "TRIAL_PHONE_ALREADY_USED" }` (a
  Lyra mostra essa mensagem na tela, sem QR novo).
- `refreshConnectionStatus(tenantId, instanceId, { evolution? })` — igual, sem buscar QR (mais
  barato; "Verificar agora"/atualização de status pura).
- `disconnectWhatsapp`/`removeWhatsappInstance` — chamam `logout`/`deleteInstance` na Evolution
  como MELHOR ESFORÇO (falha remota não impede a atualização local — o usuário pediu para
  desconectar/remover, e mesmo que a Evolution já não tenha a instância, o painel precisa
  refletir a intenção). `remove` é soft delete (`deletedAt`), nunca perde o histórico.
- `setSandbox(tenantId, instanceId, sandbox)` — sem chamada à Evolution, só a coluna local.

### Server Actions (`src/modules/whatsapp/actions.ts`)

Leitura aberta a qualquer membro do tenant; MUTAÇÃO restrita a `OWNER`
(`requireTenantMember(slug, ["OWNER"])`) — decisão de infraestrutura da empresa, mesmo nível de
`updateTenantThemeAction`.

- `listWhatsappInstancesAction(tenantSlug): Result<WhatsappInstanceView[]>`
- `createWhatsappInstanceAction(tenantSlug, { label }): Result<WhatsappInstanceView>` — exige
  `requireVerifiedEmail()` **ANTES** de `requireTenantMember(..., ["OWNER"])` (docs/arquitetura.md
  §7.3 regra 2: "sem e-mail verificado, não é possível conectar WhatsApp" — a ordem garante que
  um usuário sem e-mail verificado recebe sempre `EMAIL_NOT_VERIFIED`, independente de ser ou
  não `OWNER` ali, sem vazar permissão). Também chama `assertTenantCanWrite` (bloqueado se a
  assinatura estiver `SUSPENDED`/`CANCELED`). Erros: `EMAIL_NOT_VERIFIED`, `FORBIDDEN` (não é
  `OWNER`), `NOT_FOUND` (empresa/membership), `TENANT_SUSPENDED`, `PLAN_LIMIT_REACHED` (`details:
  { rule: "maxWhatsappNumbers", limit, current }`), `N8N_NOT_CONFIGURED`,
  `EVOLUTION_NOT_CONFIGURED`, `INVALID_PAYLOAD`.
- `getQrCodeAction(tenantSlug, instanceId): Result<QrCodeView>` — `QrCodeView: { status, 
  qrCodeDataUrl, pairingCode, phoneE164, blockedReason }`. Consultado pelo Client Component a
  cada ~3s enquanto `status !== "CONNECTED"` (a Lyra decide o intervalo e o corte em ~2min, ver
  docs/arquitetura.md §4 passo 2). Erro: `NOT_FOUND` (instância não é deste tenant, ou removida).
- `refreshConnectionStatusAction(tenantSlug, instanceId): Result<ConnectionStatusView>` —
  `{ status, phoneE164, blockedReason }`, sem QR.
- `disconnectWhatsappAction(tenantSlug, instanceId): Result<WhatsappInstanceView>`
- `removeWhatsappInstanceAction(tenantSlug, instanceId): Result<{ id }>`
- `setSandboxAction(tenantSlug, instanceId, { sandbox }): Result<WhatsappInstanceView>`

`WhatsappInstanceView`: `{ id, label, instanceName, status, phoneE164, sandbox,
lastConnectedAt, createdAt }` (datas em ISO string).

### `POST /connection-events` (Fase 4 + Fase 3, completo)

`src/modules/bot-api/connection-events.ts`. Já existia (Fase 4, só `status`); esta rodada
completa a cobertura pedida: número conectado (`ownerJid`/`wuid`) e `TrialClaim`.

- `state === "CONNECTED"` (evento `open`): se o payload trouxer `wuid`, normaliza o telefone e
  chama `applyConnectedNumber` (mesma função do polling — TrialClaim incluído). **Sem `wuid`
  neste evento específico** (a Evolution às vezes manda `connection.update` sem o dono
  preenchido), aplica só `status: CONNECTED` + `lastConnectedAt` — o telefone/TrialClaim são
  resolvidos no próximo poll do dashboard (comportamento herdado da Fase 4, mantido para não
  quebrar o contrato já testado).
- `state !== "CONNECTED"` (`connecting`/`close`): aplica o status bruto diretamente
  (`QRCODE`/`DISCONNECTED`) — **sem** a heurística "só regride de CONNECTED" usada pelo polling
  (`resolveNextConnectionStatus`): um evento da Evolution é fidedigno; a heurística existe só
  para não regredir por causa de um instante intermediário de uma CONSULTA de polling.
- Sempre `200`/`{ applied: boolean }`, nunca lança — payload irreconhecível ou `state`
  desconhecido → `{ applied: false }`.

### Migration

`20260928000008_platform_n8n_cron_workflow` — não é desta feature (ver "Sincronização do n8n"
abaixo); `WhatsappInstance`/`TrialClaim` já existiam desde o schema inicial (Cronos), sem
migration nova nesta rodada.

### PENDÊNCIAS (Fase 3)

- **Sem servidor Evolution real conectado** — todo o adaptador foi testado com `fetch` mockado;
  falta confirmar os formatos de resposta (`connect`, `connectionState`, `fetchInstances`,
  `webhook/set`) contra uma instância de verdade antes de confiar em produção (mesma pendência
  da Fase 0 da arquitetura, nunca resolvida por falta de servidor disponível nesta sessão).
- **Sem tela** — Lyra consome o contrato acima (Server Actions prontas) para montar "Painel ›
  WhatsApp › Conectar número" (docs/arquitetura.md §4).
- `emailDomain` de `TrialClaim` nunca é preenchido (`null` sempre) — o schema tem o campo, mas
  nada nesta rodada o popula; simplificação consciente (o `phoneE164` já é a defesa principal).

## Sincronização do n8n — `innochat-cron` (Fase 3, acréscimo pontual)

`src/modules/platform/n8n-sync.ts` (Fase 5+, já existia) ganhou um terceiro workflow opcional:
`innochat-cron` (`n8n/README.md` — Schedule de hora em hora → nó `Config cron` → `POST
{painelUrl}/billing/tick`, credencial "InnoChat Painel (Bearer)", sem `X-InnoChat-Instance`).

- `syncN8n()` agora também resolve `innochat-cron` por id salvo (`PlatformSettings.n8nWorkflowCronId`)
  → id de fábrica (`dPMhT4MqGglCpFSw`, `n8n/README.md`) → nome — **NUNCA lança se não achar**
  (`tryResolveWorkflow`, diferente de `resolveWorkflow` usado para bot/erros): o cron é opcional,
  a sync não pode falhar por causa dele. Quando não encontrado, `N8nSyncSummary.warnings` ganha
  uma mensagem e `n8nWorkflowCronId` no banco fica como estava (nunca apaga uma referência válida
  por uma falha transitória de busca).
- Quando encontrado: escreve `painelUrl` no nó `Config cron` e reata a credencial do painel no
  nó HTTP `Chamar billing/tick` (só o grupo "painel" — o cron não conhece Evolution nem n8n API).
- `activateBotWorkflow()`/`deactivateBotWorkflow()` publicam/despublicam o `innochat-cron` JUNTO
  com o `innochat-bot` (mesma chamada). Sem cron sincronizado ainda, pula essa parte
  silenciosamente (não é erro — só o bot precisa estar sincronizado).
- `N8nSyncSummary` ganhou `cronWorkflowId: string | null` e `warnings: string[]`.

Migration `20260928000008_platform_n8n_cron_workflow` — `PlatformSettings.n8nWorkflowCronId`
(nullable), aplicada em `innochat` e `innochat_test`; `DOWN.sql` presente.

Testado em `tests/integration/platform-n8n-sync.integration.test.ts` (fake server): sincroniza
`Config cron`/credencial quando o workflow existe; não falha e avisa quando não existe;
`activateBotWorkflow` não falha quando o cron nunca foi sincronizado.

---

## O que a Íris deve testar nesta fase

- `src/lib/db/tenant-scope.ts` (`scopeArgsToTenant`, `isTenantScopedModel`) —
  testes unitários já em `src/lib/db/__tests__/tenant-scope.test.ts`, sem
  depender de Postgres.
- `src/env.ts` — validação falha com mensagem clara quando falta uma env var
  obrigatória (não testado automaticamente ainda; sugestão de teste para a
  Íris quando o schema existir e o build completo puder rodar).
- Depois que o schema existir: fluxo de login (e-mail/senha correto, senha
  errada, e-mail inexistente — todos devolvendo a mesma mensagem genérica).
- `src/core/agenda/__tests__/availability.test.ts` — já cobre os 5 cenários pedidos (virada de
  dia, DST, bloqueio parcial, serviço que não cabe, profissional inapto). Vale a Íris somar
  casos de borda extras (ex.: expediente com múltiplas faixas no mesmo dia, bloqueio que cobre o
  expediente inteiro).
- `tests/integration/agenda.integration.test.ts` (`npm run test:integration`, requer
  `TEST_DATABASE_URL` com migrations aplicadas) — concorrência real (20 paralelas → 1 sucesso +
  19 `SLOT_TAKEN`), idempotência, isolamento entre tenants por id (cancelar/remarcar/editar
  catálogo/listar). A Íris deve rodar o fluxo completo do painel (criar serviço → profissional →
  expediente → agendamento manual → cancelar/remarcar) via Playwright quando a Lyra tiver as
  telas, e testar especificamente: dois usuários de empresas diferentes tentando adivinhar o id
  um do outro na URL.
- Admin da plataforma: salvar segredo, reabrir a tela e confirmar que ele volta mascarado (nunca
  em texto puro); campo vazio no formulário não apaga o valor salvo; `internalApiSecretConfigured`
  vira `true` só depois de gerar o segredo, e o valor em texto puro nunca aparece de novo.

## O que o Órion deve revisar

- `getPrisma()` é FUNÇÃO, nunca Proxy (comentário em `src/lib/db/prisma.ts`
  explica a lição do InnoAtendente).
- `forTenant()` sobrescreve `tenantId` recebido do chamador em vez de
  confiar nele — checar que nenhum código futuro tenta contornar isso
  passando `tenantId` para dentro de um `where`/`data` já dentro de
  `forTenant()` esperando que "o mais específico ganha" (não ganha: o
  `scopeArgsToTenant` sempre sobrescreve por último).
- Regra de ESLint `no-restricted-imports` para `@prisma/client` fora de
  `src/lib/db/` — confirmar que cobre `src/core/**` com a mensagem certa
  (domínio puro, sem Prisma).
- `verifyCredentials` não lança para credencial inválida (vira `null`, não
  500) e usa mensagem genérica (sem enumeration de e-mail).
- `src/lib/auth/guards.ts`: `requireTenantMember` resolve o tenant SEMPRE por `slug` (nunca
  aceita um `tenantId` de parâmetro), e devolve `NOT_FOUND` tanto para empresa inexistente
  quanto para "sem membership" — checar que nenhuma Server Action nova aceite um `tenantId`
  direto do client como atalho para pular essa resolução.
  `requirePlatformAdmin`/`requireTenantMember` sempre releem do banco (nunca confiam em campo
  de sessão para autorização).
- `src/modules/platform/service.ts`: segredos mascarados (`maskSecret`, só os últimos 4
  caracteres); `internalApiSecretHash` nunca sai da função `regenerateInternalApiSecret`
  (verificar que nenhum `select`/log em volta dela devolve o hash ou o segredo); comparação do
  segredo (`verifyInternalApiSecret`, usado pela Fase 4) é `crypto.timingSafeEqual`, não `===`.
- `src/modules/agenda/appointments.ts`: `isExclusionViolation` detecta a constraint `EXCLUDE`
  por assinatura (`PrismaClientUnknownRequestError` + SQLSTATE `23P01` na mensagem) porque o
  Prisma não dá um `error.code` próprio para isso — confirmado contra o Postgres real
  (documentado no comentário da função); se uma versão futura do Prisma passar a reconhecer
  `23P01` com um `code` dedicado, simplificar a checagem.
- `deleteService`/`deleteProfessional` bloqueiam DELETE se houver qualquer `Appointment`
  vinculado (`HAS_APPOINTMENTS`) — o schema tem `onDelete: Cascade` em `Appointment`, então um
  DELETE sem essa checagem apagaria histórico de agendamento silenciosamente.
- `src/modules/agenda/catalog.ts` (`setProfessionalServices`, `setProfessionalWorkingHours`):
  `ProfessionalService`/`WorkingHour` não têm `tenantId` próprio — checar que todo acesso carrega
  o `Professional` pai via `forTenant()` ANTES de tocar o filho (mesma lição documentada em
  `.claude/agent-memory/vega/for_tenant_scope_limits.md`).

## Fase 4 — API interna do bot: o que a Íris deve testar

- `npm run test:integration` cobre (`tests/integration/bot-api.integration.test.ts`):
  autenticação (`resolveInternalRequest` — sem Bearer, segredo errado, sem
  `X-InnoChat-Instance`, token de instância inexistente → sempre 401); dedupe do mesmo
  `providerMessageId` 2x → `DUPLICATE` na segunda, e só 1 `InboundEvent` gravado; claim
  concorrente do mesmo contato → uma execução `busy`; isolamento entre tenants (mesmo JID e
  mesmo `providerMessageId` em duas instâncias de tenants diferentes NÃO cruzam
  `Contact`/`ChatSession`); `@lid` sem alternativa e sem `Contact.lid` conhecido →
  `UNRESOLVABLE_SENDER`; `PUT /sessions/{id}` com `lockedUntil` vencido OU `version` errada →
  `LOCK_LOST`, e com os dois corretos grava e libera a trava; 20 reservas paralelas pelo caminho
  do bot → exatamente 1 sucesso + 19 `SLOT_TAKEN` com `alternatives.{date,options}`;
  idempotência de `POST /appointments`; `contactId` de outro tenant → `NOT_FOUND`.
- **Não coberto ainda** (a Íris deve somar, quando fizer sentido): eco `fromMe` (hash bate com
  saída recente) e "humano assume" (`fromMe` sem eco); `BOT_PAUSED`/`HUMAN_MODE`; expiração de
  sessão (`sessionTimeoutMin`); `STALE` (>5 min); `TOO_LATE` em cancelar/remarcar pelo bot;
  `PATCH /contacts/{contactId}` (nome 2–60); `/connection-events`; `/sandbox/outbox`. A lógica já
  existe e está coberta por revisão de código, mas depende de manipular tempo/relógio nos
  testes — vale a pena a Íris decidir se usa `vi.useFakeTimers()` ou parâmetros injetáveis.
- Rodar o `POST /messages/claim` de verdade contra as 9 fixtures de `fixtures/evolution/` (só
  chamando `claimMessage` direto, como os testes acima) é o teste de regressão do dia em que os
  payloads REAIS da Fase 0 substituírem essas fixtures — se algum campo mudar de nome, um teste
  quebra e aponta exatamente onde mexer em `src/core/bot/evolution-normalize.ts`.

## Fase 4 — API interna do bot: o que o Órion deve revisar

- `src/modules/bot-api/internal-auth.ts`: comparação do segredo é via
  `verifyInternalApiSecret` (`crypto.timingSafeEqual`, já revisado na Fase 1); toda falha de
  auth é `401` — nunca `403` (não confirma nada sobre existência de recursos a quem não está
  autenticado).
- `src/modules/bot-api/claim.ts`: a trava é uma `updateMany` condicional
  (`WHERE lockToken IS NULL OR lockedUntil < now()`) — não um `SELECT ... FOR UPDATE` — checar
  que a leitura de `count === 0` como "não adquiriu" está certa (Postgres serializa dois
  `UPDATE`s concorrentes na mesma linha: o segundo só reavalia o `WHERE` depois que o primeiro
  comita). `isUniqueViolation` detecta `P2002` por assinatura (`constructor.name` + `.code`),
  mesmo padrão de `isExclusionViolation` (Fase 2) — ver
  `.claude/agent-memory/vega/prisma_exclude_violation_shape.md`.
- `src/core/bot/evolution-normalize.ts`: puro, nunca lança — todo caminho de payload inválido
  vira `{ kind: "unsupported" }`; é essa garantia que sustenta "claim nunca devolve 5xx".
- `src/modules/bot-texts/service.ts` (`upsertBotText`): `assertKnownVariables` bloqueia
  `{variavelDesconhecida}` no texto ANTES de salvar — checar que a lista
  `BOT_TEXT_VARIABLES` (`src/core/bot/texts.ts`) continua sincronizada com o que
  `renderTemplate` de fato substitui.
- `src/modules/agenda/appointments.ts`: os novos parâmetros opcionais `source`/
  `whatsappInstanceId`/`authorType` em `createAppointmentManual`/`cancelAppointment`/
  `rescheduleAppointment` — confirmar que omiti-los preserva EXATAMENTE o comportamento antigo
  (PANEL/USER), e que o caminho do bot (`src/modules/bot-api/booking-bot.ts`) sempre passa
  `authorType: "CONTACT"` com `actorId = contact.id` (nunca um id de `User`).
- Dívidas conscientes registradas nesta fase (avaliar se são aceitáveis): `isTenantBotAllowed`
  é stub `true` fixo (`src/modules/bot-api/subscription-gate.ts`, TODO Fase 7); sandbox outbox
  em memória do processo, sem tabela (`src/modules/bot-api/sandbox-outbox.ts`); fixtures da
  Evolution não capturadas do servidor real (`fixtures/evolution/README.md`).

---

## Fase 7 — Cobrança e cadastro público

Modelos (`Plan`, `Subscription`, `Invoice`, `ProviderEvent`, `TrialClaim`) já existiam
(Cronos, ver `.claude/agent-memory/cronos/fase7_cobranca_decisoes.md`). Esta fase implementa a
lógica de negócio, e-mail transacional, o adaptador do Mercado Pago e o cadastro público —
sem telas (a Lyra consome o contrato abaixo).

### `src/core/billing` — domínio puro (sem I/O)

- `effectiveStatus(subscription: { status, trialEndsAt, currentPeriodEnd }, now: Date):
  "TRIALING" | "ACTIVE" | "PAST_DUE" | "SUSPENDED" | "CANCELED"` — status EFETIVO calculado sob
  demanda (§7.4). `CANCELED` é terminal. Regras: `TRIALING` até `trialEndsAt`; depois disso (ou
  depois de `currentPeriodEnd`, para quem já não está mais em trial), 1 dia de carência
  (`GRACE_DAYS`) → `PAST_DUE`, depois `SUSPENDED`, depois de 60 dias em `SUSPENDED`
  (`CANCEL_AFTER_SUSPENDED_DAYS`) → `CANCELED`. **Teste não convertido** (decisão do dono,
  2026-09-29): o snapshot aceita `firstPaidAt?: Date | null`; com `firstPaidAt === null` (nunca
  pagou) o cancelamento vem `CANCEL_AFTER_SUSPENDED_TRIAL_DAYS = 7` dias depois de `SUSPENDED`
  (isto é, 1 dia de carência + 7 = 8 dias após o fim do teste). Quem já pagou (`firstPaidAt`
  preenchido) mantém os 60 dias; campo ausente (`undefined`) também mantém 60 (nunca cancela
  mais cedo na dúvida). Testes: `src/core/billing/__tests__/status.test.ts`.
- `computeTrialEndsAt(signupAt): Date` — `+3 dias` (`TRIAL_DAYS`; decisão do dono, 2026-09-29 —
  era `+1 dia` até 2026-09-28).
- `computeNextPeriodEnd({ currentPeriodEnd, wasSuspended, paidAt }): Date` — `+1 mês` a partir de
  `currentPeriodEnd` (mantém o dia-âncora) OU a partir de `paidAt` se `wasSuspended` (§7.1).

### `src/core/signup/slug.ts` — validação de endereço da empresa (pura)

- `RESERVED_SLUGS` — lista fechada (`login`, `cadastro`, `pos-login`, `admin`, `api`, `app`,
  `www`, `assets`, `static`, `public`, `convite`, `recuperar-senha`, `verificar-email`,
  `sitemap`, `robots`, `favicon.ico`, `manifest`, `_next`, `webhooks`, `internal`).
- `slugify(name): string` — normaliza (acentos, espaços, maiúsculas) sem checar unicidade/reserva.
- `validateSlug(slug): "TOO_SHORT" | "TOO_LONG" | "INVALID_FORMAT" | "RESERVED" | null` — só
  formato/reserva; unicidade no banco é responsabilidade do `service.ts` (I/O).

### `src/lib/email` — SMTP próprio via nodemailer

- `sendMail({ to, subject, html, text }): Promise<{ sent: boolean }>` (`src/lib/email/mailer.ts`)
  — lê `PlatformSettings.smtp*`. Lança `SmtpNotConfiguredError` (`DomainError`,
  `SMTP_NOT_CONFIGURED`) se faltar configuração; qualquer outro erro (SMTP fora do ar) é
  capturado, logado (sem `to`/segredo) e devolve `{ sent: false }` — nunca lança, nunca derruba
  quem chamou.
- Templates pt-BR (`src/lib/email/templates.ts`): `verificationEmail`, `passwordResetEmail`,
  `teamInviteEmail`, `invoiceGeneratedEmail`, `invoiceDueReminderEmail`,
  `subscriptionSuspendedEmail` — cada um devolve `{ subject, html, text }`.

### `src/modules/billing` — assinatura, fatura, Pix, limites

- `getDefaultSignupPlan()` — plano de menor `sortOrder` (Essencial), mesmo com `active: false`
  (o trial funciona antes do dono definir preço).
- `effectiveStatusForTenant(tenantId, now?)`, `assertTenantCanWrite(tenantId, now?)` — lança
  `DomainError("TENANT_SUSPENDED", …)` quando o status efetivo é `SUSPENDED`/`CANCELED`. Já
  aplicada em toda Server Action de MUTAÇÃO de `src/modules/agenda/catalog-actions.ts` e
  `appointment-actions.ts` (painel só-leitura quando suspenso, §7.4) — chamar SEMPRE depois de
  `requireTenantMember`.
- `isTenantBotAllowedFor(tenantId, now?): Promise<boolean>` — para o Atlas ligar no lugar do
  `TODO` de `src/modules/bot-api/subscription-gate.ts` (não editado aqui, por instrução).
- `src/modules/billing/plan-limits.ts`: `assertCanAddProfessional(tenantId)` (já chamada em
  `createProfessional`, `src/modules/agenda/catalog.ts`) e `assertCanAddWhatsappNumber(tenantId)`
  (exportada para a Fase 3 chamar antes de criar uma `WhatsappInstance`). Override de `Tenant`
  tem precedência sobre o limite do `Plan`; `null` (nos dois) = ilimitado. Erro:
  `PLAN_LIMIT_REACHED` com `details: { rule, limit, current }`.
- `src/modules/billing/mercadopago.ts`: interface `MercadoPagoGateway` (`createPixPayment`,
  `getPayment`) — implementação real (`createMercadoPagoGateway`, timeout 10s + retry 3x só em
  5xx/timeout) e `getMercadoPagoGateway({ forNewCharge? })` (lê o access token do ambiente ATIVO —
  `getActiveMercadoPagoCredentials()`; lança `MERCADOPAGO_NOT_CONFIGURED` se faltar/não decifrar e,
  com `forNewCharge`, `MERCADOPAGO_DISABLED` se a cobrança estiver desligada). `verifyMercadoPagoSignature` valida `x-signature`
  (`ts=…,v1=…`, HMAC-SHA256 do manifest `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`,
  conforme a documentação oficial do MP — ver comentário no código, PENDÊNCIAS abaixo sobre
  credenciais reais). `src/modules/billing/mercadopago.mock.ts`
  (`createMockMercadoPagoGateway()`) — fake para testes, com `approve(paymentId)`.
- `applyInvoicePayment(invoiceId, paidAt): Promise<{ alreadyProcessed: boolean }>` — idempotente
  (fatura já `PAID` → não faz nada); avança `currentPeriodEnd` (`computeNextPeriodEnd`) e volta a
  assinatura para `ACTIVE`.
- `regeneratePixForInvoice(invoiceId, payerEmail, gateway?)` — só para fatura `OPEN`; mesma
  linha, nunca cria outra.

### Cadastro público (`src/modules/signup`)

- `signUpAction(input): Result<{ tenantSlug }>` — `input: { companyName, slug, segment?,
  ownerName, email, password, termsVersion, acceptedTerms: true }`. Cria `User(OWNER)` +
  `Tenant` + `Membership` + `Subscription(TRIALING, +3 dias — `TRIAL_DAYS`)` + a primeira fatura (Pix, se o MP
  estiver configurado) numa transação; e-mail de verificação e de fatura gerada são efeitos
  colaterais fora da transação (nunca desfazem o cadastro se falharem). Rate limit: 5
  cadastros/hora por IP (`RATE_LIMITED`, `details.retryAfterMs`). Erros: `INVALID_SLUG`
  (`details.rule`), `EMAIL_TAKEN`, `SLUG_TAKEN`, `INVALID_PAYLOAD`.
- `verifyEmailAction({ token }): Result<{ tenantSlug: string | null }>` — token de uso único
  (`AuthToken`, hash SHA-256, 48h). Erro: `TOKEN_INVALID` (inválido, expirado OU já usado —
  mesma mensagem, sem distinguir).
- `requestPasswordResetAction({ email }): Result<{ requested: true }>` — sempre `ok`, mesmo se o
  e-mail não existir (sem enumeration). Token de 1h (§7.3 regra 5). Rate limit: 5/hora por IP.
- `resetPasswordAction({ token, password }): Result<{ done: true }>`.
- `inviteTeamMemberAction(tenantSlug, { email, role }): Result<{ invited: true }>` — restrito a
  `OWNER`. Token de 7 dias (§7.3 regra 6). Erro: `ALREADY_MEMBER`.
- `acceptInviteAction({ token, password }): Result<{ tenantSlug: string | null }>`.
- `requireVerifiedEmail()` (`src/lib/auth/guards.ts`) — guarda para a Fase 3 chamar antes de
  conectar WhatsApp; lança `EMAIL_NOT_VERIFIED` se `User.emailVerifiedAt` for nulo.

### `POST /api/webhooks/mercadopago`

Sem autenticação por segredo — a autenticação É a assinatura `x-signature` (`verifyMercadoPagoSignature`
contra o webhook secret do ambiente ATIVO — `getActiveMercadoPagoCredentials()`). Fluxo: valida assinatura → RECONSULTA o
pagamento na API do MP (nunca confia no corpo) → idempotência por
`ProviderEvent(provider="mercadopago", providerEventId=data.id)` → se `approved`, `applyInvoicePayment`.
Resposta sempre `200` para o MP (mesmo `ignored`), exceto assinatura inválida (`401`) — corpo
irreconhecível nunca é 5xx (mesma régua do `claim`, §6.2).

### `POST /api/internal/v1/billing/tick`

Mesma autenticação da API interna do bot (`Authorization: Bearer <INTERNAL_API_SECRET>`), SEM
`X-InnoChat-Instance` (não é escopado a uma instância — varre todas as assinaturas). Chamado por
um cron externo (n8n Schedule Trigger, fora deste repo), de hora em hora. Resposta 200:
`{ invoicesCreated, pixRegenerated, remindersSent, statusChanges, suspensionEmailsSent }`
(`src/modules/billing/tick.ts`, `BillingTickSummary`). Idempotente por desenho: fatura por
`@@unique([subscriptionId, periodStart])`; e-mail de lembrete/suspensão por marca
`*EmailSentAt` (`Invoice.dueReminderEmailSentAt`/`dueTodayEmailSentAt`,
`Subscription.suspendedEmailSentAt` — migration `20260928000005_billing_email_idempotency`);
avanço de mês só pelo pagamento (`applyInvoicePayment`), nunca pelo tick.

**Nota de coordenação:** este arquivo mora em `src/app/api/internal/v1/billing/tick/route.ts` —
mesma árvore de diretório da API do bot (Fase 4), rodando em paralelo nesta sessão. Arquivo NOVO
e isolado, sem tocar em `messages/`, `sessions/`, `appointments/`, etc. da Fase 4. Sinalizado aqui
para o Atlas confirmar que não houve concorrência de edição no mesmo arquivo.

### Admin de planos e empresas (`src/modules/billing/admin-actions.ts`) — Server Actions

Todas guardadas por `requirePlatformAdmin()`.

- `listPlansAction(): Result<Plan[]>`.
- `updatePlanAction(planId, input): Result<Plan>` — `input` parcial de `{ name, priceCents,
  maxWhatsappNumbers, maxProfessionals: number | null, active, sortOrder }`.
- `listCompaniesAction({ cursor?, limit? }): Result<{ items: CompanyListItem[]; nextCursor:
  string | null }>` — paginado (`limit` máx. 100, padrão 30), cursor por `tenantId`. Cada item
  traz `persistedStatus` E `effectiveStatus` (podem divergir até o próximo tick).
- `suspendCompanyAction(tenantId): Result<{ tenantId }>` — força `SUSPENDED` mesmo antes do
  vencimento (empurra `currentPeriodEnd` para o passado — ver comentário em
  `admin-service.ts`; um pagamento futuro sempre conta a partir de `paidAt`, então isso nunca
  "vaza" pro próximo ciclo cobrado).
- `reactivateCompanyAction(tenantId): Result<{ tenantId }>` — volta para `ACTIVE` com +1 mês a
  partir de hoje.
- `extendTrialAction(tenantId, { extraDays: 1-30 }): Result<{ tenantId }>` — só válido enquanto
  `TRIALING`; também empurra o vencimento da fatura do trial.

### O que a Íris deve testar (Fase 7)

- Unitários: `src/core/billing/__tests__/status.test.ts` (16 casos: fronteiras exatas de
  carência/suspensão/cancelamento, `CANCELED` terminal, `computeNextPeriodEnd` com/sem
  suspensão) e `src/core/signup/__tests__/slug.test.ts` (26 casos: normalização, todos os slugs
  reservados, formato).
- Integração (`npm run test:integration`, requer `TEST_DATABASE_URL` — ver
  `.claude/agent-memory/vega/integration_tests_setup.md`):
  - `tests/integration/billing-signup.integration.test.ts` — cadastro completo (User/Tenant/
    Membership/Subscription/Invoice/Pix), `INVALID_SLUG`/`EMAIL_TAKEN`/`SLUG_TAKEN`, verificação
    de e-mail (token de uso único, reuso falha), Mercado Pago fora do ar não quebra o cadastro.
  - `tests/integration/billing-webhook.integration.test.ts` — assinatura inválida → 401 sem
    tocar no banco; MESMO evento processado 2x → 1 baixa só (não avança 2 meses);
    `applyInvoicePayment` chamado 2x direto também idempotente.
  - `tests/integration/billing-tick.integration.test.ts` — geração de fatura 5 dias antes
    (2 rodadas → 1 fatura só); TRIALING não gera fatura extra (já tem a do cadastro);
    regeneração de Pix expirado; reconciliação de status (TRIALING vencido → PAST_DUE);
    e-mail de suspensão 1x só mesmo com o tick rodando várias vezes; limite de profissionais por
    plano (bloqueia e libera com override de `Tenant`).
  - **Nota de infraestrutura de teste**: `vitest.integration.config.ts` agora roda os arquivos
    de `tests/integration/**` SEQUENCIALMENTE (`fileParallelism: false`) — `billing/tick` faz
    varredura GLOBAL de `Subscription`/`Invoice` (sem filtro de tenant, de propósito, é o que
    tick faz em produção), e rodar em paralelo com o `afterAll` de outro arquivo limpando tenants
    causava "Inconsistent query result" (relação obrigatória cortada no meio de um include, por
    uma corrida real entre dois arquivos de teste — não é bug de produção).
  - Observado durante esta sessão: `tests/integration/bot-api.integration.test.ts` (Fase 4, não
    editado aqui) teve UMA falha flaky no teste de concorrência de `POST /appointments` (esperava
    1 sucesso, achou 0) rodando depois de todo o resto da suíte; rodado isolado ou numa segunda
    rodada completa, passou. Parece sensibilidade a timing/carga acumulada de conexões, não um
    bug de isolamento — vale a Íris confirmar rodando a suíte completa mais algumas vezes.
- Ainda sem teste automatizado (fora do escopo desta rodada — sinalizar para quem pegar):
  `inviteTeamMemberAction`/`acceptInvite` (convite de equipe), `requestPasswordResetAction`/
  `resetPasswordAction`, `admin-actions.ts` (planos/empresas — cobertos só por `tsc`/lint/build,
  sem integração dedicada).

### O que o Órion deve revisar (Fase 7)

- `verifyMercadoPagoSignature` (`src/modules/billing/mercadopago.ts`) foi escrito a partir do
  formato documentado (`ts=…,v1=…`, HMAC-SHA256 do manifest), **não temos credenciais reais do
  Mercado Pago para validar contra um webhook de verdade ainda** — PENDÊNCIA explícita: confirmar
  contra a documentação oficial atualizada e, quando houver conta de sandbox, testar
  ponta a ponta antes de habilitar em produção.
- `suspendCompanyManually`/`reactivateCompanyManually` (`src/modules/billing/admin-service.ts`)
  manipulam `currentPeriodEnd` diretamente para forçar o `effectiveStatus` — é um "truque"
  documentado no comentário do código; confirmar que a lógica de `computeNextPeriodEnd`
  (`wasSuspended` sempre usa `paidAt`, nunca a âncora antiga) realmente neutraliza qualquer valor
  artificial deixado por essas duas funções.
- `assertTenantCanWrite` está em toda mutação de `catalog-actions.ts`/`appointment-actions.ts`,
  mas NÃO em `bot-texts/bot-text-actions.ts`, `tenant/actions.ts` (tema) nem em nenhuma tela de
  WhatsApp (ainda não existe) — decidir se "painel só-leitura quando SUSPENDED" deveria cobrir
  esses módulos também (a leitura desses dois é de baixo risco/edição pouco frequente, mas ficou
  de fora por escopo, não por esquecimento não registrado).
- `src/lib/email/mailer.ts`: confirmar que nenhum log inclui `to` (e-mail é dado pessoal, §11) —
  só `subject` e mensagem de erro do transporte.
- `src/modules/signup/service.ts` (`inviteTeamMember`): usuário convidado nasce com
  `passwordHash` aleatório/inutilizável até aceitar o convite — confirmar que não há caminho de
  login (`verifyCredentials`) que aceite essa senha por acidente antes do `acceptInvite` trocá-la.
- Migration `20260928000005_billing_email_idempotency` (3 colunas nullable, sem dado sensível) —
  aplicada em `innochat` e `innochat_test`; `DOWN.sql` presente.

### PENDÊNCIAS (Fase 7)

- **Sem credenciais reais do Mercado Pago** (access token + webhook secret) — todo o adaptador
  foi testado com `createMockMercadoPagoGateway()`; falta um teste ponta a ponta contra a API de
  sandbox do MP antes de ligar em produção.
- **Preços dos planos ainda em `priceCents: 0`, `active: false`** (decisão do dono, já registrada
  por Cronos) — falta o dono decidir os valores; a tela de admin de planos (Lyra) precisa
  expor isso com destaque.
- **`TrialClaim` (anti-abuso de trial por número de WhatsApp, §7.3 regra 4) não foi ligado** —
  depende da Fase 3 (conexão de instância) existir; quem implementar a Fase 3 deve chamar uma
  checagem de `TrialClaim.phoneE164` antes de permitir conectar o primeiro número em trial.
- `isTenantBotAllowedFor` está pronta e exportada (`src/modules/billing/service.ts`) mas
  `src/modules/bot-api/subscription-gate.ts` continua com o stub `true` fixo — o Atlas liga isso
  quando integrar as duas frentes.

## Configuração pela plataforma (sem URL/credencial em env var)

Decisão do dono (2026-09-28): nenhuma URL ou credencial solta em env var/chat. No Easypanel só
sobram `DATABASE_URL` e `AUTH_SECRET`; o domínio público é só a aba Domínios do Easypanel. Tudo
o mais — Evolution, n8n, Mercado Pago, SMTP, e a própria URL pública do painel — mora em
`PlatformSettings` (banco), configurado pelo admin da plataforma.

### URL pública do painel (`src/lib/public-url.ts`)

`AUTH_URL`/`NEXT_PUBLIC_APP_URL` (`src/env.ts`) ficaram **opcionais** e não são mais lidas em
runtime por nenhum código (link de e-mail, `billingUrlFor`, URL do painel enviada ao n8n).

`getPublicBaseUrl(): Promise<string>`:
1. Deriva de `x-forwarded-proto`/`x-forwarded-host` (fallback `host`) da requisição atual —
   sempre correta dentro de uma Server Action/Route Handler/RSC (mesma base do `trustHost` do
   Auth.js).
2. Fora de uma requisição (ex.: um job chamado direto, sem passar pelo handler HTTP), cai para
   `PlatformSettings.publicBaseUrl` — um espelho gravado sozinho, sem intervenção manual, na
   primeira vez que um admin salva Configurações (`ensurePublicBaseUrlFromCurrentRequest`,
   chamada de dentro de `updatePlatformSettingsAction`). Nunca sobrescreve um valor já gravado.
3. Sem nenhuma das duas (nunca aconteceu um `updatePlatformSettingsAction`, e a chamada atual
   não tem requisição — ex.: `billing/tick` rodando antes do primeiro save do admin) → lança
   `DomainError("PUBLIC_URL_UNKNOWN", ...)`. Use `tryGetPublicBaseUrl()` (nunca lança, devolve
   `null`) em caminhos que já têm um fallback de UI aceitável.

### Instalação única do primeiro admin (`src/modules/platform/install.ts`, `install-actions.ts`)

- `src/instrumentation.ts` roda `bootstrapInstallCodeIfNeeded()` no boot do servidor (runtime
  `nodejs` só — instrumentação também dispara no Edge, sem Prisma). Enquanto **não existir**
  nenhum `User.isPlatformAdmin`, gera um código novo a cada boot (`PlatformInstallCode`, hash
  SHA-256 + expiração de 24h) e imprime em texto puro, uma vez, direto em `console.log`:
  `InnoChat: código de instalação = <código> (válido por 24h, use em /instalacao)`. Nenhum outro
  lugar do sistema mostra esse valor. Se já houver admin, não faz nada (nem loga).
- `hasPlatformAdminAction(): Result<{ installed: boolean }>` — pública.
- `installPlatformAdminAction(input): Result<{ userId: string }>` — pública, mas só funciona
  enquanto não houver admin (reconfere dentro de uma transação, junto com o consumo do código —
  duas instalações concorrentes nunca criam dois admins). `input: { code, name, email,
  password }` (`name` só para UX, não persistido — `User` não tem campo de nome, mesma lacuna já
  existente em `signUpAction`/`ownerName`). Rate limit de 10/15min por IP. Erros:
  `INSTALL_CODE_INVALID`, `ALREADY_INSTALLED`, `EMAIL_TAKEN`, `RATE_LIMITED`, `INVALID_PAYLOAD`.
- `/instalacao` (rota pública): responde **404** (`notFound()`) se já houver admin — nunca
  redireciona.

### Testar conexão (`src/modules/platform/connection-tests.ts`, `actions.ts`) — Fase 1

Todas restritas a `requirePlatformAdmin()`, timeout de 5s, resultado sempre
`{ ok: boolean; detalhe: string }` — nunca o segredo de volta (nem no `detalhe`, nem em log).

- `testEvolutionConnectionAction({ evolutionApiUrl, evolutionApiKey })` — `GET
  /instance/fetchInstances` com header `apikey`.
- `testMercadoPagoConnectionAction({ env, accessToken? })` (ver "Mercado Pago — par de produção e teste") — `GET
  https://api.mercadopago.com/users/me` com `Authorization: Bearer`.
- `testN8nConnectionAction({ n8nBaseUrl, n8nApiKey })` — `GET /api/v1/workflows?limit=1` com
  header `X-N8N-API-KEY`.
- `testSmtpConnectionAction({ smtpHost, smtpPort, smtpSecure?, smtpUser?, smtpPassword? })` —
  `transporter.verify()` (nodemailer).

Os quatro aceitam os valores que a tela ainda não salvou (testar antes de gravar); campo de
segredo em branco usa o salvo (decifrado só no servidor).

### Sincronização do n8n (`src/modules/platform/n8n-sync.ts`, `n8n-client.ts`) — Fase 5+

Superfície confirmada pelo Atlas contra o spec oficial (repo `n8n-io/n8n`, branch `master`,
`packages/cli/src/public-api/v1/handlers/**/spec`, consultado em 2026-09-28) — substitui o
levantamento anterior por conhecimento treinado, não mais confiável sem essa fonte:

- **Ativar/desativar**: `POST /workflows/{id}/activate`/`.../deactivate` estão **deprecated**;
  o substituto é `POST /workflows/{id}/publish`/`.../unpublish`. `n8n-client.ts` tenta
  publish/unpublish primeiro e só cai para activate/deactivate em 404 (instância antiga sem as
  rotas novas) — testado com mock nos dois caminhos.
- **Credenciais**: a versão atual do spec tem `GET /credentials`, `GET /credentials/{id}` e
  `PATCH /credentials/{id}` (update) além de `POST`/`DELETE`. `rotateCredential`
  (`n8n-sync.ts`) tenta `PATCH` primeiro (mantém o mesmo id); se a instância responder 404/405
  (rota/método não suportado — versão antiga), cai para "deletar o id antigo + criar um novo",
  que funciona em qualquer versão. Os dois caminhos são idempotentes.
- **`PUT /workflows/{id}`**: exige só `name`, `nodes`, `connections`, `settings` — `id`,
  `active`, `createdAt`, `updatedAt`, `isArchived`, `versionId`, `triggerCount`, `tags` e `meta`
  são `readOnly`; `n8n-client.ts#updateWorkflow` filtra para esses 4 campos antes de enviar,
  nunca reenvia o objeto cru do `GET`. `publishIfActive` (padrão `true`) fica no padrão.

Ainda **PENDÊNCIA para o Órion/dono**: esta sessão não tem acesso à internet para bater o pé em
uma instância real — o Atlas leu o spec do repositório, não testou contra um n8n rodando.
Confirmar contra `https://<n8n>/api/v1/docs` (Swagger da própria instância) na primeira
sincronização real, e conferir a versão do n8n do dono para saber se ela já tem
publish/unpublish e PATCH de credencial ou vai cair nos fallbacks.

- `syncN8nAction(): Result<N8nSyncSummary>` — exige `n8nBaseUrl`/`n8nApiKey` e
  `evolutionApiUrl`/`evolutionApiKey` já salvos em `PlatformSettings` (senão
  `N8N_NOT_CONFIGURED`/`EVOLUTION_NOT_CONFIGURED`). Passos, todos idempotentes:
  1. Resolve `painelUrl = ${getPublicBaseUrl()}/api/internal/v1`.
  2. Gera um novo segredo da API interna (`regenerateInternalApiSecret`) — o valor em texto
     puro só existe neste instante; nunca é devolvido pela action, só enviado ao n8n.
  3. Atualiza (ou recria, no fallback acima) as 3 credenciais `httpHeaderAuth`: `InnoChat
     Painel (Bearer)` (`Authorization: Bearer <segredo>`), `Evolution API (apikey)` (`apikey:
     <evolutionApiKey>`), `n8n API (X-N8N-API-KEY)` (`X-N8N-API-KEY: <n8nApiKey>`); os ids
     ficam em `PlatformSettings.n8nCred*Id`.
  4. Acha o workflow `innochat-bot` (por id salvo, senão o id de fábrica do
     `n8n/README.md`, senão por nome — `resolveWorkflow`), atualiza o nó `Config`
     (`painelUrl`, `evolutionUrl`) e reata a credencial certa em todo nó HTTP Request com
     `genericAuthType: "httpHeaderAuth"` (classificado pela URL: contém `evolutionUrl` →
     Evolution, `n8nApiUrl` → n8n, senão → Painel). `PUT /workflows/{id}` com o objeto
     filtrado (`name`, `nodes`, `connections`, `settings`).
  5. Mesma coisa para `innochat-erros` (nó `Config erros`, campo `n8nApiUrl`).
  6. **URL do webhook derivada do nó Webhook do bot** (`deriveWebhookBaseUrl`). Regra do n8n:
     quando o `path` do nó tem parâmetro dinâmico (`innochat/evolution/:token`), a rota de
     produção é **prefixada pelo `webhookId` do nó**. Base gravada em
     `PlatformSettings.n8nWebhookBaseUrl` (sobrescreve o valor manual do admin):
     - com `:token` no último segmento: `<n8nBaseUrl>/webhook/<webhookId>/<path sem o :token>`
       (ex.: `https://n8n.../webhook/b12d5bcf-.../innochat/evolution`);
     - sem parâmetro: `<n8nBaseUrl>/webhook/<path>`.
     A URL de cada instância continua `<base>/<webhookToken>`. Erros legíveis:
     `N8N_WEBHOOK_NODE_NOT_FOUND`, `N8N_WEBHOOK_PATH_INVALID`, `N8N_WEBHOOK_ID_MISSING`.
  7. **Reaponta as instâncias existentes**: para cada `WhatsappInstance` com `deletedAt = null`,
     `evolution.setWebhook(instanceName, <base>/<webhookToken>)`. Falha numa instância não
     derruba a sync: `N8nSyncSummary.webhooksReapontados` / `webhooksFalhos` (+ aviso em
     `warnings`). "Atualizar status"/reconexão do tenant NÃO reaplicam o webhook (só a criação
     da instância e esta sync o fazem).
  8. **Nunca ativa** nenhum dos dois — grava só os ids em `PlatformSettings`.
  Erros: `N8N_NOT_CONFIGURED`, `EVOLUTION_NOT_CONFIGURED`, `N8N_WORKFLOW_NOT_FOUND`, `N8N_WEBHOOK_*`, `FORBIDDEN`.
- `activateBotWorkflowAction()`/`deactivateBotWorkflowAction(): Result<{ activated: boolean }>`
  — ação separada, de propósito (item 4c do pedido do dono); tenta publish/unpublish e cai para
  activate/deactivate em instância antiga. Erro `N8N_NOT_SYNCED` se `syncN8nAction` nunca rodou
  (sem id de workflow salvo).

### Troca de plano pela empresa (`src/modules/billing/actions.ts`, `service.ts#changePlan`) — §7.2

- `listActivePlansAction(tenantSlug): Result<PlanListItem[]>` — qualquer membro (`OWNER`/`STAFF`)
  pode ver os planos disponíveis (`Plan.active`, ordenados por `sortOrder`).
- `changePlanAction(tenantSlug, { planId }): Result<{ appliedImmediately: boolean }>` — restrito
  a `OWNER`. Sem `assertTenantCanWrite`: funciona mesmo com a assinatura `SUSPENDED` (é o
  caminho para saír de lá).
  - **Upgrade** (`sortOrder` novo ≥ atual): aplica na hora (`planId` trocado já, `Subscription`
    atual) — `appliedImmediately: true`. A diferença de preço só aparece na próxima fatura, sem
    cálculo proporcional (decisão do dono, §7.2).
  - **Downgrade**: só aceito se o uso ATUAL já couber no plano novo, considerando os overrides
    da empresa (`Tenant.max*Override`, que continuam valendo depois da troca) —
    `PLAN_DOWNGRADE_BLOCKED` com `{ rule: "maxProfessionals" | "maxWhatsappNumbers", limit,
    current }` se não couber (a tela usa isso para dizer o que remover). Se couber, grava
    `Subscription.pendingPlanId` — `appliedImmediately: false`.
  - `pendingPlanId` entra em vigor quando `billing/tick` gera a fatura do próximo ciclo (5 dias
    antes de começar, `generateUpcomingInvoices`): a fatura já sai no preço do plano novo E
    `Subscription.planId` já troca ali (não espera o pagamento) — é o ciclo em que o downgrade
    "vale". `applyInvoicePayment` tem o mesmo swap como rede de segurança para o caso raro de um
    pagamento confirmado antes de o tick rodar.
  - Erros: `NOT_FOUND` (assinatura/plano/empresa), `INVALID_STATE` (assinatura `CANCELED`, ou já
    está neste plano), `PLAN_DOWNGRADE_BLOCKED`, `FORBIDDEN`, `INVALID_PAYLOAD`.

### Migration

`20260928000007_platform_public_url_install_n8n` — `PlatformSettings.publicBaseUrl`/
`n8nBaseUrl`/`n8nApiKey`/`n8nCredPainelId`/`n8nCredEvolutionId`/`n8nCredApiId`/
`n8nWorkflowBotId`/`n8nWorkflowErrosId` (todas nullable) + tabela nova `PlatformInstallCode`.

## Segurança — correções pós-revisão (`docs/seguranca/revisao-2026-09-28.md`)

Vega implementou os 2 achados ALTA e os 5 MÉDIA/BAIXA priorizados pelo Atlas depois da revisão do
Órion de 2026-09-28 (veredito "LIBERADO COM RESSALVAS"). Contrato de cada correção, para Lyra/Íris/
Órion:

### Rate limit de login (`src/modules/auth/service.ts#verifyCredentials`)

Dois tetos independentes, checados ANTES de tocar o banco/bcrypt:
- por IP (`login:ip:<ip>`): 20 tentativas / 5 min.
- por e-mail normalizado (`login:email:<email>`): 8 tentativas / 15 min.

Excedendo qualquer um dos dois, `verifyCredentials` devolve `null` — EXATAMENTE o mesmo retorno
de "credencial inválida" (nenhum código/mensagem novo chega ao client; o Auth.js já trata
`authorize() → null` como erro genérico de login). Não há novo estado para a Lyra tratar na tela
de login — o comportamento observável do formulário não muda, só passa a haver um teto. IP vem
de `src/lib/http/client-ip.ts` (extraído nesta rodada — antes duplicado em `signup/actions.ts` e
`platform/install-actions.ts`, agora usado também por `src/lib/auth.ts#authorize()`).

### Cabeçalhos de segurança + CSP (`next.config.ts`)

`headers()` global (`source: "/(.*)"`, sem `middleware.ts`/`proxy.ts` — Next 16 renomeou para
`proxy.ts`, mas não foi necessário para isto): `Content-Security-Policy`, `X-Frame-Options: DENY`,
`Strict-Transport-Security` (2 anos + subdomínios), `X-Content-Type-Options: nosniff`,
`Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` enxuto (nega
camera/microphone/geolocation/payment/usb, nenhum usado pelo painel).

CSP SEM nonce (decisão registrada no comentário de `next.config.ts`): `script-src`/`style-src`
usam `'unsafe-inline'` — a alternativa com nonce exige TODA página dinamicamente renderizada, e
o padrão "Without Nonces" é o que a doc da versão instalada do Next recomenda para quem não usa
nonce. `img-src` inclui `data:` (QR do Pix/Evolution vêm em base64). Fontes via `next/font`
(self-hosted) já cabem em `font-src 'self'`. **Se a Lyra algum dia adicionar um script de
terceiro (analytics, chat widget, etc.), precisa entrar em `script-src`/`connect-src`/`img-src`
explicitamente — CSP vai bloquear silenciosamente sem isso** (erro só aparece no console do
navegador, não em log de servidor).

### Corrida no webhook do Mercado Pago (`src/modules/billing/webhook.ts`)

`ProviderEvent.create` concorrente (2 notificações quase simultâneas) agora trata a violação de
unique constraint (`P2002`, `isUniqueViolation` — extraído para `src/lib/db/prisma-errors.ts`
nesta rodada, antes duplicado em `claim.ts`/`connection.ts`) como "já existe", relendo com uma
query NOVA (nunca continuando na transação que acabou de falhar — Postgres aborta a transação
inteira após uma violação; ver comentário no código). Sem `$transaction` nesta função desde esta
rodada — a constraint única já é a fonte de atomicidade real.

### Assinatura do webhook do Mercado Pago (`src/modules/billing/mercadopago.ts`)

Conferida contra o SDK oficial em Go (`github.com/mercadopago/sdk-go/pkg/webhook`,
`ValidateSignature`) — 2 desvios corrigidos:
- `data.id` agora resolvido a partir do QUERY PARAM da notificação (`route.ts`), não do corpo
  (fallback só se a query não tiver, para notificações antigas mal formadas).
- Cada par ausente (`id`/`request-id`) é OMITIDO do manifest, nunca causa rejeição isolada.

Adicionada tolerância de 10 min no `ts` (contra replay de um header capturado) —
`verifyMercadoPagoSignature` aceita um `now?: Date` opcional só para teste.

### `assertTenantCanWrite` em bot-texts e tema (`src/modules/bot-texts/bot-text-actions.ts`,
`src/modules/tenant/actions.ts`)

`upsertBotTextAction`/`resetBotTextAction`/`updateTenantThemeAction` agora bloqueiam com
`TENANT_SUSPENDED` quando a empresa está `SUSPENDED`/`CANCELED` — mesmo padrão de
`catalog-actions.ts`/`appointment-actions.ts`/`whatsapp/actions.ts`. `listBotTextsAction`/
`previewBotTextAction` continuam sem o guard (são leitura).

### LGPD — retenção/anonimização (`src/modules/maintenance/tick.ts`, NOVO)

`POST /api/internal/v1/maintenance/tick` — MESMA autenticação do `billing/tick`
(`Authorization: Bearer <INTERNAL_API_SECRET>`, sem `X-InnoChat-Instance`). Chamado
periodicamente pelo `innochat-cron` (fora deste repo — **sem workflow novo no n8n**, o Atlas
pluga a chamada). Resposta 200: `{ inboundEventsPurged, contactsAnonymized, chatMessagesPurged }`
(`MaintenanceTickSummary`).

- Purga `InboundEvent` com `createdAt` > 30 dias (`docs/arquitetura.md` §11).
- Anonimiza `Contact` de tenants `CANCELED` há mais de 90 dias (`Subscription.canceledAt`):
  zera `name`/`pushName`/`phoneE164`/`lid`, substitui `waJid` por `anon:<contactId>` (mantém a
  linha e a integridade referencial com `Appointment` histórico). Processado em lotes de 500 por
  chamada — a próxima execução continua de onde parou.
- Idempotente: `InboundEvent` já apagado não conta de novo; `Contact` já anonimizado é
  reconhecido pelo prefixo `anon:` em `waJid` e pulado.

**Correção associada em `src/modules/billing/tick.ts#reconcileStatuses`**: `canceledAt` nunca
era persistido quando o status efetivo virava `CANCELED` por lá (só era zerado na reativação) —
sem isso, uma empresa cancelada automaticamente (60 dias em `SUSPENDED`) nunca teria data de
referência para a anonimização rodar. Agora marca `canceledAt: now` na transição.

### SSRF leve em "Testar conexão" e na sincronização do n8n (`src/lib/net/safe-fetch.ts`, NOVO)

`safeFetch`/`assertSafeExternalUrl` usados em `platform/connection-tests.ts` (Evolution, n8n —
NÃO Mercado Pago, que usa URL fixa da API oficial) e `platform/n8n-client.ts` (usado por
`n8n-sync.ts`). Bloqueia: esquema diferente de `http`/`https`; o endereço de metadados de nuvem
`169.254.169.254`; redirecionamento para um HOST diferente do original. **Não bloqueia IP
privado em geral** — decisão deliberada, Evolution/n8n reais costumam estar na mesma rede
interna do Easypanel.

### Dívida técnica (não implementada nesta rodada, por pedido explícito)

- Cifragem em repouso dos segredos de `PlatformSettings` (proposta detalhada no relatório do
  Órion: AES-256-GCM com chave derivada de `AUTH_SECRET` via HKDF).
- Rate limit distribuído (Redis/Postgres) — o rate limit de login herda a mesma limitação já
  documentada em `src/lib/rate-limit.ts` (processo único, zera em restart).
Aplicada em `innochat` e `innochat_test`; `DOWN.sql` presente.

### `resendVerificationEmailAction()` (adicionado pelo Atlas, 2026-09-28)

`src/modules/signup/actions.ts`. Usuário logado; sem entrada. Rate limit de 3 por hora por usuário (`RATE_LIMITED`).
Saída: `Result<{ alreadyVerified: boolean }>`. Se já verificado, não envia nada e devolve `alreadyVerified: true`
(a UI deve parar de oferecer o botão). Falha de SMTP só é logada, como no cadastro. Coberto em
`tests/integration/billing-signup.integration.test.ts`.

## Clientes (gestão de clientes finais — Fase 8, 2026-09-28)

Tela `/[tenantSlug]/clientes` (Lyra). Todas as actions escopam por `tenantSlug` +
`requireTenantMember` (qualquer papel para leitura/edição; `deleteContactAction` e
`exportContactsCsvAction` exigem `["OWNER"]`). Mutações passam por `assertTenantCanWrite`
(bloqueadas com assinatura suspensa). Todo `id` recebido é revalidado no tenant (`forTenant` +
`findFirst`) — id de outro tenant → `NOT_FOUND`, nunca `FORBIDDEN` (mesma convenção do resto do
painel).

### Schema (`prisma/migrations/20260928000009_contact_notes`)

`Contact.notes String?` (limite de 2000 caracteres aplicado no zod da action, não no banco —
igual ao padrão do restante do schema, sem `@db.VarChar`). Aplicada em `innochat` e
`innochat_test`; `DOWN.sql` presente.

### `source: "WHATSAPP" | "PANEL"` — derivado da FORMA do `waJid`, não de um campo de origem

Não existe um campo "como este cliente nasceu" — `source` é 100% calculado a partir do `waJid`:
`@panel.local` (o padrão sintético antigo, de `createAppointmentAction` sem `contactId`) →
`"PANEL"`; qualquer outra coisa (`@s.whatsapp.net`) → `"WHATSAPP"`.

**Consequência que vale a pena registrar**: `createContactAction`/`updateContactAction`, ao
receber um telefone real, gravam de propósito um `waJid` no formato `@s.whatsapp.net` (ver
próxima seção) — para não duplicar o contato quando esse cliente mandar a primeira mensagem pelo
WhatsApp. Por isso um cliente cadastrado à mão no painel, com telefone, aparece com
`source: "WHATSAPP"` (não `"PANEL"`) — mesmo nunca tendo mandado mensagem nenhuma. Isso também é
por que o telefone desses contatos fica bloqueado para edição (`PHONE_LOCKED`, ver
`updateContactAction`): uma vez que o `waJid` foi derivado do telefone, trocar o telefone sem
trocar o `waJid` junto quebraria o casamento com a próxima mensagem real do cliente. Só um
contato ainda `@panel.local` (criado sem telefone, ou nunca editado para ganhar um) tem telefone
editável. **Se esse comportamento (badge "WhatsApp" para alguém cadastrado manualmente) for
indesejado no produto, a correção é um campo `Contact.origin` novo — mudança de schema fora do
escopo desta rodada; ver PENDÊNCIAS no handoff da Vega.**

### `waJid` de um `Contact` criado pelo painel — heurística do 9º dígito (`src/core/whatsapp/phone.ts`)

`claimMessage` (`src/modules/bot-api/claim.ts`) NUNCA normaliza o `waJid` — grava exatamente o
`remoteJid` que a Evolution/Baileys mandar. E esse `remoteJid` chega SEM o 9º dígito para MUITOS
(não todos) celulares brasileiros (achado documentado desde o InnoAtendente, ver
`normalizeBrazilianNinthDigit`). Por isso:

- `phoneE164ToLikelyWhatsappJid(phoneE164)`: escolhe o candidato SEM o 9º dígito como `waJid` de
  um `Contact` novo — bate com o caso mais comum, mas é uma HEURÍSTICA, não uma garantia. Se o
  número específico deste cliente for um dos que chegam COM o 9º dígito, a primeira mensagem dele
  ainda cria um segundo `Contact` (limitação conhecida, ver PENDÊNCIAS).
- `whatsappJidCandidatesForPhone(phoneE164)`: as duas formas plausíveis (com/sem o 9º dígito) —
  usado para PROCURAR um contato de WhatsApp real já existente com este telefone antes de criar
  um novo (`findDuplicateByPhone`, `src/modules/contacts/contacts.ts`). Cobre o caso "cliente já
  tinha mandado mensagem antes de ser cadastrado no painel" — que é o caso em que dava para checar
  de verdade. Testado em `tests/integration/contacts.integration.test.ts` (descreve
  "waJid do cliente cadastrado pelo painel bate com o que o bot gera").
- `parseBrazilianPhoneToE164(input)`: telefone digitado (qualquer formatação) → E.164, só padrão
  BR (DDD + 8/9 dígitos, com/sem `+55`).

### `src/modules/contacts/contacts.ts` + `src/lib/db/contact-queries.ts`

Agregações de agendamento por cliente (contagem, faltas, último/próximo) via **uma única query**
raw (`$queryRaw` + `LEFT JOIN LATERAL`, em `src/lib/db/contact-queries.ts` — só ali porque é o
único lugar fora de `src/lib/db/` autorizado a importar `Prisma.sql` cru, ver
`eslint.config.mjs`). Decisão registrada: o `include` nativo do Prisma resolveria em 2 idas ao
banco mas não deixaria FILTRAR por "tem agendamento futuro" nem ORDENAR por "próximo
agendamento" no banco — teria que carregar todos os contatos do tenant para paginar em memória.
`tenantId` sempre interpolado como parâmetro do tagged template (nunca concatenado em string).

- `listContactsAction(tenantSlug, { q?, filter?, cursor?, limit? }): Result<{ items:
  ContactListItem[], nextCursor: string | null }>` — `filter ∈ all | upcoming | botPaused |
  inactive90d` (padrão `all`), `limit` padrão 30, máx. 100. `q` busca por nome, `pushName` e
  telefone (compara dígitos, ignora formatação). Ordena por próximo agendamento primeiro, depois
  cadastro mais recente. **`cursor` é um offset em base64, não um keyset cursor de verdade** —
  decisão deliberada (a ordenação dinâmica não tem uma chave de corte estável simples); risco
  aceito de pular/repetir uma linha sob inserção concorrente durante a paginação, nunca vaza
  outro tenant. Exclui contatos anonimizados sempre. `inactive90d` exige que o cliente TENHA
  histórico de agendamento (mas nenhum nos últimos 90 dias) — quem nunca agendou nada não entra
  nesse filtro (não tem "voltar a vir").
- `getContactAction(tenantSlug, id): Result<ContactDetail>` — `ContactDetail` = `ContactListItem`
  + `notes`, `botPausedUntil`, `appointments` (até 50, mais recentes primeiro). `NOT_FOUND` para
  id de outro tenant ou contato anonimizado.
- `createContactAction(tenantSlug, { name, phone, notes? }): Result<{ id }>` — `phone` em
  qualquer formatação BR; `INVALID_PAYLOAD` se não bater com o padrão. `CONTACT_EXISTS` (com
  `details.contactId`) se já existir um cliente com esse telefone (painel ou WhatsApp real, ver
  seção do `waJid` acima).
- `updateContactAction(tenantSlug, id, { name?, phone?, notes? }): Result<{ id }>` —
  `PHONE_LOCKED` se o contato já tem `waJid` "de WhatsApp" (ver seção `source` acima).
  `CONTACT_EXISTS` na troca de telefone se colidir com outro cliente. `notes: ""` limpa as notas.
- `setContactBotPausedAction(tenantSlug, id, { paused, hours? }): Result<{ botPausedUntil:
  string | null }>` — `paused: true` sem `hours` = pausa indefinida (~100 anos no futuro, não um
  sentinel `null` separado — simplifica o resto do código que só compara `> now`). Retomar
  (`paused: false`) zera `Contact.botPausedUntil` **e** `humanUntil`/volta `state` para
  `MAIN_MENU` em toda `ChatSession` deste contato (transação) — sem isso, uma sessão em modo
  humano continuaria ignorando o bot até o prazo antigo mesmo com o cliente "retomado" no painel.
  Conferido: `claimMessage` já respeitava `Contact.botPausedUntil` (linha existente desde a Fase
  4, `contact.botPausedUntil > now → BOT_PAUSED`) — nada precisou mudar em `claim.ts`.
- `deleteContactAction(tenantSlug, id): Result<{ mode: "deleted" | "anonymized" }>` — só OWNER.
  Sem agendamento → apaga de verdade. Com qualquer agendamento → anonimiza (mesmo padrão de
  `src/modules/maintenance/tick.ts`: zera `name`/`pushName`/`phoneE164`/`lid`/`notes`, marca
  `waJid = anon:<id>`), preservando o histórico de `Appointment`.
- `exportContactsCsvAction(tenantSlug): Result<{ filename, csv }>` — só OWNER. UTF-8 com BOM
  (`﻿`) + separador `;` (Excel pt-BR). Colunas: nome, telefone, agendamentos, faltas,
  último, próximo, criado em. Paginado internamente (`MAX_LIST_LIMIT` por página, até 5000
  clientes por exportação) — nunca um `SELECT *` sem limite.

### Agendar para um cliente existente

`createAppointmentAction` (Fase 2) já aceita `contactId` desde a implementação original — nenhuma
mudança de contrato foi necessária aqui. `NovoAgendamentoDialog`/`ContactDetailDialog` (Lyra)
usam isso direto: "Agendar para este cliente" passa o `contactId` já resolvido.

### `runMaintenanceTick` (LGPD) — atualizado

`src/modules/maintenance/tick.ts`: a anonimização de `Contact` agora também zera `notes` (campo
novo desta fase) — mesma política dos outros campos de dado pessoal.

### O que a Íris deve testar (Clientes)

Busca (nome/telefone)/filtros/paginação; cross-tenant (`NOT_FOUND`); `CONTACT_EXISTS` na criação
E na troca de telefone; `PHONE_LOCKED` ao tentar editar telefone de contato "de WhatsApp";
pausar → `claimMessage` ignora com `BOT_PAUSED` → retomar → `claimMessage` processa de novo (e a
`ChatSession` sai do modo humano); excluir sem histórico (apaga) vs. com histórico (anonimiza,
mantém `Appointment`); CSV (BOM, separador, colunas). Tudo coberto em
`tests/integration/contacts.integration.test.ts` (11 testes) — a Íris deve rodar contra a UI real
por cima disso, focando em fluxo e mensagens de erro na tela.

### O que o Órion deve revisar (Clientes)

- A escolha de `waJid` sem o 9º dígito é uma heurística probabilística, não uma garantia de
  unicidade — confirmar que isso é aceitável (o pior caso é um `Contact` duplicado por telefone,
  nunca um vazamento de dado entre tenants).
- `exportContactsCsvAction` devolve TODOS os dados pessoais de todos os clientes de uma vez — só
  OWNER, mas vale confirmar se isso precisa de log de auditoria (quem exportou, quando) — não
  implementado nesta rodada.
- `src/lib/db/contact-queries.ts` é o único lugar fora de `src/lib/db/` com `Prisma.sql` cru —
  confirmar que todo valor interpolado usa `${}` (parametrizado) e nunca concatenação de string.

### PENDÊNCIAS (Clientes)

- **`source` como proxy de "origem de cadastro"**: ver seção acima — um `Contact.origin` próprio
  resolveria a ambiguidade, mas é mudança de schema fora do escopo pedido nesta rodada.
- **Heurística do 9º dígito**: cobre só o caso "cliente já mandou mensagem antes de ser
  cadastrado". Se o número específico do cliente for um dos que chegam COM o 9º dígito no
  `remoteJid` real, a primeira mensagem dele ainda cria um `Contact` duplicado — sem uma forma de
  reconciliar automaticamente depois (ex.: casar por `phoneE164` quando os dois `Contact`
  existirem) sem tocar em `claim.ts`, fora do escopo desta rodada.

## Planos — preços aprovados pelo dono (`prisma/migrations/20260928000010_plan_prices`, 2026-09-28)

Data migration idempotente (não altera schema): aplica os 3 preços aprovados — Essencial R$ 59,90
(5990), Profissional R$ 109,90 (10990), Clínica R$ 189,90 (18990) — e marca os 3 planos
`active = true`. Dois caminhos, sempre pelo `code` (`essencial`/`profissional`/`clinica`):

1. **Cria** o plano se `code` ainda não existir (produção nasce vazia — `prisma/seed.ts` não roda
   em produção).
2. **Atualiza** um plano já existente SÓ SE ele estiver exatamente no estado "recém-criado pelo
   seed, não precificado" (`priceCents = 0 AND active = false`). Qualquer plano com preço
   diferente de 0 (mesmo que ainda inativo) é deixado intocado — nunca sobrescreve uma edição que
   o dono já tenha feito pela tela Admin → Planos.

Nada no código fixa esses valores — `admin-actions.ts`/`admin-service.ts` (Fase 7) continuam
sendo o único jeito de mudar preço/limites/ativação depois da migration; o dono pode reajustar
livremente pela tela. `prisma/seed.ts` (ambiente de dev) foi atualizado com os mesmos 3 valores,
já `active: true`, para o dev ficar consistente com produção — `update: {}` no `upsert` garante
que rodar o seed de novo nunca sobrescreve um ajuste manual.

`docs/deploy-easypanel.md` não precisou de passo extra: o passo já documentado ("Console do
serviço → `npx prisma migrate deploy` — manual, sempre") já cobre esta migration.

Aplicada e conferida em `innochat` (dev) e `innochat_test`.

## Cobrança — alinhamento com o Parque das Feiras (Mercado Pago), 2026-09-29

O dono confirmou que o Parque das Feiras tem a integração com o Mercado Pago validada em
produção — usada como referência de verdade contra o nosso adaptador (só testado com mock).
Comparação item a item entre `ParquedasFeiras/backend/src/lib/mercadopago.ts` +
`lib/pagamentos/adaptadores/mercadoPago.ts` e `src/modules/billing/mercadopago.ts` +
`webhook.ts`:

| Item | Parque das Feiras (PF) | InnoChat (antes) | Decisão |
|---|---|---|---|
| CPF/CNPJ do pagador no Pix | Exige `payer.identification` — incidente real documentado (`payments.pix.cpf.test.ts`): sem CPF, o MP recusava e um bug ANTIGO (SDK lançando o corpo cru) virava 500 mudo | Só mandava `payer.email` — nunca enviava `identification` | **Alinhado ao PF.** O MP exige o documento para Pix; adicionamos `Tenant.document` (migration `20260929004309_tenant_billing_document`), `payerDocument`/`payerName` em `CreatePixPaymentInput`, e `createPixPayment` falha CEDO (`missing_payer_document`) sem chamar o MP se faltar. **Contrato NOVO para a Lyra:** `/cadastro` ainda não coleta CPF/CNPJ — a empresa fica sem Pix até cadastrar pela nova `updateTenantDocumentAction` (ver abaixo). |
| `date_of_expiration` na criação | Envia (implícito via SDK, que usa o padrão do MP) e usa `date_of_expiration` da RESPOSTA como fonte de verdade | Nunca enviava; calculava `expiresAt` só localmente (`Date.now() + 3 dias`), sem saber o que o MP de fato aplicou | **Alinhado ao PF.** Passamos a mandar `date_of_expiration` (`.toISOString()`, UTC) no corpo e a usar o valor da resposta do MP como `expiresAt` — evita `Invoice.pixExpiresAt` dizer uma coisa e o QR real dizer outra. |
| `notification_url` | Envia explícito por cobrança (`${APP_PUBLIC_URL}/api/payments/webhook`) | Nunca enviava — dependia 100% da URL cadastrada manualmente no painel de Developers do MP | **Alinhado ao PF, com fallback.** Passamos a mandar `notification_url` quando `getPublicBaseUrl()` resolve (via `tryGetPublicBaseUrl()`, nunca lança); sem URL resolvível (fora de requisição e sem `PlatformSettings.publicBaseUrl` gravado ainda), omite o campo e cai no comportamento antigo. |
| Formato do fuso em `date_of_expiration` | `-03:00` explícito (servidor roda no fuso do Brasil) | N/A (nem enviava) | **Não copiamos o `-03:00`.** Usamos `.toISOString()` (sufixo `Z`, UTC) — instante idêntico, sem aritmética manual de fuso e sem depender do fuso do processo Node. Equivalente correto, mais simples que o do PF. |
| `payer.first_name`/`last_name` | Quebra `order.buyer.name` no espaço; sem sobrenome, repete o primeiro nome | N/A (não enviava nome) | **Alinhado ao PF** — `splitPayerName(Tenant.name)`, mesma regra de fallback. |
| Classificação de erro do MP (CPF ausente, credencial, sem chave Pix, rate limit) | `mercadopago-errors.ts`: `MercadoPagoError` com `kind` tipado, ancorado no CAMPO (`payer.identification`) para não confundir CPF do vendedor com CPF do pagador | Um `MercadoPagoApiError` genérico só com `status`, texto solto | **Alinhado ao PF** (versão reduzida, só o que importa para Pix): `MercadoPagoFailureKind` (`missing_payer_document`, `invalid_payer_document`, `invalid_credentials`, `pix_key_not_enabled`, `rate_limited`, `payload_rejected`, `unavailable`) + `classifyMercadoPagoError`. `regeneratePixForInvoice` traduz cada `kind` num código de `DomainError` específico (`MERCADOPAGO_MISSING_DOCUMENT`/`MERCADOPAGO_MISCONFIGURED`/`MERCADOPAGO_UNAVAILABLE`) em vez de um "indisponível" genérico para qualquer causa. |
| Validação de CPF/CNPJ | Dígito verificador (módulo 11), não só contagem de dígitos | N/A | **Alinhado ao PF** — `src/core/billing/document.ts` (`validateCpfCnpj`), mesmo algoritmo público de CPF/CNPJ. |
| `x-signature` (assinatura do webhook) | Usa `verifyWebhookSignature` do SDK oficial do MP (não documentado aqui em detalhe) | Implementação própria, **conferida contra o SDK oficial em Go** (`github.com/mercadopago/sdk-go/pkg/webhook`) em 2026-09-28 — ver `.claude/agent-memory/vega/mercadopago_signature_go_sdk_spec.md` | **Mantido o nosso.** Já foi verificado contra o código-fonte oficial do MP (não só a doc em prosa), incluindo 2 desvios finos (origem do `data.id` no query param, omissão de pares ausentes no manifest) que uma reimplementação "de memória" costuma errar. Não há necessidade de alinhar a algo menos verificado. |
| `type`/`topic` da notificação (`payment` vs `merchant_order`) | `interpretarNotificacao`: `type !== 'payment'` → `evento_irrelevante`, sem reconsultar nada | Não checava `type` — qualquer `data.id` era tratado como pagamento e reconsultado via `getPayment` | **Alinhado ao PF.** `handleMercadoPagoWebhook` agora recebe `type` (de `type`/`topic`, corpo ou query) e ignora (200, sem tocar no gateway/banco) quando não é `payment` — depois da assinatura validar, igual à ordem do PF. |
| Resposta HTTP ao MP | 200 rápido, nunca 5xx por payload malformado | Igual | **Sem divergência** — já estava certo. |
| Reconsulta antes de dar baixa | Nunca confia no `status` do corpo; sempre reconsulta com a credencial própria | Igual | **Sem divergência** — já estava certo. |
| Idempotência do webhook | Não documentada em detalhe aqui | `ProviderEvent(provider, providerEventId)` + `applyInvoicePayment` idempotente por si — testado contra corrida real (`billing-webhook.integration.test.ts`) | **Sem mudança** — já mais testado que o que foi possível conferir do PF neste ponto. |
| Valor mínimo / arredondamento de centavos | `centavosDeReais`/`reaisDeCentavos`: `Math.round(reais*100)`/`centavos/100`, sem `EPSILON` | `Math.round(input.amountCents) / 100` (equivalente, já que `amountCents` já chega inteiro) | **Sem divergência real** — mesma matemática, forma textual diferente. |

### `Tenant.document` (CPF/CNPJ) — schema novo

Migration `20260929004309_tenant_billing_document` (aditiva, aplicada em `innochat` e
`innochat_test`): `Tenant.document String?`, só dígitos, `null` até a empresa cadastrar. Nasce
`null` para toda empresa — `/cadastro` não coleta isto ainda.

### `updateTenantDocumentAction(tenantSlug, { document })` — NOVO (`src/modules/tenant/actions.ts`)

Restrito a `OWNER` (mesma régua de `updateTenantThemeAction`). Valida CPF/CNPJ pelo dígito
verificador (`validateCpfCnpj`) — dígitos-só/formatado, ambos aceitos. Erro `INVALID_DOCUMENT`
para dígito verificador errado. **Contrato para a Lyra**: falta um campo em Configurações (ex.:
Configurações → Empresa) chamando esta action — sem ele, a empresa nunca consegue gerar Pix
(toda fatura nasce `OPEN` sem Pix até o CPF/CNPJ existir, mesmo caminho de "MP indisponível").

### `regeneratePixForInvoice` — erros agora específicos

Antes: qualquer falha (CPF ausente, credencial errada, MP fora do ar) virava
`MERCADOPAGO_UNAVAILABLE` genérico. Agora: `MERCADOPAGO_MISSING_DOCUMENT` (falta ou CPF/CNPJ
inválido — a tela deve linkar para o campo de Configurações acima),
`MERCADOPAGO_MISCONFIGURED` (credencial da plataforma ou conta sem chave Pix — problema do
ADMIN da plataforma, não da empresa) ou `MERCADOPAGO_UNAVAILABLE` (rate limit/indisponibilidade
— tentar de novo). `tryAttachPix` (usado em segundo plano por `signup`/`tick`) continua só
logando e devolvendo `null` em qualquer falha — comportamento inalterado para quem não chama a
ação explícita.

### Bug corrigido: `expiresInDays` ignorado

`createPixPayment` recebia `input.expiresInDays` mas sempre usava uma constante fixa do módulo
(`PIX_EXPIRATION_DAYS = 3`) — parâmetro morto. Sem efeito prático hoje (todo caller já passava
3), mas corrigido enquanto o código estava sob revisão.

## Teste grátis: 3 dias (decisão do dono, 2026-09-29)

`TRIAL_DAYS` (`src/core/billing/status.ts`) mudou de `1` para `3` — única fonte, sem config nova
no admin. `GRACE_DAYS` (carência, 1 dia) **não muda**. A primeira fatura continua sendo gerada
já no cadastro. Atualizados: `computeTrialEndsAt` (era `+1 dia`, agora `+3 dias`),
`status.test.ts`, comentários em `signup/service.ts`/`billing/tick.ts`, e este documento +
`docs/arquitetura.md` §7.1/§7.3/§7.4. **Pendente na UI (Lyra):**
`src/app/(public)/cadastro/cadastro-form.tsx:144` ainda diz "1 dia de teste grátis" — texto
estático, não lido de `TRIAL_DAYS` (que é backend); precisa trocar para "3 dias".

## Termos de uso: versão conferida no servidor (decisão do dono, 2026-09-29)

`signUpAction` deixou de gravar `termsVersion` como o client mandou sem checar. Agora
`assertCurrentTermsVersion` (`src/lib/legal.ts`) compara contra `TERMS_VERSION` (a mesma
constante que `/termos`/`/privacidade` exibem) e lança `DomainError("TERMS_VERSION_OUTDATED", ...)`
se vierem diferentes — cenário real: uma aba de `/cadastro` aberta há dias, em cache, mandando
uma versão de termos que já não é a vigente. `signUp` sempre grava a constante do SERVIDOR
(`TERMS_VERSION`), nunca o valor bruto do client, mesmo depois de validado igual. **Contrato para
a Lyra:** tratar o código `TERMS_VERSION_OUTDATED` no formulário de cadastro com uma mensagem de
"atualize a página" (ex.: `location.reload()` antes de tentar de novo) — hoje ele cai no erro
genérico.

`PlatformSettings.termsVersion` foi **descontinuado no código** (deixou de ser lido/gravado em
`src/modules/platform/service.ts`/`actions.ts`): duplicava `TERMS_VERSION` e nenhuma tela de
admin o editava. A coluna continua no schema (`prisma/schema.prisma`, marcada como órfã) — sem
migration destrutiva agora; proposta para o Cronos decidir quando vale remover.

## Cadastro público: CPF/CNPJ obrigatório (decisão do dono, 2026-09-29)

Como a primeira fatura (com Pix) já nasce no cadastro (§7.3), `document` passou de "não
coletado" para **obrigatório** em `signUpAction`.

- `SignUpInput.document: string` (`src/modules/signup/service.ts`) — aceita formatado ou só
  dígitos (`validateCpfCnpj` normaliza, mesma função de `updateTenantDocumentAction`). `signUp`
  valida o dígito verificador ANTES de abrir a transação e grava `Tenant.document` já dentro da
  `tx` de criação (mesma transação de `User`/`Tenant`/`Membership`/`Subscription`/`Invoice`).
- Erro: `INVALID_DOCUMENT` (`"CPF ou CNPJ inválido — confira os dígitos."`), mesmo código que
  `updateTenantDocumentAction` já usava — a Lyra trata os dois no mesmo lugar do formulário.
- `signUpSchema` (`src/modules/signup/actions.ts`) ganhou o campo `document: z.string().trim().min(1, ...)`
  — só confere presença; o dígito verificador é responsabilidade do `signUp` (a mensagem de erro
  específica sai de lá, não do zod).
- Efeito prático: toda empresa criada a partir de agora já nasce com `Tenant.document`
  preenchido, e o Pix da primeira fatura sai de fato no cadastro (antes, a fatura nascia sempre
  `OPEN` sem Pix, porque nada coletava o documento). `updateTenantDocumentAction` continua
  existindo — corrige o documento de uma empresa antiga (criada antes desta mudança, com
  `document = null`) ou troca um documento errado depois.
- Testes atualizados: `tests/integration/billing-signup.integration.test.ts` — o caso "cadastro
  com documento válido gera Pix" é agora o cenário PADRÃO (era "sem Pix" antes); adicionado o
  caso "CPF/CNPJ com dígito verificador inválido → `INVALID_DOCUMENT`".
- **Contrato confirmado com a Lyra** (onda 2, commit `6d8a4b3`): o formulário de `/cadastro` já
  manda `document` normalizado (só dígitos, `normalizeDocumentDigits`) e valida no client antes
  de enviar (`validateCpfCnpj`) — o backend sempre revalida (nunca confia no client).

## "Gerar Pix agora" pela própria empresa (`regenerateMyInvoicePixAction`, decisão do dono/Lyra, 2026-09-29)

Antes, `regeneratePixForInvoice` só rodava em segundo plano pelo `billing/tick` (de hora em
hora) — a tela de Assinatura não tinha como reagir na hora a `MERCADOPAGO_MISSING_DOCUMENT`
(documento acabou de ser cadastrado) ou `MERCADOPAGO_UNAVAILABLE` (tentar de novo).

- `regenerateMyInvoicePixAction(tenantSlug, invoiceId): Result<{ invoiceId, pixCopyPaste:
  string | null }>` (`src/modules/billing/actions.ts`). Restrito a `OWNER` (mesma régua de
  `changePlanAction`).
- **Escopo por tenant**: `findOwnInvoiceOrThrow(tenantId, invoiceId)` (`src/modules/billing/
  service.ts`) confirma que a fatura pertence à `Subscription` DESTE tenant antes de tocar em
  qualquer coisa — `NOT_FOUND` (nunca revela se o id existe em outra empresa) se não pertencer
  ou não existir. Sem isto, um OWNER autenticado poderia adivinhar/tentar um `invoiceId` de
  outra empresa e regerar Pix nela.
- **Rate limit**: 5 tentativas / 10 min por `tenantId` (`checkRateLimit`, chave
  `regenerate-pix:<tenantId>`) — é uma chamada de rede de verdade ao Mercado Pago, não um clique
  de UI barato. Erro: `RATE_LIMITED` (`details.retryAfterMs`), mesmo formato do rate limit de
  cadastro.
- Erros herdados de `regeneratePixForInvoice` (docs/contratos.md, "Cobrança — alinhamento com o
  Parque das Feiras"): `MERCADOPAGO_MISSING_DOCUMENT`, `MERCADOPAGO_MISCONFIGURED`,
  `MERCADOPAGO_UNAVAILABLE`, `INVALID_STATE` (fatura não está `OPEN`), `NOT_FOUND`.
- **Contrato para a Lyra**: a tela de Assinatura, ao ver `MERCADOPAGO_MISSING_DOCUMENT`/
  `MISCONFIGURED`/`UNAVAILABLE` numa fatura aberta, oferece um botão "Gerar Pix agora"/"Tentar
  de novo" chamando esta action com o `invoiceId` da fatura corrente — sem precisar de página
  nova nem de reload.

## Dados jurídicos da empresa operadora (docs/arquitetura.md — LGPD/Termos, decisão do dono, 2026-09-29)

Nada disso pelo chat/código — tudo cadastrável pelo admin da plataforma, numa tela nova ("Dados
jurídicos"). `PlatformSettings` ganhou 9 campos opcionais (migration
`20260929010000_platform_settings_legal_health`): `companyLegalName`, `companyCnpj`,
`companyAddress`, `contactEmail`, `dpoName`, `dpoEmail`, `forumCity` (comarca), `hostingRegion`,
`backupRetentionDays` (Int). **Nenhum destes é segredo** — diferente das credenciais de
integração (`service.ts`, sempre mascaradas), a leitura devolve tudo em claro.

### `src/modules/platform/legal-service.ts` — I/O

- `getPlatformLegalInfo(): Promise<PlatformLegalInfo>` — leitura para a tela de admin.
- `updatePlatformLegalInfo(input, updatedByUserId): Promise<PlatformLegalInfo>` — diferente de
  `updatePlatformSettings` (credenciais, "string vazia mantém o valor atual"), AQUI string vazia
  ou `null` **LIMPA** o campo; `undefined` (campo não mandado no `input`) mantém o valor atual.
- `getPublicLegalInfo(): Promise<PlatformLegalInfo>` — `cache()` do React (memoiza dentro do
  MESMO ciclo de render de uma requisição; fora de um render de RSC, degrada para uma leitura
  direta sem memoização — nunca lança). Leitura **pública**, sem `requirePlatformAdmin` — para
  as páginas `/termos` e `/privacidade` chamarem direto.

### Server Actions (`src/modules/platform/actions.ts`)

- `getPlatformLegalInfoAction(): Result<PlatformLegalInfo>` — `requirePlatformAdmin()`.
- `updatePlatformLegalInfoAction(input): Result<PlatformLegalInfo>` — `input` parcial de
  `{ companyLegalName, companyCnpj, companyAddress, contactEmail, dpoName, dpoEmail, forumCity,
  hostingRegion, backupRetentionDays }`, todos opcionais/anuláveis. `companyCnpj` é validado
  pelo dígito verificador (`isValidCnpj`, `@/core/billing`) quando não vazio — erro
  `INVALID_CNPJ`. `contactEmail`/`dpoEmail` validam formato de e-mail (ou string vazia, para
  limpar).

### `src/core/legal/placeholders.ts` — domínio puro (sem I/O)

- `PlatformLegalInfo` — o mesmo shape usado por `legal-service.ts` (import cruzado de tipo, sem
  I/O real neste arquivo).
- `formatCnpjDisplay(digitsOrRaw): string` — `"11444777000161"` → `"11.444.777/0001-61"`;
  devolve o valor original se não tiver 14 dígitos (defensivo, nunca lança).
- `fillLegalPlaceholders(text, info): string` — substitui cada marcador conhecido do texto
  público pelo valor cadastrado, ou por `"a definir"` quando vazio. Marcadores DESCONHECIDOS
  (fora do mapa abaixo) são deixados intactos — nunca mascarados silenciosamente; é assim que a
  sintaxe de link Markdown `[Política de Privacidade](/privacidade)` (usada dentro do próprio
  texto dos Termos) atravessa ilesa, mesmo casando com o mesmo regex `/\[[^\]]+\]/g`.
- Mapa de marcadores → campo (conferido contra o texto-fonte em 2026-09-29):
  `[CNPJ]` → `companyCnpj` (formatado), `[ENDEREÇO]` → `companyAddress`, `[E-MAIL DE CONTATO]` →
  `contactEmail`, `[E-MAIL DO ENCARREGADO/DPO]` → `dpoEmail`, `[NOME DO ENCARREGADO]` →
  `dpoName`, `[COMARCA]` → `forumCity`, `[PAÍS/REGIÃO DO PROVEDOR DE HOSPEDAGEM]` →
  `hostingRegion`, `[PRAZO DE RETENÇÃO DOS BACKUPS]` → `backupRetentionDays` (formatado
  `"<N> dias"`).
- Testes: `src/core/legal/__tests__/placeholders.test.ts` (substituição completa, "a definir"
  por campo vazio, marcador desconhecido intacto, texto sem marcador inalterado).

**Contrato para a Lyra:**
1. Tela de admin nova ("Dados jurídicos", sugestão: `/admin/configuracoes` ou aba própria)
   chamando `getPlatformLegalInfoAction`/`updatePlatformLegalInfoAction` — os 9 campos, todos
   opcionais, sem máscara (podem aparecer em claro no formulário).
2. `/termos` e `/privacidade` (`src/app/(public)/termos/page.tsx`,
   `.../privacidade/page.tsx` — hoje renderizam `TERMOS_SECTIONS`/`PRIVACIDADE_SECTIONS` direto)
   passam a chamar `getPublicLegalInfo()` e rodar `fillLegalPlaceholders` em cada bloco de texto
   (`string`) das seções ANTES de passar para `<LegalDocument>` — os marcadores `[CNPJ]` etc.
   viram os dados reais (ou `"a definir"`), sem editar `termos-content.ts`/
   `privacidade-content.ts` (que continuam com os marcadores literais, fonte única do texto).

## Admin → Cobrança (docs/contratos.md, decisão do dono, 2026-09-29)

Tudo em `src/modules/billing/admin-service.ts`/`admin-actions.ts` (mesmo arquivo dos planos e
empresas, §9) — guardado por `requirePlatformAdmin()`.

- `listInvoicesAdminAction({ status?, tenantId?, fromDate?, toDate?, cursor?, limit? }):
  Result<{ items: AdminInvoiceListItem[]; nextCursor: string | null }>` — faturas de TODAS as
  empresas, paginadas por cursor (`limit` máx. 100, padrão 30; nunca "todas de uma vez").
  `fromDate`/`toDate` filtram por `dueAt` (vencimento), não por criação. Um único `findMany`
  com `include` (join) resolve `tenantName`/`tenantSlug` — sem N+1. Cada item:
  `{ id, tenantId, tenantName, tenantSlug, amountCents, status, periodStart, periodEnd, dueAt,
  paidAt, hasPix: boolean, createdAt, kind: "TRIAL" | "REGULAR" }` (`hasPix` = tem `pixCopyPaste`;
  nunca devolve o Pix em si nesta listagem). `kind: "TRIAL"` = fatura criada no cadastro
  (`Invoice.isTrialConversion`) — a UI mostra o badge "Teste" (quando não paga); status `VOID`
  aparece como "Anulada" no filtro e na lista.
- `billingMonthlyTotalsAction(): Result<{ receivedCents, openCents, overdueCents, trialCents,
  trialCount, mrrCents }>` — **`openCents` e `overdueCents` EXCLUEM a fatura de teste**
  (`isTrialConversion`); ela vai para `trialCents`/`trialCount` (faturas `OPEN` de teste de conta
  não `CANCELED` — card "Em teste"). `VOID` nunca entra em total nenhum. Regra do dono
  (2026-09-29): teste não é valor a receber nem inadimplência. Detalhes dos demais campos:
  `receivedCents` (faturas `PAID` com `paidAt` no mês de hoje), `openCents` (faturas `OPEN` com
  `dueAt >= agora`, estado atual — não escopado ao mês), `overdueCents` (faturas `OPEN` com
  `dueAt < agora`, sempre em tempo real, direto da tabela — não espera o próximo `billing/tick`
  marcar `PAST_DUE`), `mrrCents` (soma de `Plan.priceCents` de toda `Subscription` com
  `status = ACTIVE` persistido). 4 agregações (`aggregate`/`groupBy`), nenhum loop somando em
  memória.
- `listDelinquentCompaniesAction(): Result<DelinquentCompany[]>` — empresas `PAST_DUE`/
  `SUSPENDED` **que já pagaram alguma vez** (`firstPaidAt` não nulo; teste não convertido não é
  inadimplente) (status persistido — a reconciliação com o efetivo acontece no próximo
  `billing/tick`, até 1h de atraso), com `daysOverdue` contado a partir de
  `Subscription.currentPeriodEnd`.
- `regeneratePixForInvoiceAdminAction(invoiceId): Result<{ invoiceId, hasPix: boolean }>` —
  "Regerar Pix" da tela: resolve o e-mail do OWNER da empresa sozinho (não pede ao admin) e
  reaproveita `regeneratePixForInvoice` (mesmos erros `MERCADOPAGO_*` de sempre).
- `markInvoicePaidManuallyAction(invoiceId, { reason }): Result<{ alreadyProcessed: boolean }>`
  — "Marcar como paga manualmente": motivo OBRIGATÓRIO (`reason`, 3-500 caracteres, erro
  `INVALID_PAYLOAD` se faltar), mesmo efeito de `applyInvoicePayment` (marca `PAID`, avança o
  ciclo, reativa a assinatura). **Auditoria**: reaproveita `ProviderEvent`
  (`provider = "manual"`, `providerEventId = invoiceId`, `payload = { invoiceId, adminId,
  reason, markedAt }`) em vez de criar uma tabela nova — a constraint
  `@@unique([provider, providerEventId])` garante UM registro por fatura. **Idempotente**: se a
  fatura já está `PAID` (por este caminho ou por webhook/tick), a segunda chamada devolve
  `{ alreadyProcessed: true }` sem duplicar auditoria nem avançar o ciclo duas vezes — inclusive
  sob concorrência (duas chamadas simultâneas: a segunda sempre perde a corrida dentro da
  transação de `applyInvoicePayment`).

**O que a Íris deve testar:** `tests/integration/billing-admin.integration.test.ts` — filtros/
paginação de `listInvoicesAdmin`, totais do mês, lista de inadimplentes, `regeneratePixForInvoiceAdmin`
(sucesso + `NOT_FOUND`), `markInvoicePaidManually` (efeito completo, idempotência, `NOT_FOUND`),
e `findOwnInvoiceOrThrow` (escopo cross-tenant, ver seção "Gerar Pix agora" acima).

**Contrato para a Lyra:** tela `/admin/cobranca` (hoje placeholder "Em breve",
`src/app/(platform)/admin/cobranca/page.tsx`) consome as 5 actions acima. Sugestão de layout:
cards de totais no topo (`billingMonthlyTotalsAction`), tabela paginada de faturas com filtros
(`listInvoicesAdminAction`) e ação "Regerar Pix"/"Marcar como paga" por linha, seção separada de
empresas inadimplentes (`listDelinquentCompaniesAction`).

## Admin → Saúde (docs/contratos.md, decisão do dono, 2026-09-29)

`src/modules/platform/health-service.ts` — guardado por `requirePlatformAdmin()` via
`getPlatformHealthAction()` (`src/modules/platform/actions.ts`).

- `getPlatformHealthAction(): Result<PlatformHealth>` —
  ```
  {
    integrations: { evolution, n8n, smtp, mercadoPago: { ok, detalhe, configured }, checkedAt },
    billingTick: { lastRunAt: string | null, lastResult: unknown, stale: boolean },
    maintenanceTick: { lastRunAt: string | null, lastResult: unknown, stale: boolean },
    whatsappInstancesByStatus: { QRCODE, CONNECTED, DISCONNECTED },
    companiesBySubscriptionStatus: { TRIALING, ACTIVE, PAST_DUE, SUSPENDED, CANCELED },
    inboundEventsLast24h: number,
    alerts: string[],
  }
  ```
- **Integrações**: reaproveita `testEvolutionConnection`/`testN8nConnection`/
  `testSmtpConnection`/`testMercadoPagoConnection` (`connection-tests.ts`, Fase 1) — não duplica
  lógica de teste. `configured: false` (sem tentar rede) quando os campos de
  `PlatformSettings` necessários estão vazios. **Cache de ~60s** (`getIntegrationsHealth`, cache
  em memória do processo, `resetIntegrationsHealthCache()` só para teste) — a tela pode ser
  recarregada com frequência; sem cache, cada visita martelaria os 4 serviços externos.
- **Jobs periódicos**: `recordBillingTickRun(result, at?)`/`recordMaintenanceTickRun(result,
  at?)` são chamados pelo PRÓPRIO `runBillingTick`/`runMaintenanceTick`
  (`src/modules/billing/tick.ts`, `src/modules/maintenance/tick.ts`) ao final de cada execução —
  persistem em `PlatformSettings.lastBillingTickAt/Result` e
  `lastMaintenanceTickAt/Result` (migration `20260929010000_platform_settings_legal_health`).
  Nunca falham o tick em si (só logam `warn` se a persistência falhar — o resumo já foi
  calculado e já foi logado antes). `stale`: billing > 2h sem rodar, maintenance > 26h.
- **Contagens**: `whatsappInstancesByStatus` (todas as empresas, `deletedAt: null`),
  `companiesBySubscriptionStatus` (status persistido de `Subscription`, `groupBy`),
  `inboundEventsLast24h` (`InboundEvent.count` com `createdAt >= agora - 24h`) — 4 queries
  agregadas (`groupBy`/`count`), nenhum loop.
- **Alertas** (`alerts: string[]`): tick de billing/maintenance parado, Evolution ou Mercado
  Pago fora do ar — frases prontas para a tela mostrar direto, sem repetir a lógica de threshold
  no frontend.

**O que a Íris deve testar:** `tests/integration/platform-legal-health.integration.test.ts` —
integrações "não configurado" sem tentar rede, cache de 60s, `stale` com/sem execução
registrada, alertas disparando, contagens de WhatsApp/assinatura.

**Contrato para a Lyra:** tela `/admin/saude` (hoje placeholder "Em breve",
`src/app/(platform)/admin/saude/page.tsx`) consome `getPlatformHealthAction()`. Sugestão:
badges de status por integração (verde/vermelho + `detalhe`), cards de "última execução" dos
dois ticks (com `stale` destacado em atenção), contagens de WhatsApp/empresas por status, banner
de alertas no topo quando `alerts.length > 0`.

**PENDÊNCIAS (Dados jurídicos / Admin Cobrança / Admin Saúde):**
- Nenhuma tela de admin ainda consome estas actions (`/admin/cobranca`/`/admin/saude` continuam
  "Em breve" — placeholders da Lyra, ver acima); as páginas `/termos`/`/privacidade` ainda não
  chamam `getPublicLegalInfo()`/`fillLegalPlaceholders` (continuam mostrando os marcadores
  literais `[CNPJ]` etc. até a Lyra plugar).
- `Órion` deve revisar: `findOwnInvoiceOrThrow` (escopo cross-tenant de
  `regenerateMyInvoicePixAction`), a idempotência/concorrência de `markInvoicePaidManually`, e
  se `getPublicLegalInfo` sem `requirePlatformAdmin` está mesmo seguro expor publicamente (são
  os MESMOS dados que já apareceriam em claro em `/termos`/`/privacidade`, mas vale o segundo
  olhar).


---

## Teste não convertido (2026-09-29, decisão do dono)

Cliente em teste não é "a receber" nem inadimplente. Implementação:

- **Marcadores (migration aditiva `20260929180000_trial_invoice_first_paid`):**
  `Invoice.isTrialConversion boolean default false` (fatura criada no cadastro, `signup/service.ts`)
  e `Subscription.firstPaidAt timestamp null` (primeiro pagamento; gravado uma vez por
  `applyInvoicePayment`). Backfill no SQL: `firstPaidAt` = menor `paidAt` das faturas `PAID`;
  `isTrialConversion` = primeira fatura (menor `periodStart`) de cada assinatura.
- **Ciclo de vida:** fim do teste → 1 dia `PAST_DUE` → `SUSPENDED` → 7 dias depois `CANCELED` (só quem
  nunca pagou; ex-pagante = 60 dias). Ao virar `CANCELED` (pelo tick, pelo dono ou pelo admin), a
  fatura `OPEN` de teste vira `VOID` na varredura final de `reconcileStatuses` (`updateMany` com
  guarda `status = OPEN`, idempotente, auto-curável; `BillingTickSummary.invoicesVoided`).
- **Tick:** `generateUpcomingInvoices` pula assinatura com fatura de teste `OPEN` (evita 2ª fatura
  no `PAST_DUE` pós-teste); Pix novo e lembretes só olham `OPEN` (nunca `VOID`). O e-mail de
  suspensão de quem nunca pagou é "Seu teste terminou — {empresa}" (assine para continuar; conta
  encerrada em 7 dias), não "falta de pagamento". Não existe e-mail de cancelamento (nem havia).
- **Pagamento tardio:** fatura de teste paga com a conta `SUSPENDED` (até 7 dias) reativa normal e
  grava `firstPaidAt`. Fatura `VOID`: `applyInvoicePayment` devolve `{ alreadyProcessed: false,
  voided: true }` sem tocar em nada; o webhook registra o `ProviderEvent` com
  `payload.voidedInvoicePayment = true`, loga `billing.webhook.payment_for_void_invoice` e responde
  `ignored`; `markInvoicePaidManually` recusa (`INVALID_STATE`). **Regra proposta: o admin reativa**
  (Admin → Empresas → Reativar) e, se o cliente pagou, estorna/confere no Mercado Pago.
- **Reativação manual** (`reactivateCompanyManually`) anula a fatura de teste `OPEN` (a conta foi
  liberada sem cobrança) e não preenche `firstPaidAt`.

## Onboarding — tour do Inno + checklist "Primeiros passos" (2026-09-29, decisão do dono)

Server Actions em `src/modules/onboarding/actions.ts`. Todas devolvem `Result<OnboardingState>`:

```ts
type OnboardingState = {
  tourCompletedAt: string | null;        // ISO; por USUÁRIO (User.onboardingTourCompletedAt)
  checklistDismissedAt: string | null;   // ISO; por EMPRESA (Tenant.onboardingChecklistDismissedAt)
  steps: Array<{ key: "services" | "professionals" | "hours" | "whatsapp" | "botTest"; done: boolean }>;
  allDone: boolean;
};
```

- `getOnboardingStateAction(tenantSlug?)` — lê o estado.
- `completeOnboardingTourAction(tenantSlug?)` — concluir OU pular (mesmo efeito); idempotente, preserva a 1ª data.
- `restartOnboardingTourAction(tenantSlug?)` — zera `tourCompletedAt` (rever pelo menu).
- `dismissOnboardingChecklistAction(tenantSlug?)` — esconde o checklist para a empresa; idempotente.

`tenantSlug` é opcional (o contrato original não tinha argumento): sem ele, usa a empresa mais antiga
do usuário; com ele, aplica `requireTenantMember` (`NOT_FOUND` se não for membro). Recomendado passar
o slug da rota. Erros: `UNAUTHENTICATED`, `NOT_FOUND`. Não exige `assertTenantCanWrite` (é preferência
de UX; funciona com conta suspensa). Steps sempre derivados dos dados (nunca marcados à mão), ordem fixa:

| key | done quando |
|---|---|
| `services` | ≥1 `Service` com `active = true` |
| `professionals` | ≥1 `Professional` com `active = true` |
| `hours` | ≥1 `Professional` ativo com ≥1 `WorkingHour` (não existe horário de funcionamento da empresa) |
| `whatsapp` | ≥1 `WhatsappInstance` com `status = CONNECTED`, `deletedAt = null`, `sandbox = false` |
| `botTest` | ≥1 `Appointment` com `source = WHATSAPP` (origem gravada só pelo bot; painel grava `PANEL`), em qualquer status |

Escolha do `botTest`: `Appointment.source` em vez de `ChatSession` (sem `tenantId`; "concluída" é string do n8n).
Migration `20260929200000_onboarding_state`: 2 colunas nulas, aditiva.

## Notificações do painel (central de notificações, 2026-09-29, pedido do dono)

Para os usuários da empresa (dono e equipe) — NÃO é o lembrete de véspera por WhatsApp ao cliente final (isso segue pós-v1). Código: `src/modules/notifications/` (`actions.ts` → `service.ts` → `format.ts` puro). Todas as actions: `requireTenantMember(tenantSlug)`, retorno `Result<T>`, sem `assertTenantCanWrite` (funcionam com a conta suspensa).

### Decisão: derivadas, não materializadas
Não existe tabela `Notification`. Cada tipo sai do estado que já existe, então nenhum ponto de escrita (painel, API do bot, drag-to-reschedule, tick) pode "esquecer" de gerar:

| kind | fonte | id (chave de leitura) | createdAt |
|---|---|---|---|
| `APPOINTMENT_CREATED/RESCHEDULED/CANCELED/COMPLETED/NO_SHOW` | `AppointmentEvent` (janela 30 dias) | `ev:<eventId>` | `event.createdAt` |
| `APPOINTMENT_UPCOMING` | `Appointment` SCHEDULED com `startsAt` em (agora, agora+60min] | `upcoming:<appointmentId>:<startsAt em minutos>` (estável; remarcar gera lembrete novo) | `startsAt − 60min` |
| `WHATSAPP_DISCONNECTED` | `WhatsappInstance` DISCONNECTED, não removida, não sandbox, com `disconnectedAt` (nova coluna) | `wa:<instanceId>:<disconnectedAt ms>` | `disconnectedAt` |
| `TRIAL_ENDING` (só OWNER) | `Subscription` TRIALING com `trialEndsAt` em (agora, agora+24h] | `trial:<subscriptionId>` | `trialEndsAt − 24h` |
| `PAYMENT_CONFIRMED` (só OWNER) | `Invoice` PAID com `paidAt` na janela | `pay:<invoiceId>` | `paidAt` |

Título e origem: na criação vale `Appointment.source` ("Novo agendamento pelo WhatsApp" / "… pelo painel"); nas demais ações vale `authorType` (CONTACT→WhatsApp, USER→painel, SYSTEM→sem sufixo). Corpo: `"Maria • Corte • com Ana • qui 02/10 às 14:00"` (fuso da empresa; só o NOME do contato, nunca telefone; sem nome → "Cliente"). `href`: `/{slug}/agenda?data=YYYY-MM-DD` (dia do agendamento; a página da agenda precisa ler o param `data`), `/{slug}/whatsapp`, `/{slug}/assinatura`.

Não há restrição de profissional por STAFF no produto: STAFF vê todos os eventos de agendamento e o WhatsApp; cobrança (trial/pagamento) só OWNER.

### Estado de leitura (por usuário e empresa)
`Membership.notificationsReadAllAt` ("marcar todas": tudo com `createdAt <=` esse instante é lido) + tabela `NotificationRead(membershipId, notificationKey, readAt)` ("marcar uma"). Em vez de `User.notificationsSeenAt` porque o usuário pode ter várias empresas. "Marcar todas" apaga as leituras individuais (ficam redundantes); o `billing`/`maintenance/tick` purga leituras com mais de 45 dias.

### Migration `20260930100000_notifications` (aditiva)
`memberships.notificationsReadAllAt`, `whatsapp_instances.disconnectedAt`, `appointment_events.tenantId` (nullable + backfill + **trigger BEFORE INSERT** que preenche a partir de `appointments`, então código antigo/novo nunca precisa informar) + índice `(tenantId, createdAt)`, tabela `notification_reads`. `disconnectedAt` é carimbado só na transição CONNECTED→DISCONNECTED inesperada (`connection-events.ts`, `syncConnectionState`) e zerado ao reconectar/desconectar manualmente/remover.

### Actions (`src/modules/notifications/actions.ts`)
- `listNotificationsAction({ tenantSlug, cursor? })` → `{ items: AppNotification[]; unreadCount; nextCursor; attendanceWaitingCount }`. Página de 20, mais recentes primeiro, janela de 30 dias. `cursor` é opaco; inválido → `INVALID_CURSOR`.
- `pollNotificationsAction({ tenantSlug, since })` → `{ unreadCount; fresh; attendanceWaitingCount }`. `fresh` = criadas depois de `since` (ISO), no máximo 10, mais novas primeiro. Custo: 1 leitura da Membership, 1 consulta indexada de eventos, 4 leituras pequenas das fontes derivadas, 1 de `NotificationRead`. `unreadCount` considera até 200 eventos da janela.
- `markNotificationsReadAction({ tenantSlug, ids?, all? })` → `{ unreadCount }`. `ids` (≤100) são os `id` das notificações; sem `ids` nem `all` ou id malformado → `INVALID_PAYLOAD`. Idempotente.
- `getUpcomingAppointmentsAction({ tenantSlug })` → `{ items }` — até 5 agendamentos SCHEDULED de hoje (fuso da empresa) a partir de agora, com `minutesUntil`.
- `getAppointmentTimelineAction({ tenantSlug, appointmentId })` → `{ items }` cronológico (antigo→novo) com `label` pt-BR ("Cliente agendou pelo WhatsApp", "Remarcado pelo painel"…). `authorLabel`: nome do contato / parte local do e-mail do membro / "Sistema". Agendamento de outra empresa → `NOT_FOUND`. `action` inclui `REOPENED` (só na timeline; nunca vira notificação). Rótulos novos: "Atendimento concluído por ana", "Cliente faltou — marcado por ana", "Atendimento reaberto por ana" (o "por ..." só aparece quando o membro é resolvido). Falha inesperada NÃO lança mais: é logada (`logger.error`, só `appointmentId` + tipo/mensagem técnica do erro) e devolve `{ ok:false, error:{ code:"TIMELINE_UNAVAILABLE", message:"Não foi possível carregar o histórico agora." } }`.
- Campo extra aditivo em `AppNotification`: `byMe?: boolean` (a ação foi do próprio usuário — a UI pode não exibir toast).

Nota: nenhuma rota do produto grava hoje `AppointmentEvent` de `COMPLETED`/`NO_SHOW` (não existe ação de "concluir"/"faltou"); o kind já é suportado assim que houver.

Testes: `tests/integration/notifications.integration.test.ts` (cada kind, leitura, isolamento, poll, upcoming, timeline, trigger, queda do WhatsApp, purge) e `src/modules/notifications/format.test.ts`. Seed local para a UI: `npm run db:seed:notifications -- [slug] [--billing] [--clean]` (`prisma/seed-notifications.ts`).

## Conciliação ativa de Pix + diagnóstico do webhook (2026-09-29)

Motivo: a baixa dependia só do webhook do MP; webhook perdido/rejeitado deixava fatura paga como `OPEN`.

**Migration aditiva** `20260930200000_mp_reconcile_diagnostics`: `Invoice.mpEnvironment` (`MercadoPagoEnvironment?`, ambiente em que o Pix foi gerado; nulo = legado), `Invoice.mpLastCheckedAt` (rate limit de consulta), `PlatformSettings.lastMpWebhookAt/lastMpWebhookResult/lastMpWebhookRejectedAt/lastMpWebhookRejection` (JSON pequeno, sem corpo/segredo).

**`reconcileInvoicePayment(invoiceId, { source, minIntervalMs?, now?, gateway?, resolveGateway? })`** (`src/modules/billing/reconcile.ts`) devolve `{ status }`: `paid` (com `environment`) | `already_paid` | `pending` (`mpStatus`) | `payment_failed` (`mpStatus`: rejected/cancelled/expired/refunded/charged_back — nunca baixa) | `voided_invoice_paid` | `throttled` | `no_payment` | `not_open` | `error` (`code`: `NOT_CONFIGURED` | `MP_UNAVAILABLE` | `PAYMENT_MISMATCH`). Usa as credenciais de `Invoice.mpEnvironment`; legado tenta o ativo e depois o outro (e grava o descoberto). Confere `external_reference === invoice.id`. Baixa via `applyInvoicePayment` (idempotente/race-safe). Auditoria: `ProviderEvent(provider="mercadopago-reconcile", providerEventId=<paymentId>, payload.source)`.

**Server Actions**
- `checkMyInvoicePaymentAction({ tenantSlug }): Result<{ status: "paid" | "pending" | "throttled" | "payment_failed" | "no_open_invoice" | "unavailable" }>` — qualquer membro do tenant; localiza a fatura `OPEN` com `mpPaymentId` da própria empresa; limite de 1 consulta ao MP / 5s por fatura (banco). A tela Assinatura chama a cada ~9s com a aba visível, por até 15 min, e ao receber `paid` mostra "Pagamento confirmado!" (`data-testid="assinatura-pagamento-confirmado"`) e faz `router.refresh()`.
- `reconcileInvoiceAdminAction(invoiceId): Result<ReconcileOutcome>` — só admin da plataforma, sem rate limit; botão "Conferir no Mercado Pago" (aria-label `Conferir no Mercado Pago a fatura de <empresa>`) em Admin → Cobrança, visível para fatura `OPEN` com `hasMpPayment`.
- `AdminInvoiceListItem.hasMpPayment: boolean` (novo).

**`billing/tick`:** primeiro passo concilia as faturas `OPEN` com `mpPaymentId` (lote de 50, as consultadas há mais tempo primeiro); resumo ganhou `invoicesReconciledPaid`.

**Diagnóstico do webhook** (`webhook-diagnostics.ts`): `lastMpWebhookResult = { outcome: processed|already_processed|ignored|rejected, reason?, environment, type }`; `lastMpWebhookRejection = { reason, environment, type }` com `reason` em `missing_signature | malformed_signature | bad_signature | stale_timestamp | no_secret_for_env | wrong_environment_secret | ignored_type | missing_data_id`. `wrong_environment_secret` = assinatura válida com a chave do OUTRO ambiente. Escrita de rejeição com throttle de 2s (endpoint público); log estruturado `billing.webhook.rejected` sempre. `PlatformHealth.mercadoPagoWebhook = { lastReceivedAt, lastOutcome, lastRejectedAt, lastRejectionReason, activeEnvironment }`, exibido em Admin → Saúde (`data-testid="saude-webhook-mp"`), com alerta quando o último foi rejeitado.

Testes: `tests/integration/billing-reconcile.integration.test.ts`, `src/modules/billing/mercadopago.test.ts` (`explainMercadoPagoSignature`).

## Histórico de conversas do WhatsApp (2026-09-29, pedido do dono)

Model `ChatMessage` (`direction` INBOUND/OUTBOUND, `body`, `providerMessageId?`, `@@unique([tenantId, providerMessageId])`); acesso via `forTenant().chatMessage`. **Retenção: 90 dias** (política de privacidade e Termos atualizados; `TERMS_VERSION` agora `2026-09-29`).

### Gravação (`src/modules/conversations/log.ts`) — nunca derruba o fluxo do bot
- **Entrada (INBOUND):** em `claimMessage`, logo depois de adquirir a trava e ANTES das checagens de ignorar — grava toda mensagem do cliente, inclusive as que o bot vai ignorar (`BOT_PAUSED`, `HUMAN_MODE`, `TENANT_SUSPENDED`, `STALE`). Texto = o texto; mídia = placeholder (`[imagem]`, `[áudio]`, `[vídeo]`, `[documento]`, `[figurinha]`, `[contato]`, `[localização]`, `[mídia]`), sem binário nem legenda (`NormalizedMessageContent.media` ganhou `label`; o `message` devolvido ao n8n segue `{ type: "media" }`). Dedup por `providerMessageId` (P2002 absorvido; o `InboundEvent` já barra a maioria antes). `busy` não grava (o n8n reenvia e grava na tentativa seguinte).
- **`fromMe` que NÃO é eco do bot** (a empresa digitou no celular) vira OUTBOUND, com `providerMessageId`. Eco do bot (`FROM_ME_ECHO`) não é gravado (a saída do bot já entrou pelo PUT abaixo).
- **Saída do bot (OUTBOUND) — SEM mudança no n8n.** Escolhida a opção (b): `PUT /sessions/{id}` já recebe `outbound: string[]` (o texto exato enviado; o nó "Montar mensagem" põe `save.outbound = [message]`) e é chamado ANTES tanto do nó "Enviar pela Evolution" quanto do desvio "Sandbox? → /sandbox/outbox". `updateSession` grava uma linha por texto, na ordem (`createdAt` +1ms por item), depois de validar a trava: `LOCK_LOST` não grava nada (a mensagem não sai). Por que (b) e não (a)/(c): (a) exigiria mexer no n8n e adicionaria um ponto novo de falha/latência/`continueOnFail`; (c) chega sem o texto normalizado e não distingue eco. Trade-off aceito: o registro acontece na gravação da sessão, antes do envio — se a Evolution falhar depois, a mensagem consta como enviada (mesma premissa que o `recentOutbound`/eco já usa). **Sandbox** também é coberto por este mesmo PUT; por isso `/sandbox/outbox` NÃO grava (duplicaria).
- **Não existe** o endpoint `POST /messages/outbound` (não foi necessário).

### Leitura — `getConversationAction` (`src/modules/conversations/actions.ts`)
`getConversationAction({ tenantSlug, contactId, cursor? })` → `Result<{ items: Array<{ id, direction: "INBOUND"|"OUTBOUND", body, createdAt: string(ISO), instanceLabel: string|null }>, nextCursor: string|null }>`. `requireTenantMember` (OWNER e STAFF), sem `assertTenantCanWrite`. Página de 50: dentro da página as **mais antigas em cima e as mais novas embaixo**; `nextCursor` (opaco) aponta para a mais antiga carregada, e a página seguinte traz as anteriores. Erros: `NOT_FOUND` (cliente de outra empresa/inexistente, ou não é membro), `INVALID_CURSOR`, `UNAUTHENTICATED`. Cliente anonimizado/excluído devolve lista vazia/NOT_FOUND (mensagens apagadas).

### Retenção / LGPD
- `maintenance/tick`: apaga `ChatMessage` com mais de 90 dias em lotes de 5000 (até 20 lotes por chamada), isolado por try/catch (falha só gera `logger.warn`). Summary ganhou `chatMessagesPurged` (aditivo). Também purga `PlatformNotificationRead` com mais de 45 dias.
- Anonimização de contato de empresa cancelada há > 90 dias e `deleteContact` (tela Clientes, modos "deleted" e "anonymized") **apagam as mensagens do contato**.
- Logs: nunca o texto da mensagem (`logger.warn` só com ids/tipo do erro).

## Central de notificações do admin da plataforma (2026-09-29)

`src/modules/platform-notifications/{actions,service,types}.ts` — mesmo desenho da central do tenant: **derivada** do estado (sem tabela), janela de 30 dias, ids estáveis, leitura por usuário (`PlatformNotificationRead` para uma; `User.platformNotificationsReadAllAt` para "todas": tudo com `createdAt <=`). Todas as actions começam com `requirePlatformAdmin` (sem sessão → `UNAUTHENTICATED`; não-admin → `FORBIDDEN`).

- `listPlatformNotificationsAction({ cursor? })` → `{ items: AdminNotification[] (20/página, mais novas primeiro), unreadCount, nextCursor }`
- `pollPlatformNotificationsAction({ since })` → `{ unreadCount, fresh: AdminNotification[] (só createdAt > since, máx. 10) }`
- `markPlatformNotificationsReadAction({ ids?, all? })` → `{ unreadCount }` (idempotente; sem ids/all → `INVALID_PAYLOAD`; ids devem casar `^(signup|pay|susp|cancel|trial|wa|mpwh|tick):...`).
- `AdminNotification = { id, kind, severity: "info"|"success"|"warning"|"danger", title, body, href: string|null, createdAt: string, read: boolean, tenant?: { id, name, slug } }`

| kind | severity | origem / id | href |
|---|---|---|---|
| `TENANT_SIGNED_UP` | info | `Tenant.createdAt` · `signup:<tenantId>` | `/admin/empresas` |
| `PAYMENT_RECEIVED` | success | `Invoice PAID`, `paidAt`, corpo com o valor · `pay:<invoiceId>` | `/admin/cobranca` |
| `TENANT_SUSPENDED` | warning | assinatura `SUSPENDED`; `createdAt = currentPeriodEnd + GRACE_DAYS` (não há coluna de suspensão) · `susp:<subId>:<periodEndMs>` | `/admin/empresas` |
| `TENANT_CANCELED` | danger | `Subscription.canceledAt` · `cancel:<subId>:<ms>` | `/admin/empresas` |
| `TRIAL_ENDING` | warning | `TRIALING` com `trialEndsAt` em ≤ 24h · `trial:<subId>` | `/admin/empresas` |
| `WHATSAPP_DISCONNECTED` | danger | instância real (não sandbox/removida) com `disconnectedAt` · `wa:<instId>:<ms>` | `/admin/saude` |
| `MP_WEBHOOK_REJECTED` | danger | `PlatformSettings.lastMpWebhookRejectedAt` (+ motivo) · `mpwh:<ms>` | `/admin/saude` |
| `TICK_LATE` | warning | billing > 2h / maintenance > 26h (regra da Saúde); fora da janela de 30 dias (vale enquanto atrasado); nunca rodou ancora na empresa mais antiga · `tick:<job>:<lastRunMs\|never>` | `/admin/saude` |

Poll barato: 1 leitura do usuário + 1 consulta pequena por fonte (cap 100, filtrada por `max(janela, min(since, readAllAt))`) + 1 leitura de reads; sem N+1. Testes: `tests/integration/platform-notifications.integration.test.ts`, `tests/integration/conversations.integration.test.ts`.


## Lembrete de véspera ao cliente final (WhatsApp) — 2026-09-29

**Job** `runReminderTick(now)` (`src/modules/reminders/tick.ts`), chamado no FIM de `runBillingTick` (mesma rota `POST /api/internal/v1/billing/tick`, n8n horário; nada muda no n8n). Falha do lembrete é isolada (`try/catch`): nunca derruba a cobrança. O summary do tick ganhou `remindersToClientsSent: number`.

- **Seleção:** `Appointment` `SCHEDULED`, `reminderSentAt` nulo, `now+2h < startsAt <= now+reminderHoursBefore`; empresa com `reminderEnabled`, assinatura efetiva não SUSPENDED/CANCELED, com instância `CONNECTED` e `sandbox=false` (a do agendamento; se caiu, a primeira conectada da empresa); contato com `waJid @s.whatsapp.net` (ou `phoneE164`) e bot NÃO pausado (`Contact.botPausedUntil` vencido/nulo e nenhuma `ChatSession.humanUntil` no futuro). Lote de 100 por rodada, mais próximos primeiro.
- **Silêncio:** só envia com a hora local da empresa em [08:00, 21:00). Fora disso espera o tick seguinte dentro da janela (a condição "> 2h" é reavaliada).
- **Idempotência:** reserva com `updateMany` condicional (`reminderSentAt` nulo -> `now`, reconferindo status/horário) ANTES de enviar. Falha no envio: rollback para nulo (só se ainda for a nossa reserva). Tentativas contadas EM MEMÓRIA (2 por agendamento por processo; sem coluna no schema) — teto natural: some da seleção quando faltar < 2h.
- **Remarcar zera `reminderSentAt`:** `rescheduleAppointment` (`src/modules/agenda/appointments.ts`) e é a função única usada por painel, arrastar e bot/API interna.
- **Envio:** `EvolutionClient.sendText(instanceName, number, text)` -> `POST /message/sendText/{instance}` `{ number, text }` (UMA tentativa, sem retry — reenviar após timeout duplicaria a mensagem). O eco `fromMe` do lembrete é registrado em `ChatSession.recentOutbound` ANTES do envio (senão o `claim` o trataria como "humano assumiu" e pausaria o bot do cliente, quebrando o "responda *menu*"). Grava `ChatMessage` OUTBOUND (com `providerMessageId` quando a Evolution devolve). Nenhum `AppointmentEvent` (não há action equivalente).
- **Texto:** `BotText REMINDER` da empresa ou o padrão. Variáveis: `{nome}` (primeiro nome, "cliente" se vazio) `{empresa}` `{servico}` `{profissional}` `{data}` (ex. "Sex 02/10", como o resto do bot) `{hora}` e NOVA `{quando}` ("hoje", "amanhã" ou "sábado, 03/10"). `quando` entrou em `BOT_TEXT_VARIABLES` (tela "Mensagens do bot" aceita). Padrão: `Olá, {nome}! Lembrete: você tem {servico} com {profissional} {quando} às {hora}.
Para remarcar ou cancelar, responda *menu*.` — "menu" foi conferido no workflow (`n8n/innochat-bot.json`, nó de roteamento: `t === '0' || t === 'menu'` volta ao menu principal; sessão expirada/inexistente também abre o menu).

### Actions (`src/modules/reminders/actions.ts`) — objeto único de entrada, retorno `Result<T>`
- `getReminderSettingsAction({ tenantSlug })` -> `{ enabled: boolean, hoursBefore: number }`. Qualquer membro.
- `updateReminderSettingsAction({ tenantSlug, enabled, hoursBefore })` -> mesma forma. **OWNER** (STAFF: `FORBIDDEN`); `assertTenantCanWrite` (suspensa: `TENANT_SUSPENDED`). `hoursBefore` inteiro 2..48, `enabled` booleano; senão `INVALID_PAYLOAD`.

## Nome do usuário (`User.name`) — 2026-09-29

- `signUpAction`: campo **`name`** obrigatório (trim, 2 a 80), grava `User.name`. O antigo `ownerName` continua aceito como alias (transição). Inválido: `INVALID_PAYLOAD`, nada é criado.
- `acceptInviteAction({ token, password, name })`: `name` obrigatório (2-80); sem nome válido o convite NÃO é consumido.
- `installPlatformAdminAction`: `name` OPCIONAL (vazio = sem nome; senão 2-80), agora persistido.
- `getMyAccountAction()` -> `{ name: string | null, email: string }`; `updateMyAccountAction({ name })` -> mesma forma (`src/modules/auth/account-actions.ts`). Qualquer usuário logado; o id vem da sessão (só o próprio). Sem sessão: `UNAUTHENTICATED`.
- `verifyCredentials` devolve `name` (fica no `user` do Auth.js; a sessão JWT NÃO é atualizada ao editar o perfil — telas leem o nome do banco).
- **Onde o nome já é preferido ao e-mail (backend):** `authorLabel`/`label` da timeline (`getAppointmentTimeline`): `name` -> parte local do e-mail -> "Equipe". As notificações do painel não exibem autor (só `byMe`). Saudação/sidebar: dado fornecido pelo layout/loaders; o visual é da Lyra.

## Extras da tela WhatsApp — 2026-09-29

`getWhatsappPageExtrasAction({ tenantSlug })` (`src/modules/whatsapp/actions.ts`, qualquer membro) -> `{ maxNumbers: number | null, usedNumbers: number, welcomePreview: { greeting: string, menu: string } }`.
- `maxNumbers`: override da empresa > limite do plano; `null` = ilimitado (na prática, só empresa sem assinatura). `usedNumbers`: instâncias com `deletedAt` nulo.
- `welcomePreview`: `GREETING` e `MAIN_MENU` da empresa (ou padrão) com `{nome}` = "Maria" e `{empresa}` = nome da empresa.

## Login com Google (2026-09-30, pedido do dono)

**Regra fixa do dono:** nenhuma credencial em env var nem no chat. O Client ID e o Client Secret do Google são cadastrados em **Admin → Configurações**; o secret fica cifrado (`enc:v1:`, `src/lib/crypto.ts`), igual ao Mercado Pago. No Easypanel continuam só `DATABASE_URL` e `AUTH_SECRET`.

### Schema (migration aditiva `20261001000000_login_google`)
- `PlatformSettings`: `googleAuthEnabled Boolean @default(false)`, `googleClientId String?`, `googleClientSecretEnc String?`.
- `User.googleSub String? @unique` (`sub` estável do Google).
- `User.passwordHash` passou a **opcional** (`DROP NOT NULL`, compatível com a versão antiga no ar): conta criada só pelo Google não tem senha. `null` nunca vira string vazia.

### Auth.js (`src/lib/auth.ts`) — forma lazy
`NextAuth(async () => config)`: o provedor Google é montado a cada requisição a partir do banco (cache de 30 s em `getGoogleRuntimeCredentials`, invalidado ao salvar). Só entra com `googleAuthEnabled` ligado + Client ID + secret que **decifram** (fail-closed; falha de banco = só e-mail/senha). Sessão JWT e token `{ userId }` idênticos aos de antes. `trustHost: true`; o retorno é `<origem pública>/api/auth/callback/google` (mesma origem de `getPublicBaseUrl()`, via `x-forwarded-*`). `checks: ["pkce","state","nonce"]` **explícitos** (o padrão do Auth.js para este provedor é só PKCE). `pages.error = "/login"`: recusas voltam como `/login?error=AccessDenied`.

### Callback `signIn` (`src/modules/google-auth/signin.ts#resolveGoogleSignIn`)
1. `email_verified` precisa ser `true`; senão recusa (`AccessDenied`).
2. Busca por `googleSub`; senão por e-mail — e nesse caso **vincula** (`googleSub`, `emailVerifiedAt` se nulo, nome se vazio). Se o e-mail estava **não verificado**, a senha da conta é descartada (defesa contra pre-hijacking: alguém cadastra o e-mail da vítima com senha própria). E-mail ligado a **outra** conta Google: recusa.
3. **`isPlatformAdmin` nunca entra pelo Google** (por `sub` ou por e-mail): recusa (`AccessDenied`). Decisão de segurança: o admin controla todas as empresas, então fica só com e-mail+senha. Reverter só por pedido explícito do dono.
4. Sem usuário nenhum: **não cria nada**; assina um token (HMAC-SHA256 com chave derivada do `AUTH_SECRET` + finalidade, 15 min, `{ email, name, sub }`) e redireciona para `/cadastro/google?t=<token>`.
5. `jwt`: para o Google, o `userId` sai de `User.googleSub` (o `user.id` do provedor é o `sub`, não o nosso id).

Código que a tela de login recebe em `?error=`: `AccessDenied` (e-mail não verificado, admin, conta Google diferente, convite com e-mail diferente) e os genéricos do Auth.js.

### Login por senha de conta só-Google
`verifyCredentials` lança `DomainError("GOOGLE_ONLY_ACCOUNT")` (só depois dos dois tetos de rate limit e sem bcrypt); `authorize()` converte em `CredentialsSignin` com `code = "google_account"`; `loginAction` responde **"Esta conta usa login com Google. Entre com o Google, ou use “Esqueci minha senha” para definir uma senha."**. "Esqueci a senha" → `resetPassword` grava `passwordHash` (a conta passa a ter os dois modos; `googleSub` permanece).

### Server Actions
Públicas (`src/modules/signup/actions.ts`):
- `getGoogleSignUpPrefillAction({ token })` → `Result<{ email, name }>`. Erros: `TOKEN_INVALID`, `TOKEN_EXPIRED`, `ALREADY_REGISTERED` (já existe conta com esse Google/e-mail: a tela manda entrar com o Google).
- `completeGoogleSignUpAction({ token, tenantName, document, phone?, planCode?, acceptTerms })` → `Result<{ redirectTo: "/pos-login" }>`. Cria empresa + usuário (sem senha, e-mail **já verificado**, sem e-mail de verificação) + Membership OWNER + trial + 1ª fatura pelo **mesmo** `createAccount` do `signUp` (`src/modules/signup/service.ts`); o endereço (slug) é derivado do nome da empresa (sufixo `-2`, `-3`… se já existir). `planCode` é **opcional**: sem ele vale `getDefaultSignupPlan` (igual ao cadastro normal); com ele precisa ser um plano **ativo** (`INVALID_PLAN`). `phone` é validado (10–13 dígitos) mas **ainda não é gravado** (não há coluna; o cadastro por senha também não pede). Termos: grava `TERMS_VERSION` do servidor. Depois autentica com o provedor interno `google-signup` (prova assinada de 60 s gerada e consumida na própria action; nunca vai ao cliente). Erros: `TOKEN_INVALID`, `TOKEN_EXPIRED`, `ALREADY_REGISTERED`, `INVALID_DOCUMENT`, `INVALID_PLAN`, `INVALID_PAYLOAD`, `RATE_LIMITED` (5/h por IP **e** 5/h por `sub`).
- **Uso único do token:** amarrado ao `sub`. Depois do cadastro o `googleSub` existe, então repetir o token cai em `ALREADY_REGISTERED`; corrida entre duas requisições cai na unicidade do banco (uma só conta). O token **nunca** abre sessão por si (só o cadastro recém-feito, na mesma action).
- `getPublicAuthOptions()` (`src/modules/auth/public-options.ts`, função de servidor, sem login) → `{ google: boolean }`.

Admin (`src/modules/platform/actions.ts`, `requirePlatformAdmin`; **nunca** devolvem o secret):
- `getGoogleAuthConfigAction()` → `{ enabled, clientId: string|null, clientSecretSaved, redirectUri, origin }` (`redirectUri` = `<origem>/api/auth/callback/google`; `clientSecretSaved` só é `true` se o secret **decifra**).
- `saveGoogleAuthConfigAction({ enabled?, clientId?, clientSecret? })` → mesma view. Secret/ID vazio = mantém o atual. Erros: `INVALID_GOOGLE_CLIENT_ID` (precisa terminar em `.apps.googleusercontent.com`), `GOOGLE_CONFIG_INCOMPLETE` (ligar sem ID ou sem secret).
- `removeGoogleClientSecretAction()` → view; apaga o secret **e desliga** o login com Google.
- `testGoogleAuthConfigAction()` → `{ ok, detalhe, checks: { clientIdFormat, secretDecrypts } }`. **Não valida contra o Google** (só o fluxo OAuth real faz isso): confere o formato do ID e se o secret decifra. O teste real é clicar em "Entrar com Google".

### Convite de equipe com Google (mecânica)
`startGoogleInviteSignInAction({ token })` (`src/modules/google-auth/actions.ts`): valida o convite **sem consumir**, grava o token num cookie **httpOnly, SameSite=Lax, 15 min** (`innochat_google_invite`) e chama `signIn("google")` (redireciona; só devolve `Result` de erro `TOKEN_INVALID`). No callback `signIn` o cookie é lido e apagado e `acceptInviteWithGoogle` (`signup/service.ts`) exige que o e-mail do Google seja o do convite (`INVITE_EMAIL_MISMATCH` → recusa **sem** consumir o convite), vincula `googleSub`, verifica o e-mail e consome o token (uso único). A conta fica só-Google (a senha provisória do convite é descartada; quem já tinha e-mail verificado mantém a própria). O token nunca passa pelo Google nem pela URL. Sem o cookie, quem entra pelo Google com o e-mail do convite também entra (o vínculo por e-mail vale), só não consome o token (expira sozinho).

### CSP
`form-action` passou a incluir `https://accounts.google.com` (o botão é um formulário cuja resposta redireciona ao Google).

### Revisão de segurança do login com Google (2026-09-30, correções do Órion)
- **Revogação de sessão (I1):** `User.sessionVersion Int @default(0)` (migration aditiva `20261001100000_user_session_version`). O JWT carrega `sv`; o callback `jwt` confere com o banco (cache de memória de 5 s; login lê fresco) e devolve `null` (deslogado) se diferir. Incrementa em: vínculo Google por e-mail / convite Google em conta **não verificada**, `resetPassword` e `signOutEverywhere(userId)` (`src/modules/auth/session-version.ts`, sem tela ainda). Token antigo sem `sv` conta como 0. JWT: `maxAge` 30 dias, `updateAge` 24 h. Suposição: em multi-instância a revogação leva até 5 s para valer nas outras.
- **Convite Google atômico (I2):** claim do convite + `update` do usuário na mesma `$transaction`; `sub` já ligado a outro usuário (checado antes e por P2002) → `GOOGLE_ACCOUNT_MISMATCH` e o convite **não** é consumido.
- **URL base confiável (I3):** `PlatformSettings.publicBaseUrl` tem prioridade absoluta em `getPublicBaseUrl()` (links de e-mail) e fixa `AUTH_URL` do Auth.js (`redirect_uri`, cookies `__Secure-`). `x-forwarded-*`/`host` só valem como fallback **enquanto não há base gravada** (instalação), validados (host DNS, http/https). `ensurePublicBaseUrlFromCurrentRequest` agora só **preenche se vazia**; se a requisição do admin vier de outro host apenas loga `public_url.host_differs`. Trocar a base: `setPublicBaseUrlAction({ baseUrl })` (admin da plataforma; só origem https; erro `INVALID_PAYLOAD`) — **sem tela ainda**. Um `AUTH_URL` definido pelo operador no processo (dev/E2E) tem prioridade e nunca é sobrescrito. `trustHost` só é ligado na janela de instalação.
- **Token de cadastro (S1):** TTL 10 min; além do `?t=`, o callback grava o cookie httpOnly `innochat_google_signup` (SHA-256 do token, SameSite=Lax, Secure em produção, 10 min). `getGoogleSignUpPrefillAction` e `completeGoogleSignUpAction` exigem que bata (`TOKEN_INVALID` senão).
- **Cookie de convite (S2):** apagado em `signInWithGoogleAction` e lido+apagado no callback (sucesso ou falha).
- **IP do cliente (S4):** `clientIp()` usa o ÚLTIMO valor do `X-Forwarded-For` (1 proxy confiável = Traefik do Easypanel, `TRUSTED_PROXY_HOPS`), valida com `isIP`, fallback `X-Real-IP`, depois `"unknown"`.

## Bot v2 — versão do fluxo na API interna (`X-InnoChat-Flow`)

- **Quem manda o quê:** o workflow v2 envia `X-InnoChat-Flow: 2` em TODOS os nós HTTP do painel. O v1 (o que roda em produção até o "Publicar fluxo") NÃO manda o header. Só o valor exato `2` liga o v2 (`flowVersionOf`, `src/modules/bot-api/flow-version.ts`); ausente, vazio, `1` ou lixo = v1.
- **`POST /messages/claim` sem o header = formato v1 congelado:** mesmas chaves de antes da B-2 (`action, inboundEventId, instance, to, message, contact{id,name,pushName}, session{id,state,context,invalidCount,version,lockToken,expired}, tenant{name,askProfessional,timezone}, texts`), **sem `flow`**, sem `contact.firstName`, `session.previous/resumedFromHuman` e `tenant.today/nowLocal/...`, e `texts` só com as 34 chaves do catálogo v1 (`MAIN_MENU` numerado). Com o header: `flow: 2` e o catálogo v2. Teste que congela: `tests/integration/bot-api-claim-v1-freeze.integration.test.ts`.
- **`tenant.lastBookableDate` (v2)** sai da mesma função de `/availability/days` (`lastBookableISO`: hoje + `maxHorizonDays` − 1), então os dois nunca divergem.
- **Mudanças de COMPORTAMENTO que o v1 recebe depois da B-2 (conscientes, aceitas pelo dono; o v2 é publicado logo depois do deploy):**
  - o `release` de uma execução que falhou avisa o cliente (`TECH_ERROR`);
  - pedido de atendente feito pelo v1 cria `HandoffRequest` com motivo `LEGACY_FLOW` (aparece no sino do painel);
  - quando o prazo do atendente vence sem "menu", a próxima mensagem já é de sessão nova (`resumedFromHuman: "TIMEOUT"` só no v2; no v1 a sessão é reiniciada sem o campo).
  O que NÃO muda é o formato das respostas.
- **Segredos no fluxo (I4):** o snapshot de rollback (`previous`) e o download do fluxo vivo passam por `redactFlowSecrets` (`n8n-flow-hash.ts`): valores de `Authorization`, `apikey`, `x-api-key`, `Bearer …` e JWT `eyJ…` literais viram `[REDACTED]`. Expressões do n8n (`={{ … }}`) ficam. Rollback de um fluxo que tinha token colado à mão restaura com o placeholder (reponha o token no n8n).
- **Entrada do cliente (I1/S2):** `normalizeText` corta em 4000 caracteres e apara a pontuação final com laço linear (sem ReDoS); `validateName` remove bidi/zero-width e recusa nome que comece com `=`, `+`, `-` ou `@`.

## Atendimento humano pelo painel + aviso ao cliente nas mudanças da equipe (2026-09-30, pedido do dono)

Schema (migration `a6dbff6`): `Tenant.notifyClientOnStaffChanges` (default `true`), `ChatMessage.authorUserId` (`authorUser`), textos v2 `STAFF_BOOKED`, `STAFF_RESCHEDULED`, `STAFF_CANCELED`, `HANDOFF_CLOSED` (lidos por `getMergedBotTexts(tenantId, 2)`).

### Actions (`src/modules/attendance/actions.ts`) — `requireTenantMember` (OWNER e STAFF), retorno `Result<T>`
- `listAttendanceQueueAction({ tenantSlug })` → `{ items: AttendanceQueueItem[]; waitingCount }`. Item: `{ contactId, contactName, handoffId|null, status: "WAITING"|"IN_PROGRESS"|"RECENT", requestedAt|null, offHours, lastMessage: { body (até 200 caracteres), direction, author: "CLIENT"|"BOT"|"AGENT", createdAt }|null, botPausedUntil|null }`. Um item por cliente (vence o mais urgente). `WAITING` = pedido aberto sem resposta; `IN_PROGRESS` = pedido aberto já respondido OU sessão em modo humano (`humanUntil` no futuro, ex.: equipe puxou a conversa); `RECENT` = encerrado nas últimas 24h. Ordem: WAITING (mais antigo primeiro), IN_PROGRESS e RECENT (atividade mais recente primeiro). Limites: até 100 ativos + 50 recentes. Nunca devolve telefone/JID. Leitura: funciona com a conta suspensa.
- `getAttendanceConversationAction({ tenantSlug, contactId, cursor? })` → mesmo formato de `getConversationAction`. **Aditivo em ambas:** cada item ganhou `author: "CLIENT"|"BOT"|"AGENT"` (INBOUND = CLIENT; OUTBOUND com `authorUserId` = AGENT; demais OUTBOUND = BOT) e `authorName` (nome do atendente; "Atendente" se o usuário não tem nome; `null` se não for AGENT).
- `sendAgentMessageAction({ tenantSlug, contactId, text })` → `{ message: ConversationItem }`. Exige conta ativa (`TENANT_SUSPENDED`). O texto é aparado (trim). Fluxo: valida, limita, escolhe a instância (a do pedido aberto; senão a última usada; senão a primeira CONNECTED não sandbox), **registra o eco (`registerOutboundEcho`) antes**, envia pela Evolution, grava `ChatMessage` OUTBOUND com `authorUserId`, marca `HandoffRequest.answeredAt` (1ª resposta) e estende a pausa por `Tenant.handoffResumeMinutes`. Com pedido aberto: pausa da sessão (mesma mecânica do fromMe pelo celular). Sem pedido (equipe puxou): pausa a sessão E `Contact.botPausedUntil`. Nunca encurta pausa maior já existente. Se a pausa falhar depois de enviar, loga e devolve sucesso (a mensagem já saiu).
  - Erros: `TEXT_EMPTY`, `TEXT_TOO_LONG` (>4096), `RATE_LIMITED` (20/min por usuário, em memória, `details.retryAfterMs`), `CONTACT_HAS_NO_PHONE`, `WHATSAPP_NOT_CONNECTED` (nenhuma instância CONNECTED não sandbox, ou Evolution sem configuração), `TENANT_SUSPENDED`, `NOT_FOUND` (contato de outra empresa). **Extras além do combinado:** `CONVERSATION_BUSY` (o bot está no meio da resposta e a trava não liberou em ~1 s; nada foi enviado, tentar de novo) e `SEND_FAILED` (a Evolution recusou/caiu; nada foi gravado).
  - Histórico grava no máximo 4000 caracteres (`CHAT_BODY_MAX`), mesmo aceitando 4096 no envio.
- `closeAttendanceAction({ tenantSlug, contactId })` → `{ closed: true, clientNotified }`. Exige conta ativa. Fecha o pedido aberto com `endReason: "PANEL_RESUME"` (mesmo valor do "Retomar bot"; nenhum outro do enum descreve "equipe encerrou" e não há migration nova), zera `Contact.botPausedUntil` e o `humanUntil` das sessões (volta a `MAIN_MENU`) e manda `HANDOFF_CLOSED` (com `{nome}` e `{empresa}`, eco e `ChatMessage` sem autor). **Idempotente:** sem pedido aberto nem pausa ativa não muda nada e devolve `clientNotified: false`; dois cliques simultâneos avisam uma vez só (trocas por `updateMany` condicional). Falha no aviso não desfaz o encerramento (`clientNotified: false`).
- **Badge do menu:** `listNotificationsAction` e `pollNotificationsAction` passam a devolver `attendanceWaitingCount: number` = pedidos abertos ainda sem resposta da equipe (`endedAt` e `answeredAt` nulos). Uma consulta `count` a mais por poll.

### Aviso ao cliente (`src/modules/agenda/staff-notify.ts`, chamado por `src/modules/agenda/appointment-actions.ts`)
- `createAppointmentAction`, `rescheduleAppointmentAction` (inclui o arrastar) e `cancelAppointmentAction` passam a devolver, **junto do resultado de antes**, o campo aditivo `clientNotification: "SENT"|"DISABLED"|"NO_WHATSAPP"|"NO_PHONE"|"FAILED"`. Criar devolve `{ appointment, alreadyExisted, clientNotification }`; remarcar e cancelar devolvem a linha do agendamento + `clientNotification`.
- Depois do commit, se `Tenant.notifyClientOnStaffChanges` estiver ligado, envia `STAFF_BOOKED` / `STAFF_RESCHEDULED` / `STAFF_CANCELED` com `nome` (primeiro nome), `empresa`, `servico`, `profissional`, `data`, `hora`, `quando` (`whenLabel`, o mesmo do lembrete). Eco registrado antes e `ChatMessage` gravado, sem autor e **sem pausar o bot**.
- `DISABLED` = toggle desligado **ou** nada mudou (repetição idempotente de criar; cancelar algo já cancelado; remarcar para o mesmo horário). `NO_PHONE` = cliente sem telefone. `NO_WHATSAPP` = sem instância CONNECTED não sandbox (ou Evolution sem configuração). `FAILED` = envio recusado, bot ocupado (`BUSY`) ou erro inesperado (logado sem o corpo). **Nunca** bloqueia nem desfaz a operação de agenda.
- Concluir, "faltou" e reabrir **não** avisam. O bot e a API interna (`/api/internal/v1/appointments/*`) também não usam este caminho.
- `cancelAppointment` ganhou `cancelAppointmentDetailed` (`{ appointment, changed }`) e a troca de status passou a ser condicional (`status != CANCELED`): dois cancelamentos simultâneos geram um único evento e um único aviso.

### Configurações (`src/modules/tenant`)
- `getBotRulesAction` e `updateBotRulesAction` incluem `notifyClientOnStaffChanges: boolean`. Escrita só `OWNER`; no update o campo é opcional (omitido = não altera; não-booleano = `INVALID_PAYLOAD`).
