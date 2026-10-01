# Régua de cobrança e visão financeira (plano)

Autora: Nova (arquitetura). Data: 2026-10-01. Base: HEAD `322525f` (v1.3.1).
Status: **plano, nada implementado**. As decisões da §6 são do dono.

Pedido do dono: "já fizemos alguma coisa para lembrar ao nosso cliente que a mensalidade dele está
próxima de vencer? [...] por e-mail, por WhatsApp, por notificação no sistema [...] mecanismo
financeiro robusto, profissional e 100% funcional."

Resposta curta: existe uma régua **só por e-mail**, com 4 envios (fatura gerada, véspera, "dia" e
suspensão). Ela funciona no caminho feliz, mas **perde avisos em silêncio quando o SMTP falha**, não
avisa nada durante os 60 dias de suspensão, não avisa antes nem depois do cancelamento automático e
não aparece no sino do painel. WhatsApp para o assinante não existe. Este documento audita o que
existe, propõe a régua completa e quebra o trabalho em fases.

---

## 0. Contexto e hipóteses

- **Escala:** dezenas a poucas centenas de empresas nos próximos 6 a 12 meses. No pior dia, algumas
  dezenas de avisos. Não justifica fila externa (Redis, SQS): **Postgres como outbox** basta.
- **Maturidade:** produto no ar, com clientes pagando de verdade. Cobrança é a parte em que errar
  custa dinheiro ou cliente, então a prioridade é confiabilidade (nenhum aviso perdido, nenhum
  duplicado) antes de canal novo.
- **Infra:** o mesmo processo Next.js do painel, tick horário chamado pelo n8n (`n8n/innochat-cron.json`),
  Evolution API compartilhada com o InnoAtendente, SMTP próprio. Nada de serviço novo.
- **Gateway:** Mercado Pago, Pix pontual por ciclo (arquitetura §7.1). Não há débito automático,
  então a inadimplência depende da régua. Isso torna este trabalho central, não acessório.

---

## 1. Auditoria do que existe hoje

### 1.1 `billing/tick` (`src/modules/billing/tick.ts`)

Ordem de execução (`tick.ts:87-93`): conciliar com o MP, anular reativações abandonadas, gerar
faturas, regerar Pix, lembretes, reconciliar status.

| Etapa | Onde | O que faz | Marca de idempotência |
|---|---|---|---|
| Conciliação ativa | `tick.ts:122-138` | Até 50 faturas `OPEN` com `mpPaymentId` por rodada, mais antigas primeiro | `mpLastCheckedAt` |
| Fatura gerada (D-5) | `tick.ts:176-238`, `INVOICE_LEAD_DAYS = 5` (`:46`) | Cria a fatura do próximo ciclo (só `ACTIVE`/`PAST_DUE`, sem cancelamento agendado) e manda o e-mail "Fatura do InnoChat" | Unique `(subscriptionId, periodStart)` na fatura. **O e-mail não tem marca** |
| Regerar Pix | `tick.ts:240-292` | Pix `OPEN` expirado ou nunca gerado ganha Pix novo, 3 dias | n/a |
| Lembrete véspera | `tick.ts:295-303` | `dueAt` nas próximas 24 h | `Invoice.dueReminderEmailSentAt` |
| Lembrete "vence hoje" | `tick.ts:305-311` | `dueAt <= now` (ou seja, **depois** de vencer) | `Invoice.dueTodayEmailSentAt` |
| Status | `tick.ts:358-411` | Persiste `effectiveStatus`; ao entrar em `SUSPENDED` manda e-mail | `Subscription.suspendedEmailSentAt` |
| Cancelamento automático | `tick.ts:368-380` + `cancellation.ts:107-136` | 60 dias suspensa (7 se nunca pagou) vira `CANCELED`, anula faturas, desconecta números | claim condicional |
| Saúde | `tick.ts:98-103` | `recordBillingTickRun` grava `lastBillingTickAt` | n/a |

Constantes (`src/core/billing/status.ts`): `GRACE_DAYS = 1` (`:8`), `CANCEL_AFTER_SUSPENDED_DAYS = 60`
(`:11`), `CANCEL_AFTER_SUSPENDED_TRIAL_DAYS = 7` (`:17`), `CANCELED_RETENTION_DAYS = 90` (`:20`),
`TRIAL_DAYS = 3` (`:23`). Pix vale 3 dias (`service.ts:19`). A carência de 1 dia vale igual para teste e
para cliente pagante (`status.ts:67`).

Destinatário: `findBillingRecipientEmail` (`service.ts:637-646`) devolve o e-mail do OWNER mais antigo.
Não existe e-mail de cobrança dedicado nem telefone do dono (o cadastro com Google valida `phone` e
descarta, `signup/actions.ts:188` e comentário em `:203`).

### 1.2 E-mails (`src/lib/email/templates.ts`)

| Template | Linha | Quando sai hoje |
|---|---|---|
| `invoiceGeneratedEmail` | `:87` | Cadastro (fatura do teste, `signup/service.ts:226`) e D-5 |
| `invoiceDueReminderEmail` | `:116` | Véspera e "vence hoje" (inclusive para a fatura do teste, que vence no fim do teste) |
| `subscriptionSuspendedEmail` | `:134` | Ao suspender (variante "Seu teste terminou") |
| `paymentConfirmedEmail` | `:170` | Primeira baixa da fatura (`service.ts:479`, teto de 10 s) |
| `subscriptionCancelEmail` | `:197` | Só quando o **dono** cancela (`cancellation.ts:206`, `:226`) |

### 1.3 Sino do painel da empresa (`src/modules/notifications`)

Notificações **derivadas** do estado, sem tabela (`notifications/service.ts:26-31`). De cobrança,
só existem duas, ambas só para OWNER:

- `TRIAL_ENDING`: teste acaba em menos de 24 h (`service.ts:249-260`).
- `PAYMENT_CONFIRMED`: fatura paga nos últimos 30 dias (`service.ts:262-274`).

**Não existe** aviso de fatura disponível, vencendo, vencida, conta suspensa ou cancelamento chegando.

### 1.4 Banner (`SubscriptionBanner`, `src/components/shell/panel-shell.tsx:66-134`)

| Status | Mostra | Botão |
|---|---|---|
| `TRIALING` | "Seu teste termina em Nh." | "Ver assinatura" (sem Pix, ao contrário do que diz arquitetura §7.4) |
| `ACTIVE` com fatura aberta vencendo | **nada** | n/a |
| `PAST_DUE` | "Sua fatura está atrasada..." | "Pagar agora" |
| `SUSPENDED` | "Assinatura suspensa: somente leitura e bot mudo" | "Pagar e reativar" (sem prazo do cancelamento) |
| `CANCELED` | "Assinatura cancelada" | "Reativar" |

A tela Assinatura carrega só a fatura aberta (`assinatura/page.tsx:45-46`). A empresa não vê o
histórico de pagamentos nem baixa recibo antigo.

### 1.5 Admin da plataforma

- **Sino** (`src/modules/platform-notifications/types.ts`): `TENANT_SIGNED_UP`, `PAYMENT_RECEIVED`,
  `TENANT_SUSPENDED`, `TENANT_CANCELED`, `TENANT_CANCEL_SCHEDULED`, `PAYMENT_ON_VOID_INVOICE`,
  `TRIAL_ENDING`, `WHATSAPP_DISCONNECTED`, `MP_WEBHOOK_REJECTED`, `TICK_LATE`. O `TICK_LATE` já avisa
  billing parado há mais de 2 h e maintenance há mais de 26 h (`service.ts:27-28`, `:252-272`).
- **Cobrança** (`admin-service.ts:255-349`): cards de recebido no mês, a receber, vencido, em teste
  e MRR; lista paginada de faturas com filtro por empresa/status/vencimento; lista de inadimplentes
  com dias de atraso; "Regerar Pix" e "Marcar como paga" (auditado em `ProviderEvent`).
- **Saúde** (`health-service.ts:193-211`): integrações, última execução dos ticks, empresas por status,
  alertas em texto.
- **O que falta:** próximos vencimentos (7/30 dias), churn, quantidade de inadimplentes junto do valor,
  histórico por empresa numa tela só, CSV e qualquer registro de **o que foi avisado a quem**.

### 1.6 WhatsApp

O painel envia direto pela Evolution (`evolution-client.ts:323`), sempre pela instância **da empresa**
para os clientes finais dela (lembrete de véspera, `reminders/tick.ts:279`). Não há número da
plataforma. `PlatformSettings.salesWhatsappE164` = (84) 3113-2584 só alimenta o botão da landing
(`platform/sales-contact.ts:22`).

### 1.7 Lacunas e riscos encontrados (ordenados por gravidade)

| # | Problema | Evidência | Efeito |
|---|---|---|---|
| R1 | **Lembrete marcado como enviado mesmo quando o envio falha.** `sendMail` devolve `{ sent: false }` em falha de SMTP e lança `SmtpNotConfiguredError` sem configuração; o tick engole os dois e grava a marca | `tick.ts:350-354`, `mailer.ts:57` | SMTP fora do ar por 1 hora no momento errado = cliente nunca é avisado e é suspenso |
| R2 | E-mail de fatura gerada sem marca nem nova tentativa | `tick.ts:225-236` (`created` só é `true` uma vez) | Falhou, perdeu. A fatura existe mas o cliente não sabe |
| R3 | E-mail de suspensão grava `suspendedEmailSentAt` sem olhar o resultado | `tick.ts:398-409`, `service.ts:631` | Mesmo efeito do R1 |
| R4 | **Cancelamento automático (60/7 dias) não manda e-mail nenhum** e não há aviso antes | `cancellation.ts:107-136` não chama `sendCancelEmail` | Cliente descobre que perdeu a conta quando abre o painel |
| R5 | Nenhum lembrete durante os 60 dias de suspensão | só um e-mail, `tick.ts:398` | Dinheiro recuperável deixado na mesa |
| R6 | "Vence hoje" sai **depois** do vencimento e em qualquer hora; véspera também em qualquer hora (pode ser 3h) | `tick.ts:295`, `:306` | Texto errado ("vence hoje" quando já venceu) e horário ruim. Inviável para WhatsApp |
| R7 | O Pix do e-mail de D-5 expira em D-2; véspera e dia não trazem Pix | `service.ts:19`, `tick.ts:272`, `templates.ts:116-131` | Quem tenta pagar pelo código do e-mail antigo recebe erro no banco |
| R8 | Ticks sobrepostos podem duplicar e-mails (leitura, envio e marca sem claim) | `tick.ts:297-354` | Duplicado se alguém rodar o tick manualmente durante a rodada horária |
| R9 | Tick parado só aparece se o admin abrir o painel (sino/Saúde são "puxados") | `health-service.ts:193`, `platform-notifications/service.ts:27` | n8n cai na sexta, ninguém vê até segunda; faturas não nascem |
| R10 | Destinatário fixo no OWNER mais antigo | `service.ts:637-646` | Financeiro de clínica não recebe; dono que trocou de e-mail não recebe |
| R11 | Sino da empresa não mostra nada de fatura | `notifications/service.ts:174-187` | Quem vive no painel e não lê e-mail é pego de surpresa |
| R12 | Banner mudo em `ACTIVE` com fatura vencendo; teste sem botão de Pix | `panel-shell.tsx:75-133` | Perde o momento de maior intenção de pagar |
| R13 | Mudanças de status não são registradas em lugar nenhum | só a linha atual de `Subscription` | Sem histórico, não há churn confiável nem linha do tempo |
| R14 | Receita do mês calculada no fuso do servidor (UTC no container) | `admin-service.ts:284-285` | Pagamento das 21h às 24h do último dia cai no mês seguinte |
| R15 | Teste recebe "Sua fatura vence amanhã" em vez de "seu teste termina amanhã" | fatura do teste vence em `trialEndsAt` (`signup/service.ts:211`) | Tom errado no momento de converter |
| R16 | Descrição da fatura no MP usa travessão | `service.ts:653` | Aparece no app do banco do cliente; fere o guia de voz |

---

## 2. Régua proposta

### 2.1 Convenções

- **D** = data do vencimento **no fuso da empresa** (`Tenant.timezone`). Hoje `dueAt` é um instante
  qualquer (a hora do cadastro). Decisão D7 recomenda normalizar para 23:59 do dia local, o que faz
  "vence hoje" ser verdade o dia inteiro.
- **S** = data em que a conta foi suspensa. **C** = data do cancelamento automático.
- **T** = fim do teste.
- **Janela de envio:** WhatsApp de 09:00 às 19:00 no fuso da empresa. E-mail de 08:00 às 20:00. Se o
  tick passa fora da janela, o aviso espera a próxima janela. Exceção: pagamento confirmado sai na
  hora (é resposta a uma ação do cliente).
- **Um aviso por etapa por canal por ciclo**, garantido pelo banco (§2.5).
- Antes de enviar qualquer aviso, o despachante **reconfere** se ele ainda faz sentido (fatura ainda
  `OPEN`, status ainda o esperado). Se o cliente pagou entre o planejamento e o envio, o aviso vira
  `SKIPPED`. Isso evita o pior erro de cobrança: cobrar quem já pagou.

### 2.2 Tabela canal x momento (recomendação, com carência de 3 dias, decisão D3)

Legenda: **E** = e-mail, **S** = sino do painel, **B** = banner/contador, **W** = WhatsApp para o dono.
"(já)" = já existe, só passa a usar o motor novo.

| Momento | E | S | B | W | Observação |
|---|---|---|---|---|---|
| Fatura gerada (D-5) | sim (já) | sim | sim, informativo | sim, com Pix | Pix vigente anexado na hora do envio |
| D-3 | não | sim | sim | não | Só dentro do painel, sem ruído |
| D-1 | sim (já) | sim | sim, amarelo | sim | |
| D (dia do vencimento) | sim (corrigido, R6) | sim | sim, amarelo, contador de horas | sim | De manhã, dentro da janela |
| D+1 (venceu, carência) | sim | sim | sim, vermelho, "o bot para em X" | sim | |
| Último dia de carência (D+3) | não | sim | sim, vermelho | sim | Só se a carência for maior que 1 dia |
| Suspensão (S) | sim (já) | sim | sim (já), com prazo de C | sim | |
| S+3 | sim | sim | sim | não | |
| S+7 | sim | sim | sim | sim | |
| S+15 | sim | sim | sim | não | |
| S+30 | sim | sim | sim | sim | |
| S+45 | sim | sim | sim | não | Só pagantes (teste cancela em 7) |
| C-7 | sim | sim | sim | sim | Lembra o CSV de clientes |
| C-1 | sim | sim | sim | sim | |
| Cancelamento automático (C) | sim (novo, R4) | n/a (painel só Assinatura) | sim (já) | sim | Explica 90 dias e reativação |
| Pagamento confirmado | sim (já) | sim (já, texto novo) | cartão "renovada até X" por 7 dias | sim | Sai na hora |
| Pix expirado | não | não | não | não | O tick já regera; o aviso seguinte leva o Pix novo |
| Falha ao gerar Pix (MP fora) | não | sim | sim, "gere o Pix na tela" | não | Admin recebe alerta no sino |
| Teste T-1 | sim | sim (já) | sim, com "Assinar com Pix" | sim | Texto de teste, não de fatura (R15) |
| Teste T (dia) | sim | sim | sim, contador de horas | sim | |
| Teste encerrado (suspenso) | sim (já) | sim | sim | sim | |
| Teste T+5 (C-2 do teste) | sim | sim | sim | sim | Cancela em 7 dias após a suspensão |

Carência de 1 dia (se o dono mantiver): D+1 vira a própria suspensão e a linha "último dia de
carência" some.

Para quem já pagou e está `ACTIVE` sem fatura aberta, o banner some. O cartão "Assinatura renovada até
dd/mm" aparece no topo da tela Assinatura e no sino por 7 dias depois do pagamento.

### 2.3 Textos de exemplo

Seguem `docs/guia-de-voz.md`: "você" para o dono, frases curtas, sem travessão, sem "prezado".
Variáveis entre chaves. No WhatsApp, o Pix copia e cola vai **numa mensagem separada**, sozinho, para o
dono poder tocar e copiar.

**Fatura gerada (D-5)**
- E-mail: já existe ("Sua fatura chegou"). Mantém.
- Sino: "Fatura disponível" / "{valor}, vence em {data}. Dá pra pagar com Pix pelo painel."
- Banner: "Sua fatura de {valor} vence em {data}." Botão "Pagar com Pix".
- WhatsApp 1: "Oi, {nome}! A fatura do InnoChat de {empresa} já está disponível: {valor}, com vencimento em {data}. O código Pix vai na próxima mensagem. Se preferir, pague pelo painel: {link}"
- WhatsApp 2: "{pix_copia_e_cola}"
- Rodapé da primeira mensagem do ciclo: "Não quer receber estes avisos por aqui? Responda SAIR."

**D-3**
- Sino: "Sua fatura vence em 3 dias" / "{valor} até {data}. O bot continua atendendo normalmente."
- Banner: "Sua fatura de {valor} vence em 3 dias ({data})." Botão "Pagar com Pix".

**D-1**
- E-mail: já existe ("Sua fatura do InnoChat vence amanhã"). Passa a levar o Pix vigente.
- WhatsApp: "Oi, {nome}. Passando pra lembrar que a fatura do InnoChat vence amanhã ({data}). Valor: {valor}. O Pix vai na mensagem seguinte. Se você já pagou, pode ignorar."

**D (dia)**
- E-mail, assunto: "Sua fatura do InnoChat vence hoje ({empresa})".
- Banner: "Sua fatura vence hoje. Pague até as 23h59 para o bot seguir atendendo." Botão "Pagar com Pix".
- WhatsApp: "Bom dia, {nome}! A fatura do InnoChat de {empresa} vence hoje. Assim que o Pix cair, a confirmação chega por aqui."

**D+1 (carência)**
- E-mail, assunto: "Sua fatura venceu ontem ({empresa})". Corpo: "Ainda dá tempo. O bot continua atendendo até {data_suspensao}. Depois disso ele para de responder até o pagamento."
- Banner: "Fatura vencida. O bot para de responder em {N} dias." Botão "Pagar com Pix".
- WhatsApp: "{nome}, a fatura do InnoChat venceu ontem. O bot de {empresa} continua atendendo até {data_suspensao}. Pra não parar, pague o Pix: {link}"

**Último dia de carência**
- WhatsApp: "{nome}, hoje é o último dia. Se a fatura de {valor} não for paga até a meia-noite, o bot de {empresa} para de responder seus clientes amanhã."

**Suspensão**
- E-mail: já existe. Ganha o prazo: "Se a fatura não for paga até {data_cancelamento}, a conta é encerrada."
- Banner: "Bot pausado por falta de pagamento. A conta é encerrada em {N} dias." Botão "Pagar e reativar".
- WhatsApp: "{nome}, o atendimento automático de {empresa} foi pausado porque a fatura de {valor} não foi paga. Seus clientes continuam conseguindo mandar mensagem, mas o bot não responde. Pague o Pix e ele volta em poucos minutos: {link}"

**S+3, S+15, S+45 (só e-mail e painel)**
- Assunto: "O bot de {empresa} está parado há {N} dias".
- Corpo: "Sua agenda e seus clientes continuam guardados. Para o bot voltar a responder, pague {valor} pelo painel. A confirmação é automática."

**S+7 e S+30 (também WhatsApp)**
- WhatsApp: "{nome}, o bot de {empresa} está parado há {N} dias. Está tudo guardado: agenda, clientes e serviços. Pra voltar, é só pagar {valor}: {link}. Se quiser conversar sobre o plano, chama a gente no {whatsapp_comercial}."

**C-7 e C-1**
- E-mail, assunto: "Sua conta no InnoChat será encerrada em {N} dias ({empresa})".
- WhatsApp: "{nome}, faltam {N} dias para a conta de {empresa} ser encerrada ({data}). Depois disso os números são desconectados e, 90 dias depois, os dados dos clientes são apagados. Pra manter, pague {valor}: {link}. Pra guardar a lista de clientes, exporte o CSV na tela Clientes."

**Cancelamento automático**
- E-mail, assunto: "Sua conta no InnoChat foi encerrada ({empresa})". Reaproveita `subscriptionCancelEmail` com `immediate: true` e um parágrafo próprio: "A conta foi encerrada porque a fatura ficou {N} dias sem pagamento."
- WhatsApp: "{nome}, a conta de {empresa} no InnoChat foi encerrada hoje. Os dados ficam guardados por 90 dias. Se quiser voltar, a reativação é pelo painel: {link}"

**Pagamento confirmado**
- E-mail: já existe.
- Sino: "Pagamento confirmado" / "Recebemos {valor}. Sua assinatura está renovada até {data}."
- WhatsApp: "Pagamento recebido! {valor} de {empresa}, confirmado em {data_pagamento}. Sua assinatura está renovada até {data_renovacao}. Obrigado."

**Teste T-1 e T**
- E-mail, assunto: "Seu teste do InnoChat termina amanhã ({empresa})" / "Seu teste termina hoje às {hora}".
- Banner: "Seu teste termina em {N}h." Botão "Assinar com Pix".
- WhatsApp: "Oi, {nome}! Seu teste do InnoChat termina amanhã às {hora}. Pro bot de {empresa} continuar atendendo, é só assinar com Pix: {link}"

**Teste encerrado + 5 dias**
- WhatsApp: "{nome}, a conta de teste de {empresa} será apagada em 2 dias. Se quiser continuar, assine pelo painel: {link}"

Mensagem automática quando alguém responde ao número da plataforma (no máximo 1 por contato a cada 24 h):
"Oi! Este número só envia avisos de cobrança do InnoChat. Pra falar com a gente, chama no {whatsapp_comercial}. Se não quiser mais receber avisos aqui, responda SAIR."

Resposta ao "SAIR": "Pronto, você não recebe mais avisos de cobrança por aqui. Os e-mails continuam. Pra voltar, ative em Assinatura no painel."

### 2.3.1 Sequência de conversão do teste grátis (pedido do dono, 2026-10-01)

Objetivo: quem está no teste de 3 dias **sentir o valor e assinar**. As mensagens mostram o que o InnoChat já fez pela empresa durante o teste, usando dados REAIS do próprio tenant (nada inventado): horários marcados pelo bot, conversas respondidas, lembretes enviados e clientes que voltaram a marcar. Se o número for zero, a mensagem muda para ajudar a pessoa a ligar o que falta (conectar WhatsApp, cadastrar serviço), sem cobrar.

| Momento | E | S | B | W | Mensagem (resumo) |
|---|---|---|---|---|---|
| T0 (cadastro) | sim (já: verificação) | sim | checklist de primeiros passos | não | Boas-vindas e os 3 passos para o bot funcionar hoje |
| T0 + 1 dia | sim | sim | progresso do checklist | sim, se conectou | **Resumo do primeiro dia:** "o Inno já marcou X horários e respondeu Y conversas". Se ainda não conectou, um empurrão com o passo que falta. |
| T-1 (véspera do fim) | sim | sim | contador + "Assinar com Pix" | sim | "Seu teste acaba amanhã. Até agora o Inno marcou X horários." Mostra o plano e o botão de pagar. |
| T (último dia) | sim | sim | contador de horas | sim | "Hoje é o último dia do teste. Assine para o bot não parar amanhã." |
| Suspenso (T+1) | sim (já) | sim | banner vermelho | sim | "Seu bot parou. Os X clientes que marcaram pelo WhatsApp vão ficar sem resposta. Pague o Pix e ele volta na hora." |
| T+3 | sim | sim | sim | não | Lembrete curto + o que fica guardado |
| T+5 (2 dias antes de cancelar) | sim | sim | sim | sim | Última chance: a conta é encerrada em 2 dias |

Regras:
- **Dados reais:** os números vêm de consultas ao próprio tenant (`Appointment` com origem bot, `ChatMessage` etc.) no momento do envio. Se der zero, usar a variação de "falta pouco para ligar".
- **Oferta:** nenhum desconto automático (o dono não aprovou). Se um dia houver cupom, ele entra como variável.
- **Pagou em qualquer etapa:** a sequência para na hora, e sai o "Pagamento confirmado" com "Bem-vindo, sua assinatura vale até X".
- **Mesmo motor e mesma idempotência da régua de pagantes** (`BillingNotice`, chave por ciclo do teste + etapa + canal).

### 2.3.2 Pagantes: antes, no dia e depois do vencimento (reforço do pedido do dono)

A tabela da §2.2 já cobre isso: **D-5** (fatura com Pix), **D-3** (sino e banner), **D-1**, **D** (de manhã), **D+1, D+2 e D+3** dentro da carência de 3 dias (bot ainda funcionando, com contagem regressiva), **suspensão** e os lembretes durante a suspensão até o cancelamento. Cada mensagem leva o Pix vigente e o valor. Pagou, para tudo e sai a confirmação.

### 2.4 WhatsApp da plataforma

**Decisão do dono (2026-10-01):** o número de cobrança **não** é o comercial (84) 3113-2584. O
comercial (`PlatformSettings.salesWhatsappE164`) continua só no botão "Tirar dúvidas" do site e não
muda. O dono quer conectar, desconectar e **trocar** o número de cobrança pelo Admin, quando quiser,
sem deploy e sem mexer no código.

**Por que não é uma `WhatsappInstance`:**
- `WhatsappInstance.tenantId` é obrigatório;
- o `syncN8n` reaponta o webhook de **toda** `WhatsappInstance` para o bot do n8n (`n8n-sync.ts:258-267`);
- o sino da empresa e os limites de plano contam essas linhas.

**Por que uma tabela e não colunas no `PlatformSettings`:** trocar de número precisa guardar qual
número mandou cada aviso, e a troca não pode deixar nenhum intervalo sem canal. Por isso cada número
conectado vira uma **linha** (uma "conexão"). No máximo uma fica ativa por vez, e as antigas viram
histórico.

```prisma
model PlatformWhatsappConnection {
  id               String    @id @default(cuid())
  // Nome da instância na Evolution, único por conexão e prefixado para não colidir com o
  // InnoAtendente no mesmo servidor: "innochat-plataforma-<8 chars do id>".
  instanceName     String    @unique
  webhookTokenHash String    @unique            // token do webhook próprio, só o hash em repouso
  label            String                       // "Cobrança", "Cobrança (chip novo)": livre, até 40
  status           String    @default("QRCODE") // QRCODE | CONNECTED | DISCONNECTED
  phoneE164        String?                      // preenchido ao conectar (ownerJid)
  // PENDING = QR aberto, ainda não assumiu. ACTIVE = é quem envia. RETIRED = saiu (troca ou desconexão).
  role             String    @default("PENDING")
  connectedAt      DateTime?
  disconnectedAt   DateTime?                    // queda inesperada; zera ao reconectar
  activatedAt      DateTime?
  retiredAt        DateTime?
  retiredReason    String?                      // REPLACED | DISCONNECTED_BY_ADMIN | ABANDONED_QR
  createdByUserId  String?
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt

  notices BillingNotice[]

  @@index([role])
  @@index([phoneE164])
  @@map("platform_whatsapp_connections")
}
```

Mais duas travas no banco (SQL escrito à mão na migration, porque o Prisma não gera índice parcial):
- índice único parcial `ON platform_whatsapp_connections ((true)) WHERE role = 'ACTIVE'`: impossível
  ter dois números ativos;
- o mesmo para `role = 'PENDING'`: no máximo um QR aberto por vez.

Em `PlatformSettings` fica só a chave geral `platformWhatsappEnabled Boolean @default(false)`
("Mandar avisos de cobrança pelo WhatsApp"). Com ela desligada, a régua roda só com e-mail e sino.

**Fluxos no Admin.** Card "WhatsApp da plataforma" em Admin > Configurações, separado do card
"WhatsApp comercial do site". Reaproveita o celular com QR ao vivo da tela da empresa e o mesmo
`evolution-client`.

| Ação | O que acontece |
|---|---|
| **Conectar** (sem número) | Cria a conexão `PENDING`, cria a instância na Evolution com o webhook `POST /api/webhooks/platform-whatsapp/[token]` e mostra o QR. Quando o QR é lido (`connection.update` = open), a mesma transação marca `ACTIVE` e grava `phoneE164` e `activatedAt` |
| **Trocar de número** | Cria uma conexão `PENDING` nova **enquanto a antiga continua enviando**. Quando a nova conecta, uma única transação faz a antiga `RETIRED/REPLACED` e a nova `ACTIVE`. Só depois, fora da transação, faz logout e apaga a instância antiga na Evolution (falha só é logada; o tick tenta de novo). Não existe minuto sem canal |
| **Cancelar a troca** | Apaga a conexão `PENDING` e a instância dela. A ativa nem percebe. QR aberto há mais de 30 min sem conectar vira `RETIRED/ABANDONED_QR` sozinho |
| **Desconectar** | Confirmação dupla ("os avisos passam a ir só por e-mail e pelo painel"). Logout e `RETIRED/DISCONNECTED_BY_ADMIN`. A régua segue sem WhatsApp |
| **Reconectar** (o número caiu) | A conexão `ACTIVE` com `status = DISCONNECTED` mostra um QR novo **na mesma linha** (mesmo número, mesma instância). Se o admin ler o QR com **outro** celular, o sistema percebe que `phoneE164` mudou e trata como troca: a linha antiga vira histórico e nasce uma linha nova |
| **Mensagem de teste** | Envia para um número digitado pelo admin. Fica registrada como `BillingNotice` com `step = ADMIN_TEST`, fora da régua |

Contrato (todas com `requirePlatformAdmin()`, em `src/modules/platform/platform-whatsapp-actions.ts`):

```ts
getPlatformWhatsappAction(): Result<{
  enabled: boolean;
  active: { id; label; status: "CONNECTED" | "DISCONNECTED"; phoneDisplay: string | null; activatedAt: string; disconnectedAt: string | null } | null;
  pending: { id; label; status: "QRCODE" | "CONNECTED"; createdAt: string } | null;
  history: Array<{ id; label; phoneDisplay: string | null; activatedAt: string | null; retiredAt: string; retiredReason: string; noticesSent: number }>;
}>
setPlatformWhatsappEnabledAction({ enabled: boolean }): Result<{ enabled: boolean }>
startPlatformWhatsappConnectionAction({ label: string }): Result<{ connectionId: string }>   // conectar ou trocar
getPlatformWhatsappQrAction(connectionId): Result<{ status; qrBase64: string | null; phoneDisplay: string | null }>  // poll de 3 s
cancelPlatformWhatsappConnectionAction(connectionId): Result<{ canceled: boolean }>           // só PENDING
disconnectPlatformWhatsappAction({ confirm: "DESCONECTAR" }): Result<{ retired: boolean }>
sendPlatformWhatsappTestAction({ toE164: string }): Result<{ sent: boolean; errorCode?: string }>
```

Erros: `FORBIDDEN`, `INVALID_STATE` (trocar com outro QR já aberto; desconectar sem número ativo),
`EVOLUTION_UNAVAILABLE`, `RATE_LIMITED` (10 ações por 10 min). No histórico o número aparece
mascarado ("+55 84 9****-1234"); inteiro, só no card do número ativo.

**Trocar de número sem perder histórico nem duplicar lembrete:**
- A idempotência da régua **não depende do número**: a chave é `(cycleKey, step, channel)` em
  `BillingNotice`. O lembrete D-1 enviado pelo número antigo continua `SENT` depois da troca, e o
  número novo nunca o reenvia.
- Cada `BillingNotice` de WhatsApp grava `platformConnectionId` e `senderPhoneE164` (cópia do número
  no momento do envio). A linha do tempo da empresa mostra "Lembrete de véspera enviado por WhatsApp
  (número anterior, final 1234)". Conexões nunca são apagadas, só aposentadas.
- O despachante resolve a conexão `ACTIVE` **no momento do claim** de cada aviso. Um aviso que estava
  `SENDING` pela conexão antiga quando ela foi aposentada termina com o resultado que a Evolution
  devolver. Se a Evolution recusar porque a instância saiu, vira `FAILED`, e a nova tentativa sai pelo
  número novo na mesma linha, sem duplicar.
- Opt-in e opt-out são da **empresa**, não do número. Quem aceitou receber avisos continua aceitando
  depois da troca; quem respondeu SAIR para o número antigo continua fora.
- **Primeira mensagem de um número novo:** se o último WhatsApp que a empresa recebeu veio de outro
  `senderPhoneE164`, a mensagem começa com "Este é o novo número de avisos do InnoChat. O anterior não
  envia mais mensagens." Assim o assinante não desconfia de golpe.
- A trava anti-loop do claim (abaixo) considera **todos** os números que já foram da plataforma, não
  só o ativo: o chip antigo pode continuar com WhatsApp em algum aparelho.

**Webhook próprio, nunca o n8n:** `POST /api/webhooks/platform-whatsapp/[token]` confere o hash do
token contra a conexão. Token de conexão `RETIRED` recebe 410 e é ignorado. Trata `connection.update`
(status e queda) e `messages.upsert` (resposta de assinante: "SAIR" e a mensagem automática). Toda
resposta de assinante vira item no sino do Admin.

**Guarda contra loop (importante):** muitos donos de salão usam o próprio celular como número do bot.
O aviso da plataforma chega nesse número, o bot da empresa responde com o menu, e a mensagem
automática da plataforma responderia de volta. Três travas:
1. o `POST /messages/claim` ignora mensagens cujo remetente está em
   `PlatformWhatsappConnection.phoneE164` (qualquer papel), com o motivo novo `PLATFORM_SENDER`. A
   lista fica em cache de 60 s e é invalidada quando um número é ativado;
2. a mensagem automática da plataforma sai no máximo 1 vez por contato a cada 24 h;
3. a plataforma nunca responde automaticamente a um número que seja `WhatsappInstance.phoneE164` de
   alguma empresa.

**Sem número conectado, ou com o número caído, a régua não quebra.**
- O planejador continua criando as etapas de WhatsApp de quem deu opt-in. Sem conexão `ACTIVE` +
  `CONNECTED`, o despachante marca:
  - etapa não crítica: `SKIPPED` com `skipReason = NO_PLATFORM_NUMBER` (nunca configurado ou
    desconectado pelo admin) ou `CHANNEL_DOWN` (há número ativo, mas ele caiu);
  - etapa crítica (D, D+1, suspensão, C-7, C-1, cancelamento): fica `PENDING` por até 12 h esperando
    a reconexão, sempre dentro da janela de horário, e depois vira `SKIPPED`.
- E-mail e sino seguem iguais, porque são etapas independentes (outro `channel`).
- Sino do Admin, com itens derivados do estado (mesmo padrão de `platform-notifications`):
  - `PLATFORM_WHATSAPP_MISSING` ("WhatsApp da plataforma sem número"): chave ligada e nenhuma conexão
    `ACTIVE`. Mostra quantos avisos foram pulados nas últimas 24 h;
  - `PLATFORM_WHATSAPP_DISCONNECTED` ("WhatsApp da plataforma caiu"): número ativo com
    `status = DISCONNECTED`. Id `pwa:<connectionId>:<disconnectedAt ms>`, volta como não lido a cada
    nova queda;
  - `PLATFORM_WHATSAPP_REPLY`: um assinante respondeu ao número.
- A tela Saúde ganha a linha "WhatsApp da plataforma" (conectado, caído, sem número, desligado). No
  `/api/health/billing` ela entra só como aviso, nunca como 503: sem WhatsApp, a cobrança continua
  funcionando.
- O tick confere o estado na Evolution a cada rodada (`connectionState` da instância ativa), porque o
  `connection.update` pode se perder.

**Ritmo anti-bloqueio:** o mesmo padrão do lembrete de véspera (`reminders/tick.ts`): teto por rodada
(30), intervalo sorteado de 3 a 8 s entre envios e orçamento de tempo dentro do tick. Mensagem curta,
sem link encurtado, sempre com o nome da empresa e do dono. Só envia para quem deu opt-in. Número
recém-conectado começa com teto menor (10 por rodada nos primeiros 3 dias), porque número novo
mandando volume é o perfil que o WhatsApp mais bloqueia.

**Opt-in e opt-out:** o dono da empresa informa o WhatsApp de cobrança e marca "Quero receber avisos
de cobrança no WhatsApp" na tela Assinatura. Para quem já é cliente, começa desligado. No cadastro
novo, começa ligado com o telefone que o cadastro pede, com texto claro. Opt-out pela mesma chave ou
respondendo SAIR a qualquer número da plataforma. O e-mail de cobrança não tem opt-out: é
transacional e está no contrato.

**Orientação ao dono sobre o número** (não é decisão de arquitetura; ele conecta o número que
quiser): um chip dedicado só para avisos isola o risco de bloqueio. Se o volume passar de algumas
centenas de assinantes, ou se houver bloqueio, a API oficial da Meta (Cloud API) entra como outro
adaptador. O canal fica atrás da interface `BillingWhatsappChannel { send(to, text) }`, então o motor
da régua não muda.

### 2.5 Regras de robustez

**Motor em duas etapas (outbox no Postgres).**

1. **Planejador (puro).** `src/core/billing/dunning.ts`: `planNotices(snapshot, now, policy)` recebe
   assinatura, fatura aberta, fuso e preferências da empresa e devolve as etapas devidas
   (`{ step, channel, cycleKey, notBefore }`). Sem I/O. Testável com relógio fixo, igual a
   `effectiveStatus`.
2. **Gravação idempotente.** O tick grava cada etapa com `INSERT ... ON CONFLICT DO NOTHING` na tabela
   `BillingNotice` (abaixo). Rodar duas vezes não cria duas linhas.
3. **Despachante.** Pega linhas `PENDING` com `nextAttemptAt <= now` usando
   `UPDATE ... SET status='SENDING' ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED LIMIT n)
   RETURNING *` (dois ticks nunca pegam a mesma linha). Reconfere o estado, envia e grava `SENT`,
   `FAILED` (com próxima tentativa) ou `SKIPPED` (com motivo).

```prisma
model BillingNotice {
  id             String   @id @default(cuid())
  tenantId       String
  subscriptionId String
  invoiceId      String?            // nulo nas etapas de teste e de suspensão sem fatura
  step           String             // INVOICE_CREATED | DUE_D3 | DUE_D1 | DUE_D0 | OVERDUE_D1 | GRACE_LAST |
                                    // SUSPENDED | SUSPENDED_D3 | SUSPENDED_D7 | ... | CANCEL_WARN_D7 |
                                    // CANCEL_WARN_D1 | AUTO_CANCELED | PAYMENT_CONFIRMED |
                                    // TRIAL_T1 | TRIAL_T0 | TRIAL_CANCEL_WARN
  channel        String             // EMAIL | WHATSAPP
  cycleKey       String             // invoiceId, ou "<subscriptionId>:<inicio da suspensao ISO>", ou "<subscriptionId>:trial"
  status         String   @default("PENDING") // PENDING | SENDING | SENT | FAILED | SKIPPED
  skipReason     String?            // PAID | STATUS_CHANGED | NO_RECIPIENT | OPTED_OUT | NO_PLATFORM_NUMBER | CHANNEL_DOWN | OUT_OF_WINDOW_EXPIRED | PERMANENT_REJECTION | LEGACY_SENT
  attempts       Int      @default(0)
  notBefore      DateTime           // início da janela
  expiresAt      DateTime           // depois disso não faz mais sentido enviar
  nextAttemptAt  DateTime
  lastErrorCode  String?            // só código, nunca mensagem do provedor (pode trazer e-mail/telefone)
  recipientMasked String?           // "jo***@gmail.com", "+55 84 9****-1234"
  providerMessageId String?
  platformConnectionId String?       // WhatsApp: qual número da plataforma enviou (FK para PlatformWhatsappConnection)
  senderPhoneE164   String?          // cópia do número no envio: trocar de número não apaga o histórico
  sentAt         DateTime?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@unique([cycleKey, step, channel])
  @@index([status, nextAttemptAt])
  @@index([tenantId, createdAt])
  @@map("billing_notices")
}
```

`step`, `channel` e `status` como `String` validados no código (união TS), e não `enum` do Postgres:
`ALTER TYPE ADD VALUE` não roda na mesma transação da migration e a régua vai ganhar etapas.

- **Nova tentativa com espera crescente:** 5 min, 30 min, 2 h, 6 h, até `expiresAt`. Teto de 5
  tentativas. Rejeição permanente (4xx da Evolution que não seja 408/429; e-mail recusado pelo
  servidor de destino com 5xx SMTP) vira `SKIPPED/PERMANENT_REJECTION` sem repetir, mesmo critério de
  `isPermanentSendRejection` (`reminders/tick.ts`).
- **`sendMail` passa a ser lido:** `{ sent: false }` ou `SmtpNotConfiguredError` = `FAILED`, nunca
  `SENT`. Isso fecha R1, R2 e R3.
- **Fallback de canal:** e-mail sempre sai (canal base). WhatsApp é complementar. Se uma etapa
  **crítica** (D, D+1, suspensão, C-7, C-1, cancelamento) falhar em **todos** os canais até expirar,
  o sino do Admin recebe `BILLING_NOTICE_UNDELIVERED` com a empresa e a etapa, para o dono da
  plataforma ligar ou mandar mensagem à mão.
- **Pix sempre vigente:** antes de enviar um aviso que leva Pix, o despachante regera o Pix se ele
  expira em menos de 24 h (reaproveita `regeneratePixForInvoice`). Se o MP estiver fora, o texto troca
  o código por "gere o Pix pelo painel: {link}". Fecha R7.
- **Transição sem duplicar no dia do deploy:** o planejador trata `dueReminderEmailSentAt`,
  `dueTodayEmailSentAt` e `suspendedEmailSentAt` já preenchidos como `SKIPPED/LEGACY_SENT`. As colunas
  ficam (sem migration destrutiva) e deixam de ser escritas depois da Fase 2.
- **Tick sem sobreposição:** `pg_try_advisory_lock` no início de `runBillingTick`; se outro tick está
  rodando, sai na hora e loga. Fecha R8.
- **Monitoramento do tick (R9):**
  - já existe: `TICK_LATE` no sino do Admin e alerta na Saúde;
  - novo: rota `GET /api/health/billing` que responde 503 se `lastBillingTickAt` passou de 2 h, ou se
    há avisos críticos `FAILED` há mais de 6 h. **Não** é a `/api/health` do container (essa derrubaria
    o painel no Easypanel por causa de um cron parado);
  - um monitor externo gratuito (UptimeRobot ou similar, decisão D8) consulta essa rota a cada 5
    minutos e avisa o dono por e-mail/app. É o único jeito de saber que o n8n morreu sem depender do
    próprio n8n nem do próprio painel;
  - sino do Admin ganha `PLATFORM_WHATSAPP_DISCONNECTED` e `BILLING_EMAIL_FAILING` (3 ou mais
    e-mails de cobrança `FAILED` na última hora: SMTP com problema).
- **Destinatário configurável (R10):** `Tenant.billingEmail` (opcional). Regra recomendada (decisão
  D4): vai para o e-mail de cobrança e também para o dono nas etapas críticas, sem repetir se forem o
  mesmo endereço. Sem `billingEmail`, segue o OWNER mais antigo como hoje.
- **Privacidade:** log e `lastErrorCode` nunca levam e-mail, telefone, corpo da mensagem ou código
  Pix. `recipientMasked` serve para o suporte conferir "foi para o endereço certo?" sem expor o dado.

---

## 3. Visão financeira no Admin

Nova tela `/admin/financeiro` (ou aba no topo de Cobrança; a Lyra propõe e o dono escolhe). Todas as somas no
fuso `America/Sao_Paulo` (corrige R14), por agregação no banco, sem loop em memória.

### 3.1 Contrato

```ts
getFinanceOverviewAction(): Result<{
  asOf: string;                       // ISO
  mrrCents: number;                   // soma do preço do plano de ACTIVE + PAST_DUE (efetivo), sem teste
  subscribers: { trialing: number; active: number; pastDue: number; suspended: number; canceledThisMonth: number };
  receivedThisMonthCents: number;     // PAID com paidAt no mês local
  receivedLastMonthCents: number;
  upcoming: { next7: { count: number; cents: number }; next30: { count: number; cents: number } };
                                      // ACTIVE sem cancelamento agendado, por currentPeriodEnd
  delinquency: { count: number; cents: number; over30DaysCount: number };
                                      // faturas OPEN vencidas de quem já pagou (regra do dono: teste não entra)
  churn: { canceledCount: number; voluntary: number; involuntary: number; ratePct: number | null };
                                      // ratePct = cancelados no mês / pagantes ativos no início do mês
  recoveredThisMonth: { count: number; cents: number };
                                      // pagamentos feitos em PAST_DUE/SUSPENDED: mede se a régua funciona
}>

getCompanyBillingAction(tenantId): Result<{
  company: { id; name; slug; planName; status; currentPeriodEnd; firstPaidAt; billingEmailMasked; whatsappOptIn: boolean };
  invoices: AdminInvoiceListItem[];   // reaproveita listInvoicesAdmin({ tenantId })
  lifetimeValueCents: number;
}>

listCompanyBillingTimelineAction(tenantId, { cursor? }): Result<{
  items: Array<{
    at: string;
    kind: "NOTICE" | "EVENT";
    // NOTICE: step, channel, status, skipReason, recipientMasked, attempts
    // EVENT: type (STATUS_CHANGED | INVOICE_CREATED | PAYMENT_CONFIRMED | PIX_REGENERATED |
    //        PLAN_CHANGED | CANCEL_REQUESTED | CANCEL_UNDONE | REACTIVATION_STARTED | MANUAL_PAYMENT |
    //        MANUAL_SUSPEND | MANUAL_REACTIVATE | TRIAL_EXTENDED), from?, to?, actor
    label: string;                    // frase pronta: "Lembrete de véspera enviado por WhatsApp"
  }>;
  nextCursor: string | null;
}>

GET /api/admin/finance/invoices.csv?from=YYYY-MM-DD&to=YYYY-MM-DD&status=PAID|OPEN|VOID
  // requirePlatformAdmin; colunas: empresa, documento, plano, competência, vencimento, valor,
  // status, pago em, forma (PIX | MANUAL), id da fatura, id do pagamento MP.
  // Células que começam com = + - @ recebem apóstrofo (injeção de fórmula). Teto de 12 meses por arquivo.
```

### 3.2 Histórico que falta (R13)

Churn e linha do tempo precisam de histórico. Proposta: tabela append-only `BillingEvent`
(`tenantId`, `subscriptionId`, `invoiceId?`, `type`, `fromStatus?`, `toStatus?`, `actorType`
SYSTEM|OWNER|ADMIN, `actorUserId?`, `metadata Json?`, `createdAt`). Escrita nos pontos que já mudam
estado: `reconcileStatuses`, `persistCanceledTransition`, `applyInvoicePayment`, `requestCancellation`,
`undoCancellation`, `startReactivation`, `changePlan`, ações manuais do admin. Para o passado, uma
carga inicial deriva eventos aproximados de `Invoice.paidAt`, `Subscription.canceledAt` e
`firstPaidAt` (marcados `metadata.backfill = true`).

`cancelSource` (voluntário x involuntário) sai do `BillingEvent` do cancelamento: `OWNER` (voluntário),
`AUTO_SUSPENDED` e `TRIAL_NOT_CONVERTED` (involuntário), `ADMIN`.

### 3.3 Para a empresa (tela Assinatura)

- Lista de pagamentos (data, valor, período, "ver recibo") reaproveitando a consulta de faturas.
- Formulário "Contato de cobrança": e-mail de cobrança, WhatsApp de cobrança, chave de opt-in.
- Ajuda ⓘ com exemplos em tudo que for novo (regra do dono).

```ts
updateBillingContactAction(tenantSlug, {
  billingEmail: string | null;        // e-mail válido ou null (volta para o dono)
  billingWhatsapp: string | null;     // E.164 BR, 12-13 dígitos
  whatsappOptIn: boolean;
}): Result<{ billingEmail: string | null; billingWhatsapp: string | null; whatsappOptIn: boolean }>
// requireTenantMember(slug, ["OWNER"]); erros: FORBIDDEN, INVALID_PAYLOAD, RATE_LIMITED (10/h).
// Liga opt-in só com telefone preenchido. Grava optInAt/optOutAt (prova de consentimento, LGPD).

listOwnInvoicesAction(tenantSlug, { cursor? }): Result<{ items: Array<{ id; amountCents; periodStart; periodEnd; dueAt; status; paidAt }>; nextCursor }>

getBillingBannerState(tenantId): {   // função de servidor chamada pelo layout que já monta o PanelShell
  status: SubscriptionStatus;
  openInvoice: { amountCents: number; dueAt: string } | null;
  suspendsAt: string | null;          // PAST_DUE
  cancelsAt: string | null;           // SUSPENDED
  trialEndsAt: string | null;
  renewedUntil: string | null;        // pagamento confirmado nos últimos 7 dias
}
```

---

## 4. Plano faseado

Estimativa relativa: P (até meio dia de agente), M (1 dia), G (2 dias ou mais). Toda publicação sobe a
versão (semver, CHANGELOG, tag) e faz build limpo no HEAD antes do push.

| Fase | O quê | Dono | Depende de | Tam. |
|---|---|---|---|---|
| **F0** Correção urgente | Ler o retorno de `sendMail` antes de marcar (R1-R3); "vence hoje" restrito a 24 h depois do vencimento; e-mail no cancelamento automático (R4); `pg_try_advisory_lock` no tick (R8); descrição do MP sem travessão (R16). Sem migration | Vega, Íris | nada | P |
| **F1** Migrations aditivas | `BillingNotice`, `BillingEvent`, `Tenant.billingEmail/billingWhatsappE164/billingWhatsappOptInAt/billingWhatsappOptOutAt`, `PlatformWhatsappConnection` (com os dois índices únicos parciais em SQL), `PlatformSettings.platformWhatsappEnabled`, `BillingNotice.platformConnectionId/senderPhoneE164`. Só `CREATE TABLE`, `CREATE INDEX` e `ADD COLUMN` nulo ou com default | Cronos | D4 (só nomes) | P |
| **F2** Motor da régua (e-mail) | `planNotices` puro + política em `src/core/billing/dunning-policy.ts`; despachante; templates novos (D+1, S+N, C-7, C-1, cancelamento automático, teste T-1/T); migração das 3 marcas antigas; `BillingEvent` nos pontos de mudança | Vega (Íris testa o planejador com relógio fixo, tabela de casos) | F1, D2, D3 | G |
| **F3** Painel da empresa | Sino derivado (`INVOICE_OPEN`, `INVOICE_DUE`, `INVOICE_OVERDUE`, `SUBSCRIPTION_SUSPENDED`, `CANCEL_WARNING`, texto novo de `PAYMENT_CONFIRMED`; incluir prefixos em `KEY_PATTERN`, `notifications/service.ts:47`); banner novo com contador e "Pagar com Pix"; histórico de pagamentos; formulário de contato de cobrança; ajuda ⓘ | Lyra (UI), Vega (`getBillingBannerState`, actions) | F1. Pode rodar junto com F2 | M |
| **F4** WhatsApp da plataforma (conectar e trocar pelo Admin) | **Vega:** as 7 actions da §2.4; estados PENDING, ACTIVE e RETIRED com troca atômica; logout da instância antiga fora da transação, com nova tentativa no tick; webhook próprio com token por conexão (410 para conexão aposentada); SAIR e mensagem automática; trava `PLATFORM_SENDER` com todos os números já usados; `connectionState` conferido no tick; QR abandonado em 30 min; itens `PLATFORM_WHATSAPP_MISSING/DISCONNECTED/REPLY` no sino do Admin e linha na Saúde. **Lyra:** card "WhatsApp da plataforma" separado do comercial (celular com QR, status, Trocar número, Cancelar troca, Desconectar com confirmação, teste, histórico de números) com ajuda ⓘ. **Íris:** troca sem intervalo sem canal, troca sem aviso duplicado, queda com fallback para e-mail, loop com bot de empresa | Vega, Lyra, Íris | F1. Não depende do número escolhido: testa com instância sandbox, e o dono conecta o dele depois | M |
| **F5** Canal WhatsApp na régua | `BillingWhatsappChannel` resolvendo a conexão ativa no claim; janela; ritmo (teto menor para número novo); opt-in; aviso de "novo número"; fallback (`NO_PLATFORM_NUMBER`/`CHANNEL_DOWN`, críticos esperam 12 h); `BILLING_NOTICE_UNDELIVERED` | Vega | F2, F4 | M |
| **F6** Visão financeira | `getFinanceOverviewAction`, detalhe da empresa com linha do tempo, CSV, carga inicial de `BillingEvent`, correção do fuso (R14) | Vega (consultas), Lyra (telas) | F1; linha do tempo completa depois de F2 | M |
| **F7** Vigilância e revisão | `/api/health/billing` + monitor externo; Órion revisa webhook da plataforma (token, replay), CSV (injeção, autorização), dados pessoais em log, opt-out; Íris E2E da régua com relógio controlado | Vulcano, Órion, Íris | F2 a F6 | M |
| **F8** Documentação | `contratos.md` (seções novas), `manual-do-cliente.md` (avisos e opt-out), runbook ("o que fazer quando o tick para", "WhatsApp de avisos caiu") | Alexandria (conferir caminhos citados antes do commit) | F7 | P |

**Paralelismo:** F0 sai já, sozinha. Depois de F1: F2, F3 e F4 em paralelo (contratos acima fecham a
fronteira). F6 (métricas) também começa depois de F1. F5 junta F2 e F4.

**Caminho crítico:** F1, F2, F5, F7. Com o dono decidindo D2 a D4 logo, F0 a F3 entregam a régua
completa por e-mail e painel. O WhatsApp entra com F4+F5 e passa a funcionar no minuto em que o dono
conectar um número pelo Admin. Até lá, a régua segue por e-mail e sino, com o alerta no sino do Admin.

**Ordem de publicação sugerida:** F0 (v1.3.2), F1+F2+F3 (v1.4.0), F4+F5 (v1.5.0), F6 (v1.6.0), F7 e F8 junto da última.

---

## 5. Riscos e dívidas conscientes

- **Bloqueio do número de avisos** (Baileys não é oficial). Mitigação: opt-in, ritmo lento, teto
  menor para número novo, poucos envios por ciclo, e-mail como canal base e interface pronta para a
  API oficial. Se o número for bloqueado, o dono conecta outro pelo Admin, sem deploy (§2.4).
- **Troca de número com o chip antigo ainda ativo:** o assinante pode responder ao número antigo e
  ninguém ver. Mitigação: a primeira mensagem do número novo avisa a troca, e o número antigo continua
  na trava anti-loop. Atender o chip antigo fica por conta do dono, fora do sistema.
- **Loop com o bot da empresa** quando o dono usa o próprio celular como número do bot. Mitigação:
  as três travas da §2.4. A Íris precisa de um teste específico para isso.
- **Mudar a carência mexe em quem já está atrasado** no dia do deploy: com 3 dias, quem foi
  suspenso há menos de 3 dias volta a `PAST_DUE` e o bot volta a responder. É benéfico, mas o dono
  precisa saber. Exige separar `GRACE_DAYS` em pagante e teste em `status.ts` (função pura, testes em
  `core/billing/__tests__/status.test.ts`).
- **Normalizar o vencimento para 23:59 local** (D7) mexe em `currentPeriodEnd`. Regra: só **adiar**,
  nunca adiantar, para nenhum cliente perder horas pagas.
- **Churn do passado é aproximado** (carga inicial derivada). Os números confiáveis começam no dia
  em que `BillingEvent` entra no ar. A tela deve dizer isso.
- **Política da régua no código** (constantes) e não editável no Admin na primeira versão. Dívida
  consciente: o dono muda os dias pedindo à equipe. Tela de régua editável fica para depois, se ele
  quiser mexer com frequência.
- **MRR muda de definição** (passa a incluir `PAST_DUE`). O card atual (`admin-service.ts:314`) conta
  só `ACTIVE` persistido. Vai ficar documentado na ajuda ⓘ do card.

---

## 6. Decisões para o dono

### Decididas pelo dono em 2026-10-01

- **D1, número de cobrança:** número dedicado, conectado e trocado pelo Admin quando o dono quiser. Nunca o comercial (84) 3113-2584.
- **D2, régua:** vale a tabela da §2.2. O dono aceitou a régua recomendada como base.
- **D3, carência:** 3 dias para quem paga, 1 dia no teste.
- **D4, e-mail de cobrança:** campo opcional (`Tenant.billingEmail`). O dono continua recebendo as etapas críticas.
- **D5, WhatsApp de cobrança:** **ativado para todos** os assinantes (sem pedir opt-in), com opção de desligar (opt-out) na tela Assinatura. A trava de horário (D9) e os tetos de envio continuam valendo.
- **D9, janela do WhatsApp:** das 09h às 19h, de segunda a sábado. No domingo, só os avisos críticos (suspensão e cancelamento).
- **D10, texto do Pix:** sem travessão (feito na F0).
- **D6, D7 e D8:** seguem as recomendações do plano até o dono dizer o contrário: cancelar após 60 dias suspensa, vencimento às 23:59 do dia local e UptimeRobot como monitor externo.


| # | Decisão | Opções | Recomendação |
|---|---|---|---|
| D1 | ~~Número do WhatsApp de avisos~~ | | **Decidido pelo dono em 2026-10-01:** não é o comercial (84) 3113-2584, que fica só no site. O número de cobrança é conectado e trocado pelo próprio dono em Admin > Configurações (§2.4). Nada pendente de arquitetura |
| D2 | Dias da régua | Tabela da §2.2 | Aprovar a §2.2. WhatsApp só em D-5, D-1, D, D+1, último dia de carência, suspensão, S+7, S+30, C-7, C-1, cancelamento, pagamento e teste. O resto fica no e-mail e no painel |
| D3 | Carência antes de suspender | 1 dia (hoje), 3 dias, 5 dias | **3 dias para pagante, 1 dia para teste.** Pix pontual depende de o dono lembrar; 1 dia suspende quem esqueceu num fim de semana. Teste continua curto para não virar teste grátis estendido |
| D4 | E-mail de cobrança separado | só o dono; só o financeiro; os dois | **Campo opcional de e-mail de cobrança.** Se preenchido, recebe tudo; o dono também recebe as etapas críticas |
| D5 | Opt-in do WhatsApp para quem já é cliente | ligar para todos; pedir na tela | **Pedir na tela** (banner único "Receba os avisos de cobrança no WhatsApp"). Mensagem sem consentimento aumenta denúncia e risco de bloqueio |
| D6 | Prazo até o cancelamento automático | 60 dias (hoje), 30, 90 | **Manter 60.** Com lembretes em S+3/7/15/30/45 e C-7/C-1, há sete chances de recuperar |
| D7 | Vencimento às 23:59 do dia local | manter o instante do cadastro; normalizar | **Normalizar**, só adiando. "Vence hoje" passa a ser verdade e a suspensão acontece num horário previsível |
| D8 | Monitor externo do tick | UptimeRobot (grátis), Better Stack, nenhum | **UptimeRobot** consultando `/api/health/billing` a cada 5 min, com aviso no celular do dono |
| D9 | Janela do WhatsApp | 09h-19h todos os dias; 09h-19h sem domingo; 08h-20h | **09h-19h de segunda a sábado; no domingo, só avisos críticos** (D, suspensão, C-1). Salão e barbearia trabalham no sábado |
| D10 | Mensagem no Pix do MP | manter; trocar | Trocar para "Assinatura InnoChat ({empresa})", sem travessão |
