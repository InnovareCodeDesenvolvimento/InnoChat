import { describe, expect, it } from "vitest";
import { plainHttpsUrl } from "./google-external-button";

describe("plainHttpsUrl (link para copiar e colar no navegador)", () => {
  it("iPhone: troca o esquema do Safari por https", () => {
    expect(plainHttpsUrl("x-safari-https://innochat.innovarecode.com.br/cadastro?via=google")).toBe(
      "https://innochat.innovarecode.com.br/cadastro?via=google",
    );
  });

  it("Android: usa a URL de fallback do intent", () => {
    const fallback = encodeURIComponent("https://innochat.innovarecode.com.br/cadastro?utm_source=ig&via=google");
    const href = `intent://innochat.innovarecode.com.br/cadastro?utm_source=ig&via=google#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${fallback};end`;
    expect(plainHttpsUrl(href)).toBe("https://innochat.innovarecode.com.br/cadastro?utm_source=ig&via=google");
  });

  it("outros: devolve como veio", () => {
    expect(plainHttpsUrl("https://innochat.innovarecode.com.br/cadastro")).toBe("https://innochat.innovarecode.com.br/cadastro");
  });
});
