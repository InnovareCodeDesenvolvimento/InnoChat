import { describe, expect, it } from "vitest";
import { DEFAULT_BOT_TEXTS_V2 } from "@/core/bot/texts-v2";
import { previewHostKey, renderPreviewV2 } from "./preview";

const texts = { ...DEFAULT_BOT_TEXTS_V2 } as Record<string, string>;

describe("bot-texts/preview", () => {
  it("resumo com preço mostra a linha Valor e numera opções com keycap", () => {
    const out = renderPreviewV2("CONFIRM_SUMMARY", texts);
    expect(out).toContain("*Valor:* R$ 80,00");
    expect(out).toContain("1️⃣ Confirmar");
    expect(out).toContain("2️⃣ Corrigir dados");
    expect(out).toContain("Digite *0* para o menu");
  });

  it("resumo sem preço não mostra a linha Valor", () => {
    const out = renderPreviewV2("CONFIRM_SUMMARY", texts, { withPrice: false });
    expect(out).not.toContain("Valor");
    expect(out).toContain("*Nome:* Maria");
  });

  it("saudação vem com o menu logo abaixo", () => {
    const out = renderPreviewV2("GREETING", texts);
    expect(out).toContain("Oi, Maria!");
    expect(out).toContain("1️⃣ Agendar horário");
  });

  it("rótulo editado aparece na mensagem que o hospeda", () => {
    const out = renderPreviewV2("LABEL_MENU_BOOK", { ...texts, LABEL_MENU_BOOK: "Marcar horário" });
    expect(out).toContain("1️⃣ Marcar horário");
    expect(previewHostKey("LABEL_MENU_BOOK")).toBe("MENU_PROMPT");
  });

  it("chave ausente não quebra a tela", () => {
    expect(renderPreviewV2("GREETING", {})).toBe("");
  });
});
