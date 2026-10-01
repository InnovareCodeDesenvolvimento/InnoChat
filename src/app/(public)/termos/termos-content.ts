import type { LegalSection } from "@/components/legal/legal-document";

/**
 * Termos de Uso do InnoChat — texto publicado em `/termos`.
 * Espelho para revisão: `docs/legal/termos-de-uso.md` (mantenha os dois iguais).
 * Versão e vigência: `src/lib/legal.ts`.
 *
 * Os marcadores entre colchetes (`[CNPJ]`, `[ENDEREÇO]`, ...) são dados que o responsável
 * precisa preencher antes da publicação definitiva.
 */
export const TERMOS_INTRO: string[] = [
  "Estes Termos de Uso explicam as regras para contratar e usar o InnoChat. Leia com atenção: ao criar uma conta, você declara que leu, entendeu e aceita estes Termos e a [Política de Privacidade](/privacidade).",
];

export const TERMOS_SECTIONS: LegalSection[] = [
  {
    id: "quem-somos",
    title: "Quem somos e o que estes termos regulam",
    blocks: [
      "O InnoChat é uma plataforma on-line (software como serviço) de agendamento e atendimento automatizado pelo WhatsApp, voltada a clínicas, salões e outros negócios de serviço. O InnoChat é operado pela **Innovare Code**, inscrita no CNPJ sob o nº [CNPJ], com endereço em [ENDEREÇO] (\"Innovare Code\" ou \"nós\").",
      "Estes Termos regulam a relação entre a Innovare Code e a empresa ou profissional que cria uma conta no InnoChat (\"Empresa\" ou \"você\"), incluindo as pessoas que a Empresa autoriza a usar o painel (\"Usuários\").",
      "Quem cria a conta declara ser maior de 18 anos e ter poderes para representar a Empresa e aceitar estes Termos em nome dela. O InnoChat é contratado para uso na atividade profissional ou empresarial da Empresa.",
      "O aceite é registrado no cadastro, com a versão destes Termos e a data e hora do aceite.",
    ],
  },
  {
    id: "definicoes",
    title: "Definições",
    blocks: [
      {
        list: [
          "**Painel:** o sistema web do InnoChat, acessado com e-mail e senha, onde a Empresa configura serviços, profissionais, horários, mensagens do bot e acompanha a agenda.",
          "**Bot:** o atendimento automático que responde, pelo WhatsApp, às mensagens recebidas no número conectado pela Empresa, oferecendo um menu para agendar, remarcar e cancelar horários.",
          "**Cliente Final:** a pessoa que conversa com o Bot ou que é atendida pela Empresa e tem seus dados cadastrados no Painel.",
          "**Dados de Clientes Finais:** os dados pessoais de Clientes Finais tratados no InnoChat, como nome, telefone, agendamentos e anotações.",
          "**Plano:** a modalidade de assinatura contratada, com preço e limites próprios (por exemplo, quantidade de números de WhatsApp e de profissionais).",
          "**Período de teste:** o período gratuito concedido no cadastro, descrito na seção 8.",
        ],
      },
    ],
  },
  {
    id: "conta",
    title: "Cadastro e conta",
    blocks: [
      {
        list: [
          "Você se compromete a informar dados verdadeiros, completos e atualizados, e a mantê-los assim.",
          "É preciso confirmar o e-mail cadastrado antes de conectar um número de WhatsApp.",
          "Você é responsável por guardar a senha, por todas as ações feitas na conta e pelos Usuários que convidar. Se suspeitar de uso indevido, troque a senha e nos avise pelo [E-MAIL DE CONTATO].",
          "O Período de teste é concedido uma única vez por empresa e por número de WhatsApp. Um número que já usou o teste em outra conta só pode ser conectado depois da assinatura de um Plano.",
          "Não é permitido criar várias contas para burlar limites de Plano ou repetir o Período de teste.",
        ],
      },
    ],
  },
  {
    id: "servico",
    title: "O serviço",
    blocks: [
      "O InnoChat oferece, conforme o Plano contratado: cadastro de serviços, profissionais, expedientes e bloqueios; agenda com visão por dia e por profissional; Bot de agendamento pelo WhatsApp com textos editáveis; gestão de Clientes Finais, com pausa do Bot por cliente e exportação em planilha (CSV); e gestão da assinatura.",
      "O Bot responde apenas a quem enviou mensagem para o número da Empresa. As mensagens continuam chegando normalmente ao celular da Empresa, que pode assumir a conversa a qualquer momento. **O InnoChat guarda o texto das conversas por 90 dias, para suporte ao atendimento** (veja a Política de Privacidade). **O InnoChat também envia lembretes automáticos por WhatsApp aos clientes finais da Empresa, em nome dela, quando a Empresa ativa essa função em Configurações.** A Empresa, como controladora dos dados dos seus clientes, deve informá-los sobre esses lembretes e sobre a guarda do histórico da conversa por 90 dias.",
      "Os limites de cada Plano (números de WhatsApp, profissionais e outros) são verificados pelo sistema. Podemos melhorar, alterar ou descontinuar funcionalidades ao longo do tempo. Se uma mudança reduzir de forma relevante uma funcionalidade essencial do Plano contratado, avisaremos com antecedência razoável.",
    ],
  },
  {
    id: "whatsapp",
    title: "Conexão com o WhatsApp: riscos que você precisa conhecer",
    blocks: [
      "**Leia esta seção com atenção.** Ela trata de um risco próprio do produto.",
      {
        list: [
          "**API não oficial.** O InnoChat se conecta ao WhatsApp por meio da Evolution API, uma solução **não oficial**, que não é oferecida, autorizada nem endossada pela Meta Platforms (dona do WhatsApp). A Innovare Code não tem nenhum vínculo com a Meta ou com o WhatsApp.",
          "**Risco de restrição ou banimento.** A Meta pode, a qualquer momento e sem aviso, limitar, bloquear temporariamente ou banir de forma definitiva um número que use soluções não oficiais, ou que ela entenda estar em desacordo com as regras do WhatsApp. Esse risco existe mesmo com uso correto e não pode ser eliminado pela Innovare Code.",
          "**Sem garantia do canal.** A Innovare Code não garante que a conexão com o WhatsApp ficará sempre ativa, que todas as mensagens serão recebidas ou entregues, nem que o número conectado continuará disponível. Mudanças técnicas feitas pelo WhatsApp podem interromper o Bot até que uma correção seja possível, e pode ser necessário reconectar o número lendo um novo QR code.",
          "**Responsabilidade da Empresa.** A Empresa é a única responsável pelo número que conecta e por usá-lo de acordo com os Termos de Serviço e as políticas do WhatsApp, inclusive as regras sobre mensagens comerciais e sobre a vontade do Cliente Final de receber mensagens.",
          "**Recomendação.** Conecte um número dedicado ao atendimento do negócio, e não um número pessoal ou insubstituível. Mantenha formas alternativas de contato com seus clientes.",
        ],
      },
      "Para reduzir o risco, o Bot só responde a quem escreveu primeiro, limita a quantidade de mensagens por conversa e não faz envios em massa. Essas medidas diminuem, mas não eliminam, a chance de restrição do número.",
      "A Innovare Code não responde por perda de número, de conversas, de contatos ou de clientes decorrentes de medidas tomadas pela Meta ou pelo WhatsApp, nem por indisponibilidade do WhatsApp.",
    ],
  },
  {
    id: "uso-aceitavel",
    title: "Uso aceitável e proibições",
    blocks: [
      "É proibido usar o InnoChat para:",
      {
        list: [
          "enviar spam, mensagens em massa ou mensagens não solicitadas, ou contatar pessoas que não pediram para ser contatadas;",
          "divulgar ou armazenar conteúdo ilícito, fraudulento, enganoso, difamatório, discriminatório, violento ou que viole direitos de terceiros (inclusive direitos autorais, de imagem e de privacidade);",
          "aplicar golpes, obter dados de pessoas de forma enganosa ou se passar por outra pessoa ou empresa;",
          "oferecer produtos ou serviços proibidos por lei, ou que exijam autorização, registro ou licença que a Empresa não tenha;",
          "atividades que exijam sigilo reforçado (por exemplo, saúde, advocacia ou serviços financeiros) sem que a Empresa adote as salvaguardas legais, éticas e regulatórias exigidas para a sua atividade;",
          "tentar acessar dados de outras empresas, contornar controles de acesso ou limites de Plano, fazer engenharia reversa, testes de invasão sem autorização por escrito, ou sobrecarregar a plataforma de propósito;",
          "revender, sublicenciar ou disponibilizar o InnoChat a terceiros sem autorização por escrito da Innovare Code.",
        ],
      },
      "Se houver violação, podemos suspender o Bot ou a conta, remover conteúdo ou encerrar o contrato. Sempre que possível, avisaremos antes; em casos graves ou para proteger terceiros e a plataforma, a medida pode ser imediata.",
    ],
  },
  {
    id: "dados-pessoais",
    title: "Dados pessoais e papéis na LGPD",
    blocks: [
      "O tratamento de dados pessoais no InnoChat segue a Lei Geral de Proteção de Dados Pessoais (Lei nº 13.709/2018, \"LGPD\") e está detalhado na [Política de Privacidade](/privacidade). Em resumo:",
      {
        list: [
          "**A Empresa é a controladora dos Dados de Clientes Finais.** É ela quem decide por que e como esses dados são usados.",
          "**A Innovare Code é a operadora dos Dados de Clientes Finais.** Tratamos esses dados só para prestar o serviço, conforme as instruções da Empresa. Estes Termos e as configurações feitas pela Empresa no Painel valem como essas instruções.",
          "**A Innovare Code é a controladora dos dados da conta** (dados dos Usuários, da Empresa e de cobrança).",
        ],
      },
      "Cabe à Empresa, como controladora:",
      {
        list: [
          "ter uma base legal adequada para tratar os Dados de Clientes Finais e informar seus clientes sobre esse tratamento (por exemplo, em um aviso de privacidade próprio);",
          "coletar e registrar só os dados necessários para o atendimento;",
          "atender os pedidos dos Clientes Finais sobre os dados deles, usando as ferramentas do Painel (editar, excluir ou anonimizar cliente, exportar dados e pausar o Bot).",
        ],
      },
      {
        subtitle: "Dados de saúde e outros dados sensíveis",
        blocks: [
          "O campo de anotações do Painel permite registrar informações sobre o Cliente Final. Clínicas e outros negócios da área da saúde devem ter cuidado redobrado: **a Empresa é responsável por não inserir dados de saúde ou outros dados pessoais sensíveis além do estritamente necessário**, e por ter base legal para tratá-los nos termos do art. 11 da LGPD, além de cumprir as normas do seu conselho profissional. O InnoChat não é um prontuário eletrônico e não deve ser usado como tal. Recomendamos não registrar diagnósticos, resultados de exames ou informações clínicas nas anotações.",
        ],
      },
      "A Empresa autoriza a Innovare Code a contratar os suboperadores listados na Política de Privacidade para prestar o serviço. Se incluirmos um novo suboperador que receba Dados de Clientes Finais, atualizaremos a Política de Privacidade.",
    ],
  },
  {
    id: "planos-pagamento",
    title: "Planos, teste grátis e pagamento",
    blocks: [
      {
        subtitle: "Teste grátis",
        blocks: [
          "Toda conta nova tem um **Período de teste gratuito de 3 dias**, contados do cadastro, com os limites do plano de entrada. A primeira fatura é gerada já no cadastro, para que a Empresa possa assinar a qualquer momento. Se a fatura não for paga até o fim do teste, valem as regras de atraso descritas abaixo.",
        ],
      },
      {
        subtitle: "Assinatura e forma de pagamento",
        blocks: [
          "Os Planos são **mensais e pré-pagos**: cada mês é pago antes de ser usado. O pagamento é feito por **Pix**, processado pelo Mercado Pago. Para gerar o Pix, o Mercado Pago pode exigir o CPF ou CNPJ do pagador, que a Empresa informa no Painel. Os preços vigentes aparecem no Painel, na tela de Assinatura.",
          "A fatura de cada mês é gerada alguns dias antes do vencimento e avisada por e-mail e no Painel. O código Pix tem validade limitada e pode ser gerado de novo pelo Painel se expirar. Confirmado o pagamento, a assinatura é renovada por mais um mês a partir do vencimento anterior (ou a partir da data do pagamento, se a conta estava suspensa).",
        ],
      },
      {
        subtitle: "Atraso, suspensão e cancelamento automático",
        blocks: [
          {
            list: [
              "**Carência de 1 dia:** depois do vencimento, a conta continua funcionando normalmente por 1 dia, com aviso para pagamento.",
              "**Suspensão:** terminada a carência sem pagamento, o Bot para de responder e o Painel fica **somente para leitura** (a Empresa continua vendo a agenda e os clientes e pode pagar a fatura, mas não pode criar nem alterar nada). As mensagens dos clientes continuam chegando ao celular da Empresa.",
              "**Cancelamento automático:** após 60 dias de suspensão sem pagamento, a assinatura é cancelada e os números de WhatsApp são desconectados. Veja na seção 9 o que acontece com os dados.",
            ],
          },
        ],
      },
      {
        subtitle: "Troca de plano",
        blocks: [
          "A mudança para um Plano superior vale na hora, e a próxima fatura já vem com o preço do novo Plano; não há cobrança nem crédito proporcional pelos dias restantes do mês em curso. A mudança para um Plano inferior vale a partir do mês seguinte e só é aceita se o uso atual da Empresa couber nos limites do novo Plano.",
        ],
      },
      {
        subtitle: "Reajuste de preços",
        blocks: [
          "A Innovare Code pode alterar os preços dos Planos. Avisaremos por e-mail e/ou no Painel com pelo menos **30 dias de antecedência**; o novo preço vale a partir da primeira fatura gerada depois desse prazo. Se não concordar, a Empresa pode cancelar a assinatura antes disso.",
        ],
      },
      {
        subtitle: "Reembolso e documentos fiscais",
        blocks: [
          "Por se tratar de serviço pré-pago e mensal, os valores pagos não são reembolsados, nem de forma proporcional, ressalvados os direitos garantidos por lei.",
          "O InnoChat não emite documentos fiscais automaticamente. Dúvidas sobre documentos fiscais podem ser enviadas ao [E-MAIL DE CONTATO].",
        ],
      },
    ],
  },
  {
    id: "cancelamento",
    title: "Cancelamento e encerramento",
    blocks: [
      {
        list: [
          "A Empresa pode cancelar a assinatura a qualquer momento pelo Painel. O cancelamento vale ao fim do período já pago, sem reembolso desse período. Até essa data, a Empresa pode desfazer o cancelamento pelo Painel.",
          "Se a assinatura estiver no Período de teste, o cancelamento vale ao fim do teste. Se estiver atrasada ou suspensa, o cancelamento é imediato.",
          "A Innovare Code pode encerrar o contrato por violação destes Termos (seção 6) ou, se decidir descontinuar o InnoChat, com aviso de pelo menos 30 dias.",
          "Com a assinatura cancelada, os números de WhatsApp são desconectados e o Painel mostra apenas a tela de Assinatura, para reativação.",
          "**Os dados são guardados por 90 dias após o cancelamento.** Depois disso, os Dados de Clientes Finais são **anonimizados**: nome, telefone, identificadores de WhatsApp e anotações são apagados, e só permanece o histórico de agendamentos sem identificação de ninguém. Recomendamos exportar os dados dos clientes (CSV) antes de cancelar.",
          "Dados da conta e de cobrança podem ser mantidos pelos prazos exigidos por lei, conforme a Política de Privacidade.",
        ],
      },
    ],
  },
  {
    id: "disponibilidade",
    title: "Disponibilidade e suporte",
    blocks: [
      "Trabalhamos para manter o InnoChat disponível e funcionando bem, mas não garantimos funcionamento ininterrupto ou livre de falhas. Podem ocorrer interrupções para manutenção, atualização ou por falhas de terceiros dos quais o serviço depende (hospedagem, conexão com o WhatsApp, automação, pagamento e e-mail). Não há acordo de nível de serviço (SLA) garantido, salvo contratação específica por escrito.",
      "O suporte é prestado pelo [E-MAIL DE CONTATO], em dias úteis.",
    ],
  },
  {
    id: "propriedade-intelectual",
    title: "Propriedade intelectual",
    blocks: [
      "O InnoChat, seu código, sua marca, seu visual e sua documentação pertencem à Innovare Code. Durante a assinatura, a Empresa recebe uma licença de uso limitada, pessoal, não exclusiva e intransferível, só para as finalidades destes Termos.",
      "O conteúdo que a Empresa cadastra (nome, serviços, textos do Bot e demais informações) continua sendo da Empresa, que autoriza a Innovare Code a usá-lo só para prestar o serviço.",
    ],
  },
  {
    id: "responsabilidades",
    title: "Responsabilidades e limitações",
    blocks: [
      "A Empresa é responsável pelo conteúdo que cadastra e pelas mensagens do Bot que personaliza; pela relação com seus clientes e pelos serviços que presta a eles; pelo cumprimento das normas da sua atividade (inclusive de conselhos profissionais); e por conferir a agenda.",
      "Na extensão permitida por lei, a Innovare Code não responde por lucros cessantes, perda de clientes, de receita ou de oportunidades, nem por danos indiretos; por indisponibilidade, restrição ou banimento do WhatsApp (seção 5); por falhas de serviços de terceiros; ou por uso do InnoChat em desacordo com estes Termos.",
      "Na extensão permitida por lei, a responsabilidade total da Innovare Code relacionada a estes Termos fica limitada ao valor pago pela Empresa nos 12 meses anteriores ao fato que originou o pedido. Essa limitação não se aplica aos casos em que a lei não a permite, como dolo.",
      "A Empresa ressarcirá a Innovare Code por perdas e despesas (inclusive honorários advocatícios razoáveis) decorrentes de reclamações de terceiros causadas por uso do InnoChat em violação destes Termos ou da lei.",
    ],
  },
  {
    id: "alteracoes",
    title: "Alterações destes termos",
    blocks: [
      "Podemos atualizar estes Termos. A versão e a data de vigência ficam sempre no topo da página. Mudanças relevantes serão avisadas por e-mail e/ou no Painel com pelo menos 30 dias de antecedência, e podemos pedir um novo aceite. Se a Empresa não concordar, pode cancelar a assinatura antes da entrada em vigor; continuar usando o InnoChat depois dela significa concordar com a nova versão.",
    ],
  },
  {
    id: "disposicoes-gerais",
    title: "Disposições gerais",
    blocks: [
      {
        list: [
          "Estes Termos e a Política de Privacidade formam o acordo completo entre as partes sobre o uso do InnoChat.",
          "Se alguma cláusula for considerada inválida, as demais continuam valendo.",
          "Deixar de exigir um direito em algum momento não significa renunciar a ele.",
          "A Empresa não pode transferir este contrato sem autorização por escrito. A Innovare Code pode transferi-lo em caso de reorganização societária ou venda do negócio, mantidas as condições destes Termos.",
          "As comunicações serão feitas pelo e-mail cadastrado na conta e/ou por avisos no Painel.",
        ],
      },
    ],
  },
  {
    id: "lei-foro",
    title: "Lei aplicável e foro",
    blocks: [
      "Estes Termos são regidos pelas leis da República Federativa do Brasil. Fica eleito o foro da Comarca de [COMARCA] para resolver qualquer questão relacionada a eles, ressalvadas as hipóteses em que a lei garanta outro foro.",
    ],
  },
  {
    id: "contato",
    title: "Contato",
    blocks: [
      {
        list: [
          "**Atendimento e suporte:** [E-MAIL DE CONTATO]",
          "**Encarregado pelo tratamento de dados pessoais (DPO):** [E-MAIL DO ENCARREGADO/DPO]",
          "**Endereço:** Innovare Code, [ENDEREÇO]",
        ],
      },
    ],
  },
];
