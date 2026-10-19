import { afterEach, describe, expect, it, vi } from "vitest";

const headersMock = vi.fn();
vi.mock("next/headers", () => ({ headers: headersMock }));

const findUniqueMock = vi.fn();
const upsertMock = vi.fn();
vi.mock("@/lib/db/prisma", () => ({
  getPrisma: () => ({ platformSettings: { findUnique: findUniqueMock, upsert: upsertMock } }),
}));

const { getPublicBaseUrl, tryGetPublicBaseUrl, ensurePublicBaseUrlFromCurrentRequest, normalizeBaseUrl, setPublicBaseUrl, getTrustedPublicBaseUrlCached, clearTrustedPublicBaseUrlCache } =
  await import("../public-url");

function headerMap(entries: Record<string, string>) {
  return { get: (key: string) => entries[key] ?? null };
}

afterEach(() => {
  vi.resetAllMocks();
  clearTrustedPublicBaseUrlCache();
});

describe("getPublicBaseUrl — a base gravada pelo admin vence qualquer cabeçalho (I3)", () => {
  it("host forjado NÃO altera a base quando há publicBaseUrl gravada", async () => {
    findUniqueMock.mockResolvedValue({ publicBaseUrl: "https://innochat.innovarecode.com.br" });
    headersMock.mockResolvedValue(headerMap({ "x-forwarded-proto": "https", "x-forwarded-host": "evil.example", host: "evil.example" }));
    await expect(getPublicBaseUrl()).resolves.toBe("https://innochat.innovarecode.com.br");
  });

  it("sem base gravada (instalação): cai para x-forwarded-proto/x-forwarded-host", async () => {
    findUniqueMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(headerMap({ "x-forwarded-proto": "https", "x-forwarded-host": "app.innochat.com.br" }));
    await expect(getPublicBaseUrl()).resolves.toBe("https://app.innochat.com.br");
  });

  it("sem base gravada: cai para `host` e assume https", async () => {
    findUniqueMock.mockResolvedValue({ publicBaseUrl: null });
    headersMock.mockResolvedValue(headerMap({ host: "app.innochat.com.br" }));
    await expect(getPublicBaseUrl()).resolves.toBe("https://app.innochat.com.br");
  });

  it("usa só o primeiro valor quando há múltiplos proxies (lista separada por vírgula)", async () => {
    findUniqueMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(headerMap({ "x-forwarded-proto": "https,http", "x-forwarded-host": "app.innochat.com.br,internal.proxy" }));
    await expect(getPublicBaseUrl()).resolves.toBe("https://app.innochat.com.br");
  });

  it("fallback por cabeçalho recusa host malformado (injeção de caminho/credenciais) e protocolo estranho", async () => {
    findUniqueMock.mockResolvedValue(null);
    for (const host of ["evil.com/path", "user@evil.com", "evil.com#x", "a b.com", "evil.com?x=1"]) {
      headersMock.mockResolvedValue(headerMap({ "x-forwarded-host": host }));
      await expect(getPublicBaseUrl()).rejects.toMatchObject({ code: "PUBLIC_URL_UNKNOWN" });
    }
    headersMock.mockResolvedValue(headerMap({ "x-forwarded-proto": "javascript", "x-forwarded-host": "app.example.com" }));
    await expect(getPublicBaseUrl()).rejects.toMatchObject({ code: "PUBLIC_URL_UNKNOWN" });
  });

  it("Cloudflare em SSL Flexible (CF→origem sem TLS): x-forwarded-proto=http, mas cf-visitor diz https E o hop é da borda da Cloudflare — grava https", async () => {
    findUniqueMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(
      headerMap({
        "x-forwarded-proto": "http",
        "x-forwarded-host": "painel.innovarecode.com.br",
        host: "painel.innovarecode.com.br",
        "x-forwarded-for": "172.64.0.1", // faixa oficial da Cloudflare
        "cf-visitor": '{"scheme":"https"}',
      }),
    );
    await expect(getPublicBaseUrl()).resolves.toBe("https://painel.innovarecode.com.br");
  });

  it("ANTI-SPOOF: cf-visitor forjado (bateu direto na origem, sem passar pela Cloudflare) é ignorado — usa x-forwarded-proto", async () => {
    findUniqueMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(
      headerMap({
        "x-forwarded-proto": "http",
        "x-forwarded-host": "painel.innovarecode.com.br",
        host: "painel.innovarecode.com.br",
        "x-forwarded-for": "203.0.113.9", // IP comum, NÃO é da Cloudflare
        "cf-visitor": '{"scheme":"https"}',
      }),
    );
    await expect(getPublicBaseUrl()).rejects.toMatchObject({ code: "PUBLIC_URL_UNKNOWN" });
  });

  it("cf-visitor com JSON malformado é ignorado e cai para x-forwarded-proto normalmente", async () => {
    findUniqueMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(
      headerMap({
        "x-forwarded-proto": "https",
        "x-forwarded-host": "painel.innovarecode.com.br",
        "x-forwarded-for": "172.64.0.1",
        "cf-visitor": "não é json",
      }),
    );
    await expect(getPublicBaseUrl()).resolves.toBe("https://painel.innovarecode.com.br");
  });

  it("sem Cloudflare (sem cf-visitor): x-forwarded-proto=http fora de localhost continua recusado", async () => {
    findUniqueMock.mockResolvedValue(null);
    headersMock.mockResolvedValue(headerMap({ "x-forwarded-proto": "http", "x-forwarded-host": "app.innochat.com.br" }));
    await expect(getPublicBaseUrl()).rejects.toMatchObject({ code: "PUBLIC_URL_UNKNOWN" });
  });

  it("sem headers() (fora de uma requisição) usa a base gravada", async () => {
    headersMock.mockRejectedValue(new Error("headers() foi chamado fora de uma requisição"));
    findUniqueMock.mockResolvedValue({ publicBaseUrl: "https://salvo-antes.example.com" });
    await expect(getPublicBaseUrl()).resolves.toBe("https://salvo-antes.example.com");
  });

  it("sem requisição e sem publicBaseUrl salvo: lança PUBLIC_URL_UNKNOWN", async () => {
    headersMock.mockRejectedValue(new Error("headers() foi chamado fora de uma requisição"));
    findUniqueMock.mockResolvedValue(null);
    await expect(getPublicBaseUrl()).rejects.toMatchObject({ code: "PUBLIC_URL_UNKNOWN" });
  });
});

describe("tryGetPublicBaseUrl", () => {
  it("nunca lança — devolve null no lugar do erro", async () => {
    headersMock.mockRejectedValue(new Error("sem requisição"));
    findUniqueMock.mockResolvedValue(null);
    await expect(tryGetPublicBaseUrl()).resolves.toBeNull();
  });
});

describe("getTrustedPublicBaseUrlCached — só a base gravada, com cache (usada pelo Auth.js)", () => {
  it("nunca olha cabeçalho e serve do cache dentro de 30 s", async () => {
    findUniqueMock.mockResolvedValue({ publicBaseUrl: "https://app.example.com" });
    expect(await getTrustedPublicBaseUrlCached(1000)).toBe("https://app.example.com");
    expect(await getTrustedPublicBaseUrlCached(1000 + 29_000)).toBe("https://app.example.com");
    expect(findUniqueMock).toHaveBeenCalledTimes(1);
    expect(headersMock).not.toHaveBeenCalled();
    findUniqueMock.mockResolvedValue({ publicBaseUrl: null });
    expect(await getTrustedPublicBaseUrlCached(1000 + 31_000)).toBeNull();
  });
});

describe("ensurePublicBaseUrlFromCurrentRequest — só preenche quando vazia", () => {
  it("grava quando ainda não há publicBaseUrl salvo (instalação)", async () => {
    headersMock.mockResolvedValue(headerMap({ "x-forwarded-proto": "https", "x-forwarded-host": "app.innochat.com.br" }));
    findUniqueMock.mockResolvedValue({ publicBaseUrl: null });

    await ensurePublicBaseUrlFromCurrentRequest();

    expect(upsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 1 }, create: expect.objectContaining({ publicBaseUrl: "https://app.innochat.com.br" }) }),
    );
  });

  it("NÃO sobrescreve a base gravada quando a requisição do admin vem de outro host (host forjado)", async () => {
    headersMock.mockResolvedValue(headerMap({ "x-forwarded-proto": "https", "x-forwarded-host": "evil.example.com" }));
    findUniqueMock.mockResolvedValue({ publicBaseUrl: "https://dominio-original.example.com" });

    await ensurePublicBaseUrlFromCurrentRequest();

    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("não grava de novo quando o endereço é o mesmo", async () => {
    headersMock.mockResolvedValue(headerMap({ "x-forwarded-proto": "https", "x-forwarded-host": "app.innochat.com.br" }));
    findUniqueMock.mockResolvedValue({ publicBaseUrl: "https://app.innochat.com.br" });

    await ensurePublicBaseUrlFromCurrentRequest();

    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe("setPublicBaseUrl — troca explícita", () => {
  it("normaliza para a origem e grava", async () => {
    await expect(setPublicBaseUrl("https://novo.example.com/")).resolves.toBe("https://novo.example.com");
    expect(upsertMock).toHaveBeenCalledWith(expect.objectContaining({ update: { publicBaseUrl: "https://novo.example.com" } }));
  });

  it("recusa http (fora de localhost), caminho, credenciais e lixo", async () => {
    for (const bad of ["http://novo.example.com", "https://novo.example.com/painel", "https://u:p@novo.example.com", "não é url", "https://novo.example.com?x=1", "javascript:alert(1)"]) {
      await expect(setPublicBaseUrl(bad)).rejects.toMatchObject({ code: "INVALID_PAYLOAD" });
    }
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe("normalizeBaseUrl", () => {
  it("aceita https e http só em localhost", () => {
    expect(normalizeBaseUrl("https://a.example.com:8443")).toBe("https://a.example.com:8443");
    expect(normalizeBaseUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(normalizeBaseUrl("http://a.example.com")).toBeNull();
  });
});
