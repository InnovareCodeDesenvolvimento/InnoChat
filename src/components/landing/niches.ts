import type { DemoProfile } from "./demo-script";

/**
 * Conteúdo das páginas por tipo de negócio (`/salao`, `/barbearia`, `/clinica-estetica`,
 * `/consultorio`, `/pet-shop`). A estrutura é a da landing; muda o que a pessoa precisa ler para se
 * reconhecer: título, dores do dia a dia, serviços de exemplo e a conversa do bot.
 *
 * Regras de redação (docs/guia-de-voz.md): sem travessão, sem fórmula de IA, fato no lugar de
 * adjetivo. Só promete o que o produto faz hoje: agenda, remarca, cancela, lembra o cliente, chama a
 * equipe, duração e intervalo por serviço, profissionais com serviços e expediente próprios. Preços
 * e durações abaixo são exemplos do que a empresa cadastra; cada uma coloca os seus.
 */

export const NICHE_SLUGS = ["salao", "barbearia", "clinica-estetica", "consultorio", "pet-shop"] as const;
export type NicheSlug = (typeof NICHE_SLUGS)[number];

export type NichePain = { title: string; text: string };
export type NicheService = { name: string; detail: string; price: string };
export type NicheFaq = { question: string; answer: string };

export type Niche = {
  slug: NicheSlug;
  /** Nome no rodapé e nos atalhos entre as páginas. */
  label: string;
  /** Descrição curta para quem chega pelo Google: "agenda no WhatsApp para ...". */
  forWhom: string;
  metaTitle: string;
  metaDescription: string;
  ogAlt: string;
  /** Título da hero em três pedaços: o do meio ganha o degradê. */
  h1: { lead: string; highlight: string; tail: string };
  heroText: string;
  points: [string, string, string];
  demo: DemoProfile;
  painsTitle: string;
  painsIntro: string;
  pains: [NichePain, NichePain, NichePain];
  servicesTitle: string;
  servicesIntro: string;
  services: NicheService[];
  faq: NicheFaq[];
};

export const NICHES: Record<NicheSlug, Niche> = {
  salao: {
    slug: "salao",
    label: "Salão de beleza",
    forWhom: "salões de beleza",
    metaTitle: "Agenda no WhatsApp para salão de beleza | InnoChat",
    metaDescription:
      "O WhatsApp do seu salão marca, remarca e cancela horário sozinho e lembra a cliente no dia anterior. Cada profissional com a própria agenda. Teste grátis, sem cartão.",
    ogAlt: "InnoChat para salão de beleza: o WhatsApp agenda corte, escova e coloração sozinho",
    h1: { lead: "O WhatsApp do seu salão", highlight: "agenda sozinho", tail: ", mesmo com a mão na tinta" },
    heroText:
      "A cliente chama às 22h pedindo horário de escova para sábado. O InnoChat responde na hora, mostra os horários livres e marca. De manhã, você abre a agenda e ela já está lá.",
    points: ["Cada profissional com a própria agenda", "Coloração e corte com durações diferentes", "Lembrete no dia anterior, menos furo"],
    demo: {
      company: "Espaço Luna",
      client: "Camila",
      professional: "Ana",
      services: [
        { title: "Corte feminino", detail: "40 min" },
        { title: "Escova modelada", detail: "45 min" },
        { title: "Coloração", detail: "1h30" },
      ],
      duration: "40 min",
      price: "R$ 80,00",
      times: ["09:00", "10:30", "14:00", "16:30"],
    },
    painsTitle: "O dia de quem tem salão",
    painsIntro: "O celular não para, e quem está na cadeira também merece atenção.",
    pains: [
      {
        title: "Mensagem no meio do atendimento",
        text: "Você está com a tesoura na mão e o celular vibra. Responder agora atrasa quem está na cadeira. Deixar para depois perde quem queria horário.",
      },
      {
        title: "Cadeira vazia por esquecimento",
        text: "A cliente esquece, ou desmarca em cima da hora. O lembrete sai sozinho antes do horário, e ela remarca ali mesmo na conversa.",
      },
      {
        title: "Cada profissional faz uma coisa",
        text: "Quem faz coloração, quem faz unha, quem atende no sábado. O bot só oferece horário de quem faz aquele serviço, dentro do expediente dela.",
      },
    ],
    servicesTitle: "Serviços de salão que o bot já sabe marcar",
    servicesIntro: "Cada serviço tem duração e preço, e o bot só oferece horário em que o serviço inteiro cabe. Os valores abaixo são exemplos: você cadastra os seus.",
    services: [
      { name: "Corte feminino", detail: "40 min", price: "R$ 80,00" },
      { name: "Escova modelada", detail: "45 min", price: "R$ 60,00" },
      { name: "Coloração", detail: "1h30", price: "R$ 180,00" },
      { name: "Hidratação", detail: "50 min", price: "R$ 90,00" },
      { name: "Manicure e pedicure", detail: "1h", price: "R$ 70,00" },
      { name: "Design de sobrancelha", detail: "30 min", price: "R$ 40,00" },
    ],
    faq: [
      {
        question: "O bot sabe que coloração demora mais que um corte?",
        answer:
          "Sabe. Cada serviço tem a própria duração, e você ainda pode deixar um intervalo depois dele. O bot só mostra horários em que o serviço inteiro cabe na agenda da profissional.",
      },
      {
        question: "E se a cliente quiser falar com alguém?",
        answer:
          "Ela escolhe \"Falar com atendente\" no menu. O bot para de responder, a equipe é avisada e continua a conversa pelo painel, na tela Atendimento.",
      },
    ],
  },

  barbearia: {
    slug: "barbearia",
    label: "Barbearia",
    forWhom: "barbearias",
    metaTitle: "Agenda no WhatsApp para barbearia | InnoChat",
    metaDescription:
      "O WhatsApp da sua barbearia marca corte e barba sozinho, 24 horas por dia, e lembra o cliente antes do horário. Agenda de cada barbeiro. Teste grátis, sem cartão.",
    ogAlt: "InnoChat para barbearia: o WhatsApp agenda corte e barba sozinho",
    h1: { lead: "O WhatsApp da sua barbearia", highlight: "agenda sozinho", tail: ", mesmo na sexta lotada" },
    heroText:
      "O cliente manda \"tem horário hoje?\" quando você está com a navalha na mão. O bot responde por você, mostra o que está livre e marca. Você corta, ele confirma, ninguém fica esperando resposta.",
    points: ["Agenda separada para cada barbeiro", "Corte, barba e combo com tempo certo", "Cliente desmarca sozinho, sem ligar"],
    demo: {
      company: "Barbearia Navalha",
      client: "Rafael",
      professional: "Caio",
      services: [
        { title: "Corte masculino", detail: "30 min" },
        { title: "Barba", detail: "30 min" },
        { title: "Corte e barba", detail: "1h" },
      ],
      duration: "30 min",
      price: "R$ 45,00",
      times: ["09:00", "10:30", "15:00", "18:30"],
    },
    painsTitle: "O dia de quem tem barbearia",
    painsIntro: "Sexta e sábado enchem a cadeira e o WhatsApp ao mesmo tempo.",
    pains: [
      {
        title: "Pico de mensagens na hora do corte",
        text: "Na sexta à tarde o celular não para. O bot responde todo mundo na hora e deixa você inteiro na cadeira.",
      },
      {
        title: "Cliente que some",
        text: "Marcou, não avisou e não veio. O lembrete antes do horário traz o cliente de volta, ou libera o horário quando ele desmarca.",
      },
      {
        title: "Cada barbeiro com a sua agenda",
        text: "Um corta só de manhã, outro só atende de quinta a sábado. Cada um tem o expediente e os serviços dele, e o cliente escolhe com quem quer cortar.",
      },
    ],
    servicesTitle: "Serviços de barbearia que o bot já sabe marcar",
    servicesIntro: "Serviço curto e serviço longo convivem na mesma agenda. Os valores abaixo são exemplos: você cadastra os seus.",
    services: [
      { name: "Corte masculino", detail: "30 min", price: "R$ 45,00" },
      { name: "Barba", detail: "30 min", price: "R$ 35,00" },
      { name: "Corte e barba", detail: "1h", price: "R$ 70,00" },
      { name: "Pezinho e acabamento", detail: "15 min", price: "R$ 20,00" },
      { name: "Sobrancelha", detail: "15 min", price: "R$ 20,00" },
      { name: "Pigmentação de barba", detail: "40 min", price: "R$ 60,00" },
    ],
    faq: [
      {
        question: "O cliente consegue escolher o barbeiro?",
        answer:
          "Consegue. Cada barbeiro tem os serviços e o expediente dele, e o bot só mostra os horários de quem faz o serviço escolhido.",
      },
      {
        question: "Dá para atender cliente sem hora marcada?",
        answer:
          "Dá. O bot cuida de quem agenda, e você continua encaixando quem chega na porta. Pelo painel você marca um horário na hora, sem passar pelo WhatsApp.",
      },
    ],
  },

  "clinica-estetica": {
    slug: "clinica-estetica",
    label: "Clínica de estética",
    forWhom: "clínicas de estética",
    metaTitle: "Agenda no WhatsApp para clínica de estética | InnoChat",
    metaDescription:
      "A agenda da sua clínica de estética no WhatsApp: o bot marca sessões, respeita o intervalo entre atendimentos e lembra a paciente antes do horário. Teste grátis, sem cartão.",
    ogAlt: "InnoChat para clínica de estética: o WhatsApp marca sessões e lembra a paciente",
    h1: { lead: "O WhatsApp da sua clínica de estética", highlight: "marca a sessão sozinho", tail: ", mesmo depois do expediente" },
    heroText:
      "A paciente pergunta sobre limpeza de pele depois do expediente. O bot mostra os horários livres, marca a sessão e avisa antes do dia. A sua recepção começa o dia com a agenda pronta.",
    points: ["Sessões com duração e intervalo certos", "Lembrete antes de cada sessão", "Recepção chamada só quando precisa"],
    demo: {
      company: "Clínica Pele Viva",
      client: "Juliana",
      professional: "Dra. Marina",
      services: [
        { title: "Limpeza de pele", detail: "1h" },
        { title: "Drenagem linfática", detail: "50 min" },
        { title: "Peeling", detail: "40 min" },
      ],
      duration: "1h",
      price: "R$ 150,00",
      times: ["09:00", "11:00", "14:30", "16:00"],
    },
    painsTitle: "O dia de quem tem clínica de estética",
    painsIntro: "A sala não pode ficar parada, e a recepção também tem mais o que fazer.",
    pains: [
      {
        title: "Sessão que não pode ficar vaga",
        text: "Uma hora de sala sem paciente é dinheiro parado. O lembrete antes do horário reduz o esquecimento, e quem desmarca libera o horário na hora.",
      },
      {
        title: "Tempo de preparo entre um atendimento e outro",
        text: "Higienizar a sala e trocar o material leva tempo. Você define o intervalo depois de cada serviço, e o bot não marca nada em cima dele.",
      },
      {
        title: "Recepção presa no WhatsApp",
        text: "Perguntar horário, remarcar, cancelar. O bot faz o repetitivo. Quando a paciente quer tirar dúvida sobre um procedimento, ele chama a recepção.",
      },
    ],
    servicesTitle: "Procedimentos que o bot já sabe marcar",
    servicesIntro: "Cada procedimento tem duração, intervalo e profissional responsável. Os valores abaixo são exemplos: você cadastra os seus.",
    services: [
      { name: "Limpeza de pele", detail: "1h", price: "R$ 150,00" },
      { name: "Drenagem linfática", detail: "50 min", price: "R$ 120,00" },
      { name: "Peeling", detail: "40 min", price: "R$ 200,00" },
      { name: "Massagem modeladora", detail: "50 min", price: "R$ 110,00" },
      { name: "Depilação a laser", detail: "30 min", price: "R$ 130,00" },
      { name: "Avaliação", detail: "30 min", price: "R$ 50,00" },
    ],
    faq: [
      {
        question: "O bot tira dúvida sobre procedimento?",
        answer:
          "Não, e de propósito. Dúvida sobre procedimento é com a sua equipe. A paciente escolhe \"Falar com atendente\", o bot pausa e a recepção responde pelo painel.",
      },
      {
        question: "Dá para ter uma agenda por profissional ou por sala?",
        answer:
          "Por profissional. Cada uma tem os procedimentos e os horários dela, com folgas e bloqueios. Se a sala é compartilhada, você ajusta o expediente de cada profissional para não coincidir.",
      },
    ],
  },

  consultorio: {
    slug: "consultorio",
    label: "Consultório",
    forWhom: "consultórios",
    metaTitle: "Agenda no WhatsApp para consultório | InnoChat",
    metaDescription:
      "Para dentista, psicólogo, fisioterapeuta e nutricionista: o bot marca consulta e retorno pelo WhatsApp, remarca, cancela e lembra o paciente. Teste grátis, sem cartão.",
    ogAlt: "InnoChat para consultório: o WhatsApp marca consultas e retornos sozinho",
    h1: { lead: "O WhatsApp do seu consultório", highlight: "marca a consulta", tail: " enquanto você atende" },
    heroText:
      "O paciente quer remarcar a consulta de quinta. Você está atendendo e não pode olhar o celular. O bot mostra os horários livres, remarca e confirma. A sessão seguinte começa sem atraso.",
    points: ["Consulta e retorno com durações diferentes", "Lembrete que reduz falta e atraso", "Quem remarca não precisa ligar"],
    demo: {
      company: "Consultório Dra. Helena",
      client: "Marcos",
      professional: "Dra. Helena",
      services: [
        { title: "Primeira consulta", detail: "1h" },
        { title: "Retorno", detail: "30 min" },
        { title: "Sessão", detail: "50 min" },
      ],
      duration: "1h",
      price: "R$ 200,00",
      times: ["08:00", "10:00", "14:00", "17:00"],
    },
    painsTitle: "O dia de quem tem consultório",
    painsIntro: "Entre um paciente e outro, o WhatsApp acumula. E falta de paciente custa caro.",
    pains: [
      {
        title: "Falta e atraso do paciente",
        text: "Quem esquece não avisa, e o horário se perde. O lembrete chega antes da consulta, e remarcar leva um minuto pelo próprio WhatsApp.",
      },
      {
        title: "Consulta nova e retorno não são iguais",
        text: "A primeira consulta pede mais tempo que o retorno. Cada um é um serviço, com duração e preço próprios, e o bot respeita isso.",
      },
      {
        title: "Atendimento sem interrupção",
        text: "Você não precisa parar uma consulta para responder quem quer horário. O bot cuida do agendamento, e você só entra quando o paciente pede.",
      },
    ],
    servicesTitle: "Atendimentos que o bot já sabe marcar",
    servicesIntro: "Serve para dentista, psicólogo, fisioterapeuta, nutricionista e outros. Os valores abaixo são exemplos: você cadastra os seus.",
    services: [
      { name: "Primeira consulta", detail: "1h", price: "R$ 200,00" },
      { name: "Retorno", detail: "30 min", price: "R$ 120,00" },
      { name: "Sessão de psicologia", detail: "50 min", price: "R$ 150,00" },
      { name: "Sessão de fisioterapia", detail: "45 min", price: "R$ 130,00" },
      { name: "Limpeza odontológica", detail: "40 min", price: "R$ 180,00" },
      { name: "Avaliação nutricional", detail: "1h", price: "R$ 220,00" },
    ],
    faq: [
      {
        question: "O InnoChat guarda prontuário?",
        answer:
          "Não. Ele cuida da agenda e do atendimento pelo WhatsApp. Prontuário e histórico clínico continuam no sistema que você já usa.",
      },
      {
        question: "O paciente precisa baixar algum aplicativo?",
        answer:
          "Não. Ele conversa pelo WhatsApp, com o número do consultório que já conhece. Você conecta esse número lendo um QR Code.",
      },
    ],
  },

  "pet-shop": {
    slug: "pet-shop",
    label: "Pet shop",
    forWhom: "pet shops",
    metaTitle: "Agenda no WhatsApp para pet shop e banho e tosa | InnoChat",
    metaDescription:
      "O WhatsApp do seu pet shop marca banho, tosa e consulta sozinho e lembra o tutor antes do horário. Duração por serviço, agenda de cada profissional. Teste grátis, sem cartão.",
    ogAlt: "InnoChat para pet shop: o WhatsApp marca banho e tosa sozinho",
    h1: { lead: "O WhatsApp do seu pet shop", highlight: "agenda banho e tosa", tail: " sem você largar o cachorro" },
    heroText:
      "O tutor chama na hora do pico perguntando se tem vaga para o banho de amanhã. O bot responde na hora, mostra os horários livres e marca. Você segue com o cachorro na banheira.",
    points: ["Banho por porte, cada um com o seu tempo", "Agenda separada para banhista e veterinário", "Lembrete no dia anterior ao banho"],
    demo: {
      company: "Pet Amigo",
      client: "Fernanda",
      professional: "Bia",
      services: [
        { title: "Banho porte pequeno", detail: "40 min" },
        { title: "Banho porte grande", detail: "1h20" },
        { title: "Banho e tosa", detail: "1h30" },
      ],
      duration: "40 min",
      price: "R$ 55,00",
      times: ["08:30", "10:00", "13:30", "15:00"],
    },
    painsTitle: "O dia de quem tem pet shop",
    painsIntro: "Mão molhada, cachorro agitado e o celular tocando.",
    pains: [
      {
        title: "Mão molhada, celular tocando",
        text: "Quem está no banho não consegue pegar o telefone. O bot atende o tutor na hora e marca o horário sem você secar a mão.",
      },
      {
        title: "Banho de porte grande ocupa mais tempo",
        text: "Cadastre cada porte como um serviço, com a própria duração. O bot só marca o que cabe, e a agenda não estoura.",
      },
      {
        title: "Tutor que esquece do horário",
        text: "O lembrete chega no dia anterior. Se o tutor não pode, desmarca na conversa e libera o horário para outro cachorro.",
      },
    ],
    servicesTitle: "Serviços de pet shop que o bot já sabe marcar",
    servicesIntro: "Banho, tosa e consulta convivem na mesma agenda, cada um com a duração certa. Os valores abaixo são exemplos: você cadastra os seus.",
    services: [
      { name: "Banho porte pequeno", detail: "40 min", price: "R$ 55,00" },
      { name: "Banho porte grande", detail: "1h20", price: "R$ 110,00" },
      { name: "Banho e tosa", detail: "1h30", price: "R$ 130,00" },
      { name: "Tosa higiênica", detail: "30 min", price: "R$ 40,00" },
      { name: "Consulta veterinária", detail: "30 min", price: "R$ 140,00" },
      { name: "Vacina", detail: "15 min", price: "R$ 90,00" },
    ],
    faq: [
      {
        question: "Dá para cobrar diferente por porte do animal?",
        answer:
          "Dá. Cadastre cada porte como um serviço, por exemplo \"Banho porte pequeno\" e \"Banho porte grande\", cada um com a duração e o preço dele. O cliente escolhe na hora de marcar.",
      },
      {
        question: "Dá para ter banhista e veterinário na mesma agenda?",
        answer:
          "Dá. Cada profissional tem os serviços e o expediente dele. O bot só oferece o veterinário para consulta e o banhista para banho.",
      },
    ],
  },
};

export function getNiche(slug: string): Niche | null {
  return (NICHE_SLUGS as readonly string[]).includes(slug) ? NICHES[slug as NicheSlug] : null;
}

export function allNiches(): Niche[] {
  return NICHE_SLUGS.map((slug) => NICHES[slug]);
}
