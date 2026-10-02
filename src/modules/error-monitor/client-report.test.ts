import { beforeEach, describe, expect, it, vi } from "vitest";

const record = vi.hoisted(() => vi.fn(async (...args: unknown[]) => (void args, { recorded: true as const, groupId: "g", status: "OPEN" })));
vi.mock("./capture", () => ({ recordError: record }));

const { handleClientErrorReport, isSameOrigin, CLIENT_ERROR_PER_IP_PER_MINUTE, CLIENT_ERROR_MAX_BODY_BYTES } = await import("./client-report");
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

  it("falha ao gravar não vira erro para o navegador", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    record.mockRejectedValueOnce(new Error("db fora"));
    expect((await call(ok)).status).toBe(202);
    warn.mockRestore();
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
