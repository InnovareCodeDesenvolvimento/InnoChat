import { describe, expect, it } from "vitest";
import { suggestEmail } from "../email-suggest";

describe("suggestEmail", () => {
  it.each([
    ["ana@gmial.com", "ana@gmail.com"],
    ["ana@gmail.con", "ana@gmail.com"],
    ["Ana@Hotmial.com ", "ana@hotmail.com"],
    ["ana@outlok.com", "ana@outlook.com"],
    ["ana@hotmail.com.br", null],
    ["ana@yahoo.com.bt", "ana@yahoo.com.br"],
    ["ana@gmail.com.br", "ana@gmail.com"],
  ])("%s -> %s", (input, expected) => {
    expect(suggestEmail(input)).toBe(expected);
  });

  it("não mexe em e-mail certo, em domínio próprio nem em texto incompleto", () => {
    expect(suggestEmail("ana@gmail.com")).toBeNull();
    expect(suggestEmail("contato@salaobela.com.br")).toBeNull();
    expect(suggestEmail("ana@")).toBeNull();
    expect(suggestEmail("ana")).toBeNull();
    expect(suggestEmail("")).toBeNull();
  });

  it("pega erro de uma letra em domínio conhecido de nome longo", () => {
    expect(suggestEmail("ana@hotmaill.com")).toBe("ana@hotmail.com");
  });
});
