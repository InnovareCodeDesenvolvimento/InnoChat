import { describe, expect, it } from "vitest";
import { isStaleBuildError } from "./stale-build";

describe("isStaleBuildError", () => {
  it("reconhece o erro do Turbopack visto em produção depois de uma publicação", () => {
    expect(isStaleBuildError("ChunkLoadError", "Failed to load chunk /_next/static/chunks/10p5u_cxcodaz.js from module 964893")).toBe(true);
  });

  it("reconhece pelo nome mesmo com mensagem diferente e pelas mensagens dos navegadores", () => {
    expect(isStaleBuildError("ChunkLoadError", "qualquer coisa")).toBe(true);
    expect(isStaleBuildError("Error", "Loading chunk 123 failed.")).toBe(true);
    expect(isStaleBuildError("TypeError", "Failed to fetch dynamically imported module: https://x/_next/a.js")).toBe(true);
    expect(isStaleBuildError("TypeError", "error loading dynamically imported module")).toBe(true);
    expect(isStaleBuildError("TypeError", "Importing a module script failed.")).toBe(true);
  });

  it("não confunde erro comum com versão antiga", () => {
    expect(isStaleBuildError("TypeError", "Cannot read properties of undefined (reading 'id')")).toBe(false);
    expect(isStaleBuildError("Error", "Failed to fetch")).toBe(false);
    expect(isStaleBuildError(null, null)).toBe(false);
  });
});
