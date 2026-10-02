import { describe, expect, it } from "vitest";
import { redactText } from "./redact";
import { computeFingerprint, normalizeMessage, normalizeStackTop, prepareError, sanitizeContext, sanitizeRoute, truncateBytes, STACK_MAX_BYTES } from "./prepare";

describe("redactText", () => {
  it("troca e-mail, telefone, CPF e JID do WhatsApp", () => {
    const out = redactText("falhou para maria.silva@exemplo.com.br, fone (11) 98765-4321, +55 11 98765-4321, cpf 123.456.789-09, jid 5511987654321@s.whatsapp.net");
    expect(out).not.toMatch(/maria|98765|123\.456|5511987654321/);
    expect(out).toContain("[email]");
    expect(out).toContain("[telefone]");
    expect(out).toContain("[documento]");
  });

  it("troca token, senha, cookie e credencial de URL", () => {
    const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "abcDEF123_-xyz"].join(".");
    const out = redactText(`Authorization: Bearer ${jwt} password=hunter2 token: "abc123secret" postgresql://app:senha-forte@db:5432/x?apiKey=ZZZ999`);
    expect(out).not.toMatch(/hunter2|abc123secret|senha-forte|ZZZ999|eyJ/);
  });

  it("não estraga linha e coluna de stack", () => {
    expect(redactText("at foo (/app/src/route.ts:123:45)")).toContain(":123:45");
  });

  it("tira pasta pessoal e byte nulo", () => {
    const out = redactText("at x (C:\\Users\\Fulano\\proj\\a.ts:1:2)\u0000");
    expect(out).not.toContain("Fulano");
    expect(out).not.toContain("\u0000");
  });
});

describe("fingerprint", () => {
  const base = { source: "SERVER" as const, type: "TypeError", stack: null, route: null };

  it("ids, números e uuid não mudam a assinatura", () => {
    const a = computeFingerprint({ ...base, message: "Contato 123 não achado em 8f14e45f-ceea-467f-a8e9-1b9d4c0e7a11" });
    const b = computeFingerprint({ ...base, message: "Contato 98765 não achado em 11111111-2222-3333-4444-555555555555" });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mensagem ou tipo diferente muda a assinatura", () => {
    expect(computeFingerprint({ ...base, message: "a" })).not.toBe(computeFingerprint({ ...base, message: "b" }));
    expect(computeFingerprint({ ...base, message: "a" })).not.toBe(computeFingerprint({ ...base, type: "RangeError", message: "a" }));
  });

  it("topo da stack ignora linha, coluna e hash de build", () => {
    const s1 = "Error: x\n    at load (/app/.next/server/chunks/ab12cd34ef.js:10:20)";
    const s2 = "Error: x\n    at load (/app/.next/server/chunks/ff99aa11bb.js:99:1)";
    expect(normalizeStackTop(s1)).toBe(normalizeStackTop(s2));
    expect(computeFingerprint({ ...base, message: "x", stack: s1 })).toBe(computeFingerprint({ ...base, message: "x", stack: s2 }));
  });

  it("pula node_modules ao escolher o topo", () => {
    const stack = "Error: x\n    at a (/app/node_modules/lib/i.js:1:1)\n    at minhaFuncao (/app/src/svc.ts:5:5)";
    expect(normalizeStackTop(stack)).toContain("minhaFuncao");
  });

  it("sem stack útil a rota separa erros genéricos", () => {
    const g = { ...base, message: "An error occurred in the Server Components render." };
    expect(computeFingerprint({ ...g, route: "/a" })).not.toBe(computeFingerprint({ ...g, route: "/b" }));
  });

  it("normalizeMessage troca hex e números", () => {
    expect(normalizeMessage("id deadbeef01 em 42")).toBe("id <hex> em <n>");
  });
});

describe("prepareError", () => {
  it("respeita os limites do banco", () => {
    const p = prepareError({ source: "CLIENT", type: "X".repeat(500), message: "m".repeat(1000), stack: "é".repeat(20_000), route: "/a/b?token=1#x" });
    expect(Array.from(p.message).length).toBeLessThanOrEqual(300);
    expect(p.type.length).toBeLessThanOrEqual(120);
    expect(new TextEncoder().encode(p.stack ?? "").length).toBeLessThanOrEqual(STACK_MAX_BYTES);
    expect(p.route).toBe("/a/b");
  });

  it("não deixa PII chegar à mensagem, à stack nem ao contexto", () => {
    const err = new Error("falha para joao@x.com fone 11987654321");
    err.stack = "Error: falha para joao@x.com\n    at f (/app/a.ts:1:1)";
    const p = prepareError({ source: "SERVER", error: err, context: { email: "joao@x.com", password: "123", nota: "ligar 11987654321", aninhado: { token: "t", ok: 1 } } });
    const all = JSON.stringify(p);
    expect(all).not.toMatch(/joao@x|11987654321|"123"/);
    expect(p.context).toEqual({ nota: "ligar [telefone]", aninhado: { ok: 1 } });
  });

  it("ids inválidos e versão inválida viram nulos", () => {
    const p = prepareError({ source: "SERVER", message: "m", userId: "a b", tenantId: "<script>", version: "x y" });
    expect([p.userId, p.tenantId, p.version]).toEqual([null, null, null]);
  });

  it("contexto grande vira marcador", () => {
    const big: Record<string, unknown> = {};
    for (let i = 0; i < 20; i += 1) big[`k${i}`] = "v".repeat(190);
    expect(sanitizeContext(big)).toEqual({ truncated: true });
  });

  it("aceita lançamento que não é Error", () => {
    expect(prepareError({ source: "SERVER", error: "texto solto" }).message).toBe("texto solto");
    expect(prepareError({ source: "SERVER" }).message).toBe("Erro sem mensagem");
  });
});

describe("helpers", () => {
  it("truncateBytes não corta caractere ao meio", () => {
    expect(truncateBytes("aé", 2)).toBe("a");
  });
  it("sanitizeRoute tira query e troca ids", () => {
    expect(sanitizeRoute("/admin/empresas/clx1234567890abcdefghijk?x=1")).toBe("/admin/empresas/:id");
    expect(sanitizeRoute("sem-barra")).toBeNull();
  });
});
