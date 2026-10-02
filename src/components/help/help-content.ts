/**
 * Catálogo central dos textos de ajuda (o ícone "i" no canto de cada tela e de cada card).
 *
 * Regras de redação (valem para quem for editar):
 * - Público: dono ou funcionário de salão/clínica, não técnico. Nada de jargão ("tenant",
 *   "instância", "webhook", "n8n"…): diga "número de WhatsApp da empresa", "o bot".
 * - Todo fato (limite, horário, padrão) vem do código — se mudar lá, mude aqui. Fontes:
 *   `core/reminders/window.ts` (lembrete), `modules/tenant/service.ts` e `prisma/schema.prisma`
 *   (regras do atendimento), `modules/attendance/outbound.ts` (tetos de envio),
 *   `modules/agenda/staff-notify.ts` (aviso ao cliente), `modules/dashboard/metrics.ts` (Início).
 * - Toda entrada tem título, "para que serve" e pelo menos 1 exemplo concreto (testado em
 *   `help-content.test.ts`, que também barra os termos proibidos).
 */

export type HelpEntry = {
  /** Nome curto do assunto; entra no `aria-label` do botão ("Como funciona: <título>"). */
  title: string;
  /** "Para que serve" — 1 a 2 frases. */
  purpose: string;
  /** "Como usar" — passos numerados curtos. */
  steps?: string[];
  /** "Exemplo" — 1 a 3 situações concretas. */
  examples: string[];
  /** "Dica" opcional. */
  tip?: string;
  /** "Atenção" opcional. */
  warning?: string;
};

const HELP_ENTRIES = {
  // ───────────────────────────── Páginas ─────────────────────────────
  "pagina.inicio": {
    title: "Início",
    purpose: "Mostra o resumo do seu dia: quantos clientes vêm hoje, o que vem pela frente e se o bot está atendendo no WhatsApp.",
    steps: [
      "Olhe os números no topo: cada cartão tem um ícone \"i\" que explica o que ele conta.",
      "Para marcar um horário na hora, clique em \"Novo agendamento\".",
      "Se aparecer um aviso amarelo (WhatsApp desconectado ou período de teste acabando), clique nele para resolver.",
    ],
    examples: [
      "Você abre o painel de manhã e vê \"5 atendimentos hoje\" e \"Próximo: 09:30 com Ana\": já sabe como será o dia.",
      "O aviso \"WhatsApp desconectado\" aparece: clique nele, leia o QR code de novo e o bot volta a atender.",
    ],
  },
  "pagina.agenda": {
    title: "Agenda",
    purpose: "É o calendário da empresa, por dia ou por semana, com os horários de cada profissional.",
    steps: [
      "Escolha \"Dia\" ou \"Semana\" e use as setas (ou \"Hoje\") para navegar.",
      "Clique em \"Novo agendamento\" ou num horário vazio para marcar um cliente.",
      "Clique num agendamento para ver os detalhes, remarcar, cancelar ou marcar como concluído.",
      "No modo \"Dia\", dá para arrastar um agendamento para outro horário do mesmo profissional.",
    ],
    examples: [
      "A Ana pediu para mudar o corte das 14h para as 15h: arraste o bloco dela para as 15h na coluna do mesmo profissional.",
      "Horários com folga ou bloqueio (feriado, por exemplo) não aceitam agendamento.",
    ],
    tip: "Quando a equipe marca, remarca ou cancela, o cliente pode ser avisado automaticamente no WhatsApp. Veja em Configurações > Atendimento pelo WhatsApp.",
  },
  "pagina.agendamentos": {
    title: "Agendamentos",
    purpose: "É a lista de todos os agendamentos, para você filtrar por período, profissional e situação e achar rápido o que procura.",
    steps: [
      "Escolha as datas em \"De\" e \"Até\".",
      "Se quiser, filtre por profissional e por situação (Agendado, Concluído, Cancelado ou Faltou).",
      "Clique em um agendamento para abrir os detalhes.",
      "Use \"Novo agendamento\" para marcar um horário.",
    ],
    examples: [
      "Você quer saber quem faltou na semana passada: escolha as datas e a situação \"Faltou\".",
      "A coluna de origem mostra se o horário foi marcado pelo WhatsApp (pelo bot) ou pelo painel (pela equipe).",
    ],
    tip: "Dá para remarcar ou cancelar até 2 horas antes do horário marcado. Vale para a equipe no painel e para o cliente no WhatsApp. Ex.: um horário das 15h pode ser mudado até as 13h.",
  },
  "pagina.listaEspera": {
    title: "Lista de espera",
    purpose: "Guarda quem queria um horário num dia cheio. Quando alguém cancela ou remarca, o primeiro da fila que combina recebe o horário no WhatsApp e tem 30 minutos para aceitar.",
    steps: [
      "O bot oferece a lista quando o cliente pede um dia sem horário livre. Você também pode usar \"Adicionar à lista\" para quem ligou ou veio ao balcão.",
      "A fila segue a ordem de chegada. O aviso vai para o primeiro que combina com o serviço, o profissional, o dia e a faixa de horário que ele pediu.",
      "O cliente responde \"sim\" para ficar com o horário ou \"não\" para deixar passar. Se não responder em 30 minutos, o horário vai para o próximo.",
      "\"Oferecer encaixe\" manda a oferta agora, sem esperar um cancelamento, se já existir um horário livre que caiba no pedido.",
    ],
    examples: [
      "A Ana queria corte na sexta, mas só tinha vaga à tarde e ela só podia de manhã. Entrou na lista. Na quinta o Bruno cancelou o das 9h: a Ana recebe o aviso e responde \"sim\".",
      "O horário foi oferecido à Ana e, no meio tempo, você marcou outra pessoa nele pelo painel. Quando a Ana responde \"sim\", o bot explica que o horário foi ocupado e ela continua na fila.",
    ],
    tip: "Os clientes que estão em alguma lista veem a opção \"Minha lista de espera\" no menu do bot e podem sair quando quiserem. O texto das mensagens dá para mudar em Mensagens do bot.",
    warning: "Para o aviso sair, o número de WhatsApp da empresa precisa estar conectado. Clientes com o bot pausado ou em conversa com a equipe são pulados e a vez passa ao próximo.",
  },
  "pagina.atendimento": {
    title: "Atendimento",
    purpose: "Aqui você responde pelo painel os clientes que pediram para falar com uma pessoa no WhatsApp. Enquanto você atende, o bot fica em silêncio para aquele cliente.",
    steps: [
      "Na fila, veja as abas: \"Aguardando\" (ninguém respondeu ainda), \"Em atendimento\" e \"Encerrados (24h)\".",
      "Clique no cliente para ler a conversa e digite sua resposta.",
      "Use \"Agendar para este cliente\" para marcar um horário sem sair da conversa.",
      "Ao terminar, clique em \"Encerrar e devolver ao bot\": o bot volta a responder esse cliente e a conversa continua guardada.",
    ],
    examples: [
      "A cliente Carla escreve \"quero falar com alguém\": ela aparece em \"Aguardando\". Você responde, e o cliente passa para \"Em atendimento\".",
      "Quem espera há mais tempo fica no topo da fila, com destaque depois de 10 minutos.",
    ],
    tip: "Se você responder o cliente direto pelo celular, o bot também fica em silêncio pelo tempo definido em Configurações > Atendimento pelo WhatsApp.",
    warning: "Para o número da empresa não ser bloqueado no WhatsApp, o sistema envia no máximo 10 mensagens por hora para cada cliente. Se passar disso, espere um pouco.",
  },
  "pagina.clientes": {
    title: "Clientes",
    purpose: "É a lista de quem já falou com a empresa ou foi cadastrado. Cada cliente tem histórico de agendamentos e uma chave para pausar o bot.",
    steps: [
      "Busque pelo nome ou pelo telefone.",
      "Clique num cliente para ver os agendamentos dele, editar dados ou pausar o bot.",
      "Use \"Novo cliente\" para cadastrar alguém que ainda não falou com você.",
      "O dono da empresa também pode \"Exportar CSV\", uma planilha com a lista de clientes.",
    ],
    examples: [
      "Quem escreve pela primeira vez no WhatsApp já aparece aqui sozinho, sem você cadastrar.",
      "Você quer conversar com a Marina direto pelo celular, sem o bot atrapalhar: abra o cadastro dela e clique em \"Pausar por 1h\".",
    ],
  },
  "pagina.profissionais": {
    title: "Profissionais",
    purpose: "Cadastre quem atende na empresa. Cada profissional tem o próprio expediente da semana e a lista de serviços que faz. É com base nisso que o bot e a agenda oferecem horários.",
    steps: [
      "Clique em \"Novo profissional\" e digite o nome.",
      "Abra o profissional para marcar os serviços que ele faz e definir o expediente de cada dia.",
      "Desative quem saiu de férias ou deixou a empresa: ele deixa de receber horários, mas o histórico continua.",
    ],
    examples: [
      "O Bruno atende de segunda a sexta, das 9h às 12h e das 14h às 18h, e só faz corte e barba: cadastre esse expediente e marque esses dois serviços.",
    ],
    warning: "Seu plano pode ter um limite de profissionais. Se atingir, o sistema avisa e você pode trocar de plano em Assinatura.",
  },
  "pagina.profissionalDetalhe": {
    title: "Ficha do profissional",
    purpose: "Aqui você ajusta o nome, os serviços que este profissional faz e o expediente de cada dia da semana.",
    steps: [
      "Em \"Dados\", altere o nome ou desmarque \"Ativo\" para tirar o profissional da agenda.",
      "Em \"Serviços que realiza\", marque só o que ele faz e clique em Salvar.",
      "Em \"Expediente semanal\", informe os horários de cada dia e salve.",
    ],
    examples: [
      "A Júlia não atende às quartas: deixe a quarta sem horário. O bot e a agenda não oferecem esse dia para ela.",
    ],
  },
  "pagina.servicos": {
    title: "Serviços",
    purpose: "É o cardápio da empresa: o que você vende, quanto tempo leva e (se quiser) o preço. O bot oferece esses serviços ao cliente no WhatsApp.",
    steps: [
      "Clique em \"Novo serviço\" e preencha nome e duração em minutos.",
      "Se precisar de tempo de folga depois do atendimento, preencha \"Intervalo após\".",
      "Preço é opcional: deixe em branco e ele não aparece para o cliente.",
      "Use \"Ordem de exibição\" para decidir o que aparece primeiro.",
    ],
    examples: [
      "Corte de cabelo, 30 minutos, intervalo de 10 minutos, R$ 45: a agenda reserva 30 min para o serviço e mais 10 min livres antes do próximo cliente.",
      "Desative um serviço sazonal para o bot parar de oferecê-lo, sem perder o cadastro.",
    ],
  },
  "pagina.whatsapp": {
    title: "WhatsApp",
    purpose: "Aqui você conecta o número de WhatsApp da empresa. Depois de conectado, o bot atende, agenda e avisa seus clientes por ele.",
    steps: [
      "Clique em \"Conectar número\" e dê um nome para ele (ex.: Recepção).",
      "No celular do número da empresa, abra o WhatsApp e toque em \"Aparelhos conectados\".",
      "Toque em \"Conectar aparelho\" e aponte a câmera para o QR code da tela.",
      "Aguarde: o status muda para \"Conectado\".",
    ],
    examples: [
      "O status ficou \"Desconectado\" (o celular ficou sem internet por dias, por exemplo): clique em \"Atualizar status\" e, se precisar, conecte de novo com um QR code novo.",
    ],
    tip: "Use um número que você consiga manter sempre com internet. Sem o número conectado, o bot e os lembretes não funcionam.",
    warning: "Só o dono da empresa conecta, desconecta ou remove números. \"Remover\" apaga o número de vez: para usá-lo de novo, é preciso um QR code novo.",
  },
  "pagina.mensagensBot": {
    title: "Mensagens do bot",
    purpose: "Aqui você escolhe o que o bot escreve para o cliente no WhatsApp: saudação, etapas do agendamento, lembretes e avisos. Cada mensagem já vem pronta, e você pode deixar do seu jeito.",
    steps: [
      "Escolha o grupo de mensagens nas abas (Conversa, Agendamento, Meus agendamentos, Atendente, Rótulos).",
      "Clique em \"Editar\" na mensagem que quer mudar.",
      "Escreva o novo texto. Toque nas variáveis (ex.: {nome}) para inserir o dado do cliente no lugar certo.",
      "Confira a prévia no formato do WhatsApp e salve.",
    ],
    examples: [
      "Texto: \"Oi, {nome}! Seu horário é {quando}, às {hora}.\" O cliente recebe: \"Oi, Ana! Seu horário é amanhã, às 14:00.\"",
      "Errou ou não gostou? Clique no botão de restaurar e a mensagem volta ao texto padrão.",
    ],
    tip: "As mensagens marcadas como \"Personalizado\" são as que você já mudou; \"Padrão\" é o texto original.",
  },
  "pagina.configuracoes": {
    title: "Configurações",
    purpose: "Reúne os ajustes da empresa: dados de cobrança, lembrete automático, regras do atendimento pelo WhatsApp, tema visual, bloqueios e equipe.",
    steps: [
      "Role a página: os cartões de cima são ajustes que você edita ali mesmo.",
      "Os cartões de baixo levam a outras telas (Aparência, Bloqueios e feriados, Equipe).",
      "Cada cartão tem o seu ícone \"i\" com o passo a passo e exemplos.",
    ],
    examples: [
      "Quer que o bot lembre os clientes do horário? Ligue o \"Lembrete automático para clientes\".",
      "Quer trocar as cores do painel? Abra \"Aparência\".",
    ],
    warning: "Só o dono da empresa altera as configurações. A equipe consegue ver, mas não mudar.",
  },
  "pagina.aparencia": {
    title: "Aparência",
    purpose: "Escolha entre 3 temas prontos de cores para o painel. A escolha vale para toda a equipe da empresa.",
    steps: [
      "Olhe a prévia de cada tema.",
      "Clique no tema que mais gostou.",
      "Clique em \"Salvar tema\".",
    ],
    examples: [
      "O Índigo Clínico tem tons de azul mais sérios, bom para clínica e consultório. O Âmbar Estúdio puxa para cores quentes, com cara de salão. O Verde Slate é o mais discreto e cansa menos a vista de quem passa o dia no painel.",
    ],
    tip: "O tema muda só as cores do painel. Nada muda no que o cliente vê no WhatsApp.",
  },
  "pagina.bloqueios": {
    title: "Bloqueios e feriados",
    purpose: "Marque os períodos em que a empresa inteira não atende, como feriados e recessos. Nesses dias ninguém consegue agendar, nem o bot.",
    steps: [
      "Clique em \"Novo bloqueio\".",
      "Informe o início e o fim do período e, se quiser, o motivo.",
      "Salve. Para voltar atrás, exclua o bloqueio na lista.",
    ],
    examples: [
      "Feriado de 25/12: bloqueie o dia todo e o bot deixa de oferecer horários nessa data.",
      "Recesso de 2 a 6 de janeiro: um bloqueio só, com início dia 2 e fim dia 6.",
    ],
    tip: "Para bloquear só um profissional (férias, por exemplo), use a tela Profissionais.",
  },
  "pagina.equipe": {
    title: "Equipe",
    purpose: "Convide colegas para usar o painel. Cada pessoa entra com o próprio e-mail e senha.",
    steps: [
      "Clique em \"Convidar membro\".",
      "Digite o e-mail e escolha o papel: \"Equipe\" ou \"Dono\".",
      "A pessoa recebe um e-mail com um link para criar a senha e entrar.",
    ],
    examples: [
      "A recepcionista Paula só precisa agendar e atender: convide como \"Equipe\". Ela não altera configurações, plano nem número de WhatsApp.",
      "Seu sócio precisa mexer em tudo: convide como \"Dono\".",
    ],
    warning: "Quem é \"Dono\" pode alterar configurações, plano e WhatsApp. Convide como Dono só quem é de total confiança.",
  },
  "pagina.assinatura": {
    title: "Assinatura",
    purpose: "Mostra o plano da empresa, se a assinatura está em dia, a fatura em aberto (com Pix) e os planos disponíveis.",
    steps: [
      "Veja o plano atual e a situação (Em teste, Ativa, Fatura atrasada, Suspensa).",
      "Se houver fatura em aberto, pague pelo QR code ou copie o código Pix.",
      "Para mudar de plano, escolha em \"Planos disponíveis\".",
    ],
    examples: [
      "A fatura vence em 3 dias: abra o app do seu banco, leia o QR code e pronto. A tela atualiza sozinha quando o pagamento chega.",
    ],
    warning: "Com a assinatura suspensa por falta de pagamento, você ainda vê tudo, mas não consegue criar ou alterar nada até pagar.",
  },
  "pagina.minhaConta": {
    title: "Minha conta",
    purpose: "Mostra os seus dados de acesso e deixa você corrigir o seu nome.",
    steps: [
      "Altere o campo \"Seu nome\".",
      "Clique em Salvar.",
    ],
    examples: [
      "Seu nome aparece na saudação do Início (\"Bom dia, Paula!\") e no menu lateral.",
    ],
    tip: "O e-mail é o que você usa para entrar e não pode ser alterado por aqui.",
  },
  "pagina.onboarding": {
    title: "Primeiros passos",
    purpose: "Um passo a passo curto para deixar a empresa pronta para agendar: cadastrar um serviço, um profissional e conhecer o WhatsApp.",
    steps: [
      "Siga as etapas na ordem; o botão de avançar libera quando a etapa estiver completa.",
      "Você pode voltar a qualquer etapa para corrigir.",
      "No fim, vá para a agenda e marque o primeiro cliente.",
    ],
    examples: [
      "Etapa 1: serviço \"Corte\", 30 minutos. Etapa 2: profissional \"Bruno\". Ele já nasce com expediente de segunda a sexta, das 9h às 18h, que você ajusta depois.",
    ],
  },

  // ───────────────────────────── Início: cartões ─────────────────────────────
  "inicio.agendamentosHoje": {
    title: "Agendamentos hoje",
    purpose: "Conta quantos horários a empresa tem hoje, sem contar os cancelados.",
    examples: ["Se marcou 6 e cancelou 1, o cartão mostra 5."],
  },
  "inicio.proximos7dias": {
    title: "Próximos 7 dias",
    purpose: "Conta os agendamentos previstos para os próximos 7 dias, sem contar os cancelados. Serve para você ver se a semana está cheia.",
    examples: ["\"18\" significa 18 clientes marcados até daqui a uma semana."],
  },
  "inicio.taxaFaltas": {
    title: "Taxa de faltas",
    purpose: "Mostra a porcentagem de clientes que não apareceram nos últimos 30 dias, entre os atendimentos que você marcou como \"Concluído\" ou \"Faltou\".",
    examples: [
      "8 concluídos e 2 faltas: 2 de 10 atendimentos, então a taxa é 20%.",
    ],
    tip: "Marque sempre \"Concluído\" ou \"Faltou\" depois do horário. Sem isso, a taxa não fica fiel. O lembrete automático ajuda a baixar as faltas.",
  },
  "inicio.agendadoPeloBot": {
    title: "Agendado pelo bot",
    purpose: "Mostra a porcentagem dos horários dos últimos 30 dias que o próprio cliente marcou pelo WhatsApp, sem a equipe precisar fazer nada.",
    examples: [
      "De 40 agendamentos, 30 vieram do WhatsApp e 10 foram marcados pela equipe no painel: o cartão mostra 75%.",
    ],
  },
  "inicio.whatsappConectado": {
    title: "WhatsApp conectado",
    purpose: "Mostra quantos números de WhatsApp da empresa estão conectados agora e quantos existem no total.",
    steps: ["Se o número estiver desconectado, abra a tela WhatsApp e conecte de novo."],
    examples: ["\"1 de 2 número(s)\": um dos números caiu e precisa ser conectado de novo."],
    warning: "Sem número conectado o bot não responde e os lembretes não saem.",
  },
  "inicio.grafico": {
    title: "Agendamentos por dia",
    purpose: "Mostra, dia a dia, quantos agendamentos (sem contar os cancelados) a empresa teve nos últimos 30 dias. Ajuda a ver os dias mais cheios e os mais vazios.",
    examples: ["Se o gráfico sobe sempre às sextas e sábados, vale abrir mais horários nesses dias."],
  },

  // ───────────────────────────── Configurações: cartões ─────────────────────────────
  "config.cobranca": {
    title: "Dados para cobrança",
    purpose: "Informe o CPF ou CNPJ da empresa. Ele é exigido para gerar o Pix da mensalidade: sem ele, a cobrança não é criada.",
    steps: [
      "Digite o CPF ou CNPJ (a máscara é colocada sozinha).",
      "Clique em Salvar. A etiqueta muda de \"Pendente\" para \"Cadastrado\".",
    ],
    examples: ["Você tenta pagar a fatura e aparece \"O Mercado Pago exige o CPF ou CNPJ\": volte aqui, cadastre e gere o Pix de novo."],
    warning: "Só o dono da empresa pode alterar.",
  },
  "config.lembrete": {
    title: "Lembrete automático para clientes",
    purpose: "O bot manda uma mensagem no WhatsApp antes do horário marcado, lembrando o cliente. Menos gente falta, e você não precisa ligar para ninguém.",
    steps: [
      "Ligue a chave \"Enviar lembrete automático\".",
      "Escolha com quantas horas de antecedência enviar (de 2 a 48; o padrão é 24).",
      "Clique em Salvar.",
      "Para mudar o texto da mensagem, clique em \"Editar o texto do lembrete\".",
    ],
    examples: [
      "Sua cliente Ana marcou corte às 14h de sexta. Com lembrete de 24h, ela recebe na quinta por volta das 14h: \"Oi, Ana! Passando pra lembrar: você tem Corte com Bruno amanhã às 14:00. Se precisar remarcar ou cancelar, responda menu.\"",
      "Horário às 7h e lembrete de 24h: como o envio só acontece entre 8h e 21h, a mensagem sai por volta das 8h do dia anterior.",
      "Cliente que marcou com menos de 2 horas de antecedência não recebe lembrete, porque já está em cima da hora.",
    ],
    tip: "O cliente pode responder \"menu\" para remarcar ou cancelar direto pelo WhatsApp.",
    warning: "O lembrete só sai se houver um número de WhatsApp conectado. Ele não é enviado a clientes com o bot pausado ou em atendimento pela equipe. A verificação roda de hora em hora, então a mensagem chega perto do horário combinado, não no minuto exato.",
  },
  "config.atendimento": {
    title: "Atendimento pelo WhatsApp",
    purpose: "São as regras que o bot segue ao marcar horários e ao passar a conversa para a sua equipe.",
    steps: [
      "Defina quantos agendamentos futuros cada cliente pode ter ao mesmo tempo.",
      "Escolha se os horários oferecidos são de 30 em 30 ou de 15 em 15 minutos.",
      "Escolha depois de quanto tempo sem resposta da equipe o bot volta a responder.",
      "Decida se o cliente é avisado quando a equipe mexe na agenda pelo painel.",
      "Clique em Salvar.",
    ],
    examples: [
      "Limite 3 (o padrão): a Ana já tem 3 horários marcados. Se pedir um quarto pelo WhatsApp, o bot explica que ela atingiu o limite.",
      "Grade de 30 min: o bot oferece 09:00, 09:30, 10:00. Com 15 min: 09:00, 09:15, 09:30.",
    ],
    warning: "Só o dono da empresa pode alterar. Com a assinatura suspensa, a edição fica bloqueada.",
  },
  "config.limiteAgendamentos": {
    title: "Limite de horários por cliente",
    purpose: "Define quantos horários um mesmo cliente pode ter marcados ao mesmo tempo quando agenda pelo WhatsApp. Evita que uma pessoa reserve a agenda toda.",
    steps: ["Digite um número de 0 a 20 (o padrão é 3). Use 0 para não ter limite.", "Clique em Salvar no fim do cartão."],
    examples: [
      "Com limite 2: a Carla já tem corte na terça e manicure na quinta. Se tentar marcar outro pelo bot, ele avisa que o limite foi atingido.",
    ],
    tip: "Este limite vale para o bot. A equipe, pelo painel, pode marcar normalmente.",
  },
  "config.grade": {
    title: "Grade de horários",
    purpose: "É o intervalo entre os horários que o bot oferece ao cliente.",
    steps: ["Escolha \"A cada 30 minutos\" ou \"A cada 15 minutos\".", "Clique em Salvar."],
    examples: [
      "De 30 em 30: o bot oferece 09:00, 09:30, 10:00…",
      "De 15 em 15: 09:00, 09:15, 09:30… Dá mais opções, bom para serviços rápidos.",
    ],
  },
  "admin.whatsappComercial": {
    title: "WhatsApp de atendimento comercial",
    purpose: "É o número que abre quando um visitante clica no botão \"Tirar dúvidas\" do site do InnoChat. A conversa cai direto no WhatsApp da sua equipe comercial.",
    steps: [
      "Digite o telefone com DDD, com ou sem máscara.",
      "Clique em Salvar: o número aparece formatado abaixo do campo.",
      "Para esconder o botão do site, apague o número e salve.",
    ],
    examples: [
      "(84) 3113-2584 ou +55 84 3113-2584: os dois funcionam e viram o mesmo número.",
      "Celular com o nono dígito: (84) 99999-8888.",
    ],
    tip: "O número precisa ter WhatsApp ativo, senão o visitante não consegue conversar.",
  },
  "admin.whatsappCobranca": {
    title: "WhatsApp de cobrança",
    purpose: "É o número que manda os avisos de mensalidade para os assinantes: fatura gerada, vencimento, suspensão. Não é o comercial do site. Você conecta e troca por aqui, quando quiser.",
    steps: [
      "Ligue a chave \"Mandar avisos de cobrança pelo WhatsApp\". Desligada, os avisos vão só por e-mail e pelo painel.",
      "Clique em \"Conectar número\", dê um nome (por exemplo, Cobrança) e leia o QR com o WhatsApp do chip escolhido.",
      "Para trocar de número, clique em \"Trocar de número\" e leia o QR do chip novo. O atual segue enviando até o novo conectar, então nunca falta canal.",
      "Use \"Enviar teste\" para ver a mensagem chegando no seu celular.",
    ],
    examples: [
      "Você comprou um chip só para cobrança: conecte aqui. Se o WhatsApp bloquear, conecte outro chip sem mexer em mais nada.",
      "O número caiu: o card mostra \"Caiu\" e um QR para reconectar. Se você ler com outro celular, vale como troca de número.",
      "Quem responde SAIR para esse número deixa de receber os avisos por WhatsApp, e a resposta aparece no sino.",
    ],
    tip: "Um chip só para os avisos isola o risco: se for bloqueado, o WhatsApp do seu atendimento não é afetado. Número novo envia menos por hora nos 3 primeiros dias.",
    warning: "Não use o WhatsApp comercial do site nem o número do bot de uma empresa: o sistema recusa.",
  },
  "admin.pixelMeta": {
    title: "Pixel do Meta",
    purpose: "Conta quantas pessoas chegam pelos seus anúncios do Facebook e do Instagram, começam o cadastro, criam a conta e pagam a primeira mensalidade. Com isso o Meta aprende quem comprar e o anúncio fica mais barato.",
    steps: [
      "No Gerenciador de Eventos do Meta, abra a sua fonte de dados (o Pixel). O ID são só números e aparece logo abaixo do nome do Pixel.",
      "Cole o ID no campo \"ID do Pixel\".",
      "Para contar o pagamento, abra Configurações, vá na parte de Conversões, clique em gerar chave de acesso e cole a chave no campo da chave de acesso. Ela é guardada cifrada e nunca volta para a tela.",
      "Ligue a chave \"Pixel do Meta\". O aviso de cookies passa a aparecer na página inicial, nas páginas por tipo de negócio e no cadastro.",
      "Para testar, abra \"Testar eventos\" no Gerenciador, copie o código que começa com TEST, cole em \"Código de teste\", salve e clique em \"Enviar evento de teste\".",
    ],
    examples: [
      "ID do Pixel: 1234567890123456 (15 ou 16 números).",
      "Código de teste: TEST12345. Depois de validar, apague o código e salve, senão os eventos reais ficam marcados como teste.",
      "Quem clicar em Recusar no aviso de cookies não é contado, e nada do Meta carrega no navegador dessa pessoa.",
    ],
    tip: "O pagamento só é enviado para quem aceitou os cookies na hora do cadastro. Quem recusou nunca é enviado, nem pelo servidor.",
    warning: "O Pixel não roda dentro do painel das empresas, só nas páginas abertas ao público.",
  },
  "admin.smtpTeste": {
    title: "E-mail de teste",
    purpose: "Manda um e-mail simples, pelo mesmo servidor e remetente dos avisos de cobrança, e mostra o que o servidor respondeu. Serve para saber se a mensagem chega de verdade na sua caixa.",
    steps: [
      "Salve o SMTP antes. O teste usa o que está salvo, não o que está digitado na tela.",
      "Digite o seu e-mail (de preferência um Gmail) e clique em \"Enviar e-mail de teste\".",
      "Veja a resposta do servidor e depois confira a caixa de entrada, o spam e a aba Promoções.",
    ],
    examples: [
      "Resposta \"250 2.0.0 OK\" e o e-mail não chegou: o servidor aceitou, mas o Gmail pode ter filtrado. Olhe o spam e o SPF, DKIM e DMARC do domínio do remetente.",
      "Destinatário recusado: o endereço não existe ou o servidor bloqueou o envio. A resposta diz o motivo.",
    ],
    tip: "\"Aceito pelo servidor\" quer dizer que o servidor pegou a mensagem. Só você, olhando a caixa, confirma que ela chegou.",
    warning: "Cada administrador pode mandar 5 testes a cada 10 minutos.",
  },
  "pagina.adminBackup": {
    title: "Backup do banco",
    purpose: "Guarda uma cópia do banco de dados todo dia num lugar fora do servidor, apaga as cópias antigas e avisa você por e-mail e pelo sino se a cópia atrasar. Se o banco se perder, é daqui que ele volta.",
    steps: [
      "Escolha para onde a cópia vai (bucket S3 ou Google Drive) e preencha os dados do destino.",
      "Clique em \"Testar conexão\" para ver se o destino aceita gravar.",
      "Clique em \"Fazer backup agora\". É a prova de que o caminho inteiro funciona, antes de confiar no horário marcado.",
      "Ligue o backup automático e escolha a hora.",
    ],
    examples: [
      "Você liga o automático às 3h. Todo dia a cópia sai sozinha e aparece no histórico com tamanho e data.",
      "A cópia não saiu por dois dias seguidos: você recebe um e-mail e o sino do Admin fica vermelho.",
    ],
    tip: "Guardar a cópia no mesmo servidor do banco não vale: se o servidor se perder, as duas se perdem juntas.",
    warning: "Não existe botão de restaurar de propósito. Restaurar apaga o banco atual, então é feito por linha de comando. O passo a passo está no runbook.",
  },
  "backup.agendamento": {
    title: "Agendamento do backup",
    purpose: "Define se o backup roda sozinho, a que horas (horário de Brasília), por quantos dias as cópias ficam guardadas e depois de quantas horas sem cópia o sistema avisa.",
    examples: [
      "Hora 3 e guardar por 14 dias: todo dia às 3h sai uma cópia, e as de mais de 14 dias são apagadas do destino.",
      "Avisar depois de 36 horas: se passar um dia e meio sem cópia nova, chega o e-mail de backup atrasado.",
    ],
    tip: "As cópias antigas só são apagadas depois que a nova foi enviada e conferida. E o sistema nunca apaga a última cópia que existe.",
  },
  "backup.destino": {
    title: "Destino do backup",
    purpose: "É o lugar onde as cópias ficam guardadas: um bucket S3 (ou compatível, como Cloudflare R2 e Backblaze) ou uma pasta do Google Drive. Escolha um só. Os segredos ficam cifrados e não voltam para a tela.",
    steps: [
      "Para S3, informe o endereço, o bucket, a região, a pasta (opcional), a chave de acesso e o segredo.",
      "Deixe o campo do segredo em branco para manter o que já está salvo.",
    ],
    examples: [
      "Cloudflare R2: endereço https://SEU-ID.r2.cloudflarestorage.com, região auto, bucket innochat-backup, pasta banco.",
      "Backblaze B2: endereço https://s3.us-west-004.backblazeb2.com, região us-west-004.",
    ],
    warning: "Use um bucket só para backup. A cópia tem dados de todas as empresas, e a chave que serve outros arquivos não deveria abrir isso.",
  },
  "backup.drive": {
    title: "Google Drive",
    purpose: "Guarda as cópias numa pasta do seu Drive. Há dois jeitos: Conectar com Google (indicado para Gmail pessoal) ou chave de conta de serviço (para Google Workspace).",
    steps: [
      "Conectar com Google: crie um app OAuth no Google Cloud, cole o Client ID e o Client Secret, salve e clique em Conectar. O sistema cria a pasta \"Backups InnoChat\" no seu Drive.",
      "Conta de serviço: cole o conteúdo do arquivo de chave, crie uma pasta no Drive, compartilhe com o e-mail da conta de serviço como Editor e cole o link da pasta.",
    ],
    examples: [
      "Você usa Gmail pessoal: use Conectar com Google. Conta de serviço não tem espaço próprio e o Google recusa o envio.",
      "Você tem Workspace e uma unidade compartilhada: a conta de serviço entra como membro dela e a pasta é de lá.",
    ],
    tip: "Na tela de consentimento do Google Cloud, deixe o app em \"Em produção\". Em \"Teste\" o acesso expira em 7 dias e o backup para sozinho.",
    warning: "No Drive, uma pessoa pode tirar o acesso sem querer (apagar a pasta, revogar a conta). Por isso o sistema avisa assim que a cópia falha, dizendo a causa.",
  },
  "backup.historico": {
    title: "Histórico de backups",
    purpose: "Lista cada cópia feita ou tentada: quando, se foi automática ou manual, o tamanho e, se falhou, o motivo e o que fazer.",
    examples: [
      "Uma linha vermelha com \"a pasta do Google Drive não está acessível\": alguém tirou o compartilhamento. Compartilhe de novo e use Fazer backup agora.",
      "Uma linha marcada como \"só teste\" é uma cópia gerada sem destino: foi conferida, mas não saiu do servidor, então não vale como backup.",
    ],
  },
  "admin.saudeCobranca": {
    title: "Cobrança na Saúde",
    purpose: "Mostra se a cobrança das assinaturas está andando: quando foi a última rodada, quantos avisos saíram, quantos falharam e se algum ficou parado na fila.",
    steps: [
      "Olhe o selo de cada linha: verde está bem, amarelo pede atenção, vermelho quer dizer parado.",
      "Se a última rodada passou de 2 horas, veja se o fluxo que roda de hora em hora está ligado. Passou de 3 horas, o sistema já avisa por e-mail e pelo sino.",
      "Se houver avisos presos ou e-mails falhando, confira o servidor de e-mail em Configurações e rode o teste de envio.",
    ],
    examples: [
      "A última rodada foi há 4 horas e o selo está vermelho: ninguém está recebendo aviso de mensalidade agora. O fluxo que roda de hora em hora provavelmente parou.",
      "O WhatsApp de cobrança caiu e o selo está amarelo: os avisos seguem por e-mail, só falta o WhatsApp. Leia o QR de novo em Configurações.",
    ],
    tip: "Há um endereço público com este mesmo resultado, feito para um monitor externo (o guia do UptimeRobot está no runbook). Ele avisa você até se o sistema inteiro cair.",
    warning: "O e-mail de aviso sai pelo mesmo servidor de e-mail da cobrança. Se o problema for esse servidor, só o monitor externo avisa.",
  },
  "pagina.adminFinanceiro": {
    title: "Painel financeiro",
    purpose: "Mostra quanto a plataforma fatura, quem está pagando em dia, quem atrasou e quanto dinheiro está para entrar. Os valores do mês seguem o horário de Brasília.",
    steps: [
      "Leia os cartões de cima para baixo: receita, recebido, atrasos e cancelamentos.",
      "Cada cartão tem um \"i\" que explica como o número é calculado.",
      "Para levar as faturas para uma planilha, use \"Baixar faturas (CSV)\" lá embaixo.",
    ],
    examples: [
      "A receita mensal está em R$ 4.200 e o recebido no mês em R$ 2.900: ainda faltam faturas para vencer neste mês.",
      "O cartão de atrasos mostra 3 faturas com mais de 30 dias: vale ligar para essas empresas antes de elas serem canceladas.",
    ],
  },
  "admin.receitaMensal": {
    title: "Receita mensal recorrente",
    purpose: "É a soma da mensalidade das empresas que pagam e estão em dia ou atrasadas. Empresas em teste e suspensas não entram.",
    examples: [
      "10 empresas no plano de R$ 59,90 dão R$ 599,00 por mês.",
      "Se uma delas for suspensa, o valor cai R$ 59,90 no mesmo instante.",
    ],
  },
  "admin.assinantes": {
    title: "Assinantes por situação",
    purpose: "Conta as empresas em cada situação: em teste, ativas (pagando), com fatura atrasada e suspensas.",
    examples: [
      "12 em teste, 30 ativas, 2 atrasadas e 1 suspensa: 33 empresas pagam ou já pagaram, e 12 ainda estão experimentando.",
    ],
    tip: "Empresa atrasada ainda usa o sistema normalmente. A suspensa fica só para leitura.",
  },
  "admin.recebidoMes": {
    title: "Recebido no mês",
    purpose: "É o total das faturas pagas neste mês, contado pela data do pagamento, e a comparação com o mês passado.",
    examples: [
      "Recebido R$ 2.900 contra R$ 2.600 no mês passado: sobe 11,5%.",
      "Uma fatura paga no dia 31 às 23h30 conta nesse mês, no horário de Brasília.",
    ],
  },
  "admin.proximosVencimentos": {
    title: "Próximos vencimentos",
    purpose: "Mostra quantas faturas vencem nos próximos 7 e 30 dias e quanto dinheiro isso representa. Só entram empresas ativas que não pediram cancelamento.",
    examples: ["7 dias: 4 faturas, R$ 239,60. 30 dias: 18 faturas, R$ 1.078,20."],
  },
  "admin.inadimplencia": {
    title: "Faturas atrasadas",
    purpose: "Soma as faturas vencidas e ainda abertas de empresas que já pagaram alguma vez. Quem está no período de teste não entra aqui.",
    examples: [
      "3 faturas atrasadas, R$ 179,70 no total, 1 delas há mais de 30 dias: essa é a que merece contato direto.",
    ],
    warning: "Depois do prazo de carência, a empresa é suspensa e, mais adiante, cancelada.",
  },
  "admin.cancelamentos": {
    title: "Cancelamentos do mês",
    purpose: "Conta as empresas canceladas no mês e separa quem pediu para sair de quem foi cancelada por falta de pagamento. A taxa compara com as empresas que pagavam no começo do mês.",
    examples: [
      "4 cancelamentos: 1 pediu para sair e 3 por falta de pagamento. Com 40 pagantes no começo do mês, a taxa é 10%.",
      "Sem pagantes no começo do mês, a taxa aparece como \"sem base\".",
    ],
  },
  "admin.recuperados": {
    title: "Recuperados pelos avisos",
    purpose: "Conta os pagamentos feitos por empresas que estavam atrasadas ou suspensas. É a forma de saber se os avisos de cobrança estão funcionando.",
    examples: ["5 empresas pagaram depois de atrasar, somando R$ 299,50: esse dinheiro teria ficado parado sem os avisos."],
  },
  "admin.baixarFaturas": {
    title: "Baixar faturas em planilha",
    purpose: "Gera um arquivo CSV com as faturas de um período, que abre no Excel ou no Google Planilhas.",
    steps: [
      "Escolha a data inicial e a final do vencimento.",
      "Se quiser, escolha só pagas, só abertas ou só anuladas.",
      "Clique em \"Baixar faturas (CSV)\".",
    ],
    examples: ["De 01/09 a 30/09, só pagas: serve para conferir com o extrato do Mercado Pago."],
    warning: "O período pode ter no máximo 12 meses por arquivo.",
  },
  "pagina.adminEnvios": {
    title: "Envios de cobrança",
    purpose: "É o registro de cada aviso que o sistema mandou (ou tentou mandar) às empresas: lembrete de vencimento, atraso, suspensão e pagamento. Mostra para quem foi, por qual canal e se chegou.",
    steps: [
      "Use os filtros de período, empresa, canal, etapa e situação. \"Só falhas\" mostra apenas o que não saiu.",
      "Clique em \"Ver mensagem\" para ler o texto que a empresa recebeu.",
      "Nos avisos que falharam, \"Reenviar\" tenta de novo.",
    ],
    examples: [
      "Uma empresa diz que não recebeu o lembrete: filtre por ela e veja o e-mail ou telefone exato para onde foi.",
      "\"Não enviado: sem número de WhatsApp conectado\" significa que o aviso nem saiu por falta de um número da plataforma.",
    ],
    tip: "O e-mail sempre é tentado. O WhatsApp só sai para quem aceitou receber.",
  },
  "admin.enviosFiltros": {
    title: "Filtros dos envios",
    purpose: "Reduzem a lista para o que você quer conferir. Os totais no topo acompanham os filtros.",
    examples: [
      "Período de 01/10 a 07/10 e situação \"Falhou\": todos os avisos que não saíram nessa semana.",
      "Canal WhatsApp e empresa \"Studio Bela\": confere se o aviso chegou no telefone dela.",
    ],
  },
  "pagina.adminErros": {
    title: "Erros do sistema",
    purpose: "Reúne os erros que o InnoChat registrou sozinho, tanto os do servidor quanto os que apareceram no navegador de alguém. Erros iguais ficam juntos num só item, com a conta de quantas vezes aconteceram.",
    steps: [
      "Olhe os itens em \"Abertos\": são os que ainda precisam de atenção.",
      "Clique em \"Ver detalhes\" para ler a mensagem, a rota e as últimas vezes em que aconteceu.",
      "Depois de corrigir, clique em \"Resolver\". Se o erro voltar, ele reabre e avisa de novo.",
    ],
    examples: [
      "Aparece \"TypeError: não foi possível ler a lista de serviços\" com 12 ocorrências desde ontem: abra os detalhes e veja em qual tela foi.",
      "Um erro que você já sabe que não tem conserto agora (de um navegador antigo, por exemplo): clique em \"Ignorar\" e ele só continua somando, sem alertar.",
    ],
    tip: "Quando aparece um erro novo, ele chega no sino e por e-mail, no máximo um e-mail a cada 15 minutos.",
    warning: "Nenhum e-mail, telefone ou senha é guardado: o sistema apaga esses dados do texto do erro antes de gravar.",
  },
  "admin.errosFiltros": {
    title: "Filtros dos erros",
    purpose: "Mostram só os erros da situação ou da origem que você escolher. Os números no topo seguem a origem escolhida.",
    examples: [
      "Situação \"Abertos\" e origem \"Navegador\": só o que quebrou na tela de alguém e ainda não foi resolvido.",
      "Situação \"Resolvidos\": confere se algum erro que você tinha corrigido voltou a aparecer.",
    ],
  },
  "admin.errosLista": {
    title: "Lista de erros",
    purpose: "Cada linha é um tipo de erro, com quantas vezes aconteceu, quando foi a última e em qual versão do sistema. A mais recente fica no topo.",
    steps: [
      "\"Resolver\" marca o erro como corrigido.",
      "\"Ignorar\" deixa o erro quieto: ele continua contando, mas não alerta nem mostra detalhes novos.",
      "\"Reabrir\" devolve o erro para os abertos.",
    ],
    examples: [
      "Um erro com 200 ocorrências e última vez há 5 minutos ainda está acontecendo agora.",
      "Um erro resolvido que volta a acontecer reabre sozinho e gera um novo aviso.",
    ],
  },
  "admin.errosDetalhe": {
    title: "Detalhe do erro",
    purpose: "Mostra as últimas vezes em que o erro aconteceu: o dia e a hora, a versão, a rota e o detalhe técnico que ajuda a achar o ponto exato do código.",
    examples: [
      "A rota é a mesma da Agenda em todas as ocorrências: o problema está nessa tela.",
      "Só as ocorrências da versão 1.7.0 em diante: o erro nasceu nessa publicação.",
    ],
    tip: "O detalhe técnico é para quem programa. Se for mandar para o suporte, copie a mensagem e a rota.",
  },
  "pagina.adminEmpresaCobranca": {
    title: "Cobrança da empresa",
    purpose: "Reúne num lugar só o plano, a situação da assinatura, as faturas e tudo o que aconteceu com essa empresa na cobrança.",
    examples: [
      "A empresa ligou dizendo que pagou: confira a fatura e veja na linha do tempo se o pagamento foi confirmado.",
      "Ela diz que nunca recebeu aviso: a linha do tempo mostra cada mensagem enviada, com e-mail ou telefone mascarado.",
    ],
  },
  "admin.linhaDoTempo": {
    title: "Linha do tempo da cobrança",
    purpose: "Mistura os avisos enviados com o que aconteceu na assinatura (pagamento, suspensão, cancelamento), do mais novo para o mais antigo.",
    examples: [
      "Você lê: \"Lembrete da véspera enviado por WhatsApp\", depois \"Fatura paga\": o aviso funcionou.",
      "Se aparece \"Suspensa por falta de pagamento\" sem nenhum aviso antes, vale checar o canal de envio.",
    ],
  },
  "conta.doisFatores": {
    title: "Verificação em 2 etapas",
    purpose: "Pede, além da senha, um código de 6 dígitos que o app do seu celular gera e troca a cada 30 segundos. Mesmo que alguém descubra a senha, não entra sem o celular.",
    steps: [
      "Instale no celular um app como Google Authenticator, Microsoft Authenticator ou Authy.",
      "Clique em \"Ativar verificação em 2 etapas\" e leia o QR code no app (ou digite a chave).",
      "Digite o código de 6 dígitos que o app mostrar e confirme.",
      "Guarde os 10 códigos de recuperação num lugar seguro: eles aparecem só uma vez.",
    ],
    examples: [
      "Na hora de entrar, depois da senha, a tela pede o código. Você abre o app, vê 482 913 e digita.",
      "Perdeu ou trocou de celular? Na tela do código, digite um código de recuperação, como abcde-fghij. Cada um vale uma vez só.",
    ],
    tip: "Quem entra com o Google (dono ou equipe) não vê esse passo: o próprio Google já confere. O administrador da plataforma não entra pelo Google; ele usa senha e código.",
    warning: "Para o administrador da plataforma a verificação é obrigatória, e sem ela nenhuma tela de administração funciona. Se a pessoa perder o celular e os códigos, outro administrador pode redefinir.",
  },
  "admin.doisFatores": {
    title: "Verificação em 2 etapas da equipe",
    purpose: "Mostra quem tem a verificação em 2 etapas ativa e deixa você redefinir a de quem perdeu o celular e os códigos de recuperação.",
    steps: [
      "Confirme que a pessoa é quem diz ser (por exemplo, por telefone).",
      "Clique em \"Redefinir\" ao lado do nome e confirme.",
    ],
    examples: [
      "A Paula trocou de celular e perdeu os códigos: você redefine, ela entra só com a senha e cadastra o app de novo.",
    ],
    warning: "Redefinir desconecta a pessoa de todos os aparelhos. Administradores são obrigados a cadastrar de novo no próximo acesso.",
  },
  "admin.planoAnual": {
    title: "Preço do plano anual",
    purpose: "É o valor cobrado de uma vez só por 12 meses de uso. O desconto aparece sozinho: 12 mensalidades menos o preço anual. Deixe em branco para o plano não ter opção anual.",
    steps: [
      "Digite o valor do ano em reais, por exemplo 590,00.",
      "Confira a economia que aparece logo abaixo do campo.",
      "Clique em Salvar. A opção anual aparece no cadastro, na landing e na tela Assinatura das empresas.",
    ],
    examples: [
      "Mensal de R$ 59,00 e anual de R$ 590,00: 12 mensalidades custam R$ 708,00, então a empresa economiza R$ 118,00 (2 meses grátis).",
      "Na receita mensal recorrente, esse plano anual entra como R$ 590,00 dividido por 12, ou seja, R$ 49,17 por mês.",
    ],
    warning: "Mudar o preço vale só para as próximas faturas. Quem já pagou o ano não recebe devolução nem cobrança de diferença.",
  },
  "admin.cupons": {
    title: "Cupons de desconto",
    purpose: "Crie códigos que a empresa digita no cadastro ou na tela Assinatura para pagar menos. Dá para escolher porcentagem ou valor em reais, validade, limite de usos e por quantas cobranças o desconto vale.",
    steps: [
      "Clique em \"Novo cupom\" e escolha o código, o desconto e a duração.",
      "Se quiser, limite a certos planos, ao plano mensal ou anual, a uma data e a um número de empresas.",
      "Para parar de oferecer, use \"Desativar\". Cupom nunca é apagado, para o histórico continuar certo.",
      "Em \"Resgates\" você vê quais empresas usaram e quanto cada uma economizou.",
    ],
    examples: [
      "BEMVINDO20: 20% de desconto só na primeira fatura, válido até 31/12 e limitado a 50 empresas.",
      "AMIGO50: R$ 50,00 de desconto em cada uma das 3 primeiras cobranças, só para o plano mensal.",
    ],
    tip: "Uma empresa só pode usar o mesmo cupom uma vez. O desconto nunca deixa a fatura abaixo de R$ 1,00.",
    warning: "Depois que uma empresa usa o cupom, tipo, valor, duração e ciclo ficam travados, porque mudariam o desconto de quem já usou. Crie outro cupom se precisar de uma regra nova.",
  },
  "admin.cupomResgates": {
    title: "Resgates do cupom",
    purpose: "Lista as empresas que adotaram este cupom, quando isso aconteceu e quanto o desconto valeu na primeira fatura em que entrou.",
    examples: [
      "A Clínica Bela adotou o cupom em 03/10 e economizou R$ 11,80 na primeira fatura.",
      "Empresa com valor \"ainda sem fatura\": o cupom está guardado e entra na próxima cobrança.",
    ],
    tip: "Um resgate é a empresa adotar o cupom. As cobranças seguintes com desconto não criam outro resgate.",
  },
  "assinatura.cobranca": {
    title: "Cobrança mensal ou anual",
    purpose: "Escolha se a cobrança é todo mês ou uma vez por ano, com desconto. A troca vale a partir da próxima fatura, sem cálculo proporcional.",
    steps: [
      "Escolha \"Mensal\" ou \"Anual\".",
      "Confira o valor da próxima fatura e a economia do ano.",
      "A fatura que já está em aberto continua como foi emitida. A troca vale na seguinte.",
    ],
    examples: [
      "Você paga R$ 59,00 por mês. Trocando para o anual, a próxima fatura sai de R$ 590,00 e cobre 12 meses.",
      "Voltou para o mensal no meio do ano? O ano já pago continua valendo até o fim. Só a fatura seguinte volta a ser mensal.",
    ],
    warning: "Não devolvemos nem calculamos proporcional ao trocar. O período já pago segue até o fim.",
  },
  "assinatura.cupom": {
    title: "Cupom de desconto",
    purpose: "Se você recebeu um código de desconto, digite aqui. O desconto entra a partir da próxima fatura e vale pelo tempo que o cupom definir.",
    steps: [
      "Digite o código e clique em \"Conferir\" para ver o valor.",
      "Clique em \"Aplicar cupom\" para guardar.",
    ],
    examples: [
      "O cupom BEMVINDO20 tira 20% da próxima fatura de R$ 59,00 e ela sai por R$ 47,20.",
      "Cupom de 3 cobranças: o desconto aparece nas 3 próximas faturas e depois some sozinho.",
    ],
    tip: "Só dá para ter um cupom por vez, e cada cupom só pode ser usado uma vez por empresa.",
  },
  "config.retomada": {
    title: "Quando o bot volta a responder",
    purpose: "Quando o cliente pede para falar com uma pessoa, o bot fica em silêncio. Aqui você escolhe quanto tempo de silêncio da equipe faz o bot voltar a responder sozinho.",
    steps: ["Escolha um tempo entre 30 minutos e 24 horas (o padrão é 2 horas).", "Clique em Salvar."],
    examples: [
      "Configurado em 2 horas: o cliente pediu atendente às 10h e você respondeu às 10h20. O bot fica quieto até 12h20. A cada nova resposta sua, a contagem recomeça.",
      "Ou clique em \"Encerrar e devolver ao bot\" na tela Atendimento para o bot voltar na hora.",
    ],
    tip: "O cliente pode digitar \"menu\" a qualquer momento para o bot voltar a responder.",
  },
  "config.avisoCliente": {
    title: "Avisar o cliente quando a equipe mexer na agenda",
    purpose: "Quando alguém da equipe agenda, remarca ou cancela um horário pelo painel, o cliente recebe uma mensagem no WhatsApp contando a mudança. Assim ele não é pego de surpresa.",
    steps: [
      "Ligue ou desligue a chave e clique em Salvar.",
      "Para mudar o texto das mensagens, vá em Mensagens do bot, aba Agendamento.",
      "Ao agendar, remarcar ou cancelar, o painel mostra \"O cliente será avisado no WhatsApp\" quando o aviso vai sair.",
    ],
    examples: [
      "Você remarca o corte da Ana de sexta 14h para sábado 10h: ela recebe na hora a mensagem com o novo dia e horário.",
      "Você cancela o horário de um cliente que ligou desmarcando: ele recebe a confirmação do cancelamento.",
    ],
    tip: "Marcar um atendimento como \"Concluído\" ou \"Faltou\" não envia nenhuma mensagem ao cliente.",
    warning: "O aviso só sai se o cliente tiver telefone com WhatsApp e se houver um número da empresa conectado. Por segurança, o sistema envia no máximo 10 mensagens por hora para o mesmo cliente e 120 por hora para a empresa toda. Passando disso, o aviso não sai, mas a mudança na agenda vale do mesmo jeito.",
  },
  "config.pausaCliente": {
    title: "Pausar o bot para este cliente",
    purpose: "Faz o bot parar de responder só este cliente, para você conversar direto, pelo celular ou pelo painel.",
    steps: [
      "Clique em \"Pausar por 1h\", \"Pausar por 24h\" ou \"Pausar indefinidamente\".",
      "Quando quiser o bot de volta, clique em \"Retomar bot\".",
    ],
    examples: [
      "A Marina combinou um procedimento especial e você quer tratar direto com ela: pause por 24h e o bot não atrapalha a conversa.",
    ],
    warning: "Com o bot pausado, o cliente também não recebe o lembrete automático.",
  },

  // ───────────────────────────── Mensagens do bot: abas ─────────────────────────────
  "mensagens.conversa": {
    title: "Mensagens de conversa",
    purpose: "São as mensagens do dia a dia: saudação, menu de opções, ajuda e as respostas quando o bot não entende o que o cliente escreveu.",
    steps: ["Clique em \"Editar\" na mensagem.", "Altere o texto e confira a prévia.", "Salve."],
    examples: ["Você pode trocar a saudação por \"Olá! Aqui é o Studio Bela. Como posso ajudar?\" com o nome da sua empresa."],
  },
  "mensagens.agendamento": {
    title: "Mensagens de agendamento",
    purpose: "São as mensagens de cada etapa em que o cliente marca um horário: escolher serviço, profissional, dia e horário, até a confirmação.",
    steps: ["Clique em \"Editar\" na etapa que quer mudar.", "Use as variáveis (como {servico} e {hora}) para o bot preencher os dados sozinho.", "Salve."],
    examples: [
      "Na confirmação: \"Pronto, {nome}! {servico} com {profissional} em {data}, às {hora}.\"",
      "\"Agendado pela equipe\", \"Remarcado pela equipe\" e \"Cancelado pela equipe\" também ficam aqui: são os avisos que o cliente recebe quando alguém da equipe mexe na agenda pelo painel (se o aviso estiver ligado em Configurações).",
    ],
    tip: "Cada mensagem só mostra as variáveis que fazem sentido nela.",
  },
  "mensagens.meus": {
    title: "Mensagens de Meus agendamentos",
    purpose: "São as mensagens sobre horários que já existem: consulta, remarcação, cancelamento e o lembrete automático.",
    steps: ["Clique em \"Editar\" na mensagem.", "Altere o texto e confira a prévia.", "Salve."],
    examples: [
      "\"Lembrete\" é o texto enviado pelo lembrete automático. Para ligá-lo e escolher a antecedência, vá em Configurações.",
      "Para cada mensagem, o painel mostra só as variáveis que valem nela (ex.: {hora}, {servico}).",
    ],
  },
  "mensagens.atendente": {
    title: "Mensagens do atendente",
    purpose: "São as mensagens de quando o cliente pede para falar com uma pessoa: o bot avisa que a equipe vai responder e fica em silêncio.",
    steps: ["Clique em \"Editar\" na mensagem.", "Altere e salve."],
    examples: ["Você pode informar seu horário de resposta: \"Já vamos te atender! Respondemos de segunda a sábado, das 9h às 18h.\""],
  },
  "mensagens.rotulos": {
    title: "Rótulos das opções",
    purpose: "São os nomes das opções numeradas que o cliente vê no menu do bot. O bot coloca o número na frente sozinho.",
    steps: ["Clique em \"Editar\" no rótulo.", "Escreva só o nome da opção, sem número.", "Salve."],
    examples: ["Trocar \"Agendar horário\" por \"Marcar meu horário\": o cliente vê \"1. Marcar meu horário\"."],
    tip: "Nos rótulos não há variáveis: escreva só o nome da opção.",
  },

  // ───────────────────────────── Profissional: cartões ─────────────────────────────
  "profissional.dados": {
    title: "Dados do profissional",
    purpose: "Nome do profissional e se ele está ativo. Profissional inativo não recebe novos horários, mas o histórico dele continua.",
    steps: ["Altere o nome ou desmarque \"Ativo\".", "Clique em Salvar."],
    examples: ["O Bruno vai ficar 2 meses afastado: desmarque \"Ativo\" e marque de novo quando ele voltar."],
  },
  "profissional.servicos": {
    title: "Serviços que realiza",
    purpose: "Marque os serviços que este profissional atende. O bot e a agenda só oferecem esses serviços com ele.",
    steps: ["Marque os serviços.", "Clique em Salvar."],
    examples: ["Só a Júlia faz coloração: marque coloração só no perfil dela. O cliente que pedir coloração será agendado com ela."],
    tip: "Se a lista estiver vazia, cadastre os serviços antes, na tela Serviços.",
  },
  "profissional.expediente": {
    title: "Expediente semanal",
    purpose: "São os horários em que o profissional atende em cada dia da semana. Só dentro desses horários a agenda oferece horários vagos.",
    steps: ["Em cada dia, informe o início e o fim.", "Para almoço ou pausa, use dois intervalos no mesmo dia.", "Dia sem horário é folga. Clique em Salvar."],
    examples: ["Segunda, das 9h às 12h e das 14h às 18h: o horário das 12h às 14h não é oferecido para ninguém."],
  },

  "profissional.folgas": {
    title: "Bloqueios e folgas do profissional",
    purpose: "Marque períodos em que só este profissional não atende, como férias, consulta médica ou um dia de folga.",
    steps: ["Clique para adicionar um bloqueio.", "Informe início, fim e, se quiser, o motivo.", "Salve. Para voltar atrás, exclua o bloqueio."],
    examples: ["A Júlia vai de férias de 10 a 20 de outubro: bloqueie o período dela e ninguém consegue marcar com ela nesses dias. Os outros profissionais continuam atendendo."],
    tip: "Para fechar a empresa inteira (feriado, por exemplo), use Configurações > Bloqueios e feriados.",
  },

  // ───────────────────────────── Assinatura: cartões ─────────────────────────────
  "assinatura.plano": {
    title: "Plano atual",
    purpose: "Mostra qual é o seu plano e a situação da assinatura.",
    examples: [
      "\"Em teste\": você está no período gratuito e a data do fim aparece ao lado.",
      "\"Fatura atrasada\": pague o Pix para não ter a conta suspensa.",
    ],
    warning: "Suspensa: você ainda vê tudo, mas não cria nem altera nada até pagar. Ao pagar, a conta volta ao normal automaticamente.",
  },
  "assinatura.fatura": {
    title: "Fatura em aberto",
    purpose: "É a cobrança da sua mensalidade. Você paga pelo Pix, lendo o QR code ou copiando o código.",
    steps: [
      "No app do seu banco, escolha pagar com Pix e leia o QR code, ou use \"Pix Copia e Cola\" com o código copiado.",
      "Aguarde um instante: a tela atualiza sozinha quando o pagamento chega.",
      "Se o Pix venceu, um novo é gerado; se não apareceu, clique em \"Gerar Pix agora\".",
    ],
    examples: ["Você clica no botão de copiar, abre o app do banco, escolhe \"Pix Copia e Cola\" e cola o código."],
    warning: "Se aparecer que falta o CPF ou CNPJ, cadastre em Configurações > Dados para cobrança.",
  },
  "assinatura.cancelar": {
    title: "Cancelar assinatura",
    purpose: "Encerra a sua assinatura quando você não quiser mais continuar. Só o dono da empresa pode cancelar.",
    steps: [
      "Clique em \"Cancelar assinatura\" e leia o aviso com a data em que o acesso termina.",
      "Se quiser, conte o motivo (é opcional e ajuda a melhorar o InnoChat).",
      "Confirme. Até a data, tudo continua funcionando e não há nova cobrança. Mudou de ideia? Clique em \"Desfazer cancelamento\".",
    ],
    examples: [
      "Você pagou até 20/11 e cancelou em 05/11: o atendimento segue normal até 20/11 e você não paga mais nada. Se voltar atrás antes de 20/11, é só desfazer.",
      "Se a assinatura já estiver suspensa por falta de pagamento, o cancelamento vale na hora.",
    ],
    tip: "Antes de cancelar, exporte a lista dos seus clientes (CSV) na tela Clientes.",
    warning: "Depois que o acesso termina, os números de WhatsApp são desconectados e o painel mostra só a tela de Assinatura. Os dados ficam guardados por 90 dias; depois, os dados dos seus clientes são anonimizados.",
  },
  "assinatura.reativar": {
    title: "Reativar assinatura",
    purpose: "Volta a usar o InnoChat depois de ter cancelado, pagando uma nova mensalidade pelo Pix.",
    steps: [
      "Clique em \"Reativar assinatura\": aparece o Pix da mensalidade.",
      "Pague pelo app do banco. A tela atualiza sozinha quando o pagamento chega.",
      "Depois, conecte de novo o seu número em WhatsApp (leia o QR code outra vez).",
    ],
    examples: ["Você cancelou em outubro e quer voltar em dezembro: reative, pague o Pix e reconecte o WhatsApp. Seus cadastros continuam lá se isso for feito dentro de 90 dias."],
    warning: "Passados 90 dias do cancelamento, os dados dos seus clientes são anonimizados e não dá para recuperar.",
  },
  "assinatura.planos": {
    title: "Planos disponíveis",
    purpose: "Compare os planos e troque quando a empresa crescer ou quando quiser gastar menos.",
    steps: ["Clique no plano que você quer e confirme.", "Só o dono da empresa pode trocar de plano."],
    examples: [
      "Subir de plano (upgrade) vale na hora, e a diferença vem na próxima fatura.",
      "Descer de plano (downgrade) só é aceito se o que você usa hoje couber no plano menor, e vale a partir do próximo ciclo. Por exemplo: se o plano menor permite 2 profissionais e você tem 3, remova 1 antes.",
    ],
  },
  "assinatura.banner": {
    title: "Aviso de cobrança no topo",
    purpose: "Mostra quanto tempo falta para o teste acabar, para a fatura vencer ou para o bot parar de responder, com um botão que leva direto ao Pix.",
    steps: [
      "Clique em \"Pagar com Pix\" (ou \"Assinar com Pix\"): a tela Assinatura abre já no código Pix.",
      "Pague pelo app do banco. O aviso some sozinho quando o pagamento é confirmado.",
    ],
    examples: [
      "Faltam 2 dias e 4 horas para a fatura vencer: o aviso fica amarelo e o relógio vai descendo.",
      "A fatura venceu ontem: o aviso fica vermelho e diz em quanto tempo o bot para de responder. Até lá, ele segue atendendo normalmente.",
      "Depois de pagar, aparece por 7 dias \"Assinatura renovada até 20/11\". Dá para fechar no X.",
    ],
    warning: "Com a assinatura suspensa, o painel fica só para consulta e o bot não responde até o pagamento.",
  },
  "assinatura.contato": {
    title: "Contato de cobrança",
    purpose: "Define para onde vão os avisos da mensalidade: um e-mail do financeiro (opcional) e o WhatsApp de quem cuida do pagamento.",
    steps: [
      "Se quiser, informe o e-mail do financeiro. Sem ele, os avisos vão para o e-mail do dono.",
      "Informe o WhatsApp com DDD que deve receber os avisos de cobrança.",
      "Para não receber pelo WhatsApp, desligue \"Receber cobrança pelo WhatsApp\". Os e-mails continuam.",
    ],
    examples: [
      "A clínica tem uma contadora que paga as contas: coloque o e-mail dela. O dono continua recebendo os avisos mais urgentes.",
      "Você não quer mensagens no WhatsApp: desligue a chave e salve. Só chegam e-mails.",
    ],
    warning: "Só o dono da empresa altera. Quem é da equipe vê os dados, mas não edita.",
  },
  "assinatura.historico": {
    title: "Histórico de pagamentos",
    purpose: "Lista as faturas da empresa, com valor, período e situação, para você conferir o que já foi pago.",
    examples: ["Seu contador pergunta quando foi o último pagamento: a data aparece na linha da fatura paga."],
  },
  "assinatura.aviso-whatsapp": {
    title: "WhatsApp dos avisos de cobrança",
    purpose: "Pergunta qual número de WhatsApp deve receber os avisos da mensalidade (fatura chegando, vencendo e pagamento confirmado).",
    steps: [
      "Digite o número com DDD e clique em \"Salvar WhatsApp\".",
      "Para não receber pelo WhatsApp, abra a tela Assinatura e desligue a chave de cobrança.",
    ],
    examples: ["O dono atende pelo celular (84) 99999-0000: coloque esse número e os avisos chegam nele, além do e-mail."],
    tip: "Se preferir, feche o aviso no X. Ele volta na próxima vez que você entrar no painel.",
  },
  "profissional.comissao": {
    title: "Comissão do profissional",
    purpose: "Quanto do valor de cada atendimento concluído fica para o profissional. O Relatórios usa isso para mostrar quanto você deve pagar a cada um.",
    steps: [
      "Em \"Comissão padrão\", digite o percentual que vale para todos os serviços dele.",
      "Se algum serviço paga diferente, preencha o percentual ao lado do serviço. Deixe em branco para usar o padrão.",
      "Clique em Salvar comissão.",
    ],
    examples: [
      "A Ana ganha 40% em corte e 30% em química: coloque 40 na comissão padrão e 30 ao lado de Química.",
      "A Bia não comissiona em retoque: escreva 0 ao lado de Retoque. O zero vale, ele não volta para o padrão.",
    ],
    tip: "Mudar a comissão vale para os atendimentos concluídos daqui pra frente. O que já foi concluído guarda o valor da época.",
  },
  "pagina.relatorios": {
    title: "Relatórios",
    purpose: "Mostra quanto a empresa faturou no período, por serviço e por profissional, com ticket médio, faltas e a comissão a pagar. Só o dono vê esta tela.",
    steps: [
      "Escolha o período: este mês, mês passado, últimos 30 dias ou datas à sua escolha.",
      "Leia os totais no topo e as tabelas por serviço e por profissional.",
      "Clique em \"Baixar CSV\" para abrir os números numa planilha.",
    ],
    examples: [
      "No fim do mês, escolha \"Este mês\" e veja a coluna Comissão a pagar de cada profissional para fechar o acerto com a equipe.",
      "O Bruno faltou em 3 de 20 horários marcados: a taxa de faltas dele aparece como 13,0%.",
    ],
    tip: "Só entram atendimentos marcados como Concluído. Se algo ficou aberto na agenda, conclua lá para contar aqui.",
    warning: "Atendimentos concluídos antes desta tela existir usam o preço e a comissão de hoje, por isso aparecem como valores estimados.",
  },
} as const satisfies Record<string, HelpEntry>;

export type HelpKey = keyof typeof HELP_ENTRIES;

export const HELP: Record<HelpKey, HelpEntry> = HELP_ENTRIES;

/** Chaves das abas da tela Mensagens do bot (mesmo `id` do catálogo de abas). */
export const BOT_TAB_HELP: Record<"conversa" | "agendamento" | "meus" | "atendente" | "rotulos", HelpKey> = {
  conversa: "mensagens.conversa",
  agendamento: "mensagens.agendamento",
  meus: "mensagens.meus",
  atendente: "mensagens.atendente",
  rotulos: "mensagens.rotulos",
};

/** Termos técnicos que nunca podem aparecer nos textos de ajuda (conferido em `help-content.test.ts`). */
export const FORBIDDEN_HELP_TERMS = [
  "tenant",
  "instância",
  "instancia",
  "webhook",
  "n8n",
  "evolution",
  "endpoint",
  "token",
  "slug",
  "payload",
  "cron",
  "backend",
  "frontend",
  "OWNER",
  "STAFF",
  "sandbox",
  "JSON",
  "API",
] as const;
