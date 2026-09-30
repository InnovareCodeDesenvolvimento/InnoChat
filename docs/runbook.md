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

### Backup automático (Easypanel)

O Easypanel faz backup automático do Postgres (verifique a configuração no painel do Easypanel — frequência, retenção).

### Backup manual (antes de operação arriscada)

```bash
# No console do Postgres
pg_dump innochat > innochat-backup-2026-09-28.sql

# Ou via Easypanel:
# Serviço Postgres → aba Backup → "Fazer backup agora"
```

### Restauração

```bash
# Parar a aplicação (Easypanel: Deploy → Pause)
# No console do Postgres:
psql innochat < innochat-backup-2026-09-28.sql

# Reiniciar (Easypanel: Deploy → Resume)
# Rodar migration se necessário: npx prisma migrate deploy
```

**Importante:** antes de restaurar, **sempre** faça um backup do estado atual (em caso de precisar de rollback do rollback).

Ver `docs/deploy-easypanel.md` para detalhes de infraestrutura.

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
