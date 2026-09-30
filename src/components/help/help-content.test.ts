import { describe, expect, it } from "vitest";
import { BOT_TAB_HELP, FORBIDDEN_HELP_TERMS, HELP, type HelpEntry } from "./help-content";

const entries = Object.entries(HELP) as [string, HelpEntry][];

function allText(entry: HelpEntry): string {
  return [entry.title, entry.purpose, ...(entry.steps ?? []), ...entry.examples, entry.tip ?? "", entry.warning ?? ""].join("\n");
}

describe("catálogo de ajuda", () => {
  it("tem entradas", () => {
    expect(entries.length).toBeGreaterThan(30);
  });

  it.each(entries)("%s: título, uso e pelo menos 1 exemplo", (_key, entry) => {
    expect(entry.title.trim().length).toBeGreaterThan(2);
    expect(entry.purpose.trim().length).toBeGreaterThan(20);
    expect(entry.examples.length).toBeGreaterThanOrEqual(1);
    for (const example of entry.examples) expect(example.trim().length).toBeGreaterThan(15);
    for (const step of entry.steps ?? []) expect(step.trim().length).toBeGreaterThan(3);
  });

  it.each(entries)("%s: sem termo técnico proibido", (_key, entry) => {
    // Sem a flag `i`: com `u`+`i`, `[^\p{L}]` casa letras (pegadinha do motor); minúsculas à mão.
    const text = allText(entry).toLowerCase();
    for (const term of FORBIDDEN_HELP_TERMS) {
      const found = new RegExp(String.raw`(^|[^\p{L}])${term.toLowerCase()}([^\p{L}]|$)`, "u").test(text);
      expect(found, `"${term}" em ${entry.title}`).toBe(false);
    }
  });

  it("títulos são únicos (o aria-label do botão não pode repetir na mesma tela)", () => {
    const titles = entries.map(([, e]) => e.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("título novo não colide com rótulos de campos dos E2E existentes", () => {
    const titles = entries.map(([, e]) => e.title);
    expect(titles).not.toContain("Agendamentos futuros por cliente");
    expect(titles).not.toContain("Bot volta a responder depois de");
  });

  it("toda aba das mensagens do bot aponta para uma entrada existente", () => {
    for (const key of Object.values(BOT_TAB_HELP)) expect(HELP[key]).toBeDefined();
  });
});
