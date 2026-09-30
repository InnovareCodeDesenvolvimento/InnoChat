import { describe, expect, it } from "vitest";
import { parseWhatsAppLine, parseWhatsAppText } from "./whatsapp-format";

describe("whatsapp-format", () => {
  it("negrito, itálico e riscado", () => {
    expect(parseWhatsAppLine("a *b* _c_ ~d~ e")).toEqual([
      { text: "a " },
      { text: "b", bold: true },
      { text: " " },
      { text: "c", italic: true },
      { text: " " },
      { text: "d", strike: true },
      { text: " e" },
    ]);
  });

  it("aninha estilos", () => {
    expect(parseWhatsAppLine("*negrito _e itálico_*")).toEqual([
      { text: "negrito ", bold: true },
      { text: "e itálico", bold: true, italic: true },
    ]);
  });

  it("não formata dentro de palavra nem com espaço colado ao marcador", () => {
    expect(parseWhatsAppLine("snake_case_name")).toEqual([{ text: "snake_case_name" }]);
    expect(parseWhatsAppLine("2 * 3 * 4")).toEqual([{ text: "2 * 3 * 4" }]);
    expect(parseWhatsAppLine("* solto *")).toEqual([{ text: "* solto *" }]);
  });

  it("aceita pontuação depois do fechamento e keycaps", () => {
    expect(parseWhatsAppLine("*Oi*, tudo bem? 1️⃣ Agendar")).toEqual([
      { text: "Oi", bold: true },
      { text: ", tudo bem? 1️⃣ Agendar" },
    ]);
  });

  it("preserva quebras de linha", () => {
    expect(parseWhatsAppText("a\n\nb")).toEqual([[{ text: "a" }], [], [{ text: "b" }]]);
  });
});
