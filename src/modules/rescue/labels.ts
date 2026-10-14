import type { RescueLeadStatus } from "./service";
import type { BadgeVariants } from "@/components/ui/badge.variants";

export type StatusConfig = {
  label: string;
  variant: NonNullable<BadgeVariants["variant"]>;
  description: string;
};

export const RESCUE_STATUS_CONFIG: Record<RescueLeadStatus, StatusConfig> = {
  PENDING: {
    label: "Aguardando 1º envio",
    variant: "warning",
    description: "Cadastrado há menos de 24h sem entrar no painel",
  },
  MESSAGE_1_SENDING: {
    label: "Enviando passo 1",
    variant: "primary",
    description: "Mensagem do primeiro dia sendo despachada pelo WhatsApp",
  },
  MESSAGE_1_SENT: {
    label: "Passo 1 enviado",
    variant: "primary",
    description: "Recebeu a mensagem de 24h; aguardando primeiro acesso",
  },
  MESSAGE_2_SENDING: {
    label: "Enviando passo 2",
    variant: "primary",
    description: "Mensagem do 4º dia sendo despachada pelo WhatsApp",
  },
  MESSAGE_2_SENT: {
    label: "Passo 2 enviado",
    variant: "primary",
    description: "Recebeu a mensagem de 96h; régua de mensagens concluída",
  },
  RESPONDED: {
    label: "Respondeu",
    variant: "success",
    description: "Interagiu pelo WhatsApp e abriu atendimento",
  },
  CONVERTED: {
    label: "Convertido",
    variant: "success",
    description: "Acessou o painel e começou a usar a plataforma",
  },
  OPTED_OUT: {
    label: "Pediu para sair",
    variant: "neutral",
    description: "Pediu para parar de receber mensagens (SAIR/PARAR)",
  },
  EXPIRED: {
    label: "Expirado",
    variant: "neutral",
    description: "Período de resgate encerrado sem conversão",
  },
  SKIPPED: {
    label: "Pausado / Ignorado",
    variant: "warning",
    description: "Pausado pela administração ou pulado por limite",
  },
};

export const RESCUE_FILTER_STATUSES: RescueLeadStatus[] = [
  "PENDING",
  "MESSAGE_1_SENT",
  "MESSAGE_2_SENT",
  "RESPONDED",
  "CONVERTED",
  "OPTED_OUT",
  "EXPIRED",
  "SKIPPED",
];
