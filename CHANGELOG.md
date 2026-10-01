# Changelog — InnoChat

Versão semântica (`MAJOR.MINOR.PATCH`), lida do `version` do `package.json` e exibida no selo do rodapé.
- **PATCH** (1.1.**1**): só correções.
- **MINOR** (1.**2**.0): funcionalidade nova compatível.
- **MAJOR** (**2**.0.0): mudança que quebra algo para quem já usa.

Toda publicação em produção sobe a versão e ganha uma entrada aqui.

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
