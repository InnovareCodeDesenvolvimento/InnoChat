# Guia do dono do InnoChat

Este guia explica as principais funcionalidades do InnoChat em linguagem simples, sem termos técnicos. Se algo quebrar ou ficar estranho, siga os passos daqui antes de chamar a equipe.

---

## Sumário

1. [Acesso e login](#acesso-e-login)
2. [Erros do painel](#erros-do-painel)
3. [Backup (cópia de segurança)](#backup-cópia-de-segurança)
4. [2 etapas (proteção extra)](#2-etapas-proteção-extra)
5. [Lista de espera](#lista-de-espera)
6. [Plano anual e cupons](#plano-anual-e-cupons)
7. [WhatsApp de cobrança](#whatsapp-de-cobrança)
8. [Configurações](#configuracões)
9. [Publicar atualizações do bot](#publicar-atualizações-do-bot)

---

## Acesso e login

### Primeira vez

1. Abra https://innochat.innovarecode.com.br
2. Clique "Criar conta"
3. Preencha: e-mail, senha, nome da sua empresa, CPF/CNPJ
4. Escolha o tipo de negócio (salão, barbearia, clínica, consultório, pet shop)
5. Escolha o plano (mensal ou anual, com cupom se tiver código)
6. Aguarde o e-mail de confirmação e clique no link

### Login normal

1. E-mail e senha
2. Se tiver **2 etapas** ativada (proteção extra), um código vai para seu app autenticador (tipo Google Authenticator)

---

## Erros do painel

Às vezes o painel registra erros (do servidor ou do seu navegador). Você não precisa fazer nada normalmente, mas o Admin da plataforma acompanha isso.

### Se você vir um erro na tela

1. Anote o que estava fazendo (ex.: "tentava marcar um agendamento")
2. Recarregue a página (F5 ou Cmd+R)
3. Se voltar a acontecer, envie uma mensagem para a equipe com: o erro, que tela era, que navegador usa

### Admin → Erros (só para Admin da plataforma)

Em Admin → Erros você vê todos os erros do painel agrupados. Se um erro de servidor aparecer, você recebe 1 e-mail de alerta. Clique **Resolver** quando já foi corrigido ou **Ignorar** se for inofensivo (ex.: cliente com versão antiga do navegador).

---

## Backup (cópia de segurança)

Seu banco de dados é copiado automaticamente para fora do servidor, criptografado (ninguém consegue ler sem a chave).

### Gerar a chave do backup

**Primeira vez:**

1. Vá em **Admin → Backup** (`/admin/backup`)
2. Clique em **"Gerar chave"** (botão)
3. A chave aparece na tela inteira (um código muito longo)
4. **Copie e guarde em lugar seguro:** gerenciador de senhas, pen drive, papel em uma gaveta. Se perder a chave, não consegue abrir backups antigos.
5. Depois a tela mostra só os primeiros 8 caracteres (impressão digital)

**Trocar de chave:**

Se acha que a chave vazou:

1. Na mesma tela, clique "Gerar chave nova"
2. Confirme digitando "GERAR"
3. Guarde a nova chave junto com a anterior (os backups antigos ainda precisam da chave velha)

### Ligar o automático

1. Na mesma tela, ative **"Automático"** (toggle)
2. Escolha a hora (Brasília)
3. Escolha quantos dias guardar (7 a 365)
4. Escolha onde guardar: **Google Drive** (recomendado) ou bucket S3
5. Clique "Salvar"

**Google Drive:**

- Vai pedir permissão para conectar sua conta
- Cria uma pasta "InnoChat Backup" no seu Drive
- Não aparece na listagem normal (está escondida, só o app vê)

### Conferir o backup

Clique **"Conferir backup"** na mesma tela. O painel:

1. Baixa a cópia mais recente
2. Testa se consegue abrir com a chave
3. Avisa se passou OK ou se algo está errado

**Uma vez por semana o sistema faz isso sozinho** e avisa por e-mail se tiver problema.

### Se precisar restaurar (o dia ruim)

Se o banco se corromper ou você quer voltar a um ponto anterior, **não tente sozinho**. A restauração é por linha de comando (não tem botão). Chame a equipe com:

- A data do backup que quer restaurar
- Confirme que tem a chave correspondente

---

## 2 etapas (proteção extra)

Ativa uma segunda camada de segurança no seu login: além da senha, precisa de um código do seu celular.

### Ativar

1. Vá em **Minha conta** → card **"Verificação em 2 etapas"**
2. Clique "Ativar"
3. **Instale um app autenticador no celular** (Google Authenticator, Microsoft Authenticator, Authy, etc.)
4. Na tela do painel, clique "Abrir no meu autenticador". A câmera do seu celular lê um QR code
5. O app gera um código de 6 dígitos; digite na tela
6. **Anote os 10 códigos de recuperação que aparecem**; guarde-os com a senha. Se perder o celular e os códigos, só outro Admin consegue redefinir

### Se perder o celular

1. Peça para outro Admin (em **Minha conta → Equipe**) clicar "Redefinir 2FA"
2. Você recebe um e-mail avisando
3. Na próxima vez que fazer login, cadastra 2FA de novo

### Se nenhum Admin conseguir acessar

Só o dono (com acesso direto ao banco) consegue recuperar. Chame a equipe com os e-mails dos admins presos.

---

## Lista de espera

Quando o dia da agenda está cheio, o bot oferece ao cliente entrar em uma fila. O primeiro da fila recebe o primeiro horário que abrir, por WhatsApp, com 30 minutos para responder.

### Ver e gerenciar a fila

1. Vá em **Operação → Lista de espera**
2. Você verá a fila em ordem de chegada: cliente, serviço, data, posição
3. Filtros: por dia, por profissional, por situação (esperando, oferecido, aceito, expirado, recusado)

### Ações

- **Adicionar:** cliente novo ou existente vai para a fila
- **Remover:** cliente muda de ideia
- **Oferecer encaixe:** você escolhe um horário livre que cabe para o serviço e profissional. O cliente da frente recebe uma mensagem no WhatsApp: "Tem horário em [data] às [hora]. Confirma?"
  - **SIM:** agendamento criado, cliente sai da fila
  - **NÃO ou sem resposta em 30 min:** cliente volta para a fila, próxima pessoa recebe a oferta

### Horário de envio

As **ofertas automáticas** (quando alguém cancela e libera um horário) só saem entre **08h e 21h** (horário do seu negócio). Fora disso, a pessoa continua esperando. **Oferecer manualmente pelo painel ignora esse horário.**

### Mensagens

Os textos que o bot envia (convite para fila, oferta de horário) são editáveis em **Mensagens do bot** (painel da empresa → Mensagens do bot, rota `/{slug}/mensagens-bot`). Procure por "FILA" ou "LISTA DE ESPERA".

---

## Plano anual e cupons

### Plano anual

Desconto em relação a pagar 12 meses mensais. Muda a partir da próxima fatura (sem ajuste pro-rata).

**Para mudar:**

1. Vá em **Assinatura** → card **"Plano"**
2. Escolha **Mensal** ou **Anual**
3. Clique "Mudar" e confirme
4. A próxima fatura já vem no novo ciclo

### Cupons

Se tiver um código de desconto (ex.: "VERAO50"), aplica na assinatura.

**Para aplicar:**

1. Em **Assinatura**, card **"Cupom"**
2. Digite o código
3. Clique "Aplicar"
4. Mostra quanto vai descontar e em quantas faturas

O desconto entra na próxima fatura. Um cupom só pode ser usado uma vez por empresa.

---

## WhatsApp de cobrança

Um número de WhatsApp separado (diferente do comercial) envia lembretes de pagamento. O painel mostra o status em tempo real.

### Status

Vá em **Admin → Configurações → aba WhatsApp**, card **"WhatsApp de cobrança"**:

- **Conectado:** tudo bem, avisos saem normalmente
- **Desconectado:** escanear QR de novo para reconectar
- **Esperando QR:** tela mostrando o código; aponte o celular
- **Erro:** algo deu errado; tente reconectar

**O que a tela mostra:**

- Última mensagem que chegou (o cliente respondeu algo?)
- Última resposta automática que o painel enviou
- Motivo se não respondeu (fora do horário 08h-21h, limite de respostas atingido, etc.)

### Se o número ficar offline

1. Clique "Reconectar"
2. Abra o WhatsApp no celular do chip e escanear o QR
3. Leve alguns segundos para conectar

### Se nunca chegar mensagem

- O número pode estar silenciado pelo WhatsApp (muitos avisos = spam)
- Tente trocar para outro número

---

## Configurações

Todas as configurações da plataforma estão em **Admin → Configurações**, divididas em abas por tema.

| Aba | O que controla |
|---|---|
| **Geral** | URLs do painel, versão dos Termos, backup |
| **WhatsApp** | Connection do bot (Evolution), número comercial, WhatsApp de cobrança |
| **Automação** | n8n (workflow do bot); em geral, a equipe configura |
| **Pagamentos** | Mercado Pago (produção + teste); deixa com a equipe |
| **E-mail** | SMTP para enviar lembretes; a equipe configura |
| **Login** | Google (para usuários fazer login com conta Google) |
| **Marketing** | Meta Pixel (anúncios), LGPD de cookies |

**Ponto de atenção (🔔):** quando algo de uma aba precisa de ajuste, aparece um ícone. Ex.: SMTP sem servidor ativo.

---

## Publicar atualizações do bot

De vez em quando a equipe prepara novas versões do bot (novo menu, lista de espera, etc.). Você publica no painel.

### Passos

1. Vá em **Admin → Configurações → aba Automação** (`/admin/configuracoes/automacao`), card **"Fluxo do bot"**
2. Você verá:
   - **Versão disponível:** o que há de novo (ex.: 2.1.0, "agora tem lista de espera")
   - **Versão publicada:** o que o bot está usando agora (ex.: 2.0.0)
3. Clique **"Publicar"**
4. Teste no WhatsApp: envie "oi" e siga os passos (agendar, remarcar, etc.)

### Se quebrou e precisa voltar

Na mesma tela, clique **"Voltar"**. O painel volta à versão anterior. A equipe conserta o bot e você publica de novo.

---

## Problemas comuns

### Cliente não recebe lembrete de agendamento

- Confira que o WhatsApp dele está em **Contatos** (com o número completo, +55, sem espaços)
- Verifique se o número dele tem WhatsApp (o painel avisa se não tiver)
- Se tiver muitos clientes sem WhatsApp, ativa avisos por **e-mail** em **Mensagens do bot** (painel da empresa, rota `/{slug}/mensagens-bot`)

### Painel abre em branco

Recarregue a página (F5). Se continuar em branco:
- Limpe o cache do navegador (Ctrl+Shift+Delete)
- Tente outro navegador (Chrome, Firefox, Safari)
- Se nada funcionar, avise a equipe

### Fatura não baixou no Mercado Pago

- Confira que foi paga (tela **Assinatura** mostra "Paga")
- Aguarde até 2 horas para o painel reconhecer o pagamento
- Se ficou mais de 2h, avise a equipe (pode ser webhook travado)

### Contato duplicado

Se um cliente aparece duas vezes na lista:
- Procure pelo nome dele
- Clique em um deles, vá em **Mesclar contatos** (se houver botão)
- Confirma qual número/e-mail manter

---

## Quando chamar a equipe

- ❌ Painel fora do ar (erro 500, não carrega)
- ❌ Mensagens não chegam ao cliente há 1+ hora
- ❌ Pagamento confirmado mas não aparece no painel (2+ horas)
- ❌ Erro que se repete (tira print da mensagem)
- ❌ Dúvida técnica sobre recursos novos

**Inclua na mensagem:**
- O que estava fazendo
- Qual tela/menu
- Que navegador / app usa
- Print do erro (se houver)

---

## Contato

- **Documentação técnica:** `docs/` (para a equipe)
- **Dúvidas:** GitHub Issues ou Discord da equipe
- **Emergência 24h:** confira o SLA do contrato

---

**Última atualização:** 2026-10-03 (v1.7.4)
