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

  it("cada resultado tem título próprio; só SENT é sucesso e só FAILED é erro", () => {
    const all: ClientNotification[] = ["SENT", "DISABLED", "NO_WHATSAPP", "NO_PHONE", "FAILED"];
    const toasts = all.map(clientNotificationToast);
    expect(new Set(toasts.map((t) => t.title)).size).toBe(all.length);
    expect(toasts.map((t) => t.variant)).toEqual(["success", "info", "info", "info", "error"]);
    expect(toasts[0].title).toBe("Cliente avisado no WhatsApp");
    expect(toasts[1].title).toBe("Aviso ao cliente desligado");
    expect(toasts[2].title).toBe("Cliente sem WhatsApp conectado");
    expect(toasts[4].title).toBe("Não foi possível avisar o cliente");
  });
});
