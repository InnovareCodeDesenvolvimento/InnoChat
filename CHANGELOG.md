# Changelog — InnoChat

Versão semântica (`MAJOR.MINOR.PATCH`), lida do `version` do `package.json` e exibida no selo do rodapé.
- **PATCH** (1.1.**1**): só correções.
- **MINOR** (1.**2**.0): funcionalidade nova compatível.
- **MAJOR** (**2**.0.0): mudança que quebra algo para quem já usa.

Toda publicação em produção sobe a versão e ganha uma entrada aqui.

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
