import { describe, expect, it } from "vitest";
import { clientNotificationToast, readClientNotification, type ClientNotification } from "./client-notification";

describe("aviso ao cliente (toast pós-ação)", () => {
  it("lê o campo do retorno e ignora valores desconhecidos", () => {
    expect(readClientNotification({ id: "1", clientNotification: "SENT" })).toBe("SENT");
    expect(readClientNotification({ clientNotification: "OUTRO" })).toBeNull();
    expect(readClientNotification({})).toBeNull();
    expect(readClientNotification(null)).toBeNull();
    expect(readClientNotification("SENT")).toBeNull();
  });

  it("cada resultado tem título próprio; só SENT é sucesso; FAILED e RATE_LIMITED são erro", () => {
    const all: ClientNotification[] = ["SENT", "DISABLED", "NO_WHATSAPP", "NO_PHONE", "FAILED", "RATE_LIMITED"];
    const toasts = all.map(clientNotificationToast);
    expect(new Set(toasts.map((t) => t.title)).size).toBe(all.length);
    expect(toasts.map((t) => t.variant)).toEqual(["success", "info", "info", "info", "error", "error"]);
    expect(toasts[0].title).toBe("Cliente avisado no WhatsApp");
    expect(toasts[1].title).toBe("Aviso ao cliente desligado");
    expect(toasts[2].title).toBe("Cliente sem WhatsApp conectado");
    expect(toasts[4].title).toBe("Não foi possível avisar o cliente");
    expect(toasts[5].title).toBe("Aviso não enviado: limite de mensagens");
    expect(readClientNotification({ clientNotification: "RATE_LIMITED" })).toBe("RATE_LIMITED");
  });
});
