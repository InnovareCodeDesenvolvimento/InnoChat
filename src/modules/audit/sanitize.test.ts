import { describe, expect, it } from "vitest";
import { actionLabel, fieldLabel, formatAuditValue, ACTION_LABELS, AUDIT_AREAS } from "./labels";
import { clampText, diffChanges, isSecretKey, MAX_CHANGES_BYTES, REDACTED, sanitizeChanges, stripUrlSecrets, truncateIp } from "./sanitize";

describe("truncateIp", () => {
  it("IPv4 zera o último octeto (/24)", () => {
    expect(truncateIp("203.0.113.77")).toBe("203.0.113.0");
    expect(truncateIp("10.20.30.40")).toBe("10.20.30.0");
  });

  it("IPv6 guarda só os 48 bits do prefixo (/48)", () => {
    expect(truncateIp("2001:db8:abcd:12:34:56:78:9a")).toBe("2001:db8:abcd::");
    expect(truncateIp("2001:db8::1")).toBe("2001:db8:0::");
    expect(truncateIp("::1")).toBe("0:0:0::");
    expect(truncateIp("fe80::1%eth0")).toBe("fe80:0:0::");
  });

  it("IPv6 mapeado de IPv4 vira IPv4 truncado", () => {
    expect(truncateIp("::ffff:198.51.100.9")).toBe("198.51.100.0");
  });

  it("lixo, vazio e 'unknown' viram null (nunca grava texto do cliente)", () => {
    expect(truncateIp(null)).toBeNull();
    expect(truncateIp("")).toBeNull();
    expect(truncateIp("unknown")).toBeNull();
    expect(truncateIp("1.2.3")).toBeNull();
    expect(truncateIp("<script>")).toBeNull();
    expect(truncateIp("999.1.1.1")).toBeNull();
  });
});

describe("sanitizeChanges: segredos", () => {
  it.each(["s3SecretKey", "smtpPassword", "accessToken", "webhookSecret", "mpProdAccessTokenEnc", "totpSecretEnc", "capiToken", "clientSecret", "passwordHash", "evolutionApiKey", "n8nApiKey", "driveServiceAccountKey", "senha"])(
    "%s nunca guarda o valor",
    (key) => {
      expect(isSecretKey(key)).toBe(true);
      const out = sanitizeChanges({ [key]: { de: "valor-antigo-123", para: "valor-novo-456" } });
      expect(out).toEqual({ [key]: { de: REDACTED, para: REDACTED } });
      expect(JSON.stringify(out)).not.toContain("valor-");
    },
  );

  it("campos comuns passam", () => {
    expect(isSecretKey("priceCents")).toBe(false);
    expect(isSecretKey("name")).toBe(false);
    expect(sanitizeChanges({ priceCents: { de: 5000, para: 6000 } })).toEqual({ priceCents: { de: 5000, para: 6000 } });
  });

  it("vazio ou nulo vira null", () => {
    expect(sanitizeChanges(null)).toBeNull();
    expect(sanitizeChanges({})).toBeNull();
  });

  it("valor longo é encurtado e o conjunto respeita o teto do banco (8 KB)", () => {
    const big: Record<string, { de: unknown; para: unknown }> = {};
    for (let i = 0; i < 100; i += 1) big[`campo${i}`] = { de: "x".repeat(500), para: "y".repeat(500) };
    const out = sanitizeChanges(big)!;
    expect(Buffer.byteLength(JSON.stringify(out), "utf8")).toBeLessThanOrEqual(MAX_CHANGES_BYTES + 200);
    expect(Buffer.byteLength(JSON.stringify(out), "utf8")).toBeLessThan(8192);
    expect(out._omitidos?.para).toBeGreaterThan(0);
    expect(String(out.campo0!.de).length).toBeLessThanOrEqual(200);
  });

  it("objeto e data viram texto curto", () => {
    const out = sanitizeChanges({ quando: { de: new Date("2026-10-05T13:00:00.000Z"), para: { a: 1 } } })!;
    expect(out.quando).toEqual({ de: "2026-10-05T13:00:00.000Z", para: '{"a":1}' });
  });
});

describe("diffChanges", () => {
  it("só traz o que mudou de verdade", () => {
    const before = { name: "Corte", priceCents: 5000, active: true, startsAt: new Date("2026-10-05T13:00:00Z") };
    const after = { name: "Corte", priceCents: 6000, active: true, startsAt: new Date("2026-10-05T13:00:00Z") };
    expect(diffChanges(before, after, ["name", "priceCents", "active", "startsAt"])).toEqual({ priceCents: { de: 5000, para: 6000 } });
  });

  it("null e undefined são o mesmo 'vazio'; 0 e false não", () => {
    expect(diffChanges({ a: null }, { a: undefined }, ["a"])).toEqual({});
    expect(diffChanges({ a: 0 }, { a: null }, ["a"])).toEqual({ a: { de: 0, para: null } });
    expect(diffChanges({ a: false }, { a: null }, ["a"])).toEqual({ a: { de: false, para: null } });
  });
});

describe("clampText", () => {
  it("tira quebras de linha e corta no limite", () => {
    expect(clampText("a\n\nb   c", 50)).toBe("a b c");
    expect(clampText("x".repeat(400), 300)).toHaveLength(300);
  });
});

describe("rótulos em português", () => {
  it("toda ação conhecida tem rótulo e cada uma cai numa área do filtro", () => {
    for (const action of Object.keys(ACTION_LABELS)) {
      expect(actionLabel(action).length).toBeGreaterThan(3);
      const inArea = AUDIT_AREAS.some((a) => a.prefixes.some((p) => action.startsWith(p)));
      expect(inArea, action).toBe(true);
    }
  });

  it("nenhum texto usa travessão", () => {
    const texts = [...Object.values(ACTION_LABELS), ...AUDIT_AREAS.map((a) => a.label)];
    for (const t of texts) expect(t).not.toMatch(/[—–]/);
  });

  it("ação desconhecida mostra o código; campo com serviço mostra o nome", () => {
    expect(actionLabel("x.y")).toBe("x.y");
    expect(fieldLabel("priceCents")).toBe("Preço");
    expect(fieldLabel("comissao_servico:Corte")).toBe("Comissão no serviço Corte");
  });

  it("valores: dinheiro, sim/não, data no fuso, vazio e segredo oculto", () => {
    expect(formatAuditValue("priceCents", 5000)).toMatch(/R\$\s?50,00/);
    expect(formatAuditValue("active", true)).toBe("sim");
    expect(formatAuditValue("x", null)).toBe("vazio");
    expect(formatAuditValue("x", REDACTED)).toBe("valor oculto");
    expect(formatAuditValue("startsAt", "2026-10-05T13:00:00.000Z", "America/Sao_Paulo")).toBe("05/10/2026 às 10:00");
    expect(formatAuditValue("status", "NO_SHOW")).toBe("Faltou");
  });
});

describe("sanitizeChanges: endereços (B-9 do Órion)", () => {
  it.each(["evolutionApiUrl", "n8nWebhookBaseUrl", "n8nBaseUrl", "publicBaseUrl", "s3Endpoint"])("%s entra sem usuário, senha nem query string", (key) => {
    const out = sanitizeChanges({ [key]: { de: "https://user:segredo@old.example.com:8080/base?token=abc#x", para: "https://admin:s3nha@new.example.com/hooks/?apikey=zzz" } });
    expect(out).toEqual({ [key]: { de: "https://old.example.com:8080/base", para: "https://new.example.com/hooks/" } });
    const text = JSON.stringify(out);
    for (const leak of ["user", "segredo", "s3nha", "admin", "token", "apikey", "abc", "zzz"]) expect(text).not.toContain(leak);
  });

  it("endereço simples não muda; valor vazio e texto sem esquema também são tratados", () => {
    expect(stripUrlSecrets("https://evolution.example.com/")).toBe("https://evolution.example.com");
    expect(stripUrlSecrets(null)).toBeNull();
    expect(stripUrlSecrets("usuario:senha@host.example.com/x?y=1")).toBe("host.example.com/x");
  });

  it("campo que não é endereço não é mexido", () => {
    expect(sanitizeChanges({ texto: { de: null, para: "veja https://x.com/a?b=1" } })).toEqual({ texto: { de: null, para: "veja https://x.com/a?b=1" } });
  });
});
