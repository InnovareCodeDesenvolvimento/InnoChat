import { describe, expect, it } from "vitest";
import { formatBrPhoneDisplay, normalizeBrPhoneToE164 } from "../br-phone";

describe("normalizeBrPhoneToE164", () => {
  it("aceita máscara com e sem DDI", () => {
    expect(normalizeBrPhoneToE164("(84) 3113-2584")).toBe("558431132584");
    expect(normalizeBrPhoneToE164("84 3113-2584")).toBe("558431132584");
    expect(normalizeBrPhoneToE164("+55 84 3113-2584")).toBe("558431132584");
    expect(normalizeBrPhoneToE164("558431132584")).toBe("558431132584");
    expect(normalizeBrPhoneToE164("084 3113-2584")).toBe("558431132584");
  });

  it("aceita celular com 9º dígito", () => {
    expect(normalizeBrPhoneToE164("(84) 99999-8888")).toBe("5584999998888");
    expect(normalizeBrPhoneToE164("+55 (11) 98765-4321")).toBe("5511987654321");
  });

  it("não confunde DDD 55 com DDI", () => {
    expect(normalizeBrPhoneToE164("(55) 3113-2584")).toBe("555531132584");
    expect(normalizeBrPhoneToE164("55 55 3113-2584")).toBe("555531132584");
  });

  it("rejeita inválidos", () => {
    expect(normalizeBrPhoneToE164("")).toBeNull();
    expect(normalizeBrPhoneToE164("abc")).toBeNull();
    expect(normalizeBrPhoneToE164("3113-2584")).toBeNull(); // sem DDD
    expect(normalizeBrPhoneToE164("(84) 9999-8888")).toBeNull(); // celular sem o 9º dígito
    expect(normalizeBrPhoneToE164("(84) 89999-8888")).toBeNull(); // 9 dígitos que não começa em 9
    expect(normalizeBrPhoneToE164("(04) 3113-2584")).toBeNull(); // DDD com zero
    expect(normalizeBrPhoneToE164("(84) 3113-25849")).toBeNull(); // dígito a mais
    expect(normalizeBrPhoneToE164("+1 415 555 2671")).toBeNull(); // fora do Brasil
  });
});

describe("formatBrPhoneDisplay", () => {
  it("formata fixo e celular", () => {
    expect(formatBrPhoneDisplay("558431132584")).toBe("(84) 3113-2584");
    expect(formatBrPhoneDisplay("5584999998888")).toBe("(84) 99999-8888");
    expect(formatBrPhoneDisplay("+558431132584")).toBe("(84) 3113-2584");
  });
  it("devolve como veio se não for BR", () => {
    expect(formatBrPhoneDisplay("14155552671")).toBe("14155552671");
  });
});
