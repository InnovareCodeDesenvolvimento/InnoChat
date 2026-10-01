/**
 * Falas do Inno — ÚNICO arquivo de conteúdo do onboarding (tour guiado + checklist "Primeiros
 * passos"). O dono revisa/ajusta o texto aqui; nenhum componente tem frase do mascote embutida.
 *
 * Tom: primeira pessoa, amigável e profissional, frases curtas, pt-BR.
 * `target` liga o passo ao atributo `data-tour="..."` de um elemento real da tela (sem `target`
 * o balão fica centralizado). `desktopOnly`: passo que só faz sentido com a sidebar visível
 * (a partir de 1024px) — no celular o menu é uma gaveta, então esses passos são resumidos no
 * passo do botão de menu (`bodyMobile`).
 */

export type TourStepKind = "welcome" | "step" | "finish";

export type TourStepContent = {
  id: string;
  kind: TourStepKind;
  /** Valor de `data-tour` do elemento destacado. Ausente = balão centralizado. */
  target?: string;
  /** Alvo alternativo quando a tela é estreita (< 1024px). */
  targetMobile?: string;
  desktopOnly?: boolean;
  /** `happy`: o Inno fica com olhos "^ ^" (comemoração). */
  mood?: "happy";
  title: string;
  body: string;
  /** Texto alternativo para telas estreitas (mesmo passo, outra redação). */
  bodyMobile?: string;
};

export const MASCOT_NAME = "Inno";

export const TOUR_STEPS: TourStepContent[] = [
  {
    id: "welcome",
    kind: "welcome",
    title: "Oi! Eu sou o Inno 👋",
    body: "Vou te mostrar o painel rapidinho. Depois é só seguir o checklist e o seu bot já sai agendando sozinho.",
  },
  {
    id: "menu",
    kind: "step",
    target: "sidebar",
    targetMobile: "menu-button",
    title: "Este é o seu menu",
    body: "Cada área do painel fica aqui, agrupada por assunto.",
    bodyMobile:
      "No celular o menu fica neste botão: Início, Agenda, Clientes, WhatsApp, Configurações, Minha conta e o resto.",
  },
  {
    id: "inicio",
    kind: "step",
    target: "nav-inicio",
    desktopOnly: true,
    title: "Início",
    body: "Ao entrar, eu te dou bom dia com o resumo do dia, os próximos agendamentos e o checklist.",
  },
  {
    id: "atendimento",
    kind: "step",
    target: "nav-atendimento",
    desktopOnly: true,
    title: "Atendimento",
    body:
      "Quando um cliente pede um atendente, ele entra numa fila aqui e um contador no menu avisa. " +
      "Você responde pelo painel, como no WhatsApp Web, e depois devolve a conversa para mim.",
  },
  {
    id: "agenda",
    kind: "step",
    target: "nav-agenda",
    desktopOnly: true,
    title: "Agenda e agendamentos",
    body:
      "Seus horários por dia ou por semana. Clique num agendamento para concluir o atendimento, " +
      "marcar que o cliente faltou, remarcar ou cancelar. " +
      "A lista completa, com filtros, fica em Agendamentos.",
  },
  {
    id: "clientes",
    kind: "step",
    target: "nav-clientes",
    desktopOnly: true,
    title: "Clientes",
    body: "Quem fala com o bot vira cliente. Na ficha, a aba Conversa guarda o histórico do WhatsApp por 90 dias.",
  },
  {
    id: "catalogo",
    kind: "step",
    target: "nav-servicos",
    desktopOnly: true,
    title: "Serviços e equipe",
    body: "Cadastre serviços, profissionais e horários. É com isso que eu sei o que oferecer e quando.",
  },
  {
    id: "whatsapp",
    kind: "step",
    target: "nav-whatsapp",
    desktopOnly: true,
    title: "WhatsApp",
    body: "Leia o QR code para conectar o número. Aqui você vê o celular com o status da conexão e o limite do plano.",
  },
  {
    id: "mensagens-bot",
    kind: "step",
    target: "nav-mensagens-bot",
    desktopOnly: true,
    title: "Mensagens do bot",
    body: "O que eu digo: boas-vindas, confirmações e lembretes. Deixe com a cara da sua empresa.",
  },
  {
    id: "configuracoes",
    kind: "step",
    target: "nav-configuracoes",
    desktopOnly: true,
    title: "Configurações",
    body: "Ligue o lembrete automático: eu aviso seus clientes na véspera do horário. Tem também tema, equipe e bloqueios.",
  },
  {
    id: "assinatura",
    kind: "step",
    target: "nav-assinatura",
    desktopOnly: true,
    title: "Assinatura",
    body: "Plano, faturas e pagamento por Pix.",
  },
  {
    id: "status",
    kind: "step",
    target: "topbar-status",
    title: "Status do WhatsApp",
    body: "Mostra se o bot está no ar. Se o número cair, você vê na hora.",
  },
  {
    id: "notificacoes",
    kind: "step",
    target: "topbar-notifications",
    title: "Sino de avisos",
    body: "Novos agendamentos, remarcações e cancelamentos chegam aqui, e as telas se atualizam sozinhas, sem F5.",
  },
  {
    id: "busca",
    kind: "step",
    target: "topbar-search",
    title: "Busca rápida",
    body: "Aperte Ctrl K (ou Cmd K) e digite para ir a qualquer tela sem tirar a mão do teclado.",
    bodyMobile: "Toque na lupa para ir a qualquer tela rapidinho.",
  },
  {
    id: "conta",
    kind: "step",
    target: "user-block",
    desktopOnly: true,
    title: "Minha conta",
    body: "Toque no seu nome aqui embaixo para ajustar seus dados. O botão ao lado é o Sair.",
  },
  {
    id: "fim",
    kind: "finish",
    mood: "happy",
    title: "Pronto! Agora é com você",
    body: "Siga o checklist de Primeiros passos no Início e deixe tudo pronto. Para rever o tour, é só pedir no menu.",
  },
];

export const TOUR_UI = {
  dialogLabel: "Tour guiado com o Inno",
  next: "Próximo",
  back: "Voltar",
  skip: "Pular tour",
  start: "Vamos lá",
  finish: "Concluir",
  replay: "Rever tour",
  progress: (current: number, total: number) => `${current} de ${total}`,
} as const;

/** Passos do checklist — a ordem e o `key` seguem o contrato de `OnboardingState.steps`. */
export type ChecklistStepKey = "services" | "professionals" | "hours" | "whatsapp" | "botTest";

export const CHECKLIST_STEPS: {
  key: ChecklistStepKey;
  title: string;
  description: string;
  /** Caminho relativo ao tenant (`/{slug}/{path}`). */
  path: string;
  cta: string;
}[] = [
  {
    key: "services",
    title: "Cadastrar serviços",
    description: "O que você oferece, com duração e preço.",
    path: "servicos",
    cta: "Cadastrar",
  },
  {
    key: "professionals",
    title: "Cadastrar profissionais",
    description: "Quem atende os seus clientes.",
    path: "profissionais",
    cta: "Cadastrar",
  },
  {
    key: "hours",
    title: "Definir horários",
    description: "Os dias e horas em que cada profissional atende.",
    path: "profissionais",
    cta: "Definir",
  },
  {
    key: "whatsapp",
    title: "Conectar o WhatsApp",
    description: "Leia o QR code com o celular da empresa.",
    path: "whatsapp",
    cta: "Conectar",
  },
  {
    key: "botTest",
    title: "Testar o bot",
    description: 'Mande um "oi" de outro número para o WhatsApp da empresa e veja eu responder.',
    path: "whatsapp",
    cta: "Ver número",
  },
];

/**
 * Dica opcional do checklist: NÃO faz parte de `OnboardingState.steps` (contrato do backend) e por
 * isso nunca conta para `allDone` nem para o "X de 5". É só um atalho, sem estado de "feito".
 */
export const CHECKLIST_OPTIONAL_TIP = {
  title: "Ativar o lembrete automático",
  description: "Eu aviso seus clientes na véspera do horário.",
  path: "configuracoes",
  cta: "Ativar",
} as const;

export const CHECKLIST_UI = {
  title: "Primeiros passos",
  intro: "Vamos deixar tudo pronto para o seu bot agendar sozinho.",
  progress: (done: number, total: number) => `${done} de ${total} passos`,
  done: "Feito",
  hide: "Esconder",
  hideLabel: "Esconder o checklist de Primeiros passos",
  optionalLabel: "Opcional",
  doneTitle: "Tudo pronto!",
  doneBody: "O seu bot já pode agendar sozinho. Se precisar de mim, é só chamar pelo menu.",
  close: "Fechar",
  error: "Não consegui salvar agora. Tente de novo em instantes.",
} as const;
