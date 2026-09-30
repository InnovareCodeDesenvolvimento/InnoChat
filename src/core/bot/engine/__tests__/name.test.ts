import { describe, expect, it } from "vitest";
import { validateName } from "../index";

describe("validateName: caracteres invisíveis e fórmula (S2)", () => {
  it("remove bidi e zero-width do nome gravado", () => {
    const r = validateName("Ma\u202Eria\u200B Silva\u2066\uFEFF");
    expect(r).toEqual({ ok: true, name: "Maria Silva" });
  });
  it("cobre as bordas dos intervalos U+200B–200F, U+202A–202E e U+2066–2069", () => {
    for (const ch of ["\u200B", "\u200F", "\u202A", "\u202E", "\u2066", "\u2069", "\uFEFF"]) {
      expect(validateName(`Jo${ch}ao`)).toEqual({ ok: true, name: "Joao" });
    }
  });
  it.each(["=SOMA(A1)", "+55 11 99999", "-Ana", "@ana", "\u200B=cmd|' /C calc'!A0", "\u202E-Ana"])("recusa nome que começa como fórmula: %j", (raw) => {
    expect(validateName(raw)).toEqual({ ok: false, reason: "INVALID" });
  });
  it("aceita hífen e sinais no meio do nome", () => {
    expect(validateName("Ana-Maria Souza")).toEqual({ ok: true, name: "Ana-Maria Souza" });
    expect(validateName("Zé + Ana Lima")).toEqual({ ok: true, name: "Zé + Ana Lima" });
  });
  it("texto gigante é recusado como longo, rápido", () => {
    const t0 = performance.now();
    expect(validateName("a".repeat(60000))).toEqual({ ok: false, reason: "TOO_LONG" });
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
