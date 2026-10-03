import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_TABS, CONFIG_TAB_IDS, configTabFromPathname, configTabHref, isConfigTabId } from "./config-tabs";

describe("abas de /admin/configuracoes", () => {
  it("cada aba tem uma rota (pasta com page.tsx e loading.tsx)", () => {
    for (const id of CONFIG_TAB_IDS) {
      expect(existsSync(resolve(__dirname, id, "page.tsx")), `${id}/page.tsx`).toBe(true);
      expect(existsSync(resolve(__dirname, id, "loading.tsx")), `${id}/loading.tsx`).toBe(true);
    }
  });

  it("reconhece só ids conhecidos", () => {
    for (const id of CONFIG_TAB_IDS) expect(isConfigTabId(id)).toBe(true);
    expect(isConfigTabId("nao-existe")).toBe(false);
    expect(isConfigTabId("WhatsApp")).toBe(false);
    expect(isConfigTabId("")).toBe(false);
    expect(isConfigTabId(null)).toBe(false);
  });

  it("monta o link direto com âncora opcional", () => {
    expect(configTabHref("whatsapp")).toBe("/admin/configuracoes/whatsapp");
    expect(configTabHref("whatsapp", "whatsapp-cobranca")).toBe("/admin/configuracoes/whatsapp#whatsapp-cobranca");
  });

  it("descobre a aba pelo caminho", () => {
    expect(configTabFromPathname("/admin/configuracoes/email")).toBe("email");
    expect(configTabFromPathname("/admin/configuracoes/email/")).toBe("email");
    expect(configTabFromPathname("/admin/configuracoes")).toBeNull();
    expect(configTabFromPathname("/admin/configuracoes/xyz")).toBeNull();
    expect(configTabFromPathname("/admin/saude")).toBeNull();
    expect(configTabFromPathname(null)).toBeNull();
  });

  it("toda aba tem título e descrição sem travessão", () => {
    expect(CONFIG_TABS.map((t) => t.id)).toEqual([...CONFIG_TAB_IDS]);
    for (const t of CONFIG_TABS) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description).not.toMatch(/[—–]/);
    }
  });
});
