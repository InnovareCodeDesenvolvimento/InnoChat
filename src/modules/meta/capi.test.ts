import { describe, expect, it, vi } from "vitest";
import { buildCapiBody, buildUserData, hashEmail, hashPhone, sendCapiEvent, sha256Hex, type MetaServerEvent } from "./capi";

const event: MetaServerEvent = {
  name: "Purchase",
  eventId: "purchase-abc",
  eventTime: 1_700_000_000,
  sourceUrl: "https://innochat.innovarecode.com.br/cadastro",
  user: { email: "  Ana@Exemplo.COM ", phone: "5584999998888", externalId: "user-1", clientIp: "203.0.113.9", clientUserAgent: "UA", fbp: "fb.1.1.2", fbc: "fb.1.1.3" },
  customData: { currency: "BRL", value: 129.9 },
};

describe("capi: hash e payload", () => {
  it("e-mail: minúsculas, sem espaços, sha256 em hexadecimal", () => {
    expect(hashEmail("  Ana@Exemplo.COM ")).toBe(sha256Hex("ana@exemplo.com"));
    expect(hashEmail("ana@exemplo.com")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("telefone: só dígitos; curto demais não vai", () => {
    expect(hashPhone("+55 (84) 99999-8888")).toBe(sha256Hex("5584999998888"));
    expect(hashPhone("123")).toBeNull();
  });

  it("user_data: dados pessoais com hash, IP e navegador em claro, nunca o e-mail puro", () => {
    const data = buildUserData(event.user);
    expect(data.em).toEqual([sha256Hex("ana@exemplo.com")]);
    expect(data.ph).toEqual([sha256Hex("5584999998888")]);
    expect(data.external_id).toEqual([sha256Hex("user-1")]);
    expect(data.client_ip_address).toBe("203.0.113.9");
    expect(data.fbp).toBe("fb.1.1.2");
    expect(JSON.stringify(data)).not.toContain("exemplo.com");
  });

  it("IP desconhecido não vai", () => {
    expect(buildUserData({ clientIp: "unknown" }).client_ip_address).toBeUndefined();
  });

  it("corpo: event_id para dedup, origem web e código de teste só quando existe", () => {
    const body = buildCapiBody(event, "TEST123") as { data: Record<string, unknown>[]; test_event_code?: string };
    expect(body.data[0]).toMatchObject({ event_name: "Purchase", event_id: "purchase-abc", action_source: "website", event_time: 1_700_000_000 });
    expect(body.data[0]!.custom_data).toEqual({ currency: "BRL", value: 129.9 });
    expect(body.test_event_code).toBe("TEST123");
    expect("test_event_code" in (buildCapiBody(event) as object)).toBe(false);
  });
});

describe("capi: envio", () => {
  const creds = { pixelId: "1234567890", token: "SEGREDO-TOKEN-MUITO-LONGO-123" };

  it("manda o token no corpo (nunca na URL) e responde ok", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ events_received: 1 }), { status: 200 }));
    const result = await sendCapiEvent(creds, event, fetchMock as unknown as typeof fetch);
    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/1234567890/events");
    expect(url).not.toContain("SEGREDO");
    expect(JSON.parse(init.body as string).access_token).toBe(creds.token);
  });

  it("recusa da Meta vira mensagem, sem token e sem lançar", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Invalid OAuth access token" } }), { status: 400 }));
    const result = await sendCapiEvent(creds, event, fetchMock as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("Invalid OAuth access token");
    expect(result.detail).not.toContain("SEGREDO");
  });

  it("rede caída e timeout nunca lançam", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect((await sendCapiEvent(creds, event, down as unknown as typeof fetch)).ok).toBe(false);
    const slow = vi.fn(async () => {
      const error = new Error("timeout");
      error.name = "TimeoutError";
      throw error;
    });
    const result = await sendCapiEvent(creds, event, slow as unknown as typeof fetch);
    expect(result).toEqual({ ok: false, detail: "A Meta não respondeu a tempo." });
  });
});
