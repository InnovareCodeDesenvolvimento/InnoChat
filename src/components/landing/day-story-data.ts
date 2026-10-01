/**
 * Conteúdo da seção "Você conhece esse dia" (landing). UM objeto por tipo de negócio: para
 * acrescentar um nicho basta copiar um item de NICHES e trocar os textos (o teste confere que
 * nada ficou vazio). A estrutura das cenas e os horários são iguais em todos; muda quem está na
 * frente, a ferramenta na mão, o serviço e as mensagens. Nomes e mensagens são fictícios.
 *
 * O texto das cenas é montado em `day-story.tsx` a partir destes campos, em primeira pessoa
 * (quem conta o próprio dia), com concordância neutra: nunca depende do gênero de ninguém.
 */
export type AgendaRow = { time: string; name: string; service: string };

export type Niche = {
  id: string;
  /** Rótulo do chip. */
  label: string;
  /** "Abro o salão" (cena 08:40). */
  opening: string;
  /** Quem está na frente: "a cliente na cadeira" (cena 10:15). */
  inFront: string;
  /** "com a tesoura na mão". */
  busy: string;
  /** "em cima da bancada". */
  surface: string;
  /** Sujeito da cena das 16h: "A cliente das 16h". */
  noShow: string;
  /** "A cadeira fica vazia" (sem ponto final). */
  emptyPhrase: string;
  /** As 3 mensagens que esperam às 08:40 (remetente = nome da linha de agenda de mesmo índice). */
  messages: [string, string, string];
  /** Os 3 que viram horário marcado na agenda (cena 08:40, "Com InnoChat"). */
  agenda: [AgendaRow, AgendaRow, AgendaRow];
  /** Cena 10:15: quem escreve e o que pergunta. */
  buzz: { name: string; ask: string };
  /** Cena 12:30: quem pede às 15h e o serviço. */
  lunch: { name: string; service: string };
  /** Cena 16:00: quem não veio (ou foi lembrado ontem). */
  late: { name: string; service: string };
  /** Cena 23:47: quem pergunta de madrugada. */
  night: { name: string };
};

export const NICHES: Niche[] = [
  {
    id: "geral",
    label: "Qualquer negócio",
    opening: "Abro as portas",
    inFront: "quem está na minha frente",
    busy: "no meio de um atendimento",
    surface: "ao meu lado",
    noShow: "Quem tinha horário às 16h",
    emptyPhrase: "O horário fica vazio",
    messages: ["Tem horário hoje?", "Quanto custa o atendimento?", "Consegue algo livre à tarde?"],
    agenda: [
      { time: "09:30", name: "Marina", service: "Atendimento" },
      { time: "11:00", name: "Rafael", service: "Atendimento" },
      { time: "14:30", name: "Paula", service: "Retorno" },
    ],
    buzz: { name: "Bianca", ask: "Oi, ainda tem horário sábado?" },
    lunch: { name: "Rosana", service: "atendimento" },
    late: { name: "Camila", service: "atendimento" },
    night: { name: "Helena" },
  },
  {
    id: "salao",
    label: "Salão",
    opening: "Abro o salão",
    inFront: "a cliente na cadeira",
    busy: "com a tesoura na mão",
    surface: "em cima da bancada",
    noShow: "A cliente das 16h",
    emptyPhrase: "A cadeira fica vazia",
    messages: ["Tem horário hoje?", "Quanto é a escova?", "Faz hidratação à tarde?"],
    agenda: [
      { time: "09:30", name: "Marina", service: "Escova" },
      { time: "11:00", name: "Paula", service: "Corte" },
      { time: "14:30", name: "Luana", service: "Hidratação" },
    ],
    buzz: { name: "Bianca", ask: "Oi, ainda tem horário sábado pra escova?" },
    lunch: { name: "Rosana", service: "corte" },
    late: { name: "Camila", service: "progressiva" },
    night: { name: "Helena" },
  },
  {
    id: "barbearia",
    label: "Barbearia",
    opening: "Abro a barbearia",
    inFront: "o cliente na cadeira",
    busy: "com a máquina na mão",
    surface: "na bancada",
    noShow: "O cliente das 16h",
    emptyPhrase: "A cadeira fica vazia",
    messages: ["Tem horário hoje?", "Quanto é corte e barba?", "Dá pra encaixar à tarde?"],
    agenda: [
      { time: "09:30", name: "Rafael", service: "Corte e barba" },
      { time: "11:00", name: "Tiago", service: "Barba" },
      { time: "14:30", name: "Bruno", service: "Corte" },
    ],
    buzz: { name: "Diego", ask: "E aí, tem horário sábado de manhã?" },
    lunch: { name: "Felipe", service: "corte e barba" },
    late: { name: "Gustavo", service: "corte e barba" },
    night: { name: "Lucas" },
  },
  {
    id: "estetica",
    label: "Clínica de estética",
    opening: "Abro a clínica",
    inFront: "a cliente na maca",
    busy: "de luva, no meio do procedimento",
    surface: "ao lado da maca",
    noShow: "A cliente das 16h",
    emptyPhrase: "A maca fica vazia",
    messages: ["Tem horário hoje?", "Quanto é a limpeza de pele?", "Tem vaga de depilação à tarde?"],
    agenda: [
      { time: "09:30", name: "Marina", service: "Limpeza de pele" },
      { time: "11:00", name: "Paula", service: "Depilação" },
      { time: "14:30", name: "Luana", service: "Massagem" },
    ],
    buzz: { name: "Bianca", ask: "Oi, tem horário sábado pra limpeza de pele?" },
    lunch: { name: "Rosana", service: "limpeza de pele" },
    late: { name: "Camila", service: "peeling" },
    night: { name: "Helena" },
  },
  {
    id: "consultorio",
    label: "Consultório",
    opening: "Abro o consultório",
    inFront: "o paciente sentado à minha frente",
    busy: "com o prontuário aberto",
    surface: "na mesa",
    noShow: "O paciente das 16h",
    emptyPhrase: "A sala fica vazia",
    messages: ["Tem horário hoje?", "Qual o valor da consulta?", "Consigo um retorno à tarde?"],
    agenda: [
      { time: "09:30", name: "Antônio", service: "Consulta" },
      { time: "11:00", name: "Helena", service: "Consulta de retorno" },
      { time: "14:30", name: "Carlos", service: "Avaliação" },
    ],
    buzz: { name: "Bianca", ask: "Bom dia, tem consulta sábado de manhã?" },
    lunch: { name: "Rosana", service: "consulta de retorno" },
    late: { name: "Camila", service: "consulta de retorno" },
    night: { name: "Helena" },
  },
  {
    id: "pet",
    label: "Pet shop",
    opening: "Abro a loja",
    inFront: "a tutora ao lado do cachorro na mesa",
    busy: "com o secador ligado",
    surface: "no balcão",
    noShow: "A tutora do Thor, das 16h,",
    emptyPhrase: "A mesa fica vazia",
    messages: ["Tem horário hoje?", "Quanto é o banho e tosa?", "Dá pra deixar o Thor à tarde?"],
    agenda: [
      { time: "09:30", name: "Marina (Mel)", service: "Banho" },
      { time: "11:00", name: "Paula (Thor)", service: "Banho e tosa" },
      { time: "14:30", name: "Luana (Bidu)", service: "Tosa higiênica" },
    ],
    buzz: { name: "Bianca", ask: "Oi, tem banho e tosa sábado?" },
    lunch: { name: "Rosana", service: "banho e tosa" },
    late: { name: "Camila (Thor)", service: "banho e tosa" },
    night: { name: "Helena" },
  },
];

export const DEFAULT_NICHE_ID = NICHES[0]!.id;

export function nicheById(id: string): Niche {
  return NICHES.find((n) => n.id === id) ?? NICHES[0]!;
}

/** Primeira letra maiúscula, sem mexer no resto. */
export function cap(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Camila (Thor)" -> "Camila": o nome de quem fala, sem o apêndice do pet. */
export function firstName(name: string): string {
  return name.split(" (")[0]!;
}
