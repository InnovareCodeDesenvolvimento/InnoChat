# Runbook — Operação InnoChat

Manual de operação para o dono/admin da plataforma. Cobre monitoramento, incidentes, backup e procedimentos de manutenção.

---

## Índice

1. [Rotinas automáticas](#rotinas-automáticas)
2. [Monitorar a saúde](#monitorar-a-saúde)
3. [Incidentes comuns](#incidentes-comuns)
4. [Rotação de segredos](#rotação-de-segredos)
5. [Backup e restauração](#backup-e-restauração)
6. [Rollback de deploy](#rollback-de-deploy)
7. [Publicar nova versão dos termos](#publicar-nova-versão-dos-termos)

---

## Rotinas automáticas

O InnoChat executa três tarefas automáticas, todas via workflow `innochat-cron` no n8n:

### Faturamento horário (`billing/tick`)

**Frequência:** a cada hora (minuto 5)

**O que faz:**
- Gera novas faturas para empresas cujo período está vencendo (5 dias antes)
- Gera QR Pix para faturas abertas (válido por 3 dias)
- Marca faturas como `EXPIRED` se o Pix venceu sem pagamento
- Atualiza o status da assinatura: `TRIALING` → `ACTIVE` (se pagou), `ACTIVE` → `PAST_DUE` (se venceu), `PAST_DUE` → `SUSPENDED` (após 1 dia de carência)
- Envia e-mails de aviso (geração, 1 dia antes do vencimento, no vencimento)
- **Teste não convertido** (nunca pagou): suspende 1 dia após o fim do teste (e-mail "Seu teste terminou") e **cancela 7 dias depois**; a fatura do teste vira `VOID` ("Anulada") e nunca conta como inadimplência. Quem já pagou alguma vez continua com 60 dias em `SUSPENDED`.

**Logs:** vá em **Admin → Saúde** e veja a seção "Último tick de cobrança" — deve mostrar um timestamp recente. Se estiver estagnado, há um problema.

**Quando rodar:** todo dia, 24/7 automaticamente. Se o cron falhar, `effectiveStatus()` ainda calcula status correto sob demanda, então acesso não é bloqueado — mas faturas não são geradas.

**Admin → Cobrança e teste:** a fatura do cadastro aparece com o badge "Teste" e soma só no card **Em teste** (nunca em "Em aberto" nem "Vencido"; também não lista a empresa como inadimplente). Se um cliente pagar depois de a conta ser cancelada (fatura `VOID`), o webhook **não reativa sozinho**: registra o evento (`voidedInvoicePayment`), loga `billing.webhook.payment_for_void_invoice` e ignora. Ação: **Admin → Empresas → Reativar** e conferir/estornar o pagamento no Mercado Pago.

**Deploy da migration `20260929180000_trial_invoice_first_paid`** (aditiva, segura com o código antigo): rode `prisma migrate deploy` ANTES do push. Enquanto o código antigo ainda atende, cadastros novos nascem sem o marcador `isTrialConversion` e pagamentos não gravam `firstPaidAt`. Depois que o deploy novo estiver no ar, reexecute o backfill (idempotente) no banco:

```sql
UPDATE "subscriptions" s SET "firstPaidAt" = p.first_paid
FROM (SELECT "subscriptionId", MIN("paidAt") AS first_paid FROM "invoices" WHERE "status"='PAID' AND "paidAt" IS NOT NULL GROUP BY "subscriptionId") p
WHERE p."subscriptionId" = s."id" AND s."firstPaidAt" IS NULL;

UPDATE "invoices" i SET "isTrialConversion" = true
FROM (SELECT DISTINCT ON ("subscriptionId") "id" FROM "invoices" ORDER BY "subscriptionId","periodStart" ASC) f
WHERE f."id" = i."id" AND i."isTrialConversion" = false;
```

### Manutenção diária (`maintenance/tick`)

**Frequência:** diariamente às 03:15 (horário do servidor)

**O que faz:**
- Purga `InboundEvent` mais antigos que 30 dias (LGPD)
- Anonimiza contatos de tenants `CANCELED` há mais de 90 dias (apaga nome, número, tudo)
- Processa em lotes de 500 para não sobrecarregar

**Resposta esperada:**
```json
{
  "inboundEventsPurged": 1234,
  "contactsAnonymized": 5
}
```

**Logs:** **Admin → Saúde** mostra "Última manutenção" — se estiver vermelho ou vazio, avisa.

### Sincronização n8n (manual)

**Quando:** após editar URLs ou regenerar segredo interno da API

**Como:** vá em **Admin → Configurações da plataforma**, clique em **"Sincronizar n8n"**. Isso:
- Reescreve os placeholders (`painelUrl`, `evolutionUrl`, `n8nApiUrl`) nos nós `Config` dos workflows
- Reaplica as credenciais (redireciona para a interface do n8n)

Se o n8n estiver offline, a sincronização falha; tente de novo mais tarde.

---

## Monitorar a saúde

Vá em **Admin → Saúde** (tela reservada para visualizar status em tempo real).

### Seções

1. **Status geral**
   - URL do painel (descoberta automaticamente)
   - Última execução do `billing/tick` e `maintenance/tick`
   - Bot ativo/inativo

2. **Instâncias WhatsApp**
   - Lista de todas as instâncias conectadas
   - Status: `CONNECTED`, `DISCONNECTED`, `QRCODE_WAITING`
   - Se alguma estiver `DISCONNECTED`, aparece um aviso — a empresa precisa reconectar

3. **Eventos com erro**
   - `InboundEvent` que chegaram com problemas (ex.: remetente desconhecido, mensagem descarapada)
   - Helpful para diagnosticar problemas de Evolution

4. **Mensagens ocupadas**
   - Quantas mensagens ficaram esperando porque a sessão estava travada
   - Se esse número crescer muito nas últimas 24h, há concorrência anormal — investigar

5. **Saúde do n8n**
   - Últimas execuções com erro dos workflows (bot, cron, erros)
   - Links para abrir no n8n

### API de saúde

```bash
GET /api/health
```

Resposta esperada:
```json
{
  "status": "ok",
  "database": "connected",
  "n8n": "connected",
  "timestamp": "2026-09-28T22:15:30Z"
}
```

Se o banco ou n8n estiver indisponível, o status fica `degraded` ou `error`.

### Monitor externo da cobrança (UptimeRobot)

A cobrança depende de uma rotina que roda de hora em hora no n8n. Se ela para, ninguém é cobrado e nada avisa por dentro do sistema: o aviso por e-mail e o sino do Admin dependem do próprio InnoChat e do mesmo n8n. Por isso existe um monitor **de fora**, que não passa por este sistema. **Ele é a garantia real.** O e-mail e o sino são reforço.

**O que ele vigia:** `GET https://innochat.innovarecode.com.br/api/health/billing`. Endereço público, sem login e sem dado de cliente: só o status e números somados. Resposta:

| Campo | Significado |
|---|---|
| `status` | `ok`, `degraded` (aviso) ou `down` (parado) |
| `lastTickAt`, `minutesSinceLastTick` | quando foi a última rodada de cobrança e há quantos minutos |
| `lastTickResult` | `sent` e `failed` da última rodada (e `deadlineReached` se parou por tempo) |
| `pendingOverdue` | avisos que passaram da hora de sair há mais de 2 horas |
| `failedLast24h` | avisos com falha nas últimas 24 horas |
| `emailFailing` | `true` se há e-mail de cobrança falhando |
| `platformWhatsapp` | `connected`, `disconnected`, `missing` ou `disabled` |
| `reasons` | códigos do motivo (por exemplo `TICK_STALE`) |

- **HTTP 200** quando `ok` ou `degraded`. O WhatsApp de cobrança caído é só aviso, porque os avisos seguem por e-mail.
- **HTTP 503** quando `down`: a rotina não roda há mais de 3 horas, há aviso de e-mail vencido e preso (mais de 2 horas), ou os e-mails estão falhando rodada após rodada. O 503 também sai se o banco não responder.

**Criar o monitor (quem faz é o dono, a conta é dele):**

1. Crie a conta grátis em uptimerobot.com e confirme o e-mail.
2. Clique em **Add New Monitor** (ou **+ New monitor**).
3. Em **Monitor Type**, escolha **HTTP(s)**.
4. **Friendly Name:** `InnoChat - Cobrança`.
5. **URL:** `https://innochat.innovarecode.com.br/api/health/billing`
6. **Monitoring Interval:** **5 minutes** (é o mais curto do plano grátis).
7. Em **Alert Contacts To Notify**, marque o seu **e-mail**. Para o celular, instale o app **UptimeRobot** (Android ou iPhone), entre com a mesma conta e ative as notificações do aplicativo. Ele aparece como contato de alerta por push; marque-o também.
8. Salve com **Create Monitor**. Em alguns minutos o monitor deve ficar **Up**. O UptimeRobot trata qualquer resposta que não seja 2xx (como o 503) como **Down** e avisa.
9. Confira que o monitor está **Up** e mande uma notificação de teste para o seu e-mail e para o celular (a tela de **Alert Contacts** tem a opção de enviar teste). Parar o fluxo no n8n por mais de 3 horas só para testar não vale a pena.

**Quando o alerta chegar (503):**

1. Abra `https://innochat.innovarecode.com.br/api/health/billing` no navegador e leia `reasons`:
   - `TICK_STALE` ou `TICK_NEVER_RAN`: a rotina não está rodando. Vá ao passo 2.
   - `NOTICES_STUCK_EMAIL`: a rotina roda, mas avisos de e-mail ficaram na fila. Vá ao passo 4.
   - `EMAIL_FAILING_IN_SEQUENCE`: o servidor de e-mail está recusando. Vá ao passo 4.
2. **Olhe o n8n.** Abra o fluxo `innochat-cron`. Ele está ligado (publicado)? A última execução deu erro? Se o fluxo estiver desligado, ligue. Se deu erro, abra a execução e veja em qual passo parou (credencial vencida, segredo interno trocado, painel fora do ar).
3. **Rode o tick à mão** para confirmar que o painel responde (use o segredo interno que o n8n usa; o painel guarda só o hash dele e não mostra o valor. Não cole o segredo em chat nem em ticket):
   ```bash
   curl -X POST https://innochat.innovarecode.com.br/api/internal/v1/billing/tick -H "Authorization: Bearer <segredo interno>"
   ```
   Resposta 200 com os contadores = painel e banco estão bem, o problema é o agendamento no n8n. Resposta 401 = o segredo do n8n não bate com o do painel (veja "Rotação de segredos"). Resposta 500 ou sem resposta = olhe os logs do painel no Easypanel (`billing.tick.route.unexpected_error`).
4. **Abra Admin > Saúde**, seção **Cobrança**: veja a última rodada, os avisos presos e as falhas. Depois **Admin > Financeiro > Envios de cobrança** para ver quais avisos falharam e o código do erro. Se for e-mail, teste o servidor em **Configurações > E-mail de teste**.
5. Depois de rodar o tick, espere até 5 minutos: o monitor volta a **Up** sozinho quando o status deixar de ser `down`.

**Além do monitor, o sistema também avisa por dentro (reforço):**
- **Sino do Admin:** "A cobrança parou de rodar" (mais de 3 horas) e "Avisos de cobrança presos".
- **E-mail ao admin da plataforma** quando o status vira `down`: no máximo **1 a cada 6 horas** enquanto durar. Quem dispara é a própria consulta do monitor ao `/api/health/billing` e a manutenção diária (`maintenance/tick`). Os dois dependem de o painel estar no ar, e o e-mail sai pelo mesmo servidor de e-mail da cobrança: se esse servidor for o problema, o e-mail não chega. Se o n8n inteiro cair, a manutenção diária também não roda. **Só o UptimeRobot avisa nesses casos.**
- O e-mail vai para os usuários administradores da plataforma; se não houver nenhum, para o e-mail de contato de **Admin > Dados da empresa**.

---

## Operação da cobrança no dia a dia

O motor da cobrança é autônomo: planejador + despachante rodam a cada hora, os avisos saem por e-mail e WhatsApp conforme o cronograma, e o painel mostra tudo. Neste tópico, a operação manual que o dono pode fazer quando necessário.

### Conectar ou trocar o chip de cobrança

O número do WhatsApp de avisos é gerenciado sem deploy. Ele pode estar desligado (cobrança só por e-mail), ativo ou trocado por outro.

**Primeira conexão:**
1. Vá em **Admin → Configurações da plataforma** → card **"WhatsApp da plataforma"**.
2. Clique em **"Conectar novo número"** (ou "Trocar número" se já houver um).
3. Um QR code apareça na tela. Escaneie com o WhatsApp do novo chip.
4. Quando conectar, o card mostra o número mascarado (últimos 4 dígitos: `+55 84 9****-1234`) e o status muda para **"Conectado"**.

**Trocar para outro número (sem perder avisos):**
1. Na mesma tela, clique em **"Trocar número"**.
2. O número atual continua enviando enquanto o novo conecta (sem intervalo sem canal).
3. Quando o novo conectar, a transição é atômica: o antigo vira "Antigo (chip anterior)" e o novo fica ativo.
4. Os avisos que o número antigo já enviou não são reenviados (chave única por ciclo/etapa/canal).

**Se o número caiu (reconexão):**
1. O status mostrará **"Desconectado"**. Um novo QR aparecerá na mesma linha.
2. Escaneie com o mesmo chip que caiu ou com outro (o sistema detecta a mudança e mantém o histórico).
3. Sem reconexão em 30 min, a tentativa vira "Abandonada" e o sistema manda avisos só por e-mail até conectar de novo.

**Desligar o WhatsApp de avisos:**
1. Clique em **"Desconectar"** (pedirá confirmação).
2. A cobrança continua 100% por e-mail e painel. WhatsApp para assinantes não sai mais.
3. Para ligar novamente, conecte um número novo.

### Ler Envios de cobrança (auditoria e reenvio)

Cada aviso enviado (ou tentado, ou preso) aparece em **Admin → Financeiro → Envios de cobrança**.

**Colunas principais:**
- **Empresa:** qual cliente recebeu o aviso.
- **Etapa:** `Fatura criada`, `Véspera`, `Vence hoje`, `Venceu`, `Suspensão`, `Aviso x dias antes de cancelar`, etc.
- **Canal:** `E-mail` | `WhatsApp` | (sino = `Painel`).
- **Para quem:** e-mail ou telefone completo de quem recebeu. Avisos de antes da v1.5.0 aparecem mascarados, com a nota "registro anterior".
- **Situação:** `Enviado` | `Falhado` | `Preso` | `Pulado`.
- **Motivo (se pulado):** `Já pagou`, `Etapa não se aplica mais`, `Sem contato de cobrança`, `Opt-out de WhatsApp`, `Sem número de cobrança conectado`, etc.

**Filtros:** por empresa, etapa, canal, período (por data de envio, não criação).

**Ver a mensagem exata:**
1. Clique em **"Ver mensagem"** (ou no aviso).
2. Mostra assunto (e-mail) + corpo exato que foi enviado ou tentado. Se for antigo (> 12 meses ou > 90 dias após cancelamento), mostra `[texto apagado por retenção de privacidade]`. Você vê só a etapa, canal e para quem foi.

### Quando reenviar

Um aviso pode ser reenviado se ficou **`FALHADO`** ou **`PRESO`** (passou da hora). O botão **"Reenviar"** fica visível quando é possível. Reenvio é idempotente: mandar de novo o mesmo aviso cria uma única fila (não duplica mensagens).

**Caso de uso 1: SMTP falhou ontem à noite**
1. A empresa não recebeu o e-mail de "Vence hoje".
2. Em Envios, você vê a linha com `Situação: Falhado` e `Motivo: Erro no servidor de e-mail`.
3. Clique em **"Reenviar"**. O aviso entra na fila e sai na próxima oportunidade (respeitando a janela de horário).

**Caso de uso 2: WhatsApp de cobrança caiu por algumas horas**
1. Vários avisos de WhatsApp ficaram `PRESO` porque o número não estava conectado.
2. Depois de reconectar, você pode reenviar os presos do dia em lote: filtro por canal (WhatsApp) + período (hoje) + situação (Preso).
3. Selecione vários e clique em **"Reenviar"** (em desenvolvimento: seleção em massa). Por enquanto, reenvie um a um.
4. Cada um respeita opt-out e horário (09h-19h seg-sab; domingo só críticos).

**Avisos que NÃO podem ser reenviados:**
- **Enviado com sucesso:** já saiu, não faz sentido reenviar.
- **Pulado por "já pagou":** a empresa já pagou, aviso não é mais devido.
- **Pulado por "etapa mudou":** a fatura foi paga ou o cancelamento foi desfeito entre o erro e agora.
- **Suspensão manual:** se o admin suspendeu a empresa manualmente (não por falta de pagamento), esses avisos não são reenviáveis por segurança.

### Motivos de "Não enviado" e próximos passos

**NO_RECIPIENT**: não há endereço de e-mail.  
→ Verificar em Admin → Empresas → contato da empresa → "E-mail de cobrança" (deve estar preenchido) ou dono está com e-mail errado.

**OPTED_OUT**: empresa pediu para não receber avisos de cobrança por WhatsApp.  
→ Ela respondeu "SAIR" a uma mensagem ou desligou manualmente em Assinatura. Reativar em Assinatura se desejar receber de novo (opt-out = empresa decide, não sistema).

**NO_PLATFORM_NUMBER**: sem número de cobrança conectado.  
→ Admin não conectou um chip ainda. Conectar em Configurações (passo acima).

**CHANNEL_DOWN**: há número conectado, mas caiu entre o planejamento e o envio.  
→ Esperar reconexão automática (12h no máximo) ou reconectar manualmente.

**OUT_OF_WINDOW_EXPIRED**: aviso esperou a janela de horário, mas expirou (não faz mais sentido enviar).  
→ Exemplo: aviso de "Vence hoje" planejado para sair à 09h, mas o seu agendador (n8n) caiu todo dia 3h-19h. Aviso expirou = etapa passou. Normal; nada a fazer.

**PERMANENT_REJECTION**: servidor de e-mail recusou (ex.: endereço não existe no banco do cliente).  

**UNCONFIRMED_DAILY_LIMIT**: o WhatsApp ou o e-mail do financeiro ainda não foi confirmado e já recebeu 1 aviso nas últimas 24 horas. O próximo espera o dia seguinte; se perder o prazo, fica assim. Peça para a empresa responder SIM no WhatsApp de cobrança.  
→ Verificar e-mail com o cliente. Trocar em Admin → Empresas ou em Assinatura.

### Teste do servidor de e-mail

Em **Admin → Configurações da plataforma** → SMTP, há um botão **"Enviar e-mail de teste"**.

1. Digite um e-mail (seu, para receber).
2. Clique no botão.
3. A resposta mostra: `Enviado com sucesso` + id da mensagem, ou o código de erro do servidor.
4. Serve para validar credenciais, certificado SSL, rate limit, etc. Sem afeta clientes (e-mail de teste não é de cobrança).

### Quando a Saúde ficar vermelha

**Admin → Saúde** mostra o status do tick de cobrança. Se virar **VERMELHO** ("Cobrança parada" ou "Avisos presos"):

1. **Leia o motivo no card "Cobrança":**
   - "Não rodou há X horas" → vá para §"Diagnóstico de tick parado" abaixo.
   - "Avisos presos há > 2h" → há fila que passou da hora. Reenvie os `FALHADO` (button acima) ou espere o tick tentar de novo.
   - "E-mail falhando em sequência" → algo errado com SMTP. Teste a conexão (botão acima) ou entre em contato com o provedor.

2. **O UptimeRobot também vai avisar** por e-mail/app se o monitor externo detectar 503 em `/api/health/billing`.

3. **Rode o tick à mão (último recurso):**
   ```bash
   curl -X POST https://innochat.innovarecode.com.br/api/internal/v1/billing/tick \
     -H "Authorization: Bearer <seu segredo interno>"
   ```
   Se voltar `{ "noticesSent": 10, "noticesFailed": 0 }` etc., o painel está bem; o problema é o agendador (n8n).  
   Se voltar 500 ou sem resposta, há algo mais grave (banco fora, painel travado).

### Suspensões manuais antigas e revisão de segurança

**Context:** antes da v1.4.1, o admin podia suspender uma empresa manualmente, mas o sistema podia depois "desuspender" por atraso (carência), criando confusão. Desde v1.4.1, suspensão manual é marcada em `manualSuspendedAt` e nunca vira atraso.

**Se você tem empresas suspensas ANTES de 2026-10-02:**
- Se o motivo foi "pagamento pendente", você pode deixar como está (a régua continuará tentando cobrar, normalmente).
- Se suspendeu por outro motivo (manutenção, fraude, etc.), a suspensão não vira "atraso". Está segura.
- **Recomendado:** abra **Admin → Empresas**, procure por empresas em `SUSPENDED`, clique em cada uma e veja o motivo no banco (não há coluna visual, consulte o Cronos se duvidoso).

### DMARC, SPF e DKIM para cobrança

**Situação atual:** e-mail de cobrança sai pelo seu SMTP com SPF e DKIM (se configurados). DMARC está em `p=none` (monitor, não rejeita). As operadoras respeitam SPF/DKIM mas podem marcar como spam se DMARC for mais rigoroso.

**Avaliação em 2-4 semanas (decisão do dono, 2026-10-02):**
- Monitorar taxa de rejeição e spam (via logs do SMTP).
- Se taxa for baixa, considerar `p=quarantine` ou `p=reject` no DMARC para endurecê-lo (menos falso-positivo, mais seguro contra falsificação).
- Atualmente: `p=none` = o banco aceita, não rejeita. Bom para começar; endurecer depois de validar.

---

## Incidentes comuns

### Incidente 1: Bot parou de responder

**Sintomas:** cliente envia mensagem, bot fica mudo.

**Diagnóstico:**

1. Verifique a saúde (**Admin → Saúde**):
   - A instância WhatsApp está `CONNECTED`? Se não, a Evolution desconectou.
   - O `billing/tick` rodou recentemente? Se não, talvez o n8n esteja fora.
   - Há muitas mensagens "ocupadas" nas últimas 1h? Se sim, há gargalo.

2. Verifique o status da empresa (**Admin → Empresas**):
   - Assinatura em `TRIALING` ou `ACTIVE`? Se `SUSPENDED`, o bot foi bloqueado propositalmente.
   - Plano permite WhatsApp? Clique na empresa e veja o máximo de números.

3. Verifique o n8n (**Admin → Configurações da plataforma**):
   - `n8nWebhookBaseUrl` está preenchido? Se não, o bot não recebe mensagens.
   - **Bot não responde e o n8n não mostra nenhuma execução?** Teste a URL com e sem o `webhookId`
     (o n8n prefixa com o `webhookId` do nó Webhook a rota que tem parâmetro no path):
     ```bash
     curl -i -X POST https://<n8n>/webhook/innochat/evolution/teste                      # sem o webhookId
     curl -i -X POST https://<n8n>/webhook/<webhookId>/innochat/evolution/teste          # com o webhookId
     ```
     `404 "webhook not registered"` no primeiro e `200` no segundo = a URL das instâncias está
     sem o `webhookId`. Correção: **Admin → Configurações → Sincronizar n8n** (deriva a base
     correta, grava em `n8nWebhookBaseUrl` e reaponta o webhook de todas as instâncias na
     Evolution; a mensagem de sucesso mostra quantas foram reapontadas e quantas falharam).
     Se o `webhookId` do nó mudar (workflow reimportado), sincronize de novo.
   - Os workflows `innochat-bot` estão ativos? Entre no n8n e ativa se preciso.

**Ações:**

- Se a Evolution desconectou: a empresa precisa reconectar o WhatsApp (**Canal → WhatsApp** → gerar novo QR).
- Se o n8n está offline: espere a infraestrutura voltar ou reinicie o container do n8n.
- Se a assinatura está `SUSPENDED`: você pode reativar manualmente (**Admin → Empresas → Ações → Reativar**) ou a empresa paga a fatura (**Conta → Assinatura**).

### Incidente 2: WhatsApp desconecta sozinho

**Sintomas:** instância fica `DISCONNECTED`, os clientes veem "não conectado" no painel.

**Causa comum:** sessão expirou ou Evolution foi reiniciada.

**Ação:**
1. A empresa reconecta (**Canal → WhatsApp** → gera novo QR).
2. Se desconectar repetidamente (a cada poucas horas), há problema com a Evolution — investigue a versão ou chave da API.

### Incidente 3: Pix pago e não baixado (fatura continua "Aberta")

**Sintomas:** cliente pagou, viu a confirmação no banco, mas a fatura no InnoChat continua `OPEN`.

**Como funciona hoje:** a baixa NÃO depende só do webhook. Há conciliação ativa (`reconcileInvoicePayment`), que consulta o pagamento no Mercado Pago (`GET /v1/payments/{mpPaymentId}`) com as credenciais do **ambiente em que o Pix foi gerado** (`Invoice.mpEnvironment`; fatura antiga sem esse campo tenta o ambiente ativo e depois o outro) e dá baixa se `approved`. Ela roda: (a) a cada ~9s enquanto o cliente está com o Pix aberto na tela **Assinatura** (aba visível, até 15 min, no máximo 1 consulta ao MP a cada 5s por fatura); (b) a cada `billing/tick` (faturas `OPEN` com `mpPaymentId`, até 50 por rodada); (c) pelo botão **Conferir no Mercado Pago** em **Admin → Cobrança**.

**Passo a passo:**

1. **Admin → Cobrança**: na fatura aberta, clique em **Conferir no Mercado Pago**. O toast diz o resultado:
   - "Pagamento confirmado" = baixada (o webhook é que não estava chegando, siga o passo 2 para corrigir de vez);
   - "Ainda não foi pago" + status do MP (`pending`/`in_process`) = o MP ainda não aprovou; aguarde;
   - "O pagamento não foi concluído" (`rejected`/`cancelled`/`expired`) = não houve dinheiro, a fatura segue aberta (gere um novo Pix);
   - "Não foi possível consultar" = access token do ambiente da fatura ausente/recusado — confira **Admin → Configurações → Mercado Pago** (o par do ambiente certo: produção x teste).
2. **Admin → Saúde → Webhook do Mercado Pago**: veja "último recebido há X" e "última rejeição há Y — motivo":
   - `bad_signature`: a chave secreta salva não é a do webhook do painel do MP. **O webhook no painel do MP tem URL e chave secreta separadas para modo teste e produção** — a chave do ambiente ativo aqui precisa ser a do mesmo modo lá;
   - `wrong_environment_secret`: a assinatura bate com a chave do OUTRO ambiente (ex.: ativo = teste, mas o painel manda notificações do modo produção, ou vice-versa);
   - `no_secret_for_env`: não há chave secreta salva para o ambiente ativo;
   - `missing_signature` / `malformed_signature`: a chamada não veio do MP (ou o MP não tem chave secreta configurada no webhook);
   - `stale_timestamp`: assinatura antiga (reenvio muito atrasado) ou relógio do servidor desajustado;
   - `ignored_type`: notificação que não é de pagamento (ex.: `merchant_order`) — normal;
   - "Nenhum webhook recebido ainda": a URL não está cadastrada (ou está no modo errado) no painel do MP. URL: `https://<dominio>/api/webhooks/mercadopago`.
3. Corrija URL/chave no painel do MP e/ou em **Admin → Configurações**. Reenvie a notificação pelo painel do MP (Webhooks → histórico → reenviar) — opcional, a conciliação já cobre.
4. Logs (sem segredo): `billing.webhook.rejected` (com `reason`), `billing.reconcile.invoice_paid`, `billing.reconcile.get_payment_failed`, `billing.reconcile.payment_not_approved`.
5. Auditoria da baixa: `SELECT * FROM provider_events WHERE provider = 'mercadopago-reconcile' AND "providerEventId" = '<payment-id>';` (`payload.source` = `tenant_poll` | `admin_button` | `tick`). Baixa pelo webhook fica em `provider = 'mercadopago'`.

**Pagamento aprovado para fatura anulada (`VOID`):** nada é baixado; log `billing.reconcile.payment_for_void_invoice`. Reative a empresa e/ou estorne no MP.

**Último recurso:** **Admin → Cobrança → Marcar como paga manualmente** (com motivo; fica auditado). Prefira sempre a conferência no MP.

### Incidente 4: Taxa de limite de login alta

**Sintomas:** muitos IPs diferentes tentando fazer login na mesma conta.

**Causa:** força bruta ou conta comprometida.

**Ação:**
1. Peça ao cliente para trocar a senha imediatamente (**Conta → Esqueci a senha** no painel público).
2. Verifique os logs (se houver) para padrões de IP.
3. Se continuar, bloqueie o IP manualmente no servidor (fora do escopo do InnoChat — use firewall do Easypanel).

### Incidente 5: Mensagem sem resposta (o cliente nunca recebeu)

**Sintomas:** bot salvou a sessão e tentou enviar, mas a mensagem não chegou ao cliente.

**Causa:** Evolution falhou no `sendText` **depois** do `PUT /sessions`, então a trava foi liberada mas o envio não foi confirmado.

**Diagnóstico:**

1. Verifique `InboundEvent` para aquele cliente (tabela com histórico de entrada).
2. Se há um evento com `outcome = 'SENT'` e `stateAfter = 'SELECT_TIME'`, a sessão foi gravada mas a mensagem se perdeu — é raro e afeta 1 cliente.

**Ação:**
- O cliente pode repetir a última ação (reenviar "1" para serviço, etc.) e o bot reapresenta o `lastPrompt`.
- Se a sessão expirou antes de repetir, volta ao menu principal.

---

## Rotação de segredos

Procedimento para trocar credenciais sem derrubar a plataforma.

### Passo 1: Regenerar segredo interno (n8n)

Feito no painel (sem afetar produção):

1. Vá em **Admin → Configurações da plataforma**.
2. Clique em **"Regenerar segredo interno"**.
3. Um novo segredo é gerado e exibido **uma única vez** em texto puro.
4. ⚠️ **Copie esse segredo imediatamente** — ele nunca mais será exibido. Guarde em seu gerenciador de senhas.
5. Cole o novo segredo nos nós HTTP do n8n (credencial "InnoChat Painel (Bearer)").
6. Teste um webhook manualmente ou espere a próxima requisição do n8n.

### Passo 2: Atualizar outras credenciais (Evolution, Mercado Pago, SMTP)

1. Vá em **Admin → Configurações da plataforma**.
2. Localize o campo (ex.: `evolutionApiKey`).
3. **Selecione tudo** e substitua pelo novo valor — **nunca** acrescente.
4. Clique em **"Salvar"**.
5. O valor é guardado **cifrado** no banco (`enc:v1:`, AES-256-GCM; hash SHA-256 para o segredo interno) e mascarado na UI. Segredos antigos em texto puro são cifrados sozinhos na primeira leitura/gravação após o deploy.
6. Se for a chave da Evolution, reaplique para o n8n: **"Sincronizar n8n"**.

### Login com Google: criar o OAuth Client no Google Cloud Console

O botão "Entrar com Google" só aparece depois de você cadastrar as credenciais em **Admin →
Configurações → Login com Google**. Nada vai em variável de ambiente nem no chat.

1. Acesse <https://console.cloud.google.com/> e escolha (ou crie) um projeto para o InnoChat.
2. **APIs e serviços → Tela de consentimento OAuth**: tipo **Externo**, nome do app "InnoChat", e-mail de suporte, logo opcional. Escopos: só os básicos (`openid`, `email`, `profile`; não exigem verificação). Publique o app ("Em produção") — em "Teste" só entram os e-mails listados como usuários de teste.
3. **APIs e serviços → Credenciais → Criar credenciais → ID do cliente OAuth**:
   - Tipo de aplicativo: **Aplicativo da Web**.
   - **Origens JavaScript autorizadas:** `https://innochat.innovarecode.com.br`
   - **URIs de redirecionamento autorizados:** `https://innochat.innovarecode.com.br/api/auth/callback/google` (exatamente assim, sem barra no fim; o mesmo endereço aparece pronto para copiar na tela de Configurações).
4. Copie o **ID do cliente** (termina em `.apps.googleusercontent.com`) e a **chave secreta do cliente**.
5. No painel: **Admin → Configurações → Login com Google** → cole o Client ID e o Client Secret → marque **ligado** → **Salvar**. O secret é guardado cifrado e nunca mais é mostrado ("credencial salva").
6. **Testar configuração** confere só o formato do ID e se o secret foi salvo/lido corretamente — **não fala com o Google**. O teste de verdade: abra `/login` numa janela anônima e clique em "Entrar com Google".

Comportamento a saber:
- E-mail do Google **não verificado**, ou conta de **administrador da plataforma**, é recusado (admin entra só com e-mail e senha, de propósito).
- Quem já tem conta com o mesmo e-mail é **vinculado** ao Google na primeira entrada. Quem não tem conta é levado a `/cadastro/google` para informar a empresa (nada é criado antes disso).
- Contas criadas pelo Google não têm senha; "Esqueci minha senha" permite definir uma.
- Erro `redirect_uri_mismatch` no Google: a URI cadastrada no passo 3 difere da mostrada em Configurações (confira `https`, domínio e a ausência de barra final).
- Trocar o `AUTH_SECRET` faz o Client Secret deixar de decifrar: o botão some sozinho até você recadastrar o secret (ver "Trocar o `AUTH_SECRET` apaga os segredos salvos").
- Para desligar: desmarque "ligado" (ou "Remover credencial salva"); o login por e-mail e senha não é afetado.

### Mercado Pago: trocar de ambiente (produção ↔ teste)

O Mercado Pago tem **dois pares** de credenciais (Access Token + Webhook Secret, mais a Public Key):
produção e teste (sandbox). Em **Admin → Configurações → Mercado Pago**:

1. Preencha o par do ambiente desejado (segredo em branco = mantém o já salvo) e use "Testar conexão".
2. Troque o seletor de **ambiente ativo**. Vale já na próxima requisição: Pix novo, tick e webhook usam o token/segredo do ambiente ativo.
3. O webhook do Mercado Pago valida a assinatura com o segredo do ambiente **ativo** — cadastre no painel do MP o webhook do modo correspondente (o de teste usa o segredo de teste).
4. **"Cobrança liberada"** desligada bloqueia só Pix/fatura NOVOS; pagamentos já feitos continuam sendo baixados pelo webhook.
5. "Remover credencial salva" apaga um segredo de um ambiente (irreversível: recadastre depois).

Sem access token + webhook secret do ambiente ativo, o Pix não é gerado e o webhook é rejeitado (401) — o painel mostra "Mercado Pago" como não configurado.

### ⚠️ Trocar o `AUTH_SECRET` apaga os segredos salvos

A chave que cifra os segredos da plataforma (Mercado Pago, Evolution, n8n, SMTP) é derivada do
`AUTH_SECRET`. Se ele for trocado (rotação, ou variável errada no Easypanel), nenhum segredo salvo
decifra mais: eles passam a valer como **ausentes** (Pix não gera, webhook do MP é rejeitado,
e-mail e Evolution/n8n deixam de funcionar) até serem **recadastrados** em Admin → Configurações.
Também invalida as sessões de login (comportamento do Auth.js). Antes de trocar: anote/tenha à mão
as credenciais de todas as integrações. Sintoma de troca acidental: logs `platform.secret.undecryptable`
e a tela mostrando os segredos como "não salvos".

### Passo 3: Testar

- Se foi Evolution: envie uma mensagem de teste via `curl` ou pelo bot.
- Se foi Mercado Pago: tente gerar um Pix de teste.
- Se foi SMTP: use "Testar conexão" na mesma tela.

---

## Backup e restauração

> Backup que nunca foi restaurado é uma suposição. Por isso o ciclo completo (semear, copiar, apagar o banco inteiro, restaurar, conferir) roda a cada push no job `backup-restore` do CI. Se uma migration futura quebrar a restauração, o CI fica vermelho no dia, e não no dia do desastre.

### O backup automático fica em Admin → Backup

Uma cópia por dia, no horário de Brasília, enviada para **fora do servidor**. Tudo é cadastrado na tela (nenhuma variável de ambiente): ligar o automático, hora, quantos dias guardar, depois de quantas horas sem cópia avisar, e o destino (bucket S3, R2, Backblaze ou Google Drive). Os segredos ficam cifrados no banco e não voltam para a tela.

- **Fazer backup agora** prova o caminho inteiro antes de confiar no horário. Sem destino completo ele só gera um teste (a cópia é conferida e descartada) e a tela avisa que isso não é backup.
- Use um bucket **só para backup**. A cópia tem dados de todas as empresas.
- Cópias antigas são apagadas só depois que a nova subiu e foi conferida, e o sistema nunca apaga a última cópia que existe.
- **Atrasou?** Se passar o limite configurado sem cópia nova, o sino do Admin fica vermelho e chega e-mail aos administradores (no máximo um a cada 12 horas). O agendador roda dentro do próprio sistema: se o sistema estiver fora do ar, nenhuma cópia acontece e esse aviso é o único sinal. Trate como incidente.
- No Drive, uma pessoa pode tirar o acesso sem querer (apagar a pasta, revogar a conta). Toda falha do Drive aparece no histórico com a causa e o que fazer. Para Gmail pessoal use **Conectar com Google** (no Google Cloud deixe o app em "Em produção", senão o acesso expira em 7 dias). Conta de serviço só funciona com unidade compartilhada do Workspace.
- O `pg_dump` da imagem (`Dockerfile`, pacote `postgresql18-client` com queda para o 17) precisa ser da versão do banco ou mais novo. Se o banco for atualizado antes da imagem, a cópia falha dizendo exatamente isso.

### Restaurar (o dia ruim)

Não existe botão de restaurar, de propósito: um clique que apaga o banco é risco grande demais. Restaurar exige linha de comando, o destino escrito à mão e `--confirmar`.

1. Pare o `innochat-painel` no Easypanel (evita escrita durante a restauração).
2. Baixe o arquivo `backup-innochat-AAAA-MM-DD-HHhMMmSSs.dump` do bucket ou da pasta do Drive.
3. De um computador com o cliente do PostgreSQL 18 (ou da versão do banco), rode:

```bash
./scripts/restore-db.sh backup-innochat-2026-10-02-03h00m12s.dump "postgresql://usuario:senha@host:5432/innochat" --confirmar
```

O script confere o dump **antes** de tocar no destino, exige o destino como argumento (não lê a `DATABASE_URL` do ambiente) e, no fim, confere se o banco ficou com dados. Avisos de permissão do `pg_restore` são esperados (o dump usa `--no-owner`).

4. Suba o `innochat-painel`. Ele roda `prisma migrate deploy` no boot e alinha o schema, caso o dump seja de uma versão anterior.
5. Abra o painel e confira de verdade: as empresas, a agenda de uma delas, as faturas. Contar linhas prova que o dump tem dados; abrir a tela prova que o negócio voltou.

**Antes de restaurar sobre a produção**, faça uma cópia do estado atual (`./scripts/backup-db.sh`), para poder desfazer a restauração.

**Teste uma vez com os dados reais**, num banco descartável e nunca na produção: restaure o último dump num Postgres temporário e abra o painel apontando para ele.

### Cópia manual

```bash
DATABASE_URL="postgresql://..." ./scripts/backup-db.sh ./backups
```

A pasta `backups/` e os arquivos `*.dump` já são ignorados pelo Git.

Ver `docs/deploy-easypanel.md` §13 para o backup do próprio Easypanel (segunda camada, independente do sistema).

---

## Rollback de deploy

Se um deploy quebrou algo:

### Opção 1: Reverter a imagem Docker (rápido)

1. No Easypanel, vá em **Serviço → Deployments** (histórico de deploys).
2. Encontre o deploy anterior que funcionava.
3. Clique em **"Redeployar"** naquela versão.
4. A imagem antiga sobe novamente.

**⚠️ Se o deploy anterior incluiu migration:** você precisa reverter a migration também:

```bash
# No console do Postgres
npx prisma migrate resolve  # se a migration ficou "em aberto"
npx prisma migrate reset --skip-generate  # reverter tudo (CUIDADO: deleta dados)
# OU, melhor:
# Restaurar do backup (seção acima)
```

### Opção 2: Reverter o código (mais seguro)

1. `git revert <commit-que-quebrou>` (cria um commit de desfazimento).
2. Push para `main`.
3. Espere o Easypanel fazer deploy automático (ou clique "Deploy" manualmente).
4. Se teve migration, rode `npx prisma migrate deploy` no console.

### Opção 3: Hotfix rápido

Se o problema é simples (ex.: typo em variável, URL errada):

1. Corrija no código.
2. Commit.
3. Push.
4. Espere deploy e, se precisar, rodep migration.

---

## Publicar nova versão dos termos

Os textos de "Termos de uso" e "Política de privacidade" são servidos do código. Para atualizá-los:

### Localizar os termos

Arquivo: `src/lib/legal.ts`

```typescript
export const TERMS_OF_SERVICE = `
Seus textos aqui...
`;

export const PRIVACY_POLICY = `
Seus textos aqui...
`;
```

### Atualizar

1. Abra `src/lib/legal.ts`.
2. Edite os textos dentro das strings.
3. Commit e push.
4. Deploy.

### Versionar

Dentro do painel, **Admin → Configurações da plataforma**, há um campo `termsVersion` (ex.: "1.0", "1.1"). 

Sempre que atualizar os termos:

1. Atualize `termsVersion` para algo como "2.0" (um número ou data, ex.: "2026-09-28").
2. Salve em **Configurações**.
3. Clientes já cadastrados veem um aviso: "Novos termos disponíveis — releia".
4. Eles precisam aceitar de novo para continuar usando.

### Contratos

A tabela `User.termsAcceptedAt` e `User.termsVersion` rastreiam qual versão cada usuário aceitou. Você pode consultar em **Admin → Empresas** quantos usuários ainda usam versão antiga (não existe tela, mas está no banco).

---

## Checklist de saúde (diário)

Rode este checklist manualmente uma vez ao dia ou configure um alerta:

- ✅ **Banco:** painel consegue conectar? (`/api/health` retorna `"database": "connected"`)
- ✅ **n8n:** workflows estão ativos? (vá em **Admin → Saúde** ou direto no n8n)
- ✅ **Faturamento:** `billing/tick` rodou nas últimas 2h? (**Admin → Saúde**)
- ✅ **Instâncias:** alguma WhatsApp está desconectada? (**Admin → Saúde**)
- ✅ **Erros:** há execuções do n8n com erro crítico? (**Admin → Saúde**)
- ✅ **Webhook MP:** último recebimento quando? (verificar banco: `SELECT MAX(createdAt) FROM provider_events;`)

Se algo estiver vermelho, abra um incidente acima.

---

## Contato e suporte

- **Documentação:** `docs/arquitetura.md`, `docs/contratos.md`
- **Squad técnica:** consulte via GitHub Issues ou Discord
- **Dono:** para decisões de negócio (preços, planos, recursos novos)


## Deploy do bot v2 (painel + "Publicar fluxo")

**Ordem:**
1. Push do painel. O container novo aplica sozinho, no boot, as migrations `20261001200000_bot_v2_schema` e `20261001200100_bot_v2_port_texts`.
2. Confira em Admin → Saúde que o painel está no ar e em Admin → Configurações → **Fluxo do bot** que o n8n responde.
3. **Publicar fluxo:** na primeira vez, digite PUBLICAR.
4. Teste pelo WhatsApp: "oi", agendar, remarcar, cancelar e "atendente".

**Janela e rollback (revisão O-1, I2):**
- A migration de porte **insere** linhas em `bot_texts` com chaves novas (`MENU_PROMPT`, `APPOINTMENT_DETAIL`) nas empresas que editaram o menu. A imagem **antiga** lê `bot_texts` sem filtro e quebra ao encontrar essas chaves.
- A janela de risco é só o intervalo entre a migration e a troca do container. A imagem nova já filtra.
- **Rollback da imagem do painel:**
  1. Antes, volte o fluxo no card "Fluxo do bot" (VOLTAR).
  2. Rode no banco: `DELETE FROM bot_texts WHERE key IN ('MENU_PROMPT','APPOINTMENT_DETAIL');`
  3. Só então volte a imagem.
- A migration também faz `UPDATE tenants SET "slotGranularityMin" = 30`. **Isso é irreversível.** Cada empresa pode voltar para 15 em Configurações.
