import type { LegalSection } from "@/components/legal/legal-document";

/**
 * Política de Privacidade do InnoChat — texto publicado em `/privacidade`.
 * Espelho para revisão: `docs/legal/politica-de-privacidade.md` (mantenha os dois iguais).
 * Versão e vigência: `src/lib/legal.ts`.
 *
 * Os marcadores entre colchetes (`[CNPJ]`, `[ENDEREÇO]`, ...) são dados que o responsável
 * precisa preencher antes da publicação definitiva.
 */
export const PRIVACIDADE_INTRO: string[] = [
  "Esta Política explica quais dados pessoais o InnoChat trata, para quê, com quem são compartilhados, por quanto tempo são guardados e como você pode exercer seus direitos, de acordo com a Lei Geral de Proteção de Dados Pessoais (Lei nº 13.709/2018, \"LGPD\").",
];

export const PRIVACIDADE_SECTIONS: LegalSection[] = [
  {
    id: "sobre",
    title: "Sobre esta política",
    blocks: [
      "O InnoChat é uma plataforma de agendamento e atendimento automatizado pelo WhatsApp operada pela **Innovare Code**, inscrita no CNPJ sob o nº [CNPJ], com endereço em [ENDEREÇO] (\"Innovare Code\" ou \"nós\").",
      "Esta Política vale para:",
      {
        list: [
          "as empresas que contratam o InnoChat (\"Empresas\") e as pessoas que usam o painel em nome delas (\"Usuários\");",
          "as pessoas que conversam pelo WhatsApp com o atendimento automático de uma Empresa ou que são clientes dela (\"Clientes Finais\");",
          "quem visita as páginas públicas do InnoChat.",
        ],
      },
      "Os termos usados aqui têm o mesmo sentido dos [Termos de Uso](/termos).",
    ],
  },
  {
    id: "papeis",
    title: "Quem decide sobre cada dado",
    blocks: [
      "A LGPD distingue quem decide sobre o tratamento (controlador) de quem trata os dados em nome de outro (operador). No InnoChat:",
      {
        list: [
          "**Dados da conta** (Empresa, Usuários e cobrança): a **Innovare Code é a controladora**.",
          "**Dados de Clientes Finais** (nome, telefone, agendamentos e anotações): a **Empresa contratante é a controladora**, e a **Innovare Code é a operadora**, tratando esses dados só para prestar o serviço, conforme as instruções da Empresa.",
        ],
      },
      "**Se você é Cliente Final** (por exemplo, marcou um horário pelo WhatsApp de um salão ou de uma clínica), quem responde pelos seus dados é a empresa com quem você falou. As dúvidas e pedidos sobre seus dados devem ser feitos a ela. Se você nos procurar, encaminharemos o pedido à Empresa e a ajudaremos a atendê-lo (veja a seção 12).",
    ],
  },
  {
    id: "dados-tratados",
    title: "Quais dados tratamos",
    blocks: [
      {
        subtitle: "Dados da Empresa e dos Usuários",
        blocks: [
          {
            list: [
              "**Cadastro:** nome da empresa, endereço de acesso no painel, nome e e-mail dos Usuários e o papel de cada um. Quem cria a conta informa também o **telefone (WhatsApp) do responsável**, que usamos para avisos de cobrança e da conta. Em contas criadas antes de outubro de 2026, pode constar ainda o segmento de atuação.",
              "**Senha:** guardada apenas como hash (bcrypt). Nós nunca guardamos nem conseguimos ver a senha.",
              "**Cobrança:** plano, faturas (valores, datas e situação) e o identificador do pagamento no Mercado Pago. Quando o Mercado Pago exige, tratamos também o **CPF ou CNPJ do pagador**. Não recebemos dados bancários.",
              "**Aceite:** versão dos Termos e da Política aceita e a data do aceite.",
              "**WhatsApp da Empresa:** o número conectado e o estado da conexão.",
              "**Segurança e registros técnicos:** endereço IP e dados técnicos da requisição, usados para limitar tentativas de login e de cadastro, prevenir abuso e investigar falhas.",
            ],
          },
        ],
      },
      {
        subtitle: "Dados de Clientes Finais (tratados em nome da Empresa)",
        blocks: [
          {
            list: [
              "**Identificação:** nome (informado na conversa, cadastrado pela Empresa ou o nome de perfil do WhatsApp) e telefone ou identificador do WhatsApp.",
              "**Agendamentos:** serviço, profissional, data, horário e situação (marcado, cancelado, concluído ou falta).",
              "**Anotações:** observações que a Empresa escreve no painel sobre o cliente.",
              "**Estado do atendimento:** a etapa do menu em que a conversa está, as escolhas ainda em andamento e se o atendimento automático está pausado para aquele cliente. Esses dados são temporários e servem só para o bot continuar a conversa.",
            ],
          },
          "**O InnoChat guarda o histórico das conversas do WhatsApp por 90 dias.** O texto das mensagens trocadas entre o cliente e o número da Empresa (as do cliente e as respostas do bot ou da própria Empresa) fica armazenado para dar suporte ao atendimento, e a Empresa pode consultá-lo no painel. Mensagens de imagem, áudio, vídeo e documentos **não são guardadas**: fica apenas um marcador como [imagem]. Passados **90 dias** as mensagens são apagadas automaticamente; elas também são apagadas quando a Empresa exclui ou anonimiza o cliente. Guardamos ainda **metadados técnicos da mensagem** (identificador, horário e resultado do processamento), apagados após **30 dias**. **Lembretes automáticos:** quando a Empresa ativa essa função em Configurações, o InnoChat envia, em nome da Empresa, um lembrete por WhatsApp aos clientes finais que têm um agendamento marcado; a Empresa pode desligá-lo quando quiser. **Aviso aos clientes:** como controladora dos dados dos seus clientes, a Empresa deve informá-los sobre esses lembretes e sobre a guarda do histórico da conversa por 90 dias.",
        ],
      },
      {
        subtitle: "Visitantes das páginas públicas",
        blocks: [
          "Dados técnicos de acesso (como endereço IP e tipo de navegador) registrados pelos servidores. Não usamos ferramentas de análise de audiência nem de publicidade.",
        ],
      },
    ],
  },
  {
    id: "finalidades",
    title: "Para que usamos os dados e com qual base legal",
    blocks: [
      {
        list: [
          "**Criar e manter a conta e prestar o serviço** (painel, bot, agenda, e-mails de verificação, de redefinição de senha e de convite): execução de contrato (LGPD, art. 7º, V).",
          "**Cobrar a assinatura** (gerar faturas e Pix, avisar de vencimento e de suspensão): execução de contrato (art. 7º, V) e cumprimento de obrigação legal ou regulatória (art. 7º, II).",
          "**Segurança e prevenção de fraude e abuso** (limite de tentativas, bloqueio de testes repetidos com o mesmo número de WhatsApp, investigação de incidentes): legítimo interesse (art. 7º, IX).",
          "**Cumprir a lei e nos defender** em processos judiciais, administrativos ou arbitrais: art. 7º, II e VI.",
          "**Dados de Clientes Finais:** tratados apenas para prestar o serviço à Empresa, conforme as instruções dela. A base legal é definida pela Empresa, como controladora.",
        ],
      },
      "Não vendemos nem alugamos dados pessoais e não os usamos para publicidade.",
    ],
  },
  {
    id: "dados-sensiveis",
    title: "Dados de saúde e outros dados sensíveis",
    blocks: [
      "O InnoChat não pede dados sensíveis. Clínicas e outros negócios da área da saúde podem registrar anotações sobre os clientes, e **a Empresa é responsável por não inserir dados de saúde ou outros dados sensíveis além do estritamente necessário**, e por ter base legal para tratá-los (LGPD, art. 11). O InnoChat não é um prontuário eletrônico. Recomendamos não registrar diagnósticos, resultados de exames ou informações clínicas.",
    ],
  },
  {
    id: "compartilhamento",
    title: "Com quem compartilhamos",
    blocks: [
      "Para funcionar, o InnoChat depende de fornecedores que tratam dados em nosso nome (suboperadores), sempre limitados ao necessário para cada função:",
      {
        list: [
          "**Provedor de hospedagem** (servidor VPS gerenciado com Easypanel): armazena o banco de dados e executa o sistema. Todos os dados descritos nesta Política ficam nesses servidores.",
          "**Evolution API** (conexão com o WhatsApp): recebe e envia as mensagens entre o WhatsApp e o bot. É uma solução **não oficial**, sem vínculo com a Meta ou com o WhatsApp (veja a seção 5 dos [Termos de Uso](/termos)).",
          "**n8n** (automação): processa cada mensagem recebida para o bot responder e executa rotinas periódicas. Execuções bem-sucedidas não são salvas; registros de execuções com erro são apagados em até 7 dias.",
          "**Mercado Pago** (pagamento por Pix): recebe o valor da fatura e os dados do pagador (nome, e-mail e, quando exigido, CPF ou CNPJ). O Mercado Pago trata esses dados também segundo a política de privacidade dele.",
          "**Meta** (Pixel e API de Conversões, só para quem aceita o aviso de cookies): recebe os dados da visita e os eventos de cadastro e de primeiro pagamento descritos na seção de Cookies. A Meta trata esses dados também segundo a política de privacidade dela.",
          "**Provedor de e-mail (SMTP):** envia os e-mails do sistema (verificação, senha, convite, faturas e avisos), recebendo o endereço e o conteúdo da mensagem.",
        ],
      },
      "As mensagens do bot trafegam pela infraestrutura do **WhatsApp**, que é um serviço da Meta sujeito aos termos e à política de privacidade dela.",
      "Também podemos compartilhar dados quando a lei exigir ou por ordem de autoridade competente, e em caso de reorganização societária ou venda do negócio, mantidas as garantias desta Política.",
    ],
  },
  {
    id: "transferencia-internacional",
    title: "Onde os dados ficam",
    blocks: [
      "Os servidores do InnoChat ficam em [PAÍS/REGIÃO DO PROVEDOR DE HOSPEDAGEM]. Se algum fornecedor tratar dados fora do Brasil, a transferência seguirá as hipóteses do art. 33 da LGPD e a regulamentação da Autoridade Nacional de Proteção de Dados (ANPD).",
    ],
  },
  {
    id: "cookies",
    title: "Cookies",
    blocks: [
      "O InnoChat usa **apenas cookies essenciais**, necessários para o login funcionar com segurança:",
      {
        list: [
          "**Cookie de sessão** (`authjs.session-token`): mantém você conectado ao painel depois do login.",
          "**Cookie de proteção** (`authjs.csrf-token`): protege os formulários de login contra falsificação de requisições.",
          "**Cookie de retorno** (`authjs.callback-url`): lembra para qual página voltar depois do login.",
        ],
      },
      "Em conexões seguras, esses nomes podem aparecer com o prefixo `__Secure-` ou `__Host-`. Esses cookies são essenciais e não dependem de consentimento; se você bloqueá-los no navegador, não será possível entrar no painel. **Fora o Pixel descrito abaixo, não usamos cookies de análise, de publicidade nem ferramentas de rastreamento de terceiros.**",
      "**Cookies de medição, só com a sua permissão.** Nas páginas públicas (página inicial, páginas por tipo de negócio e cadastro), podemos usar o **Pixel do Meta** para medir de onde vêm os visitantes e quais anúncios terminam em cadastro. Ele só é carregado se você clicar em \"Aceitar\" no aviso que aparece nessas páginas. Se clicar em \"Recusar\", nada do Meta é carregado. O Pixel não roda dentro do painel. Você muda de ideia quando quiser em \"Preferências de cookies\", no rodapé da página inicial. Se aceitar, a Meta pode gravar cookies no seu navegador (como `_fbp` e `_fbc`) e receber dados da visita, como endereço IP, navegador e páginas acessadas. Quando você cria uma conta, também enviamos à Meta, pelo nosso servidor, o evento de cadastro e, no primeiro pagamento, o evento de compra (valor e data), com e-mail e telefone embaralhados por hash. Para isso guardamos, junto da conta, o seu aceite, o IP, o navegador e esses cookies do momento do cadastro. Nada disso é enviado para quem recusou o aviso.",
    ],
  },
  {
    id: "retencao",
    title: "Por quanto tempo guardamos os dados",
    blocks: [
      {
        list: [
          "**Dados da conta:** enquanto a conta existir. Depois do encerramento, dados de cobrança e os necessários para cumprir obrigações legais ou para defesa em processos são mantidos pelos prazos previstos em lei.",
          "**Registros de acesso:** pelo prazo exigido pelo Marco Civil da Internet (Lei nº 12.965/2014, art. 15).",
          "**Histórico de conversas do WhatsApp (texto das mensagens):** 90 dias, para suporte ao atendimento; apagado antes se a Empresa excluir ou anonimizar o cliente.",
          "**Metadados técnicos de mensagens:** 30 dias.",
          "**Registros de execuções com erro na automação:** até 7 dias.",
          "**Links enviados por e-mail:** verificação de e-mail, 48 horas; redefinição de senha, 1 hora; convite de equipe, 7 dias. Todos são de uso único.",
          "**Dados de Clientes Finais:** enquanto a Empresa usar o InnoChat, ou até a Empresa excluí-los. Se o cliente não tiver agendamentos, a exclusão é definitiva; se tiver, os dados que o identificam são anonimizados e o histórico de agendamentos é mantido sem identificação.",
          "**Após o cancelamento da Empresa:** os Dados de Clientes Finais são mantidos por **90 dias** (para permitir a reativação ou a exportação) e depois **anonimizados** automaticamente.",
          "**Cópias de segurança (backups):** guardadas por [PRAZO DE RETENÇÃO DOS BACKUPS] e depois substituídas pelas novas cópias.",
        ],
      },
    ],
  },
  {
    id: "seguranca",
    title: "Como protegemos os dados",
    blocks: [
      {
        list: [
          "Comunicação criptografada (HTTPS/TLS) entre o navegador e o InnoChat, com HSTS.",
          "Senhas guardadas apenas como hash bcrypt; links de verificação e de redefinição guardados como hash e de uso único.",
          "Isolamento entre empresas: cada Empresa só acessa os próprios dados, e essa separação é verificada pelo sistema em todas as consultas.",
          "Controle de acesso por papel no painel e limite de tentativas de login e de cadastro.",
          "Credenciais de integração acessíveis só aos administradores da plataforma e exibidas de forma mascarada.",
          "Minimização: o histórico de conversas guarda só texto, por no máximo 90 dias (mídia não é guardada), e os registros técnicos têm prazo curto.",
          "Cabeçalhos de segurança no navegador, como política de segurança de conteúdo (CSP) e proteção contra clickjacking.",
        ],
      },
      "Nenhum sistema é totalmente imune a falhas. Por isso, a Empresa também deve proteger suas senhas e o acesso ao celular e ao número conectado.",
    ],
  },
  {
    id: "incidentes",
    title: "Incidentes de segurança",
    blocks: [
      "Se ocorrer um incidente de segurança que possa causar risco ou dano relevante aos titulares, vamos:",
      {
        list: [
          "agir para conter o incidente e reduzir seus efeitos;",
          "avisar sem demora injustificada as Empresas afetadas, com as informações disponíveis, para que possam cumprir suas obrigações como controladoras dos Dados de Clientes Finais;",
          "quando formos os controladores dos dados atingidos, comunicar a ANPD e os titulares, no prazo e na forma da regulamentação da ANPD (LGPD, art. 48);",
          "registrar o incidente e as medidas tomadas.",
        ],
      },
    ],
  },
  {
    id: "direitos",
    title: "Seus direitos e como exercê-los",
    blocks: [
      "A LGPD (art. 18) garante ao titular dos dados os direitos de:",
      {
        list: [
          "confirmar se tratamos seus dados e ter acesso a eles;",
          "corrigir dados incompletos, inexatos ou desatualizados;",
          "pedir a anonimização, o bloqueio ou a eliminação de dados desnecessários, excessivos ou tratados em desacordo com a lei;",
          "pedir a portabilidade dos dados a outro fornecedor;",
          "pedir a eliminação dos dados tratados com base em consentimento, e revogar o consentimento;",
          "saber com quem compartilhamos seus dados;",
          "ser informado sobre a possibilidade de não dar consentimento e as consequências disso;",
          "opor-se a tratamento feito em desacordo com a lei.",
        ],
      },
      {
        subtitle: "Como fazer o pedido",
        blocks: [
          {
            list: [
              "**Usuários e Empresas:** muitos dados podem ser vistos e corrigidos direto no painel. Os demais pedidos devem ser enviados ao nosso encarregado, pelo [E-MAIL DO ENCARREGADO/DPO].",
              "**Clientes Finais:** faça o pedido à empresa com quem você fala pelo WhatsApp, que é a controladora dos seus dados. Ela pode, pelo painel, corrigir, exportar, excluir ou anonimizar seus dados e pausar o atendimento automático para você. Se você nos procurar, encaminharemos o pedido à empresa e a ajudaremos a atendê-lo.",
            ],
          },
          "Podemos pedir informações para confirmar a sua identidade antes de atender, para proteger os seus dados. Respondemos no prazo previsto na LGPD. Você também pode apresentar reclamação à Autoridade Nacional de Proteção de Dados (ANPD).",
        ],
      },
    ],
  },
  {
    id: "menores",
    title: "Crianças e adolescentes",
    blocks: [
      "O painel do InnoChat é destinado a maiores de 18 anos que representam uma Empresa. Se uma Empresa atende crianças ou adolescentes, cabe a ela tratar esses dados no melhor interesse deles e com as exigências do art. 14 da LGPD, como o consentimento de um dos pais ou responsável quando necessário.",
    ],
  },
  {
    id: "encarregado",
    title: "Encarregado pelo tratamento de dados (DPO)",
    blocks: [
      "O encarregado da Innovare Code pelo tratamento de dados pessoais é [NOME DO ENCARREGADO], que pode ser contatado pelo [E-MAIL DO ENCARREGADO/DPO].",
    ],
  },
  {
    id: "alteracoes",
    title: "Alterações desta política",
    blocks: [
      "Podemos atualizar esta Política. A versão e a data de vigência ficam sempre no topo da página. Mudanças relevantes serão avisadas por e-mail e/ou no painel com antecedência razoável e, quando necessário, pediremos um novo aceite.",
    ],
  },
  {
    id: "contato",
    title: "Contato e lei aplicável",
    blocks: [
      {
        list: [
          "**Encarregado (DPO):** [E-MAIL DO ENCARREGADO/DPO]",
          "**Atendimento geral:** [E-MAIL DE CONTATO]",
          "**Endereço:** Innovare Code, [ENDEREÇO]",
        ],
      },
      "Esta Política é regida pelas leis brasileiras, em especial a LGPD. Fica eleito o foro da Comarca de [COMARCA], ressalvadas as hipóteses em que a lei garanta outro foro.",
    ],
  },
];
