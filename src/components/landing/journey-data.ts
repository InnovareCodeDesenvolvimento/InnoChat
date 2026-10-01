import type { DemoMessage } from "./demo-script";

/**
 * "Da primeira mensagem à cliente na porta": os 5 passos da jornada. O conteúdo do celular sai do
 * mesmo roteiro da demo do hero (`buildDemoScript`, textos reais do bot v2): cada passo mostra
 * as mensagens até `lastMessageId`. Só comportamento que o produto cumpre; nomes fictícios, nenhum
 * número de resultado.
 */
export type JourneyStepId = "mensagem" | "resposta" | "agenda" | "lembrete" | "cliente";

export type JourneyStep = {
  id: JourneyStepId;
  title: string;
  text: string;
  /** Última mensagem do roteiro visível neste passo. */
  lastMessageId: string;
};

export const JOURNEY_STEPS: readonly JourneyStep[] = [
  {
    id: "mensagem",
    title: "Chega a mensagem",
    text: "A Camila escreve “oi” para o WhatsApp da empresa, de dia, de noite ou no fim de semana.",
    lastMessageId: "m1",
  },
  {
    id: "resposta",
    title: "O Inno responde",
    text: "O bot atende na hora por um menu numerado. Pergunta o serviço, o dia e o horário, sem ninguém da equipe digitar.",
    lastMessageId: "m2",
  },
  {
    id: "agenda",
    title: "A agenda preenche",
    text: "Ao confirmar, o horário entra sozinho na agenda, com serviço e profissional. A Camila recebe o resumo na hora.",
    lastMessageId: "m12",
  },
  {
    id: "lembrete",
    title: "O lembrete sai",
    text: "No dia anterior o InnoChat lembra a Camila do horário. Se ela precisar, remarca ou cancela pelo próprio WhatsApp.",
    lastMessageId: "m13",
  },
  {
    id: "cliente",
    title: "O cliente aparece",
    text: "No horário, a Camila chega e a equipe marca como atendido na agenda. Quem não vem fica como falta, e o painel mostra a taxa.",
    lastMessageId: "m13",
  },
];

/** Quantas mensagens do roteiro aparecem no passo `stepIndex` (0 se o id não existir). */
export function messageCountForStep(messages: DemoMessage[], stepIndex: number): number {
  const step = JOURNEY_STEPS[stepIndex];
  if (!step) return 0;
  const at = messages.findIndex((m) => m.id === step.lastMessageId);
  return at < 0 ? 0 : at + 1;
}

/** Passo para o qual o ponto de progresso aponta, limitado ao intervalo válido. */
export function clampStep(index: number): number {
  return Math.min(JOURNEY_STEPS.length - 1, Math.max(0, Math.round(index)));
}
