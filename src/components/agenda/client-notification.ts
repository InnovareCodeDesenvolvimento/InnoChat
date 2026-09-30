"use client";

import { useCallback } from "react";
import { useToast } from "@/components/ui/toast";

/** Resultado do aviso ao cliente que as ações de criar/remarcar/cancelar passam a devolver. */
export type ClientNotification = "SENT" | "DISABLED" | "NO_WHATSAPP" | "NO_PHONE" | "FAILED";

const KNOWN: ReadonlySet<string> = new Set(["SENT", "DISABLED", "NO_WHATSAPP", "NO_PHONE", "FAILED"]);

/** Lê `clientNotification` de um retorno qualquer (as actions tipam `data` como `unknown`). */
export function readClientNotification(data: unknown): ClientNotification | null {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as { clientNotification?: unknown }).clientNotification;
  return typeof value === "string" && KNOWN.has(value) ? (value as ClientNotification) : null;
}

export type ClientNotificationToast = { variant: "success" | "info" | "error"; title: string; description?: string };

/** Texto e tom do toast para cada resultado. Sucesso só quando o aviso realmente foi enviado. */
export function clientNotificationToast(value: ClientNotification): ClientNotificationToast {
  switch (value) {
    case "SENT":
      return { variant: "success", title: "Cliente avisado no WhatsApp" };
    case "DISABLED":
      // O backend também devolve DISABLED quando nada mudou (repetido, já cancelado, mesmo horário):
      // o texto cobre os dois casos sem afirmar que "o aviso está desligado" à toa.
      return {
        variant: "info",
        title: "Aviso ao cliente desligado",
        description: "O cliente não recebeu aviso. Ele pode ser ligado em Configurações, Regras do atendimento.",
      };
    case "NO_WHATSAPP":
      return { variant: "info", title: "Cliente sem WhatsApp conectado", description: "O agendamento foi salvo, mas o cliente não foi avisado." };
    case "NO_PHONE":
      return { variant: "info", title: "Cliente sem telefone cadastrado", description: "O agendamento foi salvo, mas o cliente não foi avisado." };
    case "FAILED":
      return { variant: "error", title: "Não foi possível avisar o cliente", description: "O agendamento foi salvo. Avise o cliente por outro meio." };
  }
}

/**
 * Devolve `announce(data)`: mostra o toast de aviso ao cliente conforme o retorno da ação. Sem
 * `clientNotification` no retorno (backend antigo) não mostra nada — nunca inventa um resultado.
 */
export function useClientNotificationToast(): (data: unknown) => void {
  const { notify } = useToast();
  return useCallback(
    (data: unknown) => {
      const value = readClientNotification(data);
      if (value) notify(clientNotificationToast(value));
    },
    [notify],
  );
}
