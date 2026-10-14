import { beforeEach, describe, expect, it, vi } from "vitest";

const record = vi.hoisted(() => vi.fn(async (...args: unknown[]) => (void args, { recorded: true as const, groupId: "g", status: "OPEN" })));
vi.mock("./capture", () => ({ recordError: record }));

const { handleClientErrorReport, isSameOrigin, readBodyWithLimit, CLIENT_ERROR_PER_IP_PER_MINUTE, CLIENT_ERROR_MAX_BODY_BYTES } = await import("./client-report");
const { __resetRateLimitsForTests } = await import("@/lib/rate-limit");

const ok = JSON.stringify({ message: "boom", type: "TypeError", route: "/login" });
const call = (rawBody: string, ip = "203.0.113.1") => handleClientErrorReport({ rawBody, contentLength: null, ip, resolveUserId: async () => "u1" });

beforeEach(() => {
  __resetRateLimitsForTests();
  record.mockClear();
});

describe("relato do navegador", () => {
  it("aceita relato válido e grava como CLIENT com o usuário da sessão", async () => {
    expect((await call(ok)).status).toBe(202);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ source: "CLIENT", message: "boom", userId: "u1" }));
  });

  it("rejeita JSON inválido e formato errado sem gravar", async () => {
    expect((await call("{nao json")).status).toBe(400);
    expect((await call(JSON.stringify({ message: "" }))).status).toBe(400);
    expect((await call(JSON.stringify({ message: "x", kind: "outro" }))).status).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });

  it("recusa corpo grande (declarado ou real)", async () => {
    expect((await handleClientErrorReport({ rawBody: ok, contentLength: CLIENT_ERROR_MAX_BODY_BYTES + 1, ip: "1.1.1.1", resolveUserId: async () => null })).status).toBe(413);
    expect((await call(JSON.stringify({ message: "x".repeat(CLIENT_ERROR_MAX_BODY_BYTES) }))).status).toBe(413);
  });

  it("limita por IP e não afeta outro IP", async () => {
    for (let i = 0; i < CLIENT_ERROR_PER_IP_PER_MINUTE; i += 1) expect((await call(ok, "198.51.100.7")).status).toBe(202);
    expect((await call(ok, "198.51.100.7")).status).toBe(429);
    expect((await call(ok, "198.51.100.8")).status).toBe(202);
  });

  it("descarta sem gravar erro de extensão do navegador (responde 202)", async () => {
    const stack = "TypeError: x\n    at s (chrome-extension://eppiocemhmnlbhjplcgkofciiegomcon/executors/200.js:2:3456)";
    expect((await call(JSON.stringify({ message: "Cannot read properties of undefined (reading 'M_ID')", type: "TypeError", route: "/login", stack }))).status).toBe(202);
    expect(record).not.toHaveBeenCalled();
    const mixed = `${stack}\n    at b (https://innochat.example/_next/static/a.js:1:1)`;
    await call(JSON.stringify({ message: "x", stack: mixed }));
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("descarta sem gravar erro de ruído de navegador (iabjs:// e Load failed de navegação)", async () => {
    // Caso (a) iabjs
    const iabjsStack = "Error: Error invoking postMessage: Java object is gone\n    at iabjs://navigation_performance_logger_android:1:1234";
    expect((await call(JSON.stringify({ message: "Error invoking postMessage: Java object is gone", stack: iabjsStack }))).status).toBe(202);
    expect(record).not.toHaveBeenCalled();

    // Caso (b) Load failed sem stack do nosso app
    expect((await call(JSON.stringify({ message: "Load failed", type: "TypeError", route: "/cadastro" }))).status).toBe(202);
    expect(record).not.toHaveBeenCalled();

    // Caso (b) com stack do nosso app é gravado normalmente
    const nextStack = "TypeError: Load failed\n    at f (https://innochat.innovarecode.com.br/_next/static/chunks/app.js:1:1)";
    await call(JSON.stringify({ message: "Load failed", type: "TypeError", stack: nextStack }));
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("falha ao gravar não vira erro para o navegador", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    record.mockRejectedValueOnce(new Error("db fora"));
    expect((await call(ok)).status).toBe(202);
    warn.mockRestore();
  });
});

describe("leitura do corpo com limite (sem Content-Length)", () => {
  const streamOf = (chunks: string[]) => {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
  };

  it("lê corpo pequeno em vários pedaços", async () => {
    expect(await readBodyWithLimit({ body: streamOf(['{"mess', 'age":"ok"}']) }, 100)).toBe('{"message":"ok"}');
  });

  it("para e devolve null assim que passa do limite, sem ler o resto", async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
        if (pulled > 1000) controller.close();
      },
    });
    expect(await readBodyWithLimit({ body }, 4096)).toBeNull();
    expect(pulled).toBeLessThan(20);
  });

  it("sem corpo devolve texto vazio", async () => {
    expect(await readBodyWithLimit({ body: null }, 100)).toBe("");
  });
});

describe("isSameOrigin", () => {
  it("compara o host da origem com o do site", () => {
    expect(isSameOrigin("https://app.exemplo.com", "app.exemplo.com")).toBe(true);
    expect(isSameOrigin("https://malvado.com", "app.exemplo.com")).toBe(false);
    expect(isSameOrigin(null, "app.exemplo.com")).toBe(true);
    expect(isSameOrigin("lixo", "app.exemplo.com")).toBe(false);
  });
});
