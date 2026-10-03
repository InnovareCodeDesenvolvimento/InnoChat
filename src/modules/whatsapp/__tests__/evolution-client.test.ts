import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEvolutionClient, EvolutionApiError } from "../evolution-client";

/**
 * ⚠️ HONESTIDADE SOBRE O QUE FOI VERIFICADO: os corpos de resposta abaixo são fixtures baseadas
 * na documentação pública da Evolution API v2 e no adaptador validado ao vivo do InnoAtendente
 * (2026-09-04) — **NÃO capturados de um servidor Evolution real do InnoChat** (mesma ressalva
 * de `evolution-client.ts` e `fixtures/evolution/README.md`).
 */

const BASE_URL = "https://evolution.example.com";
const API_KEY = "test-api-key";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("createEvolutionClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("createInstance chama POST /instance/create com o corpo esperado", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ instance: { instanceName: "innochat-studio-x7k2" } }));
    const client = createEvolutionClient(BASE_URL, API_KEY);

    await client.createInstance("innochat-studio-x7k2");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/instance/create`);
    expect(init.method).toBe("POST");
    expect(init.headers.apikey).toBe(API_KEY);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ instanceName: "innochat-studio-x7k2", integration: "WHATSAPP-BAILEYS", qrcode: true });
  });

  it("setWebhook envia os eventos MESSAGES_UPSERT e CONNECTION_UPDATE, byEvents/base64 false", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ webhook: { enabled: true } }));
    const client = createEvolutionClient(BASE_URL, API_KEY);

    await client.setWebhook("innochat-studio-x7k2", "https://n8n.example.com/webhook/innochat/evolution/token123");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/webhook/set/innochat-studio-x7k2`);
    const body = JSON.parse(init.body);
    expect(body.webhook).toMatchObject({
      enabled: true,
      url: "https://n8n.example.com/webhook/innochat/evolution/token123",
      byEvents: false,
      base64: false,
    });
    expect(body.webhook.events).toEqual(["MESSAGES_UPSERT", "CONNECTION_UPDATE"]);
  });

  it("connect() extrai o QR de base64 direto", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ base64: "iVBORw0KGgo=", pairingCode: "ABCD-1234" }));
    const client = createEvolutionClient(BASE_URL, API_KEY);

    const result = await client.connect("innochat-studio-x7k2");

    expect(result.qrCodeDataUrl).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(result.pairingCode).toBe("ABCD-1234");
  });

  it("connect() extrai o QR de qrcode.base64 quando a forma direta não existe", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ qrcode: { base64: "iVBORw0KGgo=" } }));
    const client = createEvolutionClient(BASE_URL, API_KEY);

    const result = await client.connect("innochat-studio-x7k2");

    expect(result.qrCodeDataUrl).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(result.pairingCode).toBeNull();
  });

  it("connect() já aceita uma data URL completa sem duplicar o prefixo", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ base64: "data:image/png;base64,iVBORw0KGgo=" }));
    const client = createEvolutionClient(BASE_URL, API_KEY);

    const result = await client.connect("innochat-studio-x7k2");

    expect(result.qrCodeDataUrl).toBe("data:image/png;base64,iVBORw0KGgo=");
  });

  it("connect() devolve qrCodeDataUrl null quando a instância já está conectada (sem QR)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const client = createEvolutionClient(BASE_URL, API_KEY);

    const result = await client.connect("innochat-studio-x7k2");

    expect(result.qrCodeDataUrl).toBeNull();
  });

  it("connectionState() lê instance.state", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ instance: { instanceName: "innochat-studio-x7k2", state: "open" } }));
    const client = createEvolutionClient(BASE_URL, API_KEY);

    expect(await client.connectionState("innochat-studio-x7k2")).toBe("open");
  });

  it("connectionState() cai para 'close' quando a resposta não traz state nenhum", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const client = createEvolutionClient(BASE_URL, API_KEY);

    expect(await client.connectionState("innochat-studio-x7k2")).toBe("close");
  });

  it("fetchOwnerJid() lê ownerJid de um array de instâncias", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ ownerJid: "5584999727583@s.whatsapp.net" }]));
    const client = createEvolutionClient(BASE_URL, API_KEY);

    expect(await client.fetchOwnerJid("innochat-studio-x7k2")).toBe("5584999727583@s.whatsapp.net");
  });

  it("fetchOwnerJid() devolve null quando não há instância nenhuma na resposta", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));
    const client = createEvolutionClient(BASE_URL, API_KEY);

    expect(await client.fetchOwnerJid("innochat-studio-x7k2")).toBeNull();
  });

  it("logout() chama DELETE /instance/logout/{instance}", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const client = createEvolutionClient(BASE_URL, API_KEY);

    await client.logout("innochat-studio-x7k2");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/instance/logout/innochat-studio-x7k2`);
    expect(init.method).toBe("DELETE");
  });

  it("deleteInstance() chama DELETE /instance/delete/{instance}", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    const client = createEvolutionClient(BASE_URL, API_KEY);

    await client.deleteInstance("innochat-studio-x7k2");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/instance/delete/innochat-studio-x7k2`);
    expect(init.method).toBe("DELETE");
  });

  it("sendText chama POST /message/sendText/{instance} com {number, text}, devolve key.id e NÃO retenta em 5xx", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ key: { id: "3EB0ABC" } }));
    const client = createEvolutionClient(BASE_URL, API_KEY);

    const result = await client.sendText("innochat-studio-x7k2", "5511999990000", "Oi");

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/message/sendText/innochat-studio-x7k2`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ number: "5511999990000", text: "Oi" });
    expect(result).toEqual({ messageId: "3EB0ABC" });

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("boom", { status: 503 }));
    await expect(client.sendText("innochat-studio-x7k2", "5511999990000", "Oi")).rejects.toBeInstanceOf(EvolutionApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("checkWhatsappNumbers chama POST /chat/whatsappNumbers/{instance} com {numbers} e devolve exists por número", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ exists: true, jid: "5584999993082@s.whatsapp.net", number: "5584999993082" }, { exists: false, jid: "558499993082@s.whatsapp.net", number: "558499993082" }]));
    const client = createEvolutionClient(BASE_URL, API_KEY);

    const result = await client.checkWhatsappNumbers("innochat-plat", ["5584999993082", "558499993082"]);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/chat/whatsappNumbers/innochat-plat`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ numbers: ["5584999993082", "558499993082"] });
    expect(result).toEqual([
      { number: "5584999993082", exists: true },
      { number: "558499993082", exists: false },
    ]);
  });

  it("checkWhatsappNumbers: resposta que não é lista e erro 5xx viram EvolutionApiError, sem retentar", async () => {
    const client = createEvolutionClient(BASE_URL, API_KEY);
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    await expect(client.checkWhatsappNumbers("i", ["5584999993082"])).rejects.toBeInstanceOf(EvolutionApiError);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("boom", { status: 503 }));
    await expect(client.checkWhatsappNumbers("i", ["5584999993082"])).rejects.toBeInstanceOf(EvolutionApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sendButtons chama POST /message/sendButtons/{instance} com botões reply e devolve status/corpo", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ key: { id: "3EB0BTN" }, status: "PENDING" }, 201));
    const client = createEvolutionClient(BASE_URL, API_KEY);

    const result = await client.sendButtons("innochat-studio-x7k2", "5511999990000", {
      title: "Qual serviço você quer?",
      footer: "Toque em uma opção",
      buttons: [
        { type: "reply", displayText: "Corte", id: "1" },
        { type: "reply", displayText: "Escova", id: "2" },
        { type: "reply", displayText: "Coloração", id: "3" },
      ],
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/message/sendButtons/innochat-studio-x7k2`);
    expect(init.method).toBe("POST");
    expect(init.headers.apikey).toBe(API_KEY);
    expect(JSON.parse(init.body)).toEqual({
      number: "5511999990000",
      title: "Qual serviço você quer?",
      footer: "Toque em uma opção",
      buttons: [
        { type: "reply", displayText: "Corte", id: "1" },
        { type: "reply", displayText: "Escova", id: "2" },
        { type: "reply", displayText: "Coloração", id: "3" },
      ],
    });
    expect(result).toEqual({ messageId: "3EB0BTN", status: 201, body: { key: { id: "3EB0BTN" }, status: "PENDING" } });
  });

  it("sendList chama POST /message/sendList/{instance}; omite description vazia da linha", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ key: { id: "3EB0LST" } }, 201));
    const client = createEvolutionClient(BASE_URL, API_KEY);

    await client.sendList("innochat-studio-x7k2", "5511999990000", {
      title: "Qual serviço você quer?",
      description: "Escolha abaixo",
      buttonText: "Ver opções",
      sections: [
        {
          title: "Serviços",
          rows: [
            { title: "Corte", rowId: "1", description: "R$ 50" },
            { title: "Escova", rowId: "2", description: "" },
          ],
        },
      ],
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/message/sendList/innochat-studio-x7k2`);
    expect(JSON.parse(init.body)).toEqual({
      number: "5511999990000",
      title: "Qual serviço você quer?",
      description: "Escolha abaixo",
      buttonText: "Ver opções",
      sections: [
        {
          title: "Serviços",
          rows: [
            { title: "Corte", rowId: "1", description: "R$ 50" },
            { title: "Escova", rowId: "2" },
          ],
        },
      ],
    });
  });

  it("sendPoll chama POST /message/sendPoll/{instance} com name/selectableCount/values", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ key: { id: "3EB0POLL" } }, 201));
    const client = createEvolutionClient(BASE_URL, API_KEY);

    const result = await client.sendPoll("innochat-studio-x7k2", "5511999990000", {
      name: "Qual serviço você quer?",
      selectableCount: 1,
      values: ["1 - Corte", "2 - Escova", "3 - Coloração"],
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`${BASE_URL}/message/sendPoll/innochat-studio-x7k2`);
    expect(JSON.parse(init.body)).toEqual({
      number: "5511999990000",
      name: "Qual serviço você quer?",
      selectableCount: 1,
      values: ["1 - Corte", "2 - Escova", "3 - Coloração"],
    });
    expect(result.messageId).toBe("3EB0POLL");
  });

  it("envio interativo NÃO retenta em 5xx e guarda o corpo do erro só em responseBody (fora da mensagem)", async () => {
    fetchMock.mockResolvedValue(new Response('{"response":{"message":["Bad Request"]}}', { status: 400 }));
    const client = createEvolutionClient(BASE_URL, API_KEY);

    const error = await client
      .sendButtons("innochat-studio-x7k2", "5511999990000", { title: "x", buttons: [{ type: "reply", displayText: "a", id: "1" }] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EvolutionApiError);
    expect((error as EvolutionApiError).status).toBe(400);
    expect((error as EvolutionApiError).responseBody).toContain("Bad Request");
    expect((error as EvolutionApiError).message).not.toContain("Bad Request");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("boom", { status: 503 }));
    await expect(client.sendPoll("i", "5511999990000", { name: "x", selectableCount: 1, values: ["a", "b"] })).rejects.toBeInstanceOf(EvolutionApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lança EvolutionApiError em 4xx SEM retentar (erro do nosso lado)", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad request", { status: 400 }));
    const client = createEvolutionClient(BASE_URL, API_KEY);

    await expect(client.createInstance("innochat-studio-x7k2")).rejects.toBeInstanceOf(EvolutionApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retenta em 5xx até 3 tentativas e depois lança", async () => {
    fetchMock.mockResolvedValue(new Response("boom", { status: 503 }));
    const client = createEvolutionClient(BASE_URL, API_KEY);

    await expect(client.createInstance("innochat-studio-x7k2")).rejects.toBeInstanceOf(EvolutionApiError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retenta em erro de rede/timeout e uma tentativa seguinte com sucesso resolve", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce(jsonResponse({}));
    const client = createEvolutionClient(BASE_URL, API_KEY);

    await expect(client.createInstance("innochat-studio-x7k2")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("nunca inclui o corpo de erro da Evolution na mensagem da exceção (pode ecoar PII)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: "telefone inválido: +5511999999999" }), { status: 400 }));
    const client = createEvolutionClient(BASE_URL, API_KEY);

    await expect(client.createInstance("innochat-studio-x7k2")).rejects.toThrowError(
      expect.not.stringContaining("+5511999999999"),
    );
  });
});
