import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  formatSecretForHumans,
  generateTotpSecret,
  matchTotpStep,
  normalizeTotpInput,
  totpCode,
  totpStepAt,
} from "./totp";
import { generateRecoveryCodes, normalizeRecoveryInput } from "./recovery";

// Segredo de teste da RFC 6238 (Apêndice B): ASCII "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

describe("TOTP (RFC 6238, SHA-1)", () => {
  it("o segredo da RFC em base32 é o esperado", () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  // Vetores oficiais: o código de 8 dígitos da RFC termina nos 6 dígitos abaixo.
  it.each([
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"],
    [20000000000, "353130"],
  ])("vetor da RFC no instante %i => %s", (seconds, expected) => {
    expect(totpCode(RFC_SECRET, seconds * 1000)).toBe(expected);
  });

  it("base32 faz ida e volta e rejeita lixo", () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(secret)!)).toBe(secret);
    expect(base32Decode("abc!def")).toBeNull();
    expect(base32Decode("")).toBeNull();
  });

  it("aceita o passo atual e ±1, recusa ±2", () => {
    const now = 1_700_000_000_000;
    const step = totpStepAt(now);
    for (const delta of [-1, 0, 1]) {
      const code = totpCode(RFC_SECRET, (step + delta) * 30_000);
      expect(matchTotpStep(RFC_SECRET, code, null, now)).toBe(step + delta);
    }
    for (const delta of [-2, 2]) {
      const code = totpCode(RFC_SECRET, (step + delta) * 30_000);
      expect(matchTotpStep(RFC_SECRET, code, null, now)).toBeNull();
    }
  });

  it("anti-replay: passo igual ou anterior ao último usado não vale", () => {
    const now = 1_700_000_000_000;
    const step = totpStepAt(now);
    const code = totpCode(RFC_SECRET, now);
    expect(matchTotpStep(RFC_SECRET, code, step - 1, now)).toBe(step);
    expect(matchTotpStep(RFC_SECRET, code, step, now)).toBeNull();
    expect(matchTotpStep(RFC_SECRET, code, step + 1, now)).toBeNull();
  });

  it("aceita espaço e hífen no que o usuário digita; recusa tamanho e letras", () => {
    expect(normalizeTotpInput("123 456")).toBe("123456");
    expect(normalizeTotpInput("123-456")).toBe("123456");
    expect(normalizeTotpInput("12345")).toBeNull();
    expect(normalizeTotpInput("1234567")).toBeNull();
    expect(normalizeTotpInput("12345a")).toBeNull();
    expect(matchTotpStep(RFC_SECRET, "abcdef", null)).toBeNull();
  });

  it("monta a URI otpauth com emissor, conta e parâmetros", () => {
    const uri = buildOtpauthUri({ issuer: "InnoChat", account: "ana@exemplo.com.br", secretBase32: "ABCDEFGH" });
    expect(uri.startsWith("otpauth://totp/InnoChat:ana%40exemplo.com.br?")).toBe(true);
    const params = new URL(uri).searchParams;
    expect(params.get("secret")).toBe("ABCDEFGH");
    expect(params.get("issuer")).toBe("InnoChat");
    expect(params.get("digits")).toBe("6");
    expect(params.get("period")).toBe("30");
    expect(params.get("algorithm")).toBe("SHA1");
  });

  it("formata a chave em blocos de 4", () => {
    expect(formatSecretForHumans("ABCDEFGHIJKL")).toBe("ABCD EFGH IJKL");
  });
});

describe("códigos de recuperação", () => {
  it("gera 10 códigos distintos no formato abcde-fghij e normaliza a digitação", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) {
      expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/);
      expect(normalizeRecoveryInput(c)).toBe(c.replace("-", ""));
      expect(normalizeRecoveryInput(c.toUpperCase().replace("-", " "))).toBe(c.replace("-", ""));
    }
  });

  it("recusa o que não parece código", () => {
    expect(normalizeRecoveryInput("123456")).toBeNull();
    expect(normalizeRecoveryInput("abcde-fghi")).toBeNull();
    expect(normalizeRecoveryInput("abcd0-fghij")).toBeNull();
  });
});
