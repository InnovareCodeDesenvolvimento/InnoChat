# Arquitetura — InnoChat

Documento de referência da squad. O que está aqui são decisões, não sugestões, e vale até ser
mudado **aqui**. Quem discordar (Vega, Lyra, Cronos, Íris, Órion, Vulcano) leva a objeção ao
Atlas em vez de implementar diferente em silêncio.

- **v1:** Nova, 2026-09-28.
- **v2:** Nova, 2026-09-28, depois das decisões do dono sobre a §13. Mudanças: o motor do menu
  passou para os nós do n8n, o painel expõe endpoints granulares, e entraram cadastro público e
  cobrança na v1.

Base: decisões do dono (`PROGRESSO.md`) e lições do InnoAtendente
(`C:\Projetos\Web\InnoAtendente\docs\arquitetura.md`, `prisma/schema.prisma`, `PROGRESSO.md`).

---

## 0. Contexto e hipóteses declaradas

| Item | Hipótese | Efeito na arquitetura |
|---|---|---|
| Maturidade | **MVP comercial**: cadastro público e assinatura paga já na v1 | Cobrança, trial e bloqueio fazem parte do núcleo, não de uma "fase SaaS" posterior |
| Mercado | **Brasil, em BRL** (Pix) | Um gateway só; LATAM ou cartão internacional ficam para depois |
| Escala (1º ano) | 1 a 100 empresas, até ~3 números cada, centenas de mensagens/dia por empresa | Postgres único dá conta; n8n com execução padrão aguenta |
| Equipe | Squad de agentes + dono como operador, que **edita o fluxo do bot no n8n** | O fluxo precisa ser legível e testável fora do código |
| Prazo | Não informado; assumido "semanas" | Plano em fases entregáveis (§11) |
| Infra | VPS do dono com Easypanel; Evolution **compartilhada com o InnoAtendente**; n8n do dono (via MCP) | Prefixo próprio nas instâncias; o n8n é peça central, não acessória |

---

## 1. Stack

| | **A. Next.js App Router + Prisma/Postgres + Auth.js v5 + Tailwind v4** | B. API separada (Fastify/Nest) + SPA React | C. Painel low-code (NocoDB/Appsmith) + n8n |
|---|---|---|---|
| Prós | Mesma stack do InnoAtendente (padrões e armadilhas conhecidos). Um processo serve painel, API interna e webhook de pagamento | Separação forte front/back | Protótipo rápido |
| Contras | Front e back no mesmo deploy (aceitável nesta escala) | Dois deploys, CORS, autenticação duplicada, sem ganho real | Não dá para ter cadastro público, cobrança, isolamento entre empresas e o fluxo de QR com a robustez pedida |
| Veredito | **Recomendada** | Descartada | Descartada |

**Stack fechada:**
- **Next.js (App Router) + TypeScript strict**: painel, API interna para o n8n (`/api/internal/v1/*`) e webhook do Mercado Pago.
- **Prisma + PostgreSQL** (serviço gerenciado do Easypanel, **banco próprio**).
- **Auth.js v5** (credenciais, bcrypt, JWT).
- **Tailwind v4** + Radix/shadcn.
- **zod** nas bordas (gera o OpenAPI da API interna, §6.8).
- **date-fns + date-fns-tz**.
- **Vitest** (Postgres real no CI) + **Playwright**.
- **E-mail transacional** (verificação de conta, redefinição de senha, cobrança): **SMTP próprio
  do dono** (decidido em 2026-09-28), via nodemailer, com host, porta, usuário, senha e remetente
  em `PlatformSettings` (senha mascarada na UI, como a chave da Evolution).
- **Sem Redis e sem worker.** O que é agendado (geração de faturas, e depois lembretes) é
  disparado por um **Schedule do n8n** chamando um endpoint idempotente do painel. Como segunda
  rede, o status da assinatura é calculado sob demanda (§7.4): se o cron falhar, ninguém ganha
  acesso indevido.

Deploy: **um** `Dockerfile` (serviço `innochat-painel`). A migration roda como passo explícito,
**antes** do push que a usa, nunca no boot (lição do InnoAtendente).

---

## 2. Divisão de responsabilidades: painel, n8n e Evolution

**Decisão do dono (fechada): o motor do menu fica nos nós do n8n,** visual e editável lá. O
desenho abaixo é **"n8n orquestra, painel expõe endpoints granulares e guarda as garantias"**.
Tudo o que pode falhar de forma silenciosa (identidade do remetente, dedupe, concorrência,
reserva de horário, limites do plano) fica no painel, em código testado. O n8n decide o
**próximo passo** do menu.

| Peça | Responsável por | Nunca faz |
|---|---|---|
| **Evolution API** | Sessão WhatsApp (Baileys), QR, envio e recebimento | Regra de negócio |
| **n8n**, workflow `innochat-bot` | Receber o webhook de todas as instâncias; interpretar a resposta do cliente contra as opções do menu atual; decidir o próximo passo (Switch por estado); chamar os endpoints do painel; montar o texto a partir dos templates do tenant; salvar a sessão; enviar pela Evolution | Guardar estado próprio (Data Table), calcular horário, gravar no banco direto, normalizar remetente, conhecer `tenantId` |
| **n8n**, workflow `innochat-cron` | Schedule que chama `POST /billing/tick` (e, no futuro, lembretes) | Decidir cobrança (só dispara) |
| **Painel (Next.js + Postgres)** | Fonte da verdade (empresas, planos, assinatura, números, catálogo, agenda, contatos, **sessão da conversa**, textos do bot). Normalização do payload da Evolution. Dedupe. Trava da sessão. Cálculo de horários. Reserva atômica. Ciclo do QR. Cobrança e webhook do Mercado Pago | Decidir o próximo passo do menu. Enviar mensagem de conversa |

### Onde fica cada peça de estado

| Estado | Onde | Por quê |
|---|---|---|
| Sessão da conversa (passo, escolhas, opções exibidas, última mensagem) | **`ChatSession` no Postgres**, lida e gravada por endpoints (§6.3) | Precisa de trava entre execuções paralelas, FK para contato e tenant, backup e visibilidade no painel ("Atendimentos"). Uma n8n Data Table não tem trava de linha nem transação, e duas execuções do mesmo contato pisariam uma na outra |
| Textos do bot | **`BotText` no painel**, por tenant | Um workflow atende todas as empresas, então o texto de cada uma não cabe no n8n. A empresa edita pelo painel sem tocar na lógica |
| Lógica do fluxo | **n8n** | Decisão do dono |
| Dedupe de mensagem | **`InboundEvent` no Postgres** | Unique no banco é a única dedupe que resiste a retry e a execução paralela |

### Fluxo de uma mensagem (resumo; nós na §6.6)

```
Evolution ─webhook─► n8n
  1. claim      → painel: normaliza, dedupe, adquire a trava da sessão, devolve sessão + textos
  2. interpreta → n8n (Code): comando global? número ou texto casa com context.options?
  3. Switch(state) → ramo do passo: chama catálogo, disponibilidade, reserva… no painel
  4. monta      → n8n (Code): template do tenant + opções numeradas
  5. save       → painel: grava a sessão, registra a saída, libera a trava
  6. envia      → Evolution sendText, em sequência
```

A sessão é salva **antes** do envio. Assim a trava é liberada cedo, e o registro da saída já
existe quando o eco `fromMe` chegar (§2, regra 7).

### Regras de robustez

1. **Dedupe no primeiro contato com o painel.** O `claim` insere `InboundEvent` com unique
   `(whatsappInstanceId, providerMessageId)`. Se for duplicata, responde `ignore/DUPLICATE`.
   O n8n responde 200 à Evolution na hora (quase não há reentrega), e o nó HTTP tem retry, que o
   dedupe absorve.
2. **Uma execução por contato de cada vez: trava com prazo (lease).** O `claim` faz um `UPDATE`
   atômico que só adquire a trava se ela estiver livre ou vencida
   (`lockedUntil < now()`, lease de **20 s**), e devolve um `lockToken`. Se a trava estiver
   ocupada, o `claim` responde `busy` **sem** registrar o `InboundEvent`. O n8n espera 1,5 s e
   tenta de novo (até 6 vezes, ~9 s). Todo `save` e `release` exige o `lockToken` e confere
   `version`. Trava vencida ou versão mudada dá **409 `LOCK_LOST`**, e a execução descarta a
   resposta.
3. **Reserva atômica.** `POST /appointments` e `/reschedule` inserem sob a constraint
   `EXCLUDE USING gist` (`btree_gist`, intervalo `[)`, só status `SCHEDULED`), em migration SQL
   escrita à mão. Conflito devolve **409 `SLOT_TAKEN` com até 6 horários alternativos** do mesmo
   dia (ou dos próximos dias com vaga), já no formato de opções de menu.
4. **Reserva idempotente.** `POST /appointments` exige `idempotencyKey` (= `inboundEventId`).
   Além disso, se o contato já tem `SCHEDULED` no mesmo serviço e no mesmo `startsAt`, o painel
   devolve **200 com o agendamento existente**. Isso cobre o caso "reservou, mas o `save` da
   sessão falhou, e o cliente digitou 1 de novo".
5. **Timeout de sessão.** Avaliado no `claim`. Se `lastInboundAt + sessionTimeoutMin` (padrão
   30) já passou, o painel devolve a sessão **zerada** em `MAIN_MENU` com `expired: true`, e o n8n
   antepõe o texto `SESSION_EXPIRED`.
6. **Mensagem fora do fluxo** (nó "Interpretar", §6.6):
   - `0` ou `menu` → menu principal; `sair` → encerra a sessão.
   - Entrada que não casa com `context.options` → reenvia `context.lastPrompt` com o texto
     `INVALID_OPTION`. Após **3** inválidas seguidas, oferece "Falar com atendente".
   - Aceita também o texto da opção (sem acento, sem caixa, prefixo único).
   - Mídia → texto `ONLY_TEXT` + `lastPrompt`.
   - O número sempre é interpretado **contra as opções gravadas na sessão**, nunca contra o
     catálogo recalculado.
   - Mensagem com mais de 5 min → `ignore/STALE`, decidido no `claim`.
7. **Atendimento humano e eco do bot.** Decidido no `claim`, não no n8n:
   - Sessão em `HUMAN` (até `humanUntil`) ou `Contact.botPausedUntil` no futuro → `ignore`.
   - `fromMe` cujo texto bate com o hash de uma saída registrada no `save` dos últimos 2 min →
     `ignore/FROM_ME_ECHO`.
   - Outro `fromMe` (o dono respondendo pelo celular) → pausa o contato por `handoffResumeMinutes` (v2; o claim v1, sem o header de fluxo, segue em `humanPauseMin`) e
     devolve `ignore/HUMAN_TOOK_OVER`.
   - A emissão de `fromMe` pela Evolution **precisa ser validada na Fase 0**.
8. **Assinatura.** O `claim` devolve `ignore/TENANT_SUSPENDED` se a assinatura não dá direito ao
   bot (§7.4). O n8n não conhece regra de cobrança.
9. **Anti-banimento.** O bot só responde a quem escreveu. Cada resposta sai com `delay`
   800–1500 ms ("digitando" nativo), no máximo 3 mensagens por turno, sem disparo em massa.

---

## 3. Menu no WhatsApp

### Formato: lista numerada em texto, sempre

Pesquisa de 2026-09-28:
- Botões e listas **não são suportados no conector Baileys**, só na Cloud API oficial; a
  alternativa sugerida é enquete.
  [strategicprojects.github.io/evolution](https://strategicprojects.github.io/evolution/)
- `sendList` enviava e **não chegava** ao contato a partir do Baileys 6.7.18 (jun/2025).
  [#1620](https://github.com/EvolutionAPI/evolution-api/issues/1620)
- Botões e listas deram HTTP 400 na v2.3.7 (jan/2026), e a issue foi fechada como *not planned*.
  [#2390](https://github.com/evolution-foundation/evolution-api/issues/2390)
- O Baileys oficial abandonou o recurso; só há forks comunitários.
  [baileys-buttons](https://github.com/meowguck-art/baileys-buttons)
- **Enquete também não serve:** o voto chega sem a opção escolhida.
  [#1644](https://github.com/evolution-foundation/evolution-api/issues/1644)

Regras:
- No máximo 9 opções (`9. Ver mais` quando houver mais).
- `0. Menu principal` sempre no rodapé.
- Datas e horas com `Intl` no fuso do tenant; o **painel já devolve os rótulos formatados**
  ("Ter 30/09", "14:30").
- Serviço com preço mostra o preço no rótulo ("Corte feminino — R$ 80,00"); sem preço, só o nome.

### Máquina de estados (implementada no Switch do n8n)

```
MAIN_MENU ──1──► SELECT_SERVICE ──► SELECT_PROFESSIONAL* ──► SELECT_DAY ──► SELECT_TIME
    │                                                                         │
    │                                                      ASK_NAME** ◄───────┘
    │                                                          │
    │                                              CONFIRM ──1──► POST /appointments ─201─► MAIN_MENU (resumo)
    │                                                 │                             └─409─► SELECT_TIME (alternativas)
    │                                                 └──2──► SELECT_TIME
    ├──2──► MY_APPOINTMENTS ──► APPOINTMENT_ACTION ──1──► CONFIRM_CANCEL ──► POST …/cancel
    │                                            └──2──► SELECT_DAY (mode=RESCHEDULE) … CONFIRM ──► POST …/reschedule
    └──3──► HUMAN (o painel silencia até humanUntil ou "Devolver ao bot")
```

\* `SELECT_PROFESSIONAL` é pulado se o serviço tem 1 profissional ou se `askProfessional = false`.
Quando aparece, inclui "Qualquer profissional" (`professionalId: null`; o painel escolhe o
primeiro livre na reserva).
\*\* `ASK_NAME` só aparece se `contact.name` está vazio. Texto livre de 2 a 60 caracteres, gravado
por `PATCH /contacts/{id}`.

Outras regras do fluxo:
- `SELECT_DAY`: 7 dias com vaga + `8. Ver mais datas`.
- `SELECT_TIME`: até 8 horários + `9. Mais horários`.
- Cancelar ou remarcar dentro de `cancelMinLeadMin` → 409 `TOO_LATE` → oferece atendente.

**Formato de `context`** (jsonb, contrato entre os ramos do n8n; o painel guarda e devolve sem
interpretar, exceto `recentOutbound`):
```json
{
  "mode": "BOOK | RESCHEDULE",
  "serviceId": "…", "professionalId": "… | null", "date": "2026-09-30", "startsAt": "2026-09-30T17:30:00Z",
  "appointmentId": "… (remarcar/cancelar)",
  "options": [{ "n": 1, "id": "svc_abc", "label": "Corte feminino — R$ 80,00" }],
  "page": 0,
  "lastPrompt": "texto completo da última mensagem de menu enviada"
}
```

---

## 4. Conexão do WhatsApp (QR code) e vários números

- **Vários números por empresa**: modelo N:1. O limite vem do **plano** (§7.2; o Essencial tem 1)
  e o admin da plataforma pode ampliá-lo por empresa.
- Todos os números da empresa atendem **a mesma agenda e o mesmo catálogo** na v1.
- `Contact` é por empresa; `ChatSession` é por **(número, contato)**.
- Nome da instância: `innochat-<tenantSlug≤20>-<4 aleatórios>`, imutável. O prefixo `innochat-`
  é obrigatório: a Evolution é compartilhada com o InnoAtendente.

```
Painel › WhatsApp › "Conectar número"   (bloqueado se atingiu o limite do plano ou se a assinatura não é ACTIVE/TRIALING)
 1. createInstance(label)
    ├─ gera instanceName e webhookToken (32 bytes, base64url)
    ├─ POST {evo}/instance/create { instanceName, integration:"WHATSAPP-BAILEYS", qrcode:true,
    │                               groupsIgnore:true, readMessages:false, alwaysOnline:false }
    ├─ POST {evo}/webhook/set/{instanceName}   (sempre explícito)
    │     { webhook:{ enabled:true, url:"<n8nWebhookBaseUrl>/<webhookToken>", byEvents:false,
    │                 base64:false, events:["MESSAGES_UPSERT","CONNECTION_UPDATE"] } }
    └─ WhatsappInstance(status=QRCODE)
 2. Modal: GET /api/whatsapp/instances/{id}/state a cada 3 s
    ├─ GET {evo}/instance/connectionState/{name}
    ├─ não "open" e QR com mais de 25 s → GET {evo}/instance/connect/{name} → QR (data URL)
    └─ para em CONNECTED ou após 2 min ("QR expirou — gerar novo")
 3. "open" → fetchInstances → ownerJid → CONNECTED + phoneE164 + lastConnectedAt
 4. Desconectar: DELETE {evo}/instance/logout/{name}   ·   Remover: DELETE {evo}/instance/delete/{name} + soft delete
 5. Queda inesperada: connection.update → n8n → POST /connection-events → DISCONNECTED + banner
```

O admin da plataforma tem o botão "Reaplicar webhook em todas as instâncias", para quando a URL
do n8n mudar. Endpoints e versão da Evolution **a confirmar na Fase 0**.

---

## 5. Modelo de dados (alto nível — o Cronos detalha)

Banco único, `tenantId` em toda tabela de negócio. O acesso passa por `forTenant(tenantId)`
(Prisma Client Extension), e o Prisma cru só é usado em `src/lib/db/` (lint). **O `tenantId`
nunca vem da requisição:** vem da sessão (painel) ou da instância resolvida pelo `webhookToken`
(API interna).

### Plataforma, identidade e cobrança
- **PlatformSettings** (singleton), todos os campos sensíveis **mascarados** na UI:
  - Evolution: `evolutionApiUrl`, `evolutionApiKey`.
  - n8n: `n8nWebhookBaseUrl`, `internalApiSecretHash`.
  - Mercado Pago: `mercadoPagoAccessToken`, `mercadoPagoWebhookSecret`.
  - E-mail: `emailProvider`, `emailApiKey`, `emailFrom`.
  - Termos: `termsVersion`.
  - Auditoria: `updatedByUserId`.
- **User** (global): e-mail único, `passwordHash`, `emailVerifiedAt?`, `isPlatformAdmin`,
  `termsAcceptedAt`, `termsVersion`.
- **AuthToken**: `userId`, `type` (`VERIFY_EMAIL | RESET_PASSWORD | INVITE`), `tokenHash`,
  `expiresAt`, `usedAt?`.
- **Tenant**: `slug`, `name`, `timezone`, `segment?`. Regras em colunas escalares:
  `slotGranularityMin` (15), `minLeadTimeMin` (60), `maxHorizonDays` (30), `cancelMinLeadMin`
  (120), `sessionTimeoutMin` (30), `humanPauseMin` (720), `askProfessional` (true). Sobrescritas
  de limite pelo admin: `maxWhatsappNumbersOverride?`, `maxProfessionalsOverride?`.
- **Membership**: `userId × tenantId × role` (`OWNER | STAFF`).
- **Plan**: `code`, `name`, `priceCents` (BRL), `maxWhatsappNumbers`, `maxProfessionals`,
  `active`, `sortOrder`.
- **Subscription** (1 por tenant): `planId`, `status` (`TRIALING | ACTIVE | PAST_DUE | SUSPENDED
  | CANCELED`), `trialEndsAt?`, `currentPeriodEnd`, `pendingPlanId?` (downgrade no próximo
  ciclo), `canceledAt?`.
- **Invoice**: `subscriptionId`, `amountCents`, `periodStart`/`periodEnd`, `dueAt`, `status`
  (`OPEN | PAID | EXPIRED | VOID`), `mpPaymentId?`, `pixQrCode?`, `pixCopyPaste?`,
  `pixExpiresAt?`, `paidAt?`. Unique `(subscriptionId, periodStart)`.
- **ProviderEvent**: `provider` + `providerEventId` **únicos**, `payload`, `processedAt`
  (idempotência do webhook de pagamento).
- **TrialClaim**: `phoneE164` único + `emailDomain?`. Garante **um trial por número de WhatsApp**
  (anti-abuso).
- **Régua de cobrança** (F1, migrations `20261004100000` e `20261004100100`; plano em
  `docs/regua-de-cobranca.md`):
  - **BillingNotice** (outbox): unique `(cycleKey, step, channel)`; `step`/`channel`/`status` são
    `String` (CHECK em `channel` e `status`); `attempts`, `nextAttemptAt`, `lastErrorCode`, `sentAt`,
    `skippedReason`; `platformConnectionId` + `senderPhoneE164`; índice `(status, nextAttemptAt)` para o
    claim com `FOR UPDATE SKIP LOCKED`. `cycleKey` = id da fatura, `<subscriptionId>:trial` ou
    `<subscriptionId>:<currentPeriodEnd ISO UTC>` (suspensão e cancelamento). O backfill marcou como
    `SKIPPED/LEGACY_SENT` os e-mails que o motor antigo já enviou.
  - **BillingEvent** (histórico append-only, UPDATE bloqueado por trigger): `type`, `fromStatus`,
    `toStatus`, `actorType` (`SYSTEM | OWNER | ADMIN`), `metadata`; índices `(tenantId, createdAt)` e
    `(type, createdAt)`.
  - **PlatformWhatsappConnection**: papéis `PENDING | ACTIVE | RETIRED` com índices únicos parciais (no
    máximo 1 `ACTIVE` e 1 `PENDING`), `instanceName` e `webhookTokenHash` únicos.
  - Campos novos: `PlatformSettings.platformWhatsappEnabled`, `Tenant.billingEmail`,
    `Tenant.billingWhatsappE164` (CHECK 12 a 13 dígitos) e `Tenant.billingWhatsappOptOutAt` (WhatsApp ativo
    para todos, com opt-out; decisão D5).

### Melhorias de outubro/2026 (Onda 0; migrations `20261010100000` a `20261010100700`)
Plano em `docs/plano-melhorias-2026-10.md`. Todas aditivas, com `DOWN.sql`. Conjuntos fechados são `String`
+ CHECK (como a régua). Segredos têm sufixo `Enc` (cifrados por `src/lib/crypto.ts`).
- **Erros**: `ErrorGroup` (`fingerprint` único, `source` SERVER|CLIENT, `status` OPEN|RESOLVED|IGNORED,
  `count`, `firstSeenAt`/`lastSeenAt`, `lastVersion`, `alertedAt`, `resolvedAt`/`resolvedByUserId`) e
  `ErrorEvent` (`groupId`, `occurredAt`, `version`, `route`, `stack` ≤ 8000 B, `userId`/`tenantId` só ids sem
  FK, `context` ≤ 4 KB). Índices `(lastSeenAt)`, `(status, lastSeenAt)`, `(groupId, occurredAt)`,
  `(occurredAt)`. Retenção: eventos > 30 dias são apagados pela manutenção; o grupo permanece.
- **Backup**: `BackupConfig` (singleton `id = 1`, CHECK; destino `S3|DRIVE` explícito, modo do Drive
  `SERVICE_ACCOUNT|OAUTH`, segredos `s3SecretKeyEnc`, `driveServiceAccountEnc`, `driveOauthClientSecretEnc`,
  `driveOauthRefreshTokenEnc`; automático exige destino), `BackupRun` (`RUNNING|SUCCESS|FAILED`,
  `SCHEDULED|MANUAL`, `sizeBytes` BigInt, `errorCode`) e `BackupDriveOauthNonce` (state de uso único).
- **2FA**: em `User`, `totpSecretEnc`, `totpEnabledAt` (CHECK: ligada exige segredo), `totpLastUsedStep`
  (anti-replay), `twoFactorRequired`; `TwoFactorRecoveryCode` (só hash, único por usuário, `usedAt`).
- **Auditoria**: `AuditLog` append-only (trigger bloqueia UPDATE; DELETE vale para cascata/retenção).
  `tenantId` opcional (CASCADE), `actorUserId`/`targetId` sem FK, `actorRole` OWNER|STAFF|PLATFORM_ADMIN|SYSTEM,
  `summary` ≤ 300, `changes` ≤ 8 KB, `ipTruncated`. Índices `(tenantId, createdAt)` e `(createdAt)`.
- **Pixel do Meta**: `PlatformSettings.metaPixelId` (só dígitos), `metaCapiTokenEnc`, `metaTestEventCode`,
  `metaEnabled` (default false).
- **Anual e cupons**: `Plan.annualPriceCents?`; `Subscription.billingCycle` (MONTHLY|ANNUAL),
  `couponId?` (RESTRICT), `couponCyclesRemaining?`; `Invoice.discountCents` (líquido em `amountCents`),
  `couponCode`, `cycle`. `Coupon` (código MAIÚSCULO único por CHECK, `kind` PERCENT|AMOUNT, `duration`
  ONCE|N_CYCLES|FOREVER, `appliesToCycle`, teto `redemptionsCount <= maxRedemptions` no banco),
  `CouponPlan` (sem linhas = todos os planos) e `CouponRedemption` (único por cupom + empresa).
- **Lista de espera**: `WaitlistEntry` (tenant-scoped): `desiredDate` (DATE local), `period`
  ANY|MORNING|AFTERNOON|EVENING, janela opcional em minutos, `status` WAITING|OFFERED|ACCEPTED|EXPIRED|
  CANCELED|FULFILLED, oferta (`offeredSlotStart`, `offeredProfessionalId`, `offeredAt`, `offerExpiresAt`),
  `appointmentId` único, `source` BOT|PANEL. Únicos parciais: 1 entrada ativa por contato+serviço+dia+
  profissional e 1 oferta aberta por horário+profissional. Índices `(tenantId, serviceId, desiredDate,
  status, createdAt)` e `(status, offerExpiresAt)`.
- **Comissões**: `Professional.commissionPct` e `ProfessionalService.commissionPct` (`Decimal(5,2)`, 0 a 100,
  nulo = herda). Sem índice novo em `Appointment`: `(tenantId, startsAt)` cobre os relatórios.
- Em `TENANT_SCOPED_MODELS` entra só `WaitlistEntry`. `AuditLog` e `CouponRedemption` têm `tenantId` mas
  são lidos cross-tenant (filtrar à mão nas telas da empresa); os demais são globais.

### Catálogo e agenda
- **Service**: `name`, `durationMin`, `bufferAfterMin`, `priceCents?`, `active`, `sortOrder`.
- **Professional**: `name`, `active`, `sortOrder`.
- **ProfessionalService**: N:N.
- **WorkingHour**: hora local `HH:mm`, várias faixas por dia.
- **ScheduleException**: `BLOCK | HOLIDAY`, escopo empresa ou profissional.

### Clientes, agendamentos e conversa
- **Contact**: único `(tenantId, waJid)`. `phoneE164?` (só exibição), `lid?`, `name?`,
  `pushName?`, `botPausedUntil?`.
- **Appointment**: `contactId`, `serviceId`, `professionalId`, `whatsappInstanceId?`,
  `startsAt`/`endsAt`, `blockEndsAt` (= `endsAt + buffer`), `status` (`SCHEDULED | CANCELED |
  COMPLETED | NO_SHOW`), `source` (`WHATSAPP | PANEL`), `idempotencyKey?` (unique por tenant).
  **`EXCLUDE`** por `professionalId` sobre `tstzrange(startsAt, blockEndsAt, '[)')` onde
  `status = 'SCHEDULED'`, em SQL à mão.
- **AppointmentEvent**: trilha imutável com autor (`CONTACT | USER | SYSTEM`).
- **WhatsappInstance**: `tenantId` (N), `instanceName` único, `label`, `status`, `phoneE164?`,
  `webhookToken` único, `sandbox` (bool, §8), `lastConnectedAt?`, `deletedAt?`.
- **ChatSession**: único `(whatsappInstanceId, contactId)`. `state`, `context` (jsonb, §3),
  `invalidCount`, `version` (int), `lockToken?`, `lockedUntil?`, `lastInboundAt`, `humanUntil?`,
  `recentOutbound` (jsonb: hashes + instante, últimos 2 min).
- **InboundEvent**: único `(whatsappInstanceId, providerMessageId)`, `outcome`, `reason?`,
  `stateBefore?`/`stateAfter?`. **Sem conteúdo**. Purga após 30 dias.
- **BotText**: `tenantId`, `key` (enum fechado, §6.7), `text`. Sem linha, vale o padrão do código.

**Não há histórico de conversa na v1** (decisão do dono).

```
User ──< Membership >── Tenant ──1 Subscription >── Plan
                          │            └──< Invoice
                          ├──< Professional ──< WorkingHour ; ──< ProfessionalService >── Service
                          ├──< ScheduleException
                          ├──< WhatsappInstance ──< ChatSession >── Contact ; ──< InboundEvent
                          ├──< Contact ──< Appointment ──< AppointmentEvent
                          └──< BotText
PlatformSettings · ProviderEvent · TrialClaim · AuthToken
Subscription ──< BillingNotice ; ──< BillingEvent ; PlatformWhatsappConnection ──< BillingNotice
```

### Cálculo de horários (função pura em `core/agenda`)
Faixas de `WorkingHour` (hora local → instante no fuso do tenant) − exceções − agendamentos
`SCHEDULED` `[startsAt, blockEndsAt)` − antecedência mínima, ∩ janela máxima, com passo
`slotGranularityMin`. O mesmo `AgendaService` atende a API interna e o painel.

---

## 6. Contratos

### 6.1 Autenticação e escopo da API interna (n8n → painel)

- Base: `https://<painel>/api/internal/v1`.
- `Authorization: Bearer <INTERNAL_API_SECRET>`. O segredo é gerado no admin da plataforma,
  exibido uma vez e guardado como hash SHA-256; a comparação é em tempo constante. No n8n, fica
  como credencial *Header Auth*.
- **Escopo por instância:** header `X-InnoChat-Instance: <webhookToken>`. O painel resolve
  `WhatsappInstance` → tenant. **Todo ID recebido** (`contactId`, `serviceId`, `sessionId`,
  `appointmentId`) é validado como pertencente a esse tenant; se não for, **404** (nunca 403, para
  não confirmar existência). O `tenantId` nunca é aceito.
- Erro: `{ "error": { "code": "…", "message": "…" } }`. Códigos gerais: `401 UNAUTHORIZED`,
  `404 NOT_FOUND`, `422 INVALID_PAYLOAD`, `500 INTERNAL`.
- No n8n: timeout de 10 s; retry 3× **só** em 5xx e timeout, e **nunca** em 409.
- Rótulos de data e hora já vêm formatados no fuso e locale do tenant.

### 6.2 `POST /messages/claim` — normaliza, deduplica, trava e carrega a sessão

Primeira chamada de toda execução. Concentra no painel o que é caro errar: formato da Evolution,
`@lid`, dedupe, trava, expiração, modo humano, eco `fromMe` e assinatura.

Request: `{ "payload": { …corpo bruto da Evolution… } }` (header `X-InnoChat-Instance` = token do path do webhook).

Response 200, processar:
```json
{
  "action": "process",
  "inboundEventId": "ie_…",
  "instance": { "name": "innochat-studio-bela-x7k2", "sandbox": false },
  "to": "5511999999999",
  "message": { "type": "text", "text": "2" },
  "contact": { "id": "ct_…", "name": null, "pushName": "Maria" },
  "session": {
    "id": "cs_…", "state": "SELECT_SERVICE", "context": { }, "invalidCount": 0,
    "version": 7, "lockToken": "lk_…", "expired": false
  },
  "tenant": { "name": "Studio Bela", "askProfessional": true },
  "texts": { "GREETING": "Olá, {nome}! …", "INVALID_OPTION": "…", "…": "…" }
}
```
- `message.type` ∈ `text | media`.
- `to` são os dígitos do JID como vieram (§6.9).
- `texts` já traz a mescla de padrões com as edições do tenant.

Response 200, tentar de novo: `{ "action": "busy", "retryAfterMs": 1500 }` (trava de outra
execução; **nada foi gravado**).

Response 200, nada a fazer: `{ "action": "ignore", "reason": "…" }`, com `reason` ∈
`DUPLICATE | STALE | GROUP | UNSUPPORTED_EVENT | FROM_ME_ECHO | HUMAN_TOOK_OVER | HUMAN_MODE |
BOT_PAUSED | TENANT_SUSPENDED | UNRESOLVABLE_SENDER`.

Payload irreconhecível **nunca** gera 5xx: vira `ignore`.

### 6.3 Sessão

- `PUT /sessions/{id}`: grava e libera a trava.
  - Request:
    ```json
    { "lockToken": "lk_…", "version": 7, "state": "SELECT_DAY", "context": { },
      "invalidCount": 0, "outbound": ["texto 1", "texto 2"], "handoff": false }
    ```
  - `outbound`: os textos que **serão** enviados. O painel guarda os hashes para reconhecer o eco.
  - `handoff: true` → o painel põe `HUMAN` e `humanUntil`.
  - Respostas: `200 { "version": 8 }`; `409 LOCK_LOST` (trava vencida ou versão diferente; o n8n
    **não envia** e encerra); `422 INVALID_STATE`.
- `POST /sessions/{id}/release` `{ "lockToken" }`: libera sem gravar. É chamado pelo caminho de
  erro do workflow. `200`, sempre idempotente.

### 6.4 Catálogo e disponibilidade (leitura)

Todas as listas devolvem `options` já numeráveis: `[{ "id", "label" }]`, com o preço incluído
no rótulo quando houver.

| Endpoint | Resposta |
|---|---|
| `GET /catalog/services` | `{ "options": [{ "id": "svc_…", "label": "Corte feminino — R$ 80,00", "durationMin": 60 }] }` (só ativos, em `sortOrder`) |
| `GET /catalog/services/{serviceId}/professionals` | `{ "options": [{ "id": "pro_…", "label": "Ana" }], "skip": false }`. `skip: true` quando há 1 só profissional ou `askProfessional=false`; nesse caso a lista traz o único (ou "qualquer") |
| `GET /availability/days?serviceId&professionalId?&from=YYYY-MM-DD&limit=7` | `{ "options": [{ "id": "2026-09-30", "label": "Ter 30/09" }], "hasMore": true, "nextFrom": "2026-10-08" }` (só dias com vaga) |
| `GET /availability/slots?serviceId&professionalId?&date=YYYY-MM-DD&offset=0&limit=8` | `{ "options": [{ "id": "2026-09-30T17:30:00Z", "label": "14:30" }], "hasMore": false }` |

`professionalId` ausente significa "qualquer profissional" (a união dos livres).

### 6.5 Escrita (contato e agendamento)

| Endpoint | Request | Respostas |
|---|---|---|
| `PATCH /contacts/{contactId}` | `{ "name": "Maria Souza" }` | `200` · `422 INVALID_NAME` |
| `GET /contacts/{contactId}/appointments?upcoming=true` | — | `{ "options": [{ "id": "ap_…", "label": "Ter 30/09 14:30 — Corte feminino (Ana)" }] }` |
| `POST /appointments` | `{ "contactId", "serviceId", "professionalId": "…\|null", "startsAt", "idempotencyKey": "<inboundEventId>", "instanceName" }` | `201 { "appointment": { "id", "summary": { "servico", "profissional", "data", "hora" } } }` · `200` com o mesmo corpo se for repetição (chave repetida ou mesmo contato+serviço+início) · `409 SLOT_TAKEN { "alternatives": { "date", "options": [...] } }` · `422 RULE_VIOLATION { "rule": "OUTSIDE_HOURS\|LEAD_TIME\|HORIZON\|INACTIVE" }` · `403 PLAN_BLOCKED` |
| `POST /appointments/{id}/cancel` | `{ "contactId", "idempotencyKey" }` | `200` (idempotente se já cancelado) · `409 TOO_LATE` · `404` |
| `POST /appointments/{id}/reschedule` | `{ "contactId", "startsAt", "idempotencyKey" }` | `200` · `409 SLOT_TAKEN { alternatives }` · `409 TOO_LATE` |

Garantias do painel: toda escrita revalida as regras do zero (nunca confia que o horário "veio de
uma lista"), roda em transação e grava `AppointmentEvent`. O `contactId` precisa ser o dono do
agendamento; se não for, 404.

### 6.6 Workflow `innochat-bot` no n8n, nó a nó

Montado pelo Atlas via MCP. Nomes dos nós em português, estáveis (os testes se referem a eles).

```
 1 Webhook            POST innochat/evolution/:token · "Respond: Immediately" (200)
 2 Filtrar evento     IF body.event ∈ {messages.upsert, connection.update}; senão → fim
 3 É conexão?         IF event == connection.update → 3a HTTP POST /connection-events → fim
 4 Claim              HTTP POST /messages/claim   (Header Auth + X-InnoChat-Instance = params.token)
 5 Roteia claim       Switch action: ignore → fim · busy → 5a · process → 6
   5a Esperar         Wait retryAfterMs → contador +1 → (≤6) volta ao 4 · (>6) → fim
 6 Interpretar        Code (genérico, sem regra por estado):
                        - media → reply = ONLY_TEXT + lastPrompt, estado mantido
                        - "0"/"menu" → estado MAIN_MENU · "sair" → encerra
                        - session.expired → prefixo SESSION_EXPIRED, estado MAIN_MENU
                        - casa número/texto com context.options → choice = {id,label}
                        - não casou → invalidCount+1; ≥3 → oferta de atendente; senão INVALID_OPTION + lastPrompt
                        - estado ASK_NAME → choice = texto livre
 7 Switch por passo   state: MAIN_MENU · SELECT_SERVICE · SELECT_PROFESSIONAL · SELECT_DAY · SELECT_TIME ·
                             ASK_NAME · CONFIRM · MY_APPOINTMENTS · APPOINTMENT_ACTION · CONFIRM_CANCEL
 8 Ramos (um por passo) — só HTTP para o painel + Set, cada ramo termina num Set com o formato:
      { nextState, contextPatch, textKey, vars, options, handoff }
      exemplos:
        SELECT_SERVICE → GET professionals → skip? GET days → SELECT_DAY : SELECT_PROFESSIONAL
        SELECT_TIME    → contact.name ? CONFIRM : ASK_NAME
        CONFIRM(1)     → POST /appointments (ou reschedule)
                          201/200 → MAIN_MENU, textKey BOOKED, vars = summary
                          409     → SELECT_TIME, textKey SLOT_TAKEN, options = alternatives
 9 Montar mensagem    Code (único, todos os ramos convergem): texts[textKey] com {vars} + opções numeradas
                      + rodapé "0. Menu principal"; grava lastPrompt; pagina (máx. 9)
10 Salvar sessão      HTTP PUT /sessions/{id} (lockToken, version, outbound) · 409 → fim sem enviar
11 Sandbox?           IF instance.sandbox → 11a HTTP POST /sandbox/outbox → fim
12 Enviar             Split Out messages → HTTP POST {evo}/message/sendText/{instance}
                      { number: to, text, delay } · batch size 1 (sequencial) · credencial Evolution do n8n
Error Trigger (workflow innochat-erros): se há sessionId+lockToken → POST /sessions/{id}/release;
                      registra falha SEM conteúdo de mensagem.
```

Regras do workflow:
- Os ramos **não** montam texto: devolvem `textKey` + `vars` + `options`, e só o nó 9 monta.
  Mudar um texto é tarefa do painel; mudar o fluxo é tarefa do n8n.
- Nenhum nó guarda estado fora da sessão. Nada de `staticData` nem Data Table.
- Configuração do n8n: **não salvar dados de execuções bem-sucedidas**; erros com prune de 7 dias
  (LGPD: há telefone e texto nas execuções).
- **Versionamento:** depois de toda alteração, o Atlas exporta o JSON do workflow via MCP para
  `n8n/innochat-bot.json` no repositório e commita. É o histórico e o diff do fluxo.
- **Mudança feita pelo dono:** editar uma cópia (`innochat-bot [rascunho]`) ligada a uma instância
  sandbox, rodar a bateria (§8) e só então promover.

### 6.7 Textos editáveis (`BotText`)

Chaves (enum fechado; os padrões ficam no código do painel):
- Navegação: `GREETING`, `MAIN_MENU`, `CHOOSE_SERVICE`, `CHOOSE_PROFESSIONAL`, `CHOOSE_DAY`,
  `CHOOSE_TIME`, `NO_SLOTS_DAY`, `NO_AVAILABILITY`, `ASK_NAME`.
- Agendamento: `CONFIRM_SUMMARY`, `BOOKED`, `SLOT_TAKEN`.
- Meus agendamentos: `MY_APPOINTMENTS`, `NO_APPOINTMENTS`, `APPOINTMENT_ACTIONS`,
  `CONFIRM_CANCEL`, `CANCELED`, `RESCHEDULED`, `TOO_LATE`.
- Controle da conversa: `HUMAN_HANDOFF`, `INVALID_OPTION`, `TOO_MANY_INVALID`, `ONLY_TEXT`,
  `SESSION_EXPIRED`, `GOODBYE`.

Variáveis: `{nome}`, `{empresa}`, `{servico}`, `{profissional}`, `{data}`, `{hora}`, `{preco}`.
A tela de edição valida que só existem variáveis conhecidas e mostra uma pré-visualização. O
número das opções e o rodapé "0. Menu principal" **não** são editáveis (são estrutura, não texto).

### 6.8 Outros endpoints internos

- `POST /connection-events` `{ payload }`: aplica `connection.update` e devolve `200` sempre.
- `POST /sandbox/outbox` `{ sessionId, messages[] }`: só aceita instância `sandbox=true`; guarda as
  mensagens para a bateria de testes. Purga em 24 h.
- `POST /billing/tick` (chamado pelo workflow `innochat-cron` a cada hora): idempotente; gera
  faturas vencendo, expira Pix, move status. Resposta:
  `{ "invoicesCreated": 0, "statusChanges": 0 }`.
- A especificação completa sai do zod como **OpenAPI** em `docs/api-interna.openapi.json` (Vega,
  Fase 4). É a fonte para o Atlas montar os nós e para os testes de contrato.

### 6.9 Webhook Evolution → n8n e remetente

- URL: `<n8nWebhookBaseUrl>/<webhookToken>`, por exemplo
  `https://n8n.dominio/webhook/innochat/evolution/<token>`.
- `byEvents:false`, `base64:false`, eventos `MESSAGES_UPSERT` e `CONNECTION_UPDATE`.
- Formato v2 esperado (a confirmar com captura real na Fase 0):
  `{ event, instance, data: { key: { remoteJid, remoteJidAlt?, fromMe, id }, pushName, message:
  { conversation | extendedTextMessage.text }, messageType, messageTimestamp }, date_time, apikey }`.
- **`@lid`**: o remetente pode chegar como `NNN@lid`, e responder para ele devolve 400
  `exists:false` em várias versões
  ([#1872](https://github.com/evolution-foundation/evolution-api/issues/1872),
  [#2326](https://github.com/EvolutionAPI/evolution-api/issues/2326)). O `claim` usa
  `remoteJidAlt`/`senderPn`. Sem campo alternativo, procura um `Contact.lid` já conhecido; sem nada,
  `ignore/UNRESOLVABLE_SENDER`. O `to` são **os dígitos do JID exatamente como vieram**; a
  reconstituição do 9º dígito BR serve só para exibição.
- Envio (nó 12): `POST {evo}/message/sendText/{instance}` com header `apikey` (credencial do
  n8n) e corpo `{ number, text, delay }`.

### 6.10 Painel ↔ navegador e Mercado Pago

- **Navegador**: Server Actions e Server Components, com `Result<T>` e `SLOT_TAKEN` como resultado
  esperado. Rotas HTTP:
  - `GET /api/whatsapp/instances/{id}/state`
  - `GET /api/agenda/slots?…`
  - `GET /api/billing/invoices/{id}/status`: consulta periódica da tela de Pix, a cada 5 s por até
    10 min.

  A Vega publica as assinaturas em `docs/contratos.md` na Fase 1.
- **Mercado Pago → painel**: `POST /api/webhooks/mercadopago`. Recebe o pagamento **direto no
  painel**, não pelo n8n: é dinheiro e precisa de código testado. Validação do `x-signature`
  (HMAC-SHA256 com `mercadoPagoWebhookSecret`), dedupe em `ProviderEvent`, e **sempre** reconsulta
  `GET /v1/payments/{id}` antes de dar baixa (nunca confia no corpo). Detalhes exatos de
  assinatura e campos: conferir a documentação oficial do MP na implementação.

---

## 7. Cadastro público, planos e cobrança

### 7.1 Gateway

| | **Mercado Pago — Pix pontual por ciclo** | Asaas (Pix, boleto e cartão com recorrência nativa) | Stripe |
|---|---|---|---|
| Prós | O dono já escolheu no InnoAtendente (Pix pontual, sem Pix Automático). Conta e credenciais conhecidas. QR + copia e cola por API, webhook assinado | Assinatura recorrente pronta, régua de cobrança própria | Excelente API |
| Contras | Sem débito automático: o cliente paga ativamente a cada mês, então a inadimplência depende de lembrete | Gateway novo para o dono homologar; duplicaria o fornecedor em relação ao InnoAtendente | Pix no Brasil é limitado e não é o foco do Stripe |
| Veredito | **Recomendado** | Plano B se a inadimplência do Pix pontual incomodar | Descartado para o Brasil |

Ciclo **mensal** em BRL. A fatura é gerada **5 dias antes** de `currentPeriodEnd`. **No trial
(3 dias — decisão do dono, 2026-09-29, era 1 dia), a primeira fatura é gerada já no cadastro**,
para a empresa poder pagar desde o primeiro minuto. O Pix vale 3 dias e é **regerado** sob
demanda se expirar. Aviso por e-mail na geração, 1 dia antes do vencimento e no vencimento, mais
banner no painel. **Nota fiscal: fora do escopo** (decisão do dono, 2026-09-28).

Pagamento confirmado → `currentPeriodEnd += 1 mês` a partir do vencimento anterior (mantém o
dia-âncora). Se a empresa estava `SUSPENDED`, o novo período conta a partir de `paidAt`.

### 7.2 Planos (proposta de limites; **preços são do dono**)

| Plano | Números de WhatsApp | Profissionais | Observação |
|---|---|---|---|
| **Essencial** | 1 | até 3 | Salão ou consultório pequeno |
| **Profissional** | 2 | até 10 | |
| **Clínica** | 3 | ilimitado | |

- Limites por plano; o admin pode sobrescrever por empresa (`*Override`).
- Upgrade vale na hora; a diferença entra na próxima fatura, sem proporcional na v1.
- Downgrade vale no próximo ciclo (`pendingPlanId`) e só é aceito se o uso atual couber no plano
  novo (a tela diz o que remover).
- O limite é verificado **no servidor**: conectar número, criar profissional. Não é só esconder o
  botão.

### 7.3 Cadastro e trial

1. `/cadastro`: nome da empresa, segmento, seu nome, e-mail, senha, aceite de termos e privacidade
   (versão gravada). Cria `User(OWNER)` + `Tenant` + `Subscription(TRIALING, plano Essencial,
   trialEndsAt = +3 dias — `TRIAL_DAYS`, decisão do dono de 2026-09-29; era 1 dia)` e a primeira
   fatura (Pix).
2. E-mail de verificação. **Sem e-mail verificado, não é possível conectar WhatsApp** (o resto do
   painel funciona).
3. Onboarding guiado em 4 passos: serviços → profissionais e expediente → conectar WhatsApp →
   testar mandando "oi".
4. Anti-abuso: ao conectar o primeiro número em trial, grava `TrialClaim(phoneE164)`. Um número que
   já teve trial em outra empresa **não pode ser conectado durante o trial**. Para usar esse
   número, a empresa precisa assinar antes. Rate limit no cadastro por IP.
5. Esqueci a senha: e-mail com token (hash no banco, 1 h, uso único).
6. Convite de equipe: e-mail com token (7 dias).

### 7.4 Vencimento: o que é bloqueado

O status **efetivo** é calculado sob demanda por `effectiveStatus(subscription, now)`, uma função
pura. O `billing/tick` só persiste a mudança e dispara o e-mail. Se o cron falhar, o acesso
continua correto.

| Status | Quando | Bot | Painel |
|---|---|---|---|
| `TRIALING` | **3 dias** (72 h) após o cadastro (`TRIAL_DAYS`, decisão do dono de 2026-09-29; era 1 dia) | Funciona | Completo + banner "teste termina em N h" com o Pix |
| `ACTIVE` | Pago | Funciona | Completo |
| `PAST_DUE` | Venceu sem pagar: **1 dia (24 h) de carência** (também no fim do trial — `GRACE_DAYS`, sem mudança) | Funciona | Completo + banner vermelho com o Pix |
| `SUSPENDED` | Após a carência | **Para de responder** (`claim` → `ignore/TENANT_SUSPENDED`). As mensagens continuam chegando ao celular da empresa, então ninguém fica sem canal | **Somente leitura** da agenda e dos clientes (a empresa precisa ver quem está marcado) + tela de Assinatura para pagar. Não cria, edita nem conecta nada |
| `CANCELED` | 60 dias em `SUSPENDED`, ou cancelamento pelo dono da empresa ao fim do período | Instâncias recebem **logout** (libera a Evolution) | Só a tela de Assinatura (reativar). Dados guardados 90 dias e depois anonimizados (LGPD) |

Por que suspender o bot e não o painel inteiro: o bot é o que custa infraestrutura e é o valor do
produto; a agenda somente leitura evita que o salão perca os clientes já marcados. Isso pressiona o
pagamento sem causar dano operacional.

---

## 8. Como testar

| Camada | Como | Quem |
|---|---|---|
| **Funções puras do painel** (`core/agenda`, `effectiveStatus`, normalização do payload com as fixtures reais da Fase 0) | Vitest | Vega → Íris |
| **Contrato da API interna** | Vitest contra Postgres real, um arquivo por endpoint. Cobre: autenticação (sem Bearer → 401; token de outra instância → 404); **isolamento** (`contactId` do tenant B com token do tenant A → 404); `claim` (duplicata, `busy`, expiração, `@lid`, eco `fromMe`, suspenso); `PUT` com trava vencida → 409; `POST /appointments` com 20 requisições paralelas no mesmo slot → exatamente 1 × 201 e 19 × 409; idempotência (mesma chave → 200 com o mesmo id); `TOO_LATE`. Os corpos são validados contra `docs/api-interna.openapi.json` | Vega + Íris |
| **Workflow n8n: nós isolados** | **Pin data** no nó 1 (Webhook) com as fixtures reais, uma por cenário. Via MCP, `test_workflow` executa o workflow contra o painel de staging, apontado para o tenant sandbox | Atlas |
| **Workflow n8n: conversa inteira** | **Bateria de roteiros** (`tests/bot-scripts/*.yaml`): sequências de mensagens com as respostas esperadas. Um script (Íris) posta payloads no webhook da **instância sandbox** (`sandbox=true`): o nó 11 desvia o envio para `/sandbox/outbox`, e o script lê o outbox e compara. Roteiros mínimos: agendar ponta a ponta; "qualquer profissional"; `SLOT_TAKEN` com alternativas; sessão expirada; 3 inválidas; mídia; cancelar; remarcar; `TOO_LATE`; duas mensagens simultâneas (uma recebe `busy` e depois é processada) | Íris |
| **Ponta a ponta real** | Número de teste real conectado, conversa manual antes de cada entrega | Íris + dono |
| **Painel (navegador)** | Playwright: cadastro, onboarding, QR (Evolution simulada), agenda, pagamento (MP em sandbox) | Íris |

A bateria de roteiros é o **teste de regressão do fluxo do n8n**: roda depois de toda alteração no
workflow, inclusive as feitas pelo dono no rascunho.

---

## 9. Telas do painel

### Público
Página de entrada simples (o que é + planos), **Cadastro**, **Login**, **Verificar e-mail**,
**Esqueci a senha / Redefinir**, **Aceitar convite**, Termos e Privacidade.

### Empresa (`/(app)/[tenantSlug]/…`)
| Tela | Propósito |
|---|---|
| **Início / Onboarding** | Checklist dos 4 passos até o primeiro agendamento; depois vira um resumo do dia |
| **Agenda** | Dia e semana por profissional; agendamento manual; cancelar; concluído ou falta |
| **Agendamentos** | Lista com filtros (útil no celular) |
| **Serviços** | CRUD: nome, duração, intervalo, preço opcional, ativo, ordem, quem realiza |
| **Profissionais** | CRUD + expediente semanal + serviços (respeita o limite do plano) |
| **Bloqueios e feriados** | Por empresa ou profissional |
| **Clientes** | Lista, agendamentos do cliente, editar nome, pausar o bot |
| **Atendimentos** | Contatos em modo humano, com "Devolver ao bot" e badge no menu |
| **WhatsApp** | Números, QR, status, desconectar, reconectar, remover (respeita o limite do plano) |
| **Mensagens do bot** | Edita os textos da §6.7 com pré-visualização; "restaurar padrão" |
| **Configurações** | Empresa, fuso, regras de agenda e do bot, equipe |
| **Assinatura** | Plano atual, trocar de plano, fatura aberta com QR Pix e copia e cola (consulta periódica até pagar), histórico, cancelar |

### Plataforma (`/(platform)/admin/…`)
| Tela | Propósito |
|---|---|
| **Empresas** | Lista com status da assinatura; ver, suspender ou reativar manualmente, sobrescrever limites, estender trial |
| **Planos** | CRUD de planos (limites, preço, ativo) |
| **Cobrança** | Faturas abertas e vencidas, recebimentos do mês, eventos do MP com erro |
| **Configurações da plataforma** | Em abas, cada uma com rota própria (`/admin/configuracoes/<aba>`): Geral, WhatsApp (Evolution e número de cobrança), Automação (n8n, fluxo e segredo interno), Pagamentos (Mercado Pago), E-mail (SMTP), Login (Google) e Marketing (Pixel do Meta). Tudo mascarado |
| **Saúde** | Instâncias e status, `InboundEvent` com erro, `UNRESOLVABLE_SENDER` e `busy` esgotado nas últimas 24 h, horário do último `billing/tick` |

---

## 10. Estrutura de pastas

```
src/
├─ app/                        casca fina: rotas, layouts, server actions
│  ├─ (public)/ (auth)/ (app)/[tenantSlug]/… (platform)/admin/…
│  └─ api/internal/v1/…  api/webhooks/mercadopago  api/whatsapp/…  api/agenda/…  api/billing/…
├─ core/                       puro: agenda/ (slots, rules, window) · billing/ (effectiveStatus, ciclo) · texts/ (padrões + render de template)
├─ modules/                    serviços: agenda/ bot-api/ whatsapp/ tenant/ platform/ billing/ auth/ contacts/
├─ adapters/                   evolution/ (payload + chamadas) · mercadopago/ · email/
└─ lib/                        db/ (forTenant) · auth.ts · logger.ts (redação de PII)
n8n/                           innochat-bot.json · innochat-cron.json · innochat-erros.json (exportados via MCP)
tests/bot-scripts/             roteiros da bateria do fluxo
fixtures/evolution/            payloads reais da Fase 0
```
Regra de dependência: `app → modules → core ← adapters`.

---

## 11. Segurança e LGPD (resumo para o Órion)

- Isolamento entre tenants:
  - `forTenant()` + lint.
  - Na API interna, **todo ID é revalidado contra o tenant da instância** (o teste de contrato
    cobre isso).
  - O `tenantId` nunca vem do corpo.
- Segredos no banco, mascarados na UI:
  - Chave da Evolution, token do MP e chave de e-mail ficam em `PlatformSettings`.
  - O segredo interno do n8n é guardado como hash.
  - A chave da Evolution **também** fica na credencial do n8n (decisão do dono): são dois lugares
    para rotacionar.
  - Cifragem em repouso: dívida consciente.
- Webhook do MP: assinatura verificada + reconsulta do pagamento + `ProviderEvent`.
- Cadastro público: rate limit por IP no cadastro, no login e em "esqueci a senha"; e-mail
  verificado antes de conectar WhatsApp; `TrialClaim` contra trial em série.
- Nada de conteúdo de mensagem em log nem em `InboundEvent`. Execuções do n8n sem dados de sucesso.
  Não há histórico de conversa.
- Termos e privacidade com versão aceita. Anonimização 90 dias após `CANCELED`.

---

## 12. Riscos

| # | Risco | Impacto | Mitigação |
|---|---|---|---|
| 1 | **Reserva e sessão não estão mais na mesma transação** (o `POST /appointments` e o `PUT /sessions` são chamadas separadas) | Agendamento gravado com a sessão ainda em `CONFIRM`, se o `save` falhar | Reserva idempotente (chave + contato/serviço/início → 200 com o existente); `release` no caminho de erro; a sessão reapresenta o passo |
| 2 | **Trava por prazo em vez de trava de transação** | Execução acima de 20 s perde a trava e outra pode entrar | `version` + `lockToken` no `PUT` → 409 e a resposta é descartada; métrica de `LOCK_LOST` na tela de Saúde |
| 3 | **Lógica do fluxo sem teste unitário em CI** | Uma edição no n8n pode quebrar um ramo sem ninguém perceber | Bateria de roteiros na sandbox (§8); rascunho + promoção; JSON exportado no git para ver o diff; ramos sem texto (só `textKey`) |
| 4 | **Latência**: 3 a 6 chamadas HTTP por mensagem | Resposta mais lenta | Painel e n8n na mesma rede interna do Easypanel, se possível (§14); `claim` concentra várias verificações; meta: p95 < 2 s + `delay` |
| 5 | **Mensagem sem resposta** quando o `busy` se esgota ou o envio falha depois do `save` | Cliente precisa repetir | O estado já avançou e reapresenta o `lastPrompt` na próxima mensagem; métrica na tela de Saúde |
| 6 | **LID / remetente sem número** | Resposta não chega | `remoteJidAlt`/`senderPn`, fixtures reais, métrica `UNRESOLVABLE_SENDER`, versão fixada |
| 7 | **Regressão da Evolution ao atualizar** | Bot mudo | Versão fixada; fixtures + bateria antes de atualizar |
| 8 | **n8n fora do ar** | Bot mudo e sem `billing/tick` | Status de acesso calculado sob demanda; alerta de erro; "último processamento" na tela de Saúde |
| 9 | **Inadimplência do Pix pontual** (sem débito automático) | Receita instável | Três e-mails + banner; carência curta; Asaas ou cartão recorrente como plano B pós-v1 |
| 10 | **Abuso do cadastro público** (trial em série, spam) | Custo e risco de banimento na Evolution compartilhada | Verificação de e-mail, `TrialClaim` por número, rate limit, limite de 1 número no trial |
| 11 | **Evolution compartilhada com o InnoAtendente** | Colisão ou disputa de recursos | Prefixo `innochat-`; limites por plano; monitorar RAM |
| 12 | **Banimento de número** | Empresa sem canal | Só responde a quem escreveu, "digitando", ≤ 3 mensagens por turno, sem disparo em massa |
| 13 | **Double booking** | Dois clientes no mesmo horário | `EXCLUDE` + teste com 20 paralelas |
| 14 | **Dados pessoais no n8n** | Exposição LGPD | Execuções de sucesso não salvas; prune de erros em 7 dias |
| 15 | **VPS única** | Tudo fora do ar junto | Backup com restauração testada |

**Dívidas conscientes:** sem histórico de conversa; sem reserva temporária de horário; resposta
"no máximo uma vez"; números da empresa compartilham a agenda; segredos sem cifragem em repouso;
sem proporcional na troca de plano; sem nota fiscal automática; lembrete de véspera fica para
depois da v1.

---

## 13. Plano faseado

Legenda: 🔑 = depende de dado do dono · ∥ = paralelo.

| Fase | Entrega | Quem | Depende de |
|---|---|---|---|
| **0. Dados do dono + spike Evolution** | Versão, URL e chave da Evolution; URL do n8n e rede; domínio do painel; conta MP (token + segredo de webhook) e provedor de e-mail. Instância de teste para capturar payloads reais (texto, `extendedTextMessage`, `@lid`, `fromMe` do celular, eco do `sendText`, `connection.update`); teste de `sendText` para `@lid`. Resultado em `fixtures/evolution/` | Atlas + Vega | 🔑 |
| **1. Fundação** | Esqueleto Next/Prisma/Auth.js; `forTenant` + lint; identidade (User, AuthToken, Tenant, Membership, PlatformSettings); admin da plataforma (configurações mascaradas, segredo interno); login; `Dockerfile` + Postgres no Easypanel; `docs/contratos.md` | Cronos ∥ Vega ∥ Lyra (design system + shell) ∥ Vulcano | domínio 🔑 para o deploy |
| **2. Catálogo e agenda** | Service, Professional, WorkingHour, ScheduleException, Contact, Appointment + `EXCLUDE`; `core/agenda`; `AgendaService`; telas Serviços, Profissionais, Bloqueios, Agenda, Agendamentos | Cronos → Vega ∥ Lyra → Íris | 1 |
| **3. Conexão WhatsApp** ∥ 2 | Adaptador Evolution; instâncias com `sandbox`; tela WhatsApp + QR; `/connection-events` | Vega ∥ Lyra → Íris | 1, 0 🔑 |
| **4. API interna do bot** | ChatSession (trava + versão), InboundEvent, BotText; endpoints da §6.2–6.5 e 6.8 (sandbox); OpenAPI; **testes de contrato** (§8); tela Mensagens do bot | Cronos → Vega → Íris | 2, 0 (fixtures) |
| **5. Workflow n8n** | `innochat-bot` nó a nó (§6.6), `innochat-erros`, retenção de execuções; export para `n8n/`; pin data com fixtures. **O esqueleto (nós 1–5 e 9–12) pode começar junto com a 4**, contra o OpenAPI | Atlas via MCP | OpenAPI da 4 ∥; ponta a ponta precisa de 3 + 4; URL do n8n 🔑 |
| **6. Bateria de roteiros** | `tests/bot-scripts/` + script contra a sandbox; todos os roteiros mínimos da §8 verdes | Íris | 4, 5 |
| **7. Cadastro público e cobrança** ∥ 4–6 | Plan, Subscription, Invoice, ProviderEvent, TrialClaim; cadastro, verificação de e-mail, esqueci a senha, convite; onboarding; `effectiveStatus` + bloqueios (bot no `claim`, painel somente leitura); adaptador MP (Pix) + webhook; `billing/tick` + workflow `innochat-cron`; telas Assinatura, admin de Planos e Cobrança; e-mails | Cronos → Vega ∥ Lyra → Íris; Atlas (cron) | 1; MP + e-mail 🔑; preços 🔑 |
| **8. Operação humana** | Clientes, Atendimentos, pausa por `fromMe`, tela Saúde | Vega ∥ Lyra → Íris | 4, 5 |
| **9. Endurecimento e entrega** | Revisão OWASP + isolamento + cobrança (Órion); E2E Playwright + ponta a ponta real (Íris); backup com restauração testada e rollback (Vulcano); docs (Alexandria) | Órion ∥ Íris ∥ Vulcano → Alexandria | 6, 7, 8 |
| *Pós-v1* | Lembrete de véspera (Schedule no n8n), cartão recorrente ou Asaas, número por unidade, Cloud API com botões | — | dono |

Caminho crítico: **0 → 1 → 2 → 4 → 5 → 6 → 9**. A Fase 7 (cobrança) é a maior frente paralela e
não bloqueia o bot, mas **bloqueia o lançamento público**.

---

## 14. Convenções herdadas do InnoAtendente

- Credenciais da plataforma no banco (`PlatformSettings`), só `isPlatformAdmin` edita, sempre
  mascaradas. Nada em env var.
- Um Dockerfile por serviço no Easypanel.
- Migration antes do push que a usa; nunca no boot; `AUTH_URL`/`NEXT_PUBLIC_APP_URL` com **um**
  domínio.
- Um fuso por empresa; `Date` construído por componentes, nunca dependendo do fuso da máquina.
- Normalização do 9º dígito BR só para exibição; o envio usa o JID recebido.
- Teste de concorrência contra Postgres real: "teste passou" com volume baixo não prova nada.

---

## 15. Decisões

### Fechadas pelo dono em 2026-09-28
1. Motor do menu nos nós do n8n (§2, §6.6).
2. Cadastro público + assinatura paga na v1 (§7).
3. Lembrete de véspera fica para depois da v1; sem histórico de conversa na v1.
4. Limite de 1 número, ampliável por plano; chave da Evolution como credencial do n8n; preço no
   menu quando preenchido.

### Ainda dependem do dono
1. 🔑 **Dados de infraestrutura:** versão, URL e chave da Evolution; URL do n8n e se ele está na
   mesma rede do Easypanel (afeta a latência, risco 4); domínio do painel (sugestão:
   `innochat.innovarecode.com.br`).
2. **Preços** dos três planos, e se os **limites** propostos (§7.2) servem.
3. **Credenciais do Mercado Pago** (produção + sandbox). Gateway confirmado: Mercado Pago Pix pontual.
4. **Dados do SMTP próprio** (host, porta, usuário, senha, remetente). Cadastrados na tela de admin.
5. **Termos de uso e política de privacidade:** o texto é responsabilidade do dono (o sistema só
   versiona o aceite).
