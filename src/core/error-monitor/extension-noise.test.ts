import { describe, expect, it } from "vitest";
import { isBrowserExtensionOnlyStack } from "./extension-noise";

const SITE = "https://innochat.innovarecode.com.br/_next/static/chunks/app.js:1:2";

describe("erro de extensão do navegador", () => {
  it("descarta o caso real: frames só de chrome-extension://", () => {
    const stack = [
      "TypeError: Cannot read properties of undefined (reading 'M_ID')",
      "    at s (chrome-extension://eppiocemhmnlbhjplcgkofciiegomcon/executors/200.js:2:3456)",
      "    at chrome-extension://eppiocemhmnlbhjplcgkofciiegomcon/executors/200.js:2:99",
    ].join("\n");
    expect(isBrowserExtensionOnlyStack(stack)).toBe(true);
  });

  it.each(["moz-extension://abc-123/content.js:1:1", "safari-extension://x/y.js:1:1", "safari-web-extension://x/y.js:1:1"])("descarta %s", (frame) => {
    expect(isBrowserExtensionOnlyStack(`Error: x\n    at f (${frame})`)).toBe(true);
  });

  it("mantém quando há algum frame do nosso domínio ou do _next", () => {
    const mixed = `Error: x\n    at a (chrome-extension://abc/x.js:1:1)\n    at b (${SITE})`;
    expect(isBrowserExtensionOnlyStack(mixed)).toBe(false);
    expect(isBrowserExtensionOnlyStack(`Error: x\n    at b (${SITE})`)).toBe(false);
  });

  it("mantém stack vazio, ausente ou sem endereço nenhum", () => {
    expect(isBrowserExtensionOnlyStack(undefined)).toBe(false);
    expect(isBrowserExtensionOnlyStack("")).toBe(false);
    expect(isBrowserExtensionOnlyStack("Error: x\n    at <anonymous>")).toBe(false);
  });

  it("citar 'chrome-extension' só na mensagem não basta", () => {
    expect(isBrowserExtensionOnlyStack("Error: veio de chrome-extension (texto)\n    at <anonymous>")).toBe(false);
  });
});
