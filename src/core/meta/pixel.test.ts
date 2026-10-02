import { describe, expect, it } from "vitest";
import { isValidMetaEventId, isValidPixelId, isValidTestEventCode, normalizePixelId } from "./pixel";

describe("pixel", () => {
  it("ID do Pixel: só dígitos, 5 a 20", () => {
    expect(isValidPixelId("1234567890123456")).toBe(true);
    expect(isValidPixelId("12345")).toBe(true);
    expect(isValidPixelId("1234")).toBe(false);
    expect(isValidPixelId("123456789012345678901")).toBe(false);
    expect(isValidPixelId("12345a")).toBe(false);
    expect(isValidPixelId("")).toBe(false);
  });

  it("nada que feche o script entra no ID", () => {
    expect(isValidPixelId("123456');alert(1);//")).toBe(false);
    expect(isValidPixelId("12345\n")).toBe(false);
  });

  it("normaliza espaços e pontos colados, e zera o que tem letra", () => {
    expect(normalizePixelId(" 1234 5678 ")).toBe("12345678");
    expect(normalizePixelId("1.234.567")).toBe("1234567");
    expect(normalizePixelId("abc123")).toBe("");
  });

  it("código de teste e id de evento", () => {
    expect(isValidTestEventCode("TEST12345")).toBe(true);
    expect(isValidTestEventCode("TEST 1")).toBe(false);
    expect(isValidTestEventCode("")).toBe(false);
    expect(isValidMetaEventId("3f1c2a9e-1111-4222-8333-444455556666")).toBe(true);
    expect(isValidMetaEventId("curto")).toBe(false);
    expect(isValidMetaEventId(42)).toBe(false);
    expect(isValidMetaEventId("com espaço no meio")).toBe(false);
  });
});
