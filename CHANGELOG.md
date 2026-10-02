# Changelog — InnoChat

Versão semântica (`MAJOR.MINOR.PATCH`), lida do `version` do `package.json` e exibida no selo do rodapé.
- **PATCH** (1.1.**1**): só correções.
- **MINOR** (1.**2**.0): funcionalidade nova compatível.
- **MAJOR** (**2**.0.0): mudança que quebra algo para quem já usa.

Toda publicação em produção sobe a versão e ganha uma entrada aqui.

## v1.5.0 — 2026-10-02

### Novidades: Financeiro no Admin
- **Menu "Financeiro"** com três submenus: Visão geral, Cobranças e Envios de cobrança.
- **Visão geral:** receita mensal recorrente, assinantes por situação, recebido no mês comparado ao anterior, próximos vencimentos, inadimplência, cancelamentos do mês (por vontade da empresa ou por falta de pagamento) e quantos voltaram a pagar graças aos avisos. Também dá para baixar as faturas em planilha (CSV).
- **Envios de cobrança:** cada aviso enviado, com empresa, etapa, canal, **para quem foi** (e-mail ou telefone completo), situação e motivo. "Ver mensagem" mostra o texto exato e "Reenviar" fica disponível quando o sistema já desistiu de tentar. Tem filtros e totais.
- **Cobrança de cada empresa:** resumo, faturas e a linha do tempo de tudo o que aconteceu.
- **Paginação numerada** com 10, 25, 50 ou 100 itens por página nas listas do Admin.

### Privacidade
- Os destinatários e os textos dos avisos são apagados depois de 12 meses, ou 90 dias depois do cancelamento da empresa.

## v1.4.1 — 2026-10-01

### Correções (revisão de segurança da cobrança)
- **Suspensão feita pelo Admin** fica marcada e nunca vira "atraso" pela carência nova. As suspensões manuais feitas antes desta versão precisam ser repetidas no Admin.
- **Pix antigo é cancelado** quando um novo é gerado. Se ainda assim cair um pagamento a mais, o Admin é avisado para fazer o estorno.
- **WhatsApp de cobrança precisa ser confirmado:** o dono responde SIM. Até confirmar, recebe no máximo 1 mensagem por dia. E-mail do financeiro: no máximo 1 por dia, e o dono continua recebendo.
- Proteções contra aviso repetido e limpeza automática das respostas guardadas depois de 45 dias.

## v1.4.0 — 2026-10-01

### Novidades: régua de cobrança completa
- **Avisos de mensalidade** por e-mail, no sino do painel, numa faixa no topo do painel (contador e botão "Pagar com Pix") e pelo **WhatsApp de cobrança**. Saem 5 dias antes, 3 dias antes (só no painel), na véspera, no dia, durante a carência, na suspensão, durante a suspensão e antes do cancelamento. Quem paga para de receber na hora e recebe "Assinatura renovada até…".
- **Carência de 3 dias** para quem já paga (1 dia no teste). O vencimento conta até as 23:59 do dia.
- **Teste grátis:** mensagens que mostram o que o Inno já fez pela empresa (horários marcados, conversas respondidas) e convidam a assinar.
- **WhatsApp de cobrança** conectado e trocado pelo Admin com QR Code, separado do número comercial. Respostas dos assinantes chegam no sino do Admin, "SAIR" desliga os avisos e a resposta automática indica o (84) 3113-2584.
- Tela **Assinatura**: e-mail do financeiro, WhatsApp de cobrança com opção de desligar e histórico de pagamentos.
- **Cadastro:** campo opcional "Seu WhatsApp", usado nos avisos.

### Correções
- O vencimento das faturas em aberto estava gravado um mês à frente; foi corrigido.

## v1.3.2 — 2026-10-01

### Correções (cobrança mais confiável)
- Lembretes de cobrança só contam como enviados quando o e-mail sai de verdade. Se o servidor de e-mail falhar, o sistema tenta de novo e avisa o Admin pelo sino.
- O cancelamento automático (por falta de pagamento ou teste não assinado) agora avisa a empresa por e-mail.
- A rotina de cobrança não roda duas vezes ao mesmo tempo, tem limite de tempo e um erro num cliente não trava os outros.
- Antes de mandar um lembrete, o sistema confere se o cliente acabou de pagar.
- Suspensão feita pelo Admin não manda e-mail de "falta de pagamento".
- "Vence hoje" só sai nas 24 horas seguintes ao vencimento.

## v1.3.1 — 2026-10-01

### Melhorias
- **Textos revisados para soar como gente** (guia em `docs/guia-de-voz.md`): landing, painel, ajuda ⓘ, Admin, login, e-mails, notificações e as mensagens padrão do bot. Exemplos: "Oi, Ana! Aqui é a Studio Bella", "Passando pra lembrar", "Já passou do prazo para cancelar este horário". Saíram os travessões e as fórmulas prontas. Empresas que personalizaram os textos do bot não são afetadas.
- Landing: o card "Entre com o Google" só aparece quando o login com Google está configurado.
- Admin: o botão do WhatsApp comercial agora se chama "Salvar WhatsApp".

## v1.3.0 — 2026-10-01

### Novidades
- **Botão "Tirar dúvidas"** na landing, com o Inno, que abre o WhatsApp comercial com uma mensagem pronta. O número é cadastrado em **Admin → Dados da empresa** e já vem preenchido com (84) 3113-2584; com o campo vazio, o botão some.
- **Rede animada no topo:** linhas de conexão que levam mensagens até a agenda e reagem ao mouse.
- **Telas do painel em 3D**, que se endireitam conforme a pessoa rola a página.
- **Jornada em rolagem:** o celular fica parado e a história avança (chega a mensagem → o Inno responde → a agenda preenche → o lembrete sai → o cliente é atendido).

## v1.2.4 — 2026-10-01

### Melhorias
- Aviso "© 2026 Innovare Code. Todos os direitos reservados." no rodapé da landing, nas telas de login e cadastro, nos Termos e na Política e no rodapé de todos os e-mails.
- Logo oficial (balão "i") também nas telas de login e cadastro e nas páginas de Termos e Privacidade.

## v1.2.3 — 2026-10-01

### Melhorias
- Landing: o **Inno** fica ao lado do celular, apresentando a conversa. O balão acompanha a demonstração: "Quem responde sou eu!", três pontinhos enquanto digita e "✓ Agendado!" no fim.

## v1.2.2 — 2026-10-01

### Correções
- As fontes do site agora ficam dentro do projeto. O deploy não depende mais do Google Fonts (a v1.2.1 falhou no Easypanel ao baixar a fonte Sora), e o site carrega um pouco mais rápido.

## v1.2.1 — 2026-10-01

### Melhorias
- Landing: a seção das dores virou **"Você conhece esse dia."**. É uma linha do tempo de um dia real (08:40, 10:15, 12:30, 16:00, 23:47), com a chave **Sem InnoChat ⇄ Com InnoChat** e a escolha do tipo de negócio (qualquer negócio, salão, barbearia, clínica de estética, consultório, pet shop). Tem animações, e quem prefere menos movimento vê tudo parado.

## v1.2.0 — 2026-10-01

### Novidades
- **Landing page nova**, premium, em innochat.innovarecode.com.br:
  - topo com a dor ("pare de largar o cliente para responder WhatsApp") e um **celular realista do WhatsApp** mostrando o bot agendar sozinho, com os textos reais do bot;
  - 4 dores e suas soluções, como funciona, recursos, telas reais do painel, para quem é, planos (lidos do Admin), perguntas frequentes e chamada para o teste grátis;
  - preparada para o Google e para compartilhamento: título, descrição, imagem, robots e sitemap.
- **Cancelar a assinatura pelo painel** (só o dono), como dizem os Termos:
  - vale ao fim do período pago; no teste, ao fim do teste; atrasada ou suspensa, na hora;
  - dá para desfazer até a data;
  - o Pix em aberto é cancelado no Mercado Pago;
  - na data, os números são desconectados e o painel fica só com a tela de Assinatura;
  - o dono pode **reativar sozinho**;
  - aviso no sino do Admin com o motivo do cancelamento e e-mail de confirmação ao dono.
- Aviso no sino do Admin quando um pagamento cai numa fatura já cancelada (estorno manual).

### Melhorias
- Logo oficial (balão "i") na landing.
- Termos e Política de Privacidade, versão de 1º de outubro de 2026: regras de cancelamento em teste e com atraso; o aviso de "documento-modelo" foi removido.

### Correções
- Pagar uma fatura de conta cancelada reativava com o período já vencido.
- Conta cancelada não consegue mais reconectar o WhatsApp.

## v1.1.1 — 2026-09-30

### Correções
- O selo "Desenvolvido por InnovareCode" volta a **flutuar no canto inferior direito**, sempre à vista, agora como uma pílula compacta (logo + versão). O nome completo aparece ao passar o mouse.
- O selo **some sozinho** quando algum botão ou campo passa por baixo dele e volta quando o caminho fica livre. Nunca fica em cima de algo clicável.

## v1.1.0 — 2026-09-30

### Novidades
- **Login com Google:** entrar e criar a conta da empresa com a conta Google. As credenciais são cadastradas no Admin.
- **Bot v2 (fluxo 2.0.0):**
  - menu revisado e textos mais profissionais;
  - limite de 3 agendamentos futuros por cliente;
  - horários de 15 ou 30 minutos;
  - "Falar com atendente" pausa o bot, avisa a equipe e retoma sozinho;
  - confirmação e "Posso ajudar em algo mais?" em mensagens separadas.
- **Atendimento pelo painel:**
  - página **Atendimento** no estilo WhatsApp Web, com fila, resposta pelo sistema e "Encerrar e devolver ao bot";
  - número de clientes esperando no menu;
  - o sino abre direto a conversa.
- **Aviso ao cliente:** quando a equipe agenda, remarca ou cancela pela agenda, o cliente recebe a mensagem no WhatsApp. Há chave em Configurações, os textos ficam em Mensagens do bot e os formulários mostram o aviso "o cliente receberá...".
- **Ajuda ⓘ em todas as telas e configurações:** para que serve, como usar e exemplos.
- **Favicon** com o balão ⓘ do InnoChat.

### Melhorias
- O bot fica pausado pelo mesmo tempo quando a equipe responde, seja pelo painel ou pelo celular.
- Limites de envio para proteger o número de bloqueio no WhatsApp: 10 mensagens por hora por cliente e 120 por empresa.
- O menu lateral fica fixo ao rolar.
- O selo da versão fica no rodapé, à direita, sem cobrir botões.
- Lembrete automático: a chave de ligar fica junto do título e as horas podem ser editadas mesmo com o lembrete desligado.

### Correções
- Bot sem resposta depois de publicar o fluxo v2: o motor não usa mais getters, que o n8n não suporta.
- Resposta repetida ao clicar em "Tentar de novo" com a internet instável.

## v1.0.0 — 2026-09-29
- Lançamento:
  - painel multiempresa (agenda, clientes, profissionais, serviços, lembretes);
  - bot de agendamento no WhatsApp;
  - cobrança via Pix pelo Mercado Pago.
