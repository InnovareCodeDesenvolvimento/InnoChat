# Changelog — InnoChat

Versão semântica (`MAJOR.MINOR.PATCH`), lida do `version` do `package.json` e exibida no selo do rodapé.
- **PATCH** (1.1.**1**): só correções.
- **MINOR** (1.**2**.0): funcionalidade nova compatível.
- **MAJOR** (**2**.0.0): mudança que quebra algo para quem já usa.

Toda publicação em produção sobe a versão e ganha uma entrada aqui.

## v1.11.2 — 2026-10-14

### Correções
- Pixel do Meta na tela de cadastro agora carrega direto, sem banner de consentimento. A pergunta "Posso medir de onde você chegou?" travava novos cadastros — o Pixel continua contando PageView e disparando Lead/CompleteRegistration, mas o usuário não precisa aceitar manualmente.
- Auto-reparo de migrations: o checksum gravado em `_prisma_migrations` cabe no VARCHAR(64) (antes estourava com `value too long`).

## v1.11.1 — 2026-10-14

### Correções
- Auto-reparo de migrations no boot: se a imagem publicada não tiver a pasta da migration nova (o que aconteceu com a v1.11.0 publicada sem a migration do Resgate), o servidor detecta as colunas/tabela ausentes e aplica o SQL automaticamente antes de começar a responder. Idempotente. A regra do projeto continua sendo rebuildar a imagem após cada push com migration — este auto-reparo é só a rede de segurança.

## v1.11.0 — 2026-10-14

### Novidade: Suporte do admin no catálogo + Resgate automático de leads do Meta Ads
- O admin em sessão de suporte agora vê e edita o catálogo da empresa direto: serviços, profissionais, agendamentos e bloqueios. Um badge discreto no cabeçalho de cada tela reforça que o modo suporte está ativo, com modal explicativo e atalho para a ajuda. Todos os campos sensíveis ganharam ícone de ajuda ⓘ com exemplos práticos. Listas longas ganharam paginação numerada (10/25/50/100).
- Resgate automático de leads: clientes que vieram do Meta Ads, criaram a conta, mas nunca entraram no painel agora recebem até 2 mensagens de WhatsApp (24h e 96h após o cadastro) com um tom humano, dica de como seguir e opção clara de SAIR. Resposta do cliente para o resgate vira notificação no sino do admin da plataforma, com link para abrir a conversa. A régua respeita horário de silêncio e tem kill-switch global.

## v1.10.1 — 2026-10-14

### Correções
- O suporte do admin agora deixa rastro de auditoria também nas ações do catálogo (serviços, profissionais, agendamentos). O ID da sessão de suporte é gravado junto com o evento para ficar fácil de seguir o que foi feito em nome de quem.

## v1.10.0 — 2026-10-14

### Novidade: Suporte do admin com impersonação
- O admin da plataforma agora entra na conta de uma empresa para dar suporte direto. O botão "Entrar como empresa" mora em Admin → Empresas → [detalhes da empresa] e exige motivo formal (15 a 500 letras) + 2FA ativa do admin.
- A sessão de suporte dura 1 hora e morre sozinha, sem renovação. Em qualquer tela da empresa, aparece um banner de alto contraste com contagem regressiva e botão "Sair da conta e voltar ao Admin". Se a sessão expirar, o admin é devolvido para a tela da empresa no Admin com aviso.
- Toda ação feita durante a sessão de suporte fica registrada na auditoria com o nome do admin, o papel "Suporte InnoChat" e o vínculo com a sessão. A empresa tem como ver quem acessou e o que fez.
- Ações destrutivas (excluir empresa, mudar e-mail/senha/2FA do dono, excluir membros, desconectar WhatsApp) ficam bloqueadas para o suporte — só leitura nessas áreas. O resto o admin faz com os mesmos poderes do dono da empresa.

## v1.9.2 — 2026-10-14

### Correções
- Painel `/admin/erros`: o monitor parou de registrar ruído de navegador. WebView do Chrome Android (`iabjs://`, "Java object is gone") e o `TypeError: Load failed` que aparecia toda vez que alguém terminava o cadastro (a navegação imediata abortava o `fetch` do relato) agora são descartados em duas camadas — antes de enviar, no cliente, e antes de gravar, no servidor. Os 6 registros antigos de `iabjs` continuam lá para você investigar caso a caso.

## v1.9.1 — 2026-10-10

### Correções
- iPhone dentro do Instagram: o Instagram não deixa o "Continuar com Google" abrir o Safari sozinho. Agora, ao tocar, aparece na hora um passo a passo de 2 toques (⋯ e "Abrir no navegador externo"), um botão "Copiar link" para colar no Safari e o lembrete de que dá para cadastrar ali mesmo com e-mail e senha. No Android, o mesmo guia aparece se o Chrome não abrir.

## v1.9.0 — 2026-10-10

### Novidade: cadastro sem fricção
- O cadastro cabe numa tela só: nome da empresa, seu nome, WhatsApp, e-mail, senha (com botão de mostrar) e o aceite dos termos. O endereço da página é criado sozinho e a pessoa entra direto no painel, sem parar na tela "confirme seu e-mail".
- CPF/CNPJ, ciclo de cobrança e segmento saíram do cadastro. O documento é pedido no cartão do Pix, na Assinatura, e um aviso aparece no painel nas últimas 24 horas do teste. A fatura do fim do teste nasce normalmente; só o Pix espera o documento.
- Cupom pelo link (`/cadastro?cupom=CODIGO`), com selo mostrando o desconto.
- Cadastros válidos: WhatsApp obrigatório com DDD conferido, e-mail descartável recusado, sugestão quando o domínio do e-mail vem digitado errado e armadilha invisível contra robôs.
- Quem chega pelo navegador do Instagram ou do Facebook vê "Continuar com Google", que abre o cadastro no Chrome (Android) ou no Safari (iPhone), onde o Google funciona, levando o cupom e a origem do anúncio.
- No celular, o aviso de cookies não cobre mais o botão de criar conta.

### Cobrança
- Trocar de ciclo, aplicar cupom ou trocar de plano durante o teste refaz a fatura do teste com o valor certo (a antiga é anulada e o Pix antigo cancelado, com nova tentativa automática se o Mercado Pago falhar). As mensagens da Assinatura explicam isso.
- O aviso "sua fatura chegou" do teste só sai quando há CPF/CNPJ, já com o Pix.

### Segurança
- Convite de equipe para um e-mail cadastrado e nunca confirmado derruba a senha e as sessões dessa conta antes de liberar o acesso.
- Limite de tentativas no selo de cupom e na troca de plano, e teto diário por número de WhatsApp nos avisos de cobrança.
- Termos de uso e política de privacidade na versão 2026-10-10 (inclui o WhatsApp do responsável).

### Correções
- Nomes de empresa muito longos podiam gerar endereço de página inválido.
- Ao reabrir o aviso de cookies pelo rodapé, o foco às vezes não ia para o aviso.

## v1.8.1 — 2026-10-05

### Correções
- Backup automático: uma cópia feita pelo botão "Fazer backup agora" à tarde fazia o sistema pular a cópia da madrugada seguinte, e o aviso de 36 horas sem backup disparava. Agora só as cópias automáticas contam para a regra de uma por dia, e se o sistema estiver fora do ar na hora marcada a cópia sai assim que ele voltar (até 12 horas depois).

## v1.8.0 — 2026-10-03

### Novidade: planos com 4 ciclos
- Cada plano pode ser pago a cada **1, 3, 6 ou 12 meses** (mensal, trimestral, semestral e anual). Em Admin → Planos você define o preço de cada ciclo; ciclo em branco não aparece para o cliente. O botão "Sugerir preços" preenche 5% no trimestral, 10% no semestral e 2 meses grátis no anual, e você ajusta.
- Não dá para apagar o preço de um ciclo que tenha clientes ativos nele, e um preço abaixo da metade do normal pede confirmação antes de salvar.
- **Cupons por ciclo:** em Admin → Cupons, caixinhas para escolher em quais ciclos o cupom vale. A duração passa a ser contada em faturas (num plano trimestral, 3 faturas cobrem 9 meses). Os cupons que já existiam foram convertidos sem perder nada.
- **Cadastro e Assinatura:** seletor "Pagar a cada 1, 3, 6 ou 12 meses" com o valor do período, quanto sai por mês e a economia. O cadastro pelo Google também ganhou a escolha de ciclo e o cupom.
- Trocar de ciclo vale a partir da próxima fatura, sem cobrança proporcional. Se o plano novo não tiver o ciclo do cliente, o sistema pede para escolher outro antes da troca.
- Faturas, avisos de cobrança, Financeiro (receita mensal), landing e Termos ajustados para os 4 ciclos.

### Correções
- O fim do período pago é calculado direito no fim do mês: 31/08 mais 6 meses termina em 28/02.

## v1.7.5 — 2026-10-03

### Lista de espera
- A fila é conferida pelo próprio sistema a cada 5 minutos: um encaixe que venceu passa logo para o próximo e, às 8h, sai o que esperou a noite. Antes isso dependia da rodada de hora em hora.
- Limite de 30 ofertas automáticas por hora para cada empresa, para não disparar WhatsApp demais. O "Oferecer encaixe" manual não entra no limite.

### Segurança
- Next.js 16.3.8 e nodemailer 10, que corrigem os alertas de segurança das bibliotecas.
- Backup no S3: o endereço é conferido de novo no momento da conexão.
- Trocar a chave do backup passa a pedir a sua senha ou o código das 2 etapas.
- Se o histórico de alterações não conseguir gravar uma ação, isso vira alerta no monitor de erros.
- A resposta automática do WhatsApp de cobrança não duplica quando duas mensagens chegam juntas.

### Documentação
- Guia do dono em linguagem simples (docs/guia-do-dono.md) e manual de operação atualizado com as novidades.

## v1.7.4 — 2026-10-03

### Correções
- Quem estava com uma página aberta durante uma publicação podia ver um erro ao navegar, porque os arquivos da versão anterior deixam de existir. Agora a página recarrega sozinha uma vez e abre já na versão nova, e o monitor de erros não registra isso como erro.

## v1.7.3 — 2026-10-03

### Melhorias
- Admin → Configurações organizado em abas, cada uma com endereço próprio: Geral, WhatsApp, Automação (n8n), Pagamentos, E-mail, Login e Marketing. Quem abre /admin/configuracoes cai em Geral.
- Um ponto de atenção aparece na aba quando algo dela precisa de ajuste, por exemplo o SMTP sem servidor ou o WhatsApp de cobrança desconectado.
- Ao trocar de aba com um formulário editado e não salvo, o sistema avisa antes.

## v1.7.2 — 2026-10-03

### WhatsApp de cobrança
- A resposta automática do número de cobrança voltou a sair sempre. Ela não respondia quem chegava pelo novo identificador de privacidade do WhatsApp e só respondia uma vez por dia. Agora responde de novo depois de 10 minutos, com limite de 6 respostas por dia para cada número. SAIR e SIM sempre recebem resposta.
- Texto novo da resposta automática, com negrito, itálico e emoji.
- Admin → Configurações, card do WhatsApp de cobrança: última mensagem recebida, última resposta automática e o motivo quando não respondeu.
- O sistema confere sozinho se o número de cobrança está recebendo as mensagens e corrige o endereço quando precisa.

### Contato de cobrança
- Card "Contato de cobrança" também em Configurações, levando direto ao campo do WhatsApp.
- Aviso no painel do dono quando um WhatsApp de cobrança não chega, com botão para corrigir o número.
- Ao salvar, o sistema confere se o número tem WhatsApp.
- O Admin pode corrigir o contato de cobrança de uma empresa.

### Monitor de erros
- Erros que vêm de extensões do navegador de quem acessa não aparecem mais.

## v1.7.1 — 2026-10-02

### Fluxo do bot com versão de verdade
- O fluxo do bot passa a ter número de versão e histórico do que mudou. A versão atual é a **2.1.0**, que trouxe a lista de espera (convite quando o dia está cheio, "Minha lista de espera" no menu e resposta SIM ou NÃO ao encaixe). A 2.0.0 é o fluxo v2 original.
- Admin → Publicar fluxo mostra a versão disponível no sistema, a versão publicada e o que mudou entre elas.
- Trava automática: se o fluxo mudar sem subir a versão, a verificação do sistema falha e avisa.

## v1.7.0 — 2026-10-02

### Novidades para as empresas
- **Plano anual com desconto:** no cadastro e na tela Assinatura dá para escolher mensal ou anual, com a economia à vista. A troca vale a partir da próxima fatura.
- **Cupons de desconto** no cadastro e na Assinatura, com validação na hora e o valor da primeira fatura já calculado.
- **Lista de espera:** quando o dia está cheio, o bot oferece a lista. Se alguém desmarcar, o primeiro da fila recebe o horário pelo WhatsApp e tem 30 minutos para aceitar. Os avisos saem só entre 8h e 21h. No painel, a tela Lista de espera mostra a fila e tem o botão "Oferecer encaixe".
- **Relatórios** (só para o dono): faturamento por período, serviço e profissional, ticket médio, faltas por profissional e comissão a pagar, com planilha (CSV). O preço e a comissão ficam gravados quando o atendimento é concluído, então mudar um preço não altera o passado.
- **Comissões** na ficha do profissional: uma porcentagem padrão e, se quiser, outra por serviço.
- **Histórico de alterações** em Configurações: quem mudou o quê e quando, com o antes e o depois. Guardado por 5 anos.
- **Verificação em 2 etapas** (opcional para donos) com app autenticador e códigos de recuperação.

### Novidades no Admin
- **Erros:** o sistema registra erros do servidor e do navegador, agrupa os iguais e avisa no sino e por e-mail quando aparece um novo.
- **Backup automático** para S3 (ou compatível) ou Google Drive, com horário, prazo de guarda, aviso de atraso e **arquivo criptografado** com chave própria, mostrada uma única vez. O botão "Conferir backup" abre a cópia e confere se está inteira, e o sistema também confere sozinho toda semana.
- **Verificação em 2 etapas obrigatória** para o admin da plataforma.
- **Auditoria** de todas as empresas e da plataforma, com filtros.
- **Cupons** e **preço anual** dos planos.
- **Pixel do Meta e API de Conversões**, com aviso de cookies nas páginas públicas.

### Site
- Páginas para cada tipo de negócio: /salao, /barbearia, /clinica-estetica, /consultorio e /pet-shop.
- Aviso de cookies com "Aceitar" e "Recusar" no mesmo peso; recusando, nada da Meta é carregado.
- Termos de Uso (plano anual e cupons) e Política de Privacidade (cookies e Meta) atualizados.

### Segurança
- Duas revisões de segurança completas, com todos os pontos graves e médios corrigidos antes da publicação.

## v1.6.1 — 2026-10-02

### Melhorias
- Os ícones de ajuda ⓘ aparecem por 6 segundos quando cada tela abre e depois somem, deixando a tela mais limpa. Voltam ao passar o mouse sobre o card ou título e ao navegar pelo teclado; no celular, tocar no cantinho ainda abre a ajuda.

## v1.6.0 — 2026-10-02

### Novidades: monitor da cobrança
- **Endereço de saúde da cobrança** (`/api/health/billing`), que diz se a rotina está ok, em atenção ou parada, sem nenhum dado pessoal. É ele que o UptimeRobot confere.
- **Alertas no sino do Admin** quando a cobrança fica mais de 3 horas sem rodar ou quando há avisos travados.
- **Tela Saúde:** card "Cobrança" com última execução, enviados, falhas, avisos presos e o status do WhatsApp de cobrança.
- **E-mail para o admin** quando a cobrança para, no máximo um a cada 6 horas.
- Passo a passo do monitor externo (UptimeRobot) no runbook.

## v1.5.1 — 2026-10-02

### Correções
- Um aviso por e-mail só conta como "Enviado" quando o servidor aceita o destinatário. Se recusar, aparece como "Falhou", com a resposta do servidor.
- Em Envios de cobrança, cada e-mail mostra o id da mensagem e a resposta do servidor de e-mail, para investigar entregas.
- Admin → Configurações → SMTP: botão "Enviar e-mail de teste", que mostra a resposta do servidor.

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
